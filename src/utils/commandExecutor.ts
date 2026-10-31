import { startProcess } from '../jobs/proc.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Logger } from './logger.js';
import {
  resolveBinary,
  describeUnresolvedBinary,
  childEnvWithAugmentedPath,
  CODEX_PATH_ENV,
  BinaryResolution,
} from './binaryResolver.js';

export interface CommandResult {
  ok: boolean;
  code: number | null;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  partialStdout?: string;
}

export interface RetryOptions {
  attempts: number;
  backoffMs: number;
  retryOn: ('timeout' | 'exit_nonzero' | 'spawn_error')[];
}

export interface ExecuteOptions {
  onProgress?: (newOutput: string) => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
  retry?: RetryOptions;
  cwd?: string;
  /**
   * Written to the child's stdin, which is then closed. When omitted stdin is
   * `'ignore'`, so the child sees an immediate EOF and can never read this
   * process's stdin (the MCP stdio transport).
   */
  stdinInput?: string;
}

/**
 * A nonexistent `cwd` makes spawn fail with an ENOENT whose `path` and
 * `syscall` name the *command*, not the directory — indistinguishable from a
 * missing binary. Checking the directory up front is the only way to report
 * the real cause.
 */
function validateCwd(cwd: string): string | undefined {
  try {
    if (!statSync(cwd).isDirectory()) {
      return `Working directory is not a directory: ${cwd}`;
    }
  } catch {
    return (
      `Working directory does not exist: ${cwd}\n` +
      `Check the 'workingDir' argument and the CODEX_MCP_CWD environment variable ` +
      `in your MCP client configuration.`
    );
  }
  return undefined;
}

/**
 * Execute a command with streaming output and structured error handling
 */
export async function executeCommandDetailed(
  command: string,
  args: string[],
  options: ExecuteOptions = {}
): Promise<CommandResult> {
  const {
    onProgress,
    timeoutMs = 600000,
    maxOutputBytes = 50 * 1024 * 1024, // 50MB default
    retry,
    cwd,
    stdinInput,
  } = options;

  // Pre-flight checks. Both failures below would otherwise surface as an
  // identical, misleading "command not found" ENOENT — and neither is fixed by
  // retrying, so they short-circuit the retry loop.
  if (cwd) {
    const cwdError = validateCwd(cwd);
    if (cwdError) {
      Logger.error(cwdError);
      return { ok: false, code: null, stdout: '', stderr: cwdError, timedOut: false };
    }
  }

  // The override only applies to the Codex CLI itself; it must not redirect
  // some other command to the codex binary.
  const resolution = resolveBinary(command, command === 'codex' ? CODEX_PATH_ENV : undefined);
  if (!resolution.resolved) {
    const message = describeUnresolvedBinary(command, resolution, CODEX_PATH_ENV);
    Logger.error(message);
    return { ok: false, code: null, stdout: '', stderr: message, timedOut: false };
  }

  let attempt = 0;
  const maxAttempts = retry?.attempts || 1;

  while (attempt < maxAttempts) {
    attempt++;
    const result = await executeOnce(resolution, args, {
      onProgress,
      timeoutMs,
      maxOutputBytes,
      cwd,
      stdinInput,
    });

    if (result.ok) {
      return result;
    }

    const shouldRetry =
      retry &&
      ((result.timedOut && retry.retryOn.includes('timeout')) ||
        (result.code !== 0 && result.code !== null && retry.retryOn.includes('exit_nonzero')) ||
        (result.code === null && !result.signal && retry.retryOn.includes('spawn_error')));

    if (!shouldRetry || attempt >= maxAttempts) {
      return result;
    }

    // Exponential backoff
    const delay = retry.backoffMs * Math.pow(2, attempt - 1);
    Logger.warn(`Retrying command after ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  // This should never be reached
  throw new Error('Unexpected retry loop exit');
}

async function executeOnce(
  resolution: BinaryResolution,
  args: string[],
  { onProgress, timeoutMs, maxOutputBytes, cwd, stdinInput }: Omit<ExecuteOptions, 'retry'>
): Promise<CommandResult> {
  const startedAt = Date.now();
  Logger.commandExecution(resolution.command, args, startedAt);
  const directory = mkdtempSync(join(tmpdir(), 'codex-mcp-exec-'));
  const stdoutPath = join(directory, 'stdout');
  const stderrPath = join(directory, 'stderr');
  let timer: NodeJS.Timeout | undefined;
  let outputExceeded = false;
  let bytes = 0;
  let closed = false;
  let retain = false;
  const cleanup = () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      Logger.warn('Failed removing command output files', error);
    }
  };
  const running = startProcess({
    exe: resolution.command,
    args,
    stdin: stdinInput,
    env: childEnvWithAugmentedPath(),
    cwd: cwd ?? process.cwd(),
    stdout: stdoutPath,
    stderr: stderrPath,
    async onSpawn() {
      timer = setTimeout(() => void running.stop('timeout'), timeoutMs ?? 600000);
    },
    onSnapshot() {},
    onLine() {},
    onClosed() {
      closed = true;
      if (retain) cleanup();
    },
    onData(data, stream) {
      if (stream !== 'stdout') return;
      bytes += Buffer.byteLength(data);
      if (maxOutputBytes && bytes > maxOutputBytes) {
        outputExceeded = true;
        void running.stop();
      } else {
        onProgress?.(data);
      }
    },
  });
  try {
    const outcome = await running.done;
    clearTimeout(timer);
    retain = !!outcome.killFailed && !closed;
    const read = (path: string) => {
      try {
        return readFileSync(path)
          .subarray(0, maxOutputBytes ?? 50 * 1024 * 1024)
          .toString('utf8')
          .trim();
      } catch {
        return '';
      }
    };
    const stdout = read(stdoutPath);
    const stderr =
      outcome.error ||
      (outcome.killFailed
        ? 'kill-failed: process termination could not be confirmed'
        : read(stderrPath));
    const timedOut = outcome.kind === 'timeout';
    Logger.commandComplete(startedAt, outcome.code, stdout.length);
    return {
      ok: outcome.kind === 'exit' && outcome.code === 0 && !outputExceeded,
      code: outcome.code,
      signal: outcome.signal,
      stdout,
      stderr,
      timedOut,
      partialStdout: timedOut || outputExceeded ? stdout : undefined,
    };
  } finally {
    clearTimeout(timer);
    if (!retain) cleanup();
  }
}
/**
 * Backward compatible wrapper that returns stdout string
 */
export async function executeCommand(
  command: string,
  args: string[],
  onProgress?: (newOutput: string) => void,
  timeoutMs: number = 600000
): Promise<string> {
  const result = await executeCommandDetailed(command, args, {
    onProgress,
    timeoutMs,
  });

  if (!result.ok) {
    const errorMessage = result.stderr || 'Unknown error';
    throw new Error(
      result.timedOut
        ? `Command timed out after ${timeoutMs}ms`
        : `Command failed with exit code ${result.code}: ${errorMessage}`
    );
  }

  return result.stdout;
}
