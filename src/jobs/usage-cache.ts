import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite } from './store.js';
import { tryAcquireMutex, type MutexHandle } from './lock.js';
import { runCommand, systemBinary } from './proc.js';
import { usageIntervals } from './config.js';

export const USAGE_TTL_MS = 15 * 60 * 1000;
export const USAGE_BATTERY_TTL_MS = 30 * 60 * 1000;
/** A failed probe is not retried sooner than this (or the interval, whichever is longer). */
export const USAGE_BACKOFF_MS = 15 * 60 * 1000;
/** Never more than one probe per connector in this window, even for forced job-edge refreshes. */
export const MIN_PROBE_GAP_MS = 60 * 1000;
/** Power status is read at most this often (Windows needs a PowerShell start for it). */
export const POWER_TTL_MS = 10 * 60 * 1000;

export interface UsageProbe<T> {
  ok: boolean;
  raw: unknown;
  parsed: T | null;
}
export interface UsageSnapshot<T> extends UsageProbe<T> { takenAt: number }
export interface UsageCacheOptions {
  /** Defaults to AGENT_JOBS_HOME or ~/.agent-jobs. */
  home?: string;
  now?: () => number;
  onBattery?: boolean | (() => boolean | Promise<boolean>);
  /** Probe interval on AC / on battery; default from config (15 / 30 minutes). */
  ttlMs?: number;
  batteryTtlMs?: number;
  backoffMs?: number;
  /** Job edge (about to start / just stopped): probe now unless one ran in the last 60 s. */
  force?: boolean;
  /** Must exceed the probe's timeout; defaults to two minutes. */
  staleLockMs?: number;
}

function readSnapshot<T>(path: string): UsageSnapshot<T> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value && Number.isFinite(value.takenAt) && typeof value.ok === 'boolean' && 'raw' in value && 'parsed' in value) return value;
  } catch { /* Missing, partial or invalid cache is a miss. */ }
  return undefined;
}

async function systemOnBattery(): Promise<boolean> {
  if (process.platform === 'win32') {
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class UsagePower { [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out Status status); [StructLayout(LayoutKind.Sequential)] public struct Status { public byte AC, Flag, Percent, Saver; public uint Life, Full; } }'; $s = New-Object UsagePower+Status; if ([UsagePower]::GetSystemPowerStatus([ref]$s)) { $s.AC -eq 0 }`;
    return /^true$/i.test((await runCommand(systemBinary('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], undefined, 5000)).trim());
  }
  if (process.platform === 'darwin') return /Now drawing from 'Battery Power'/i.test(await runCommand('pmset', ['-g', 'batt'], undefined, 5000));
  return readdirSync('/sys/class/power_supply').some(name => {
    try { return readFileSync(join('/sys/class/power_supply', name, 'status'), 'utf8').trim() === 'Discharging'; }
    catch { return false; }
  });
}

async function onBattery(opts: UsageCacheOptions): Promise<boolean> {
  if (typeof opts.onBattery === 'boolean') return opts.onBattery;
  // Even power detection is shared: Windows needs a short native power-status
  // query, never a CLI authentication or quota probe. Don't launch it per reader.
  const power = await getUsage('machine-power', async () => {
    const battery = typeof opts.onBattery === 'function' ? await opts.onBattery() : await systemOnBattery();
    return { ok: true, raw: battery, parsed: battery };
  }, { home: opts.home, now: opts.now, onBattery: false, ttlMs: POWER_TTL_MS });
  return power?.parsed === true;
}

/**
 * Shared snapshot and single probe per connector. Contending readers never wait:
 * they receive the last snapshot, even stale, or undefined on the first cache miss.
 * Probes should have a timeout shorter than staleLockMs. Failures retain the last
 * parsed value and back off; callers can distinguish it with ok/takenAt.
 */
export async function getUsage<T>(
  connector: string,
  probe: () => Promise<UsageProbe<T>>,
  opts: UsageCacheOptions = {}
): Promise<UsageSnapshot<T> | undefined> {
  if (!/^[a-zA-Z0-9_-]+$/.test(connector)) throw new Error('Invalid usage cache connector');
  const home = resolve(opts.home ?? process.env.AGENT_JOBS_HOME ?? join(homedir(), '.agent-jobs'));
  const dir = join(home, 'cache');
  const path = join(dir, `${connector}-usage.json`), lock = join(dir, `${connector}-usage.lock`);
  const now = opts.now ?? Date.now;
  const configured = usageIntervals();
  const ttl = opts.ttlMs ?? configured.intervalMs, backoff = opts.backoffMs ?? USAGE_BACKOFF_MS;
  const batteryTtl = Math.max(opts.batteryTtlMs ?? configured.batteryIntervalMs, ttl);
  const fresh = (value: UsageSnapshot<unknown> | undefined, limit: number) => value && now() >= value.takenAt && now() - value.takenAt < limit;
  let saved = readSnapshot<T>(path);
  const cachedBattery = () => {
    if (typeof opts.onBattery === 'boolean') return opts.onBattery;
    const power = readSnapshot<boolean>(join(dir, 'machine-power-usage.json'));
    return power?.ok === true && power.parsed === true && !!fresh(power, POWER_TTL_MS);
  };
  // Interval by power source; a failed probe waits the longer of that and the backoff.
  const snapshotFresh = (value: UsageSnapshot<T> | undefined) => {
    const interval = cachedBattery() ? batteryTtl : ttl;
    if (opts.force && !(value && fresh(value, MIN_PROBE_GAP_MS))) return false;
    if (opts.force) return true;
    return fresh(value, value?.ok === false ? Math.max(interval, backoff) : interval);
  };
  if (snapshotFresh(saved)) return saved;
  const token = randomUUID();
  let mutex: MutexHandle | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    try {
      const raw = readFileSync(lock, 'utf8');
      let ts = statSync(lock).mtimeMs;
      try { const record = JSON.parse(raw); if (Number.isFinite(record.ts)) ts = record.ts; } catch { /* partial claim */ }
      if (now() - ts < (opts.staleLockMs ?? 120000)) return readSnapshot<T>(path) ?? saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

    mutex = await tryAcquireMutex(lock, home);
    if (!mutex) return readSnapshot<T>(path) ?? saved;
    try { writeFileSync(lock, JSON.stringify({ token, ts: now() })); } catch {}

    saved = readSnapshot<T>(path) ?? saved;
    if (snapshotFresh(saved)) return saved;
    if (!opts.force && saved?.ok && fresh(saved, batteryTtl)) {
      try { if (await onBattery({ ...opts, home })) return saved; } catch { /* Power status unavailable: normal TTL. */ }
    }
    let result: UsageProbe<T>;
    try { result = await probe(); }
    catch (error) { result = { ok: false, raw: String((error as Error)?.message ?? error), parsed: saved?.parsed ?? null }; }
    const snapshot: UsageSnapshot<T> = { takenAt: now(), ok: result.ok, raw: result.raw ?? null, parsed: result.parsed ?? saved?.parsed ?? null };
    atomicWrite(path, JSON.stringify(snapshot));
    return snapshot;
  } catch { return saved; } // Cache/lock unavailable: fail open without an uncoordinated probe.
  finally {
    if (mutex) {
      try {
        if (existsSync(lock)) {
          try {
            if (JSON.parse(readFileSync(lock, 'utf8')).token === token) unlinkSync(lock);
          } catch { unlinkSync(lock); }
        }
      } catch {}
      await mutex.release();
    }
  }
}
