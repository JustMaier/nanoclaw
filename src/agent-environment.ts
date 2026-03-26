/**
 * Shared agent environment setup for NanoClaw.
 * Used by both container-runner (Docker) and direct-runner (native).
 *
 * Centralizes group environment creation so changes only need to happen once:
 * - Session settings, skills syncing, IPC directory structure
 * - Output marker parsing, timeout management
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Ensure all directories for a group's IPC communication exist.
 */
export function ensureGroupIpcDirs(groupFolder: string): string {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  return groupIpcDir;
}

/**
 * Ensure per-group Claude sessions directory exists with default settings.
 * Returns the path to the .claude directory.
 */
export function ensureGroupSessionSettings(groupFolder: string): string {
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  return groupSessionsDir;
}

/**
 * Sync skills from container/skills/ into a group's .claude/skills/ directory.
 */
export function syncSkillsToGroup(groupSessionsDir: string): void {
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
}

/**
 * Copy agent-runner source into a per-group writable location.
 * Returns the path to the group's agent-runner-src directory.
 */
export function syncAgentRunnerSource(groupFolder: string): string {
  const projectRoot = process.cwd();
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    'agent-runner-src',
  );

  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }

  return groupAgentRunnerDir;
}

/**
 * Ensure the global memory directory exists.
 */
export function ensureGlobalDir(): string {
  const globalDir = path.join(GROUPS_DIR, 'global');
  fs.mkdirSync(globalDir, { recursive: true });
  return globalDir;
}

/**
 * Set up the full group environment (sessions, skills, IPC, agent-runner).
 * Shared between container and direct mode.
 */
export function setupGroupEnvironment(
  group: RegisteredGroup,
  _isMain: boolean,
): {
  groupDir: string;
  groupIpcDir: string;
  groupSessionsDir: string;
  groupAgentRunnerDir: string;
  globalDir: string;
} {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const groupIpcDir = ensureGroupIpcDirs(group.folder);
  const groupSessionsDir = ensureGroupSessionSettings(group.folder);
  syncSkillsToGroup(groupSessionsDir);
  const groupAgentRunnerDir = syncAgentRunnerSource(group.folder);
  const globalDir = ensureGlobalDir();

  return {
    groupDir,
    groupIpcDir,
    groupSessionsDir,
    groupAgentRunnerDir,
    globalDir,
  };
}

/**
 * Parse streaming output markers from a buffer.
 * Returns parsed outputs and the remaining unparsed buffer.
 */
export function parseOutputMarkers(buffer: string): {
  outputs: ContainerOutput[];
  remaining: string;
} {
  const outputs: ContainerOutput[] = [];
  let remaining = buffer;

  let startIdx: number;
  while ((startIdx = remaining.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = remaining.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break; // Incomplete pair, wait for more data

    const jsonStr = remaining
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
    remaining = remaining.slice(endIdx + OUTPUT_END_MARKER.length);

    try {
      outputs.push(JSON.parse(jsonStr));
    } catch {
      // Malformed JSON, skip this marker pair
    }
  }

  return { outputs, remaining };
}

/**
 * Parse the final output from accumulated stdout (legacy non-streaming mode).
 */
export function parseFinalOutput(stdout: string): ContainerOutput {
  const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
  const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

  let jsonLine: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    jsonLine = stdout
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
  } else {
    // Fallback: last non-empty line (backwards compatibility)
    const lines = stdout.trim().split('\n');
    jsonLine = lines[lines.length - 1];
  }

  return JSON.parse(jsonLine);
}
