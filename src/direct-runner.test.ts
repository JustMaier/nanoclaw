import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match direct-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  DIRECT_MODE: true,
  ONECLI_URL: 'http://localhost:10254',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({
        isDirectory: () => false,
        mtimeMs: 0,
      })),
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/nanoclaw-test-groups/${folder}`,
  ),
  resolveGroupIpcPath: vi.fn(
    (folder: string) => `/tmp/nanoclaw-test-data/ipc/${folder}`,
  ),
}));

// Mock OneCLI SDK
vi.mock('@onecli-sh/sdk', () => {
  class MockOneCLI {
    getContainerConfig() {
      return Promise.resolve({ env: {}, caCertificate: null });
    }
  }
  return { OneCLI: MockOneCLI };
});

// Mock container-runner exports that direct-runner re-exports
vi.mock('./container-runner.js', () => ({
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.killed = false;
  proc.pid = 54321;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn to return our fake process
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    execSync: vi.fn(() => ''),
  };
});

import { runDirectAgent } from './direct-runner.js';
import type { ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('direct-runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves success when output marker received and process exits 0', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runDirectAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Direct mode response',
      newSessionId: 'session-direct-1',
    });

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-direct-1');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Direct mode response' }),
    );
  });

  it('resolves error when process exits non-zero', async () => {
    const resultPromise = runDirectAgent(testGroup, testInput, () => {});

    fakeProc.stderr.push('Something went wrong\n');
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('exited with code 1');
  });

  it('resolves error on timeout with no output', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runDirectAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Fire hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    fakeProc.emit('close', null);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });

  it('timeout after output resolves as success (idle cleanup)', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runDirectAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-idle',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Timeout fires after output was received
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', null);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-idle');
  });

  it('calls onProcess with the child process and name', async () => {
    const onProcess = vi.fn();
    const resultPromise = runDirectAgent(testGroup, testInput, onProcess);

    // Flush async setup (OneCLI getContainerConfig)
    await vi.advanceTimersByTimeAsync(0);

    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: null })}\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    expect(onProcess).toHaveBeenCalledTimes(1);
    expect(onProcess).toHaveBeenCalledWith(
      fakeProc,
      expect.stringContaining('nanoclaw-direct-test-group-'),
    );
  });

  it('handles spawn error gracefully', async () => {
    const resultPromise = runDirectAgent(testGroup, testInput, () => {});

    // Flush async setup (OneCLI getContainerConfig)
    await vi.advanceTimersByTimeAsync(0);

    fakeProc.emit('error', new Error('ENOENT: node not found'));
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Spawn error');
  });

  it('parses multiple streamed output markers', async () => {
    const outputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (o: ContainerOutput) => {
      outputs.push(o);
    });

    const resultPromise = runDirectAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit two output markers
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First response',
      newSessionId: 'session-multi',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second response',
    });

    await vi.advanceTimersByTimeAsync(10);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;

    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(outputs[0].result).toBe('First response');
    expect(outputs[1].result).toBe('Second response');
  });
});
