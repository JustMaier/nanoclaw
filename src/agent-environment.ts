/**
 * Shared agent environment utilities.
 *
 * Extracted from container-runner.ts so that any runner (container or direct)
 * can reuse group setup, IPC directory creation, skill syncing, and output parsing.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';

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
 * Ensure the global shared memory directory exists.
 */
export function ensureGlobalDir(): string {
  const globalDir = path.join(GROUPS_DIR, 'global');
  fs.mkdirSync(globalDir, { recursive: true });
  return globalDir;
}

/**
 * Set up the group folder on disk if it does not exist.
 */
export function setupGroupEnvironment(groupFolder: string): string {
  const groupDir = resolveGroupFolderPath(groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  return groupDir;
}

/**
 * Ensure per-group IPC directories exist.
 */
export function ensureGroupIpcDirs(groupFolder: string): string {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  return groupIpcDir;
}

/**
 * Ensure per-group Claude session settings exist (settings.json with defaults).
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
 * Sync container skills from container/skills/ into a group's .claude/skills/.
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
 * Recompiled on container startup via entrypoint.sh.
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
 * Parse output markers from a buffer, extracting all complete marker pairs.
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
    if (endIdx === -1) break;

    const jsonStr = remaining
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
    remaining = remaining.slice(endIdx + OUTPUT_END_MARKER.length);

    try {
      outputs.push(JSON.parse(jsonStr));
    } catch {
      // Skip malformed JSON
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
