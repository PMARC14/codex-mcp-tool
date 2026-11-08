import spawn from 'cross-spawn';
import { spawnStats } from './spawn-stats.js';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, writeSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { JobEvent, Owner } from './connector.js';
import { updateStdin, type ApprovalDecision, type SteerResult, type StdinPlan } from './stdin.js';
import { jobWrapper } from './jobobject.js';

/** stdin write errors that only mean the child stopped reading (EOF is the Windows form of EPIPE). */
const CLOSED_PIPE_CODES = new Set(['EPIPE', 'EOF', 'ECONNRESET']);
// After stdin closes or the child exits, wait this long for the pipes to close. A worker's own
// background processes can keep the child alive or hold its pipes open; then the tree is killed.
export const closeGrace = { ms: 15_000 };

export function resolveCommand(exe: string, args: string[]): { exe: string; args: string[] } {
  if (/\.(cmd|bat)$/i.test(exe)) {
    const shim = readFileSync(exe, 'utf8');
    const target = /["']%(?:~dp0|dp0%)[\\/]?([^"'\r\n]+\.(?:c?js|mjs))["']/i.exec(shim)?.[1];
    if (!target)
      throw new Error(
        `Cannot resolve npm shim ${exe} to JavaScript; set the CLI path to its executable`
      );
    return {
      exe: process.execPath,
      args: [resolve(dirname(exe), target.replace(/\\/g, '/')), ...args],
    };
  }
  if (/\.(?:c?js|mjs)$/i.test(exe)) return { exe: process.execPath, args: [exe, ...args] };
  try {
    const fd = openSync(exe, 'r');
    const bytes = Buffer.alloc(150);
    let length: number;
    try {
      length = readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      closeSync(fd);
    }
    const header = bytes.subarray(0, length).toString();
    if (/^#!.*\bnode\b/.test(header)) return { exe: process.execPath, args: [exe, ...args] };
  } catch {
    /* PATH commands and missing binaries are handled by spawn. */
  }
  return { exe, args };
}

export function spawnOptions(platform = process.platform): SpawnOptions {
  return { windowsHide: true, shell: false, ...(platform === 'win32' ? {} : { detached: true }) };
}

/**
 * Final spawn options. Windows Terminal is the default terminal, so any console program that gets
 * a new console shows up as a tab: always windowsHide, never a shell, and never `detached` on
 * Windows (a detached console process allocates its own console).
 */
export function finalSpawnOptions(options: SpawnOptions, platform = process.platform): SpawnOptions {
  const result: SpawnOptions = { ...spawnOptions(platform), ...options, windowsHide: true, shell: false };
  if (platform === 'win32') delete result.detached;
  return result;
}

export function safeSpawn(exe: string, args: string[], options: SpawnOptions, wrapJob = true): ChildProcess {
  if (process.platform === 'win32') {
    if (!isAbsolute(exe) && !/[\\/]/.test(exe)) {
      const env = options.env ?? process.env;
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
      const extensions = /\.[a-z0-9]+$/i.test(exe) ? [''] : ['.exe', '.com', '.cmd', '.bat', ''];
      let found: string | undefined;
      for (const directory of (env[pathKey ?? 'PATH'] ?? '').split(delimiter)) {
        if (!directory) continue;
        for (const extension of extensions) {
          const candidate = resolve(directory.replace(/^"|"$/g, ''), `${exe}${extension}`);
          try {
            if (statSync(candidate).isFile()) {
              found = candidate;
              break;
            }
          } catch {
            /* Next PATH entry. */
          }
        }
        if (found) break;
      }
      if (!found)
        throw Object.assign(new Error(`Executable not found in PATH: ${exe}`), { code: 'ENOENT' });
      exe = found;
    } else if (!isAbsolute(exe)) exe = resolve(options.cwd?.toString() ?? process.cwd(), exe);
  }
  const command = resolveCommand(exe, args);
  if (process.platform === 'win32' && !/\.(?:exe|com)$/i.test(command.exe)) {
    throw new Error(
      `Refusing to run ${command.exe} through cmd.exe; use a native executable or JavaScript target`
    );
  }
  const spawnArgs = finalSpawnOptions(options);
  if (process.platform === 'win32') {
    // Missing targets must fail before cross-spawn's Windows shell fallback.
    if (!statSync(command.exe).isFile()) throw new Error(`Not an executable file: ${command.exe}`);
    if (options.cwd && !statSync(options.cwd).isDirectory())
      throw new Error(`Not a working directory: ${options.cwd}`);
  }
  spawnStats.count++;
  const wrapper = wrapJob ? jobWrapper() : undefined;
  if (wrapper) spawnStats.viaLauncher++;
  return wrapper
    ? spawn(wrapper, [command.exe, ...command.args], spawnArgs)
    : spawn(command.exe, command.args, spawnArgs);
}

/** Raw stdout bytes; callers that need exact content (patches) must not go through a string. */
export function runCommandBuffer(
  exe: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30000
): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    // Short-lived checks (--version, usage, power, git) also go through the launcher on Windows:
    // it creates the child with CREATE_NO_WINDOW, so no console tab appears even when this server
    // has no console of its own (Windows Terminal as the default terminal).
    const child = safeSpawn(exe, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }, process.platform === 'win32');
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${exe} timed out`));
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout?.on('data', (data: Buffer) => {
      stdout.push(data);
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr.push(data);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolveResult(Buffer.concat(stdout));
      else
        reject(
          new Error(
            `${exe} exited ${code}: ${Buffer.concat(stderr).toString('utf8') || Buffer.concat(stdout).toString('utf8')}`
          )
        );
    });
  });
}

export async function runCommand(
  exe: string,
  args: string[],
  cwd?: string,
  timeoutMs = 30000
): Promise<string> {
  return (await runCommandBuffer(exe, args, cwd, timeoutMs)).toString('utf8').trimEnd();
}

export function systemBinary(name: string): string {
  if (process.platform !== 'win32') return name;
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  return name === 'powershell.exe'
    ? join(system, 'WindowsPowerShell', 'v1.0', name)
    : join(system, name);
}

const powershell = (script: string) =>
  runCommand(
    systemBinary('powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    undefined,
    15000
  );

export async function processStartTime(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid < 1) return undefined;
  try {
    process.kill(pid, 0);
    if (process.platform === 'win32') {
      return (
        await powershell(
          `$ErrorActionPreference='Stop'; [math]::Floor((Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks / 10000).ToString('0')`
        )
      ).trim();
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    return (await runCommand('ps', ['-p', String(pid), '-o', 'lstart='])).trim() || undefined;
  } catch {
    return undefined;
  }
}

let ownerPromise: Promise<Owner> | undefined;
export function currentOwner(): Promise<Owner> {
  return (ownerPromise ??= processStartTime(process.pid).then(startTime => {
    if (!startTime) throw new Error('Cannot determine server process start time');
    return { pid: process.pid, startTime };
  }));
}

export async function isAlive(owner: Owner): Promise<boolean> {
  if (owner.pid === process.pid && ownerPromise)
    return owner.startTime === (await ownerPromise).startTime;
  return !!owner.startTime && (await processStartTime(owner.pid)) === owner.startTime;
}

// Liveness for lock/recovery decisions is conservative when inspection is denied.
// Killing uses isAlive instead, which requires a verified start-time match.
export async function ownerAlive(owner: Owner): Promise<boolean> {
  if (owner.startTime && owner.pid === process.pid && ownerPromise)
    return owner.startTime === (await ownerPromise).startTime;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    startTimeCache.delete(owner.pid);
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (!owner.startTime) return true;
  const startTime = await cachedStartTime(owner.pid);
  return startTime === undefined || startTime === owner.startTime;
}

// The job pump asks about the same few owners every 500 ms, and on Windows each fresh lookup
// starts a powershell.exe. ownerAlive is the conservative check, so a recently seen start time
// is good enough there: a PID reused inside the TTL only delays orphan recovery until it expires.
// isAlive (used before killing) never takes this shortcut.
export const START_TIME_TTL_MS = 60_000;
/** Test hook: how many owner start times are cached. */
export const startTimeCacheSize = () => startTimeCache.size;
const startTimeCache = new Map<number, { value: string | undefined; at: number }>();

async function cachedStartTime(pid: number): Promise<string | undefined> {
  const hit = startTimeCache.get(pid);
  if (hit && Date.now() - hit.at < START_TIME_TTL_MS) return hit.value;
  const value = await processStartTime(pid);
  startTimeCache.set(pid, { value, at: Date.now() });
  if (startTimeCache.size > 256)
    for (const [key, entry] of startTimeCache)
      if (Date.now() - entry.at >= START_TIME_TTL_MS) startTimeCache.delete(key);
  return value;
}

async function processRows(): Promise<ProcessRow[]> {
  const raw = await powershell(
    `@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='Start';e={[math]::Floor($_.CreationDate.ToUniversalTime().Ticks / 10000).ToString('0')}}) | ConvertTo-Json -Compress`
  );
  return JSON.parse(raw || '[]') as ProcessRow[];
}

export async function descendants(root: Owner, known: Owner[] = []): Promise<Owner[]> {
  if (process.platform !== 'win32') return [];
  return snapshotDescendants(await processRows(), root, known);
}

/** Identities that are alive in one snapshot: same PID and same start time. */
export function liveIn(rows: ProcessRow[], identities: Owner[]): Owner[] {
  const byPid = new Map(rows.map(row => [row.ProcessId, row]));
  return identities.filter(identity => !!identity.startTime && byPid.get(identity.pid)?.Start === identity.startTime);
}

export interface ProcessRow {
  ProcessId: number;
  ParentProcessId: number;
  Start: string;
}

/**
 * Pure tree walk over one process snapshot. An orphan keeps its dead parent's PID, and Windows
 * may hand that PID to a newer process, so an edge is only trusted when the child did not
 * start before its parent.
 */
export function snapshotDescendants(rows: ProcessRow[], root: Owner, known: Owner[] = []): Owner[] {
  const byPid = new Map(rows.map(row => [row.ProcessId, row]));
  const parents = new Map(
    [root, ...known].filter(p => p.startTime && (!byPid.has(p.pid) || byPid.get(p.pid)?.Start === p.startTime)).map(p => [p.pid, p.startTime])
  );
  const found = new Map(known.map(p => [p.pid, p]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!parents.has(row.ParentProcessId) || parents.has(row.ProcessId)) continue;
      if (Number(row.Start) < Number(parents.get(row.ParentProcessId)!)) continue;
      parents.set(row.ProcessId, row.Start);
      found.set(row.ProcessId, { pid: row.ProcessId, startTime: row.Start });
      changed = true;
    }
  }
  // Dead entries still serve as parents above (orphans keep their dead parent's PID), but are
  // not kept: a long job spawns hundreds of short-lived test processes.
  return [...found.values()].filter(p => !byPid.has(p.pid) ? false : byPid.get(p.pid)!.Start === p.startTime);
}

export async function killTree(root?: Owner, recorded: Owner[] = [], child?: ChildProcess): Promise<void> {
  if (process.platform === 'win32') {
    // One snapshot, one batched taskkill, one re-check: per-PID probes cannot finish inside the
    // 10 second cancel deadline once a job has recorded hundreds of descendants.
    const rows = await processRows().catch(() => undefined);
    const all = [...(root ? [root] : []), ...(rows && root ? snapshotDescendants(rows, root, recorded) : recorded)];
    // Only a still-live child handle authorizes PID-based termination without a start time.
    // Persisted empty identities alone must never authorize killing a possibly reused PID.
    const heldChild = !!root && !root.startTime && child?.pid === root.pid && child.exitCode === null && child.signalCode === null;
    const targets = rows ? liveIn(rows, all) : (await Promise.all(all.map(async identity => (await isAlive(identity)) ? identity : undefined))).filter((x): x is Owner => !!x);
    const handleLive = !!child && child.pid === root?.pid && child.exitCode === null && child.signalCode === null;
    // A snapshot can miss the root; a live handle plus a verified start time still authorizes it.
    if (root && !targets.includes(root) && (heldChild || (handleLive && await isAlive(root)))) targets.unshift(root);
    for (let i = 0; i < targets.length; i += 40) {
      let batch = targets.slice(i, i + 40);
      // Earlier batches kill whole trees (/T), freeing PIDs that may be reused: re-check later ones.
      if (i > 0) {
        const now = await processRows().catch(() => undefined);
        if (!now) break;
        batch = liveIn(now, batch);
        if (!batch.length) continue;
      }
      await runCommand(systemBinary('taskkill.exe'), [...batch.flatMap(t => ['/PID', String(t.pid)]), '/T', '/F']).catch(() => {});
    }
    if (heldChild) child!.kill();
    if (!targets.length) return;
    const after = await processRows().catch(() => undefined);
    const survivors = after ? liveIn(after, targets.filter(t => t.startTime)) : (await Promise.all(targets.map(ownerAlive))).some(Boolean) ? targets : [];
    if (survivors.length || (heldChild && child!.exitCode === null && child!.signalCode === null && after?.some(row => row.ProcessId === root!.pid)))
      throw new Error('kill-failed: processes in the tree are still alive');
    return;
  }
  if (!root?.startTime) { child?.kill(); return; }
  await killProcessGroup(root);
}

export interface GroupKillDeps {
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  startTime(pid: number): Promise<string | undefined>;
  graceMs: number;
  killWaitMs: number;
  pollMs: number;
}

// Grace plus the post-SIGKILL wait stays inside the 10 second cancel deadline in startProcess.
const groupKillDeps: GroupKillDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  startTime: processStartTime,
  graceMs: 5000,
  killWaitMs: 4000,
  pollMs: 50,
};

/** POSIX tree kill by process group, injectable so it is unit-tested on every platform. */
export async function killProcessGroup(root: Owner, deps = groupKillDeps): Promise<void> {
  const current = await deps.startTime(root.pid);
  if (current && current !== root.startTime) return;
  try {
    deps.kill(-root.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  const groupAlive = () => {
    try {
      deps.kill(-root.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const wait = async (ms: number) => {
    const limit = Date.now() + ms;
    while (groupAlive() && Date.now() < limit)
      await new Promise(resolveWait => setTimeout(resolveWait, deps.pollMs));
  };
  await wait(deps.graceMs);
  if (!groupAlive()) return;
  const identity = await deps.startTime(root.pid);
  if (identity && identity !== root.startTime) return;
  try {
    deps.kill(-root.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  // The root may be gone while a descendant keeps the group alive, so confirm the group itself.
  await wait(deps.killWaitMs);
  if (groupAlive()) throw new Error('kill-failed: process group is still alive after SIGKILL');
}

export interface ProcessOutcome {
  kind: 'exit' | 'cancel' | 'timeout' | 'error';
  code: number | null;
  error?: string;
  killFailed?: boolean;
  signal?: NodeJS.Signals;
}

export interface RunningProcess {
  done: Promise<ProcessOutcome>;
  steer?: (message: string) => Promise<SteerResult>;
  respond?: (decision: ApprovalDecision) => void;
  stop(reason?: 'cancel' | 'timeout'): Promise<ProcessOutcome>;
}

export function startProcess(options: {
  exe: string;
  args: string[];
  stdin?: string;
  stdinPlan?: StdinPlan;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdout: string;
  stderr: string;
  onSpawn(identity: Owner): Promise<void>;
  onSnapshot(identities: Owner[]): void;
  onLine(line: string, stream: 'stdout' | 'stderr'): void;
  onEvent?(event: JobEvent): void;
  onClosed?(): void;
  onData?(data: string, stream: 'stdout' | 'stderr'): void;
}): RunningProcess {
  let child!: ChildProcess;
  let root: Owner | undefined;
  let children: Owner[] = [];
  let outcome: ProcessOutcome | undefined;
  let closed = false;
  let snapshot: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let spawnReady: Promise<void> = Promise.resolve();
  let setupError: string | undefined;
  let termination: Promise<void> | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let completing = false;
  let spawned!: () => void;
  const spawnEvent = new Promise<void>(resolveSpawn => {
    spawned = resolveSpawn;
  });
  let finish!: (outcome: ProcessOutcome) => void;
  const done = new Promise<ProcessOutcome>(resolveResult => {
    finish = resolveResult;
  });
  const fds: number[] = [];
  const buffers = { stdout: '', stderr: '' };
  const inputHandler = options.stdinPlan?.({
    apply: action => { updateStdin(child?.stdin, action); if (action.close) armGrace(); },
    emit: event => options.onEvent?.(event),
  });
  const onLine = (line: string, stream: 'stdout' | 'stderr') => {
    const action = inputHandler?.(line, stream);
    if (action) { updateStdin(child.stdin, action); if (action.close) armGrace(); }
    options.onLine(line, stream);
  };
  function armGrace() {
    if (graceTimer || closed) return;
    graceTimer = setTimeout(() => {
      if (closed) return;
      // The work is done; only stragglers remain. Finish as a clean exit, then clean up the tree.
      claim({ kind: 'exit', code: child?.exitCode ?? 0 });
      beginTermination();
      void termination?.finally(() => {
        if (closed) return;
        for (const stream of ['stdout', 'stderr'] as const) child?.[stream]?.destroy();
        void complete();
      });
    }, closeGrace.ms);
    graceTimer.unref?.();
  }
  const claim = (value: ProcessOutcome) => {
    outcome ??= value;
  };
  const beginTermination = () => {
    try { updateStdin(child?.stdin, { close: true }); } catch { /* Continue cleanup. */ }
    termination ??= spawnEvent
      .then(() => spawnReady)
      .then(async () => {
        if (process.platform === 'win32' && root) {
          children = await descendants(root, children).catch(() => children);
          try {
            options.onSnapshot(children);
          } catch {
            /* Continue killing if persistence fails. */
          }
        }
        await killTree(root, children, child);
      })
      .catch(() => {
        if (outcome) outcome.killFailed = true;
      });
  };
  const complete = async () => {
    if (completing) return;
    completing = true;
    clearTimeout(graceTimer);
    try { updateStdin(child?.stdin, { close: true }); } catch { /* Child has exited. */ }
    closed = true;
    inputHandler?.dispose?.();
    clearInterval(snapshot);
    await spawnReady;
    await termination;
    clearTimeout(killTimer);
    try {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (buffers[stream]) onLine(buffers[stream], stream);
      }
    } catch (error) {
      setupError = String(error);
      claim({ kind: 'error', code: null, error: String(error) });
    }
    for (const fd of fds.splice(0)) closeSync(fd);
    if (setupError && outcome?.kind === 'exit')
      outcome = { ...outcome, kind: 'error', error: setupError };
    finish(outcome ?? { kind: 'error', code: null, error: 'Process closed without exit status' });
    options.onClosed?.();
  };
  try {
    fds.push(openSync(options.stdout, 'a'));
    fds.push(openSync(options.stderr, 'a'));
    child = safeSpawn(options.exe, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    }, true);
    child.once('close', () => {
      void complete();
    });
    child.on('error', error => {
      spawned();
      claim({ kind: 'error', code: null, error: error.message });
    });
    child.stdin?.on('error', error => {
      // A child that exits without reading all of stdin is normal. POSIX reports
      // EPIPE; Windows reports EOF (or ECONNRESET), so all three are benign.
      if (!CLOSED_PIPE_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
        setupError = error.message;
        claim({ kind: 'error', code: null, error: error.message });
        beginTermination();
      }
    });
    child.once('spawn', () => {
      spawnReady = (async () => {
        let startTime = await processStartTime(child.pid!);
        if (!startTime && child.exitCode === null && child.signalCode === null)
          startTime = await processStartTime(child.pid!);
        root = { pid: child.pid!, startTime: startTime ?? '' };
        await options.onSpawn(root);
        if (process.platform === 'win32' && !closed) {
          const takeSnapshot = async () => {
            try {
              children = await descendants(root!, children);
            } catch {
              return;
            }
            if (!closed) {
              try {
                options.onSnapshot(children);
              } catch (error) {
                setupError = String(error);
                claim({ kind: 'error', code: null, error: setupError });
                beginTermination();
              }
            }
          };
          void takeSnapshot();
          snapshot = setInterval(() => void takeSnapshot(), 10000);
          snapshot.unref();
        }
      })().catch(async error => {
        setupError = String(error);
        claim({ kind: 'error', code: null, error: String(error) });
        await killTree(root, children, child).catch(() => {
          if (outcome) outcome.killFailed = true;
        });
      });
      spawned();
    });
    for (const [index, stream] of (['stdout', 'stderr'] as const).entries()) {
      child[stream]?.setEncoding('utf8');
      child[stream]?.on('error', error => {
        setupError = error.message;
        claim({ kind: 'error', code: null, error: setupError });
        beginTermination();
      });
      child[stream]?.on('data', (data: string) => {
        try {
          writeSync(fds[index], data);
          options.onData?.(data, stream);
          buffers[stream] += data;
          let newline: number;
          while ((newline = buffers[stream].indexOf('\n')) >= 0) {
            onLine(buffers[stream].slice(0, newline).replace(/\r$/, ''), stream);
            buffers[stream] = buffers[stream].slice(newline + 1);
          }
        } catch (error) {
          setupError = String(error);
          claim({ kind: 'error', code: null, error: String(error) });
          beginTermination();
        }
      });
    }
    child.once('exit', (code, signal) => {
      claim({ kind: 'exit', code, signal: signal ?? undefined });
      armGrace();
    });
    if (options.stdin !== undefined) {
      if (inputHandler) updateStdin(child.stdin, { write: options.stdin });
      else child.stdin?.end(options.stdin, 'utf8');
    }
  } catch (error) {
    setupError = String(error);
    claim({ kind: 'error', code: null, error: String(error) });
    if (child) beginTermination();
    else {
      spawned();
      void complete();
    }
  }

  return {
    done,
    ...(inputHandler?.onSteer ? { steer: async (message: string) => {
      if (closed || outcome || !child?.stdin?.writable || child.stdin.writableEnded)
        throw new Error('Job input has closed; use agent_message after it stops');
      const action = await inputHandler.onSteer!(message);
      updateStdin(child.stdin, action);
      return action;
    } } : {}),
    ...(inputHandler?.onRespond ? { respond: (decision: ApprovalDecision) => {
      if (closed || outcome || !child?.stdin?.writable || child.stdin.writableEnded)
        throw new Error('Job input has closed');
      updateStdin(child.stdin, inputHandler.onRespond!(decision));
    } } : {}),
    async stop(reason = 'cancel') {
      if (closed) return done;
      claim({ kind: reason, code: null });
      if (reason === 'cancel' && inputHandler?.onInterrupt) {
        try { const action = inputHandler.onInterrupt(); if (action) updateStdin(child.stdin, action); }
        catch { /* Continue with process-tree cleanup. */ }
        let interruptTimer: NodeJS.Timeout | undefined;
        await Promise.race([done, new Promise<void>(resolve => { interruptTimer = setTimeout(resolve, 3000); })]);
        clearTimeout(interruptTimer);
      }
      if (!closed) {
        // Give tree cleanup its full budget after the cooperative interrupt grace.
        killTimer ??= setTimeout(() => {
          finish({ ...outcome!, killFailed: true });
        }, 10000);
        beginTermination();
      }
      return done;
    },
  };
}
