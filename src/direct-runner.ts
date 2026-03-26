/**
 * Direct Runner for NanoClaw
 * Runs the agent-runner as a local Node.js child process instead of in Docker.
 * Works on all platforms (macOS, Linux, Windows) and removes the container
 * runtime dependency.
 *
 * Mirrors the ContainerInput/ContainerOutput interface of container-runner.ts
 * so the rest of the system doesn't need to know which mode is active.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
} from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { OneCLI } from '@onecli-sh/sdk';
import { RegisteredGroup } from './types.js';
import {
  ContainerInput,
  writeTasksSnapshot,
  writeGroupsSnapshot,
  AvailableGroup,
} from './container-runner.js';
import {
  ContainerOutput,
  setupGroupEnvironment,
  parseOutputMarkers,
  parseFinalOutput,
} from './agent-environment.js';

const onecli = new OneCLI({ url: ONECLI_URL });

// Re-export types that index.ts imports from container-runner
export { writeTasksSnapshot, writeGroupsSnapshot };
export type { ContainerInput, AvailableGroup };
export type { ContainerOutput } from './agent-environment.js';

/**
 * Ensure the agent-runner is built and ready to run locally.
 * In direct mode, we compile the agent-runner TypeScript on first use.
 */
let agentRunnerReady = false;

function ensureAgentRunnerBuilt(): string {
  const projectRoot = process.cwd();
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
  const distDir = path.join(agentRunnerDir, 'dist');
  const entryPoint = path.join(distDir, 'index.js');

  if (agentRunnerReady && fs.existsSync(entryPoint)) {
    return entryPoint;
  }

  // Check if node_modules exists
  const nodeModules = path.join(agentRunnerDir, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    logger.info('Installing agent-runner dependencies...');

    execSync('npm install', { cwd: agentRunnerDir, stdio: 'pipe' });
  }

  // Build if dist doesn't exist or is stale
  const srcIndex = path.join(agentRunnerDir, 'src', 'index.ts');
  const needsBuild =
    !fs.existsSync(entryPoint) ||
    fs.statSync(srcIndex).mtimeMs > fs.statSync(entryPoint).mtimeMs;

  if (needsBuild) {
    logger.info('Building agent-runner for direct mode...');

    execSync('npx tsc', { cwd: agentRunnerDir, stdio: 'pipe' });
  }

  agentRunnerReady = true;
  return entryPoint;
}

/**
 * Set up the directory structure and return environment variables
 * for the agent-runner process. Uses shared setupGroupEnvironment()
 * for all the common setup (sessions, skills, IPC, agent-runner source).
 */
function setupDirectEnvironment(
  group: RegisteredGroup,
  isMain: boolean,
): Record<string, string> {
  const projectRoot = process.cwd();

  // Shared environment setup (same as container mode)
  const shared = setupGroupEnvironment(group, isMain);

  // Build env vars that tell the agent-runner where things are
  const env: Record<string, string> = {
    NANOCLAW_GROUP_DIR: shared.groupDir,
    NANOCLAW_IPC_DIR: shared.groupIpcDir,
    NANOCLAW_IPC_INPUT_DIR: path.join(shared.groupIpcDir, 'input'),
    NANOCLAW_GLOBAL_DIR: shared.globalDir,
    HOME: shared.groupSessionsDir.replace(/[/\\].claude$/, ''), // parent of .claude
    CLAUDE_CONFIG_DIR: shared.groupSessionsDir,
  };

  // Additional mount directories
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    const extraDir = path.join(DATA_DIR, 'sessions', group.folder, 'extra');
    fs.mkdirSync(extraDir, { recursive: true });
    env.NANOCLAW_EXTRA_DIR = extraDir;
  }

  if (isMain) {
    env.NANOCLAW_PROJECT_DIR = projectRoot;
  }

  return env;
}

export async function runDirectAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Ensure agent-runner is built
  let entryPoint: string;
  try {
    entryPoint = ensureAgentRunnerBuilt();
  } catch (err) {
    logger.error({ err }, 'Failed to build agent-runner for direct mode');
    return {
      status: 'error',
      result: null,
      error: `Failed to build agent-runner: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const directEnv = setupDirectEnvironment(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-direct-${safeName}-${Date.now()}`;

  // MCP server path — use the built version alongside index.js
  const mcpServerPath = path.join(path.dirname(entryPoint), 'ipc-mcp-stdio.js');

  // Get credentials from OneCLI gateway (same mechanism as container mode).
  // In container mode, applyContainerConfig() adds -e flags to docker run.
  // In direct mode, we get the same env vars and pass them to the child process.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  let credentialEnv: Record<string, string> = {};
  try {
    const config = await onecli.getContainerConfig(agentIdentifier);
    credentialEnv = { ...config.env };
    // In direct mode, the child process runs on the host — not inside Docker.
    // Replace host.docker.internal with localhost so the proxy is reachable.
    for (const key of Object.keys(credentialEnv)) {
      credentialEnv[key] = credentialEnv[key].replace(
        /host\.docker\.internal/g,
        '127.0.0.1',
      );
    }
    // Write CA cert so the child process can verify the OneCLI proxy's TLS
    if (config.caCertificate) {
      const caPath = path.join(DATA_DIR, 'onecli-ca.pem');
      fs.mkdirSync(path.dirname(caPath), { recursive: true });
      fs.writeFileSync(caPath, config.caCertificate);
      credentialEnv.NODE_EXTRA_CA_CERTS = caPath;
    }
    logger.info({ processName }, 'OneCLI credentials applied for direct mode');
  } catch {
    logger.warn(
      { processName },
      'OneCLI gateway not reachable — direct agent will have no credentials',
    );
  }

  // Build environment for the child process
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...directEnv,
    ...credentialEnv,
    // Pass IPC dir to the MCP server
    NANOCLAW_IPC_DIR: directEnv.NANOCLAW_IPC_DIR,
  };

  logger.info(
    {
      group: group.name,
      processName,
      isMain: input.isMain,
      entryPoint,
      groupDir,
    },
    'Spawning direct agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const child = spawn('node', [entryPoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      cwd: groupDir,
    });

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdin!.write(JSON.stringify(input));
    child.stdin!.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Direct agent timeout, killing',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    child.stdout!.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Direct agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        const { outputs, remaining } = parseOutputMarkers(parseBuffer);
        parseBuffer = remaining;

        for (const parsed of outputs) {
          if (parsed.newSessionId) {
            newSessionId = parsed.newSessionId;
          }
          hadStreamingOutput = true;
          resetTimeout();
          outputChain = outputChain.then(() => onOutput(parsed));
        }
      }
    });

    child.stderr!.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ agent: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Direct agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Direct agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `direct-${timestamp}.log`);
      const logLines = [
        `=== Direct Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
      ];
      if (code !== 0 || process.env.LOG_LEVEL === 'debug') {
        logLines.push(
          ``,
          `=== Stderr ===`,
          stderr,
          ``,
          `=== Stdout ===`,
          stdout,
        );
      }
      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, logFile },
          'Direct agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Direct agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Direct agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker pair
      try {
        const output = parseFinalOutput(stdout);
        logger.info(
          { group: group.name, duration, status: output.status },
          'Direct agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse direct agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Direct agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * No-op equivalents for container runtime functions.
 * In direct mode, there's no Docker to check or clean up.
 */
export function ensureDirectModeReady(): void {
  ensureAgentRunnerBuilt();
  logger.info('Direct mode ready (no container runtime needed)');
}

export function cleanupDirectOrphans(): void {
  // In direct mode, orphan cleanup is handled by the OS (process exits).
  // Nothing to do here.
}
