import { closeSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import spawn from 'cross-spawn';

export interface UsageWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt: number;
  resetAtIso: string;
  resetIn: string;
}

export interface CodexUsage {
  available: boolean;
  reason?: string;
  plan?: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  rateLimitReached?: string | null;
  snapshotAt?: string;
  snapshotAgeSec?: number;
  meter?: string;
  /** live: asked codex app-server just now; session-log: last snapshot a Codex session wrote. */
  source?: 'live' | 'session-log';
  /** Free full-reset credits on the account (never spent automatically). */
  resetCreditsAvailable?: number;
}

const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 50;

function listSessionFiles(dir: string): { path: string; mtime: number }[] {
  const found: { path: string; mtime: number }[] = [];
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl'))
        try {
          found.push({ path, mtime: statSync(path).mtimeMs });
        } catch {
          /* file vanished */
        }
    }
  };
  walk(dir);
  return found.sort((a, b) => b.mtime - a.mtime);
}

function readTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function findLatestSnapshot(
  text: string
): { limits: Record<string, any>; timestamp?: number } | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const event = JSON.parse(lines[i]);
      const limits = event?.payload?.rate_limits ?? event?.rate_limits;
      if (limits?.primary && limits?.secondary) {
        const stamp = Date.parse(event.timestamp);
        return { limits, timestamp: Number.isNaN(stamp) ? undefined : stamp };
      }
    } catch {
      /* partial first line of the tail or malformed line */
    }
  }
  return undefined;
}

function resetIn(resetsAtSec: number, nowMs: number): string {
  const minutes = Math.floor((resetsAtSec * 1000 - nowMs) / 60000);
  if (minutes <= 0) return 'reset';
  return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function windowOf(raw: any, nowMs: number): UsageWindow {
  return {
    usedPercent: Number(raw.used_percent),
    windowMinutes: raw.window_minutes,
    resetsAt: Number(raw.resets_at),
    resetAtIso: new Date(Number(raw.resets_at) * 1000).toISOString(),
    resetIn: resetIn(Number(raw.resets_at), nowMs),
  };
}

const bar = (percent: number) => {
  const filled = Math.max(0, Math.min(20, Math.floor(percent / 5)));
  return '#'.repeat(filled) + '.'.repeat(20 - filled);
};

function usageFromLimits(limits: Record<string, any>, at: number, nowMs: number): CodexUsage {
  const fiveHour = windowOf(limits.primary, nowMs);
  const weekly = windowOf(limits.secondary, nowMs);
  const line = (label: string, w: UsageWindow) =>
    `${label.padEnd(7)} [${bar(w.usedPercent)}] ${String(w.usedPercent).padStart(5)}%  resets ${w.resetIn === 'reset' ? '(window has reset since)' : `${w.resetAtIso} (${w.resetIn})`}`;
  return {
    available: true,
    plan: limits.plan_type ?? undefined,
    fiveHour,
    weekly,
    rateLimitReached: limits.rate_limit_reached_type ?? null,
    snapshotAt: new Date(at).toISOString(),
    snapshotAgeSec: Math.max(0, Math.round((nowMs - at) / 1000)),
    meter: `codex 5h ${fiveHour.usedPercent}% · wk ${weekly.usedPercent}%
${line('5-hour', fiveHour)}
${line('weekly', weekly)}`,
  };
}

/** Maps a live `account/rateLimits/read` reply (camelCase) onto the usage shape; undefined if it has no windows. */
export function fromAppServer(result: any, nowMs = Date.now()): CodexUsage | undefined {
  const rl = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!rl?.primary || !rl?.secondary) return undefined;
  const win = (w: any) => ({ used_percent: w.usedPercent, window_minutes: w.windowDurationMins, resets_at: w.resetsAt });
  const usage = usageFromLimits(
    { plan_type: rl.planType, primary: win(rl.primary), secondary: win(rl.secondary), rate_limit_reached_type: rl.rateLimitReachedType },
    nowMs,
    nowMs
  );
  const credits = result?.rateLimitResetCredits?.credits;
  return {
    ...usage,
    source: 'live',
    resetCreditsAvailable: Array.isArray(credits) ? credits.filter((c: any) => c?.status === 'available').length : undefined,
  };
}

/**
 * Asks a short-lived `codex app-server` for `account/rateLimits/read`: live, no
 * model turn, no quota spent. Hidden window; resolves undefined on any failure.
 */
export function readLiveCodexUsage(exe = 'codex', timeoutMs = 20000): Promise<CodexUsage | undefined> {
  return new Promise(resolveUsage => {
    let done = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (usage?: CodexUsage) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      resolveUsage(usage);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      child = spawn(exe, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return finish();
    }
    child.on('error', () => finish());
    child.stdin?.on('error', () => undefined);
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          child?.stdin?.write(JSON.stringify({ method: 'initialized' }) + '\n');
          child?.stdin?.write(JSON.stringify({ method: 'account/rateLimits/read', id: 2 }) + '\n');
        } else if (msg.id === 2) {
          finish(msg.result ? fromAppServer(msg.result) : undefined);
        }
      }
    });
    child.stdin?.write(
      JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'codex-mcp-tool', title: 'codex-mcp-tool', version: '1' } } }) + '\n'
    );
  });
}

/** Reads the newest rate_limits snapshot from Codex session logs. Local files only. */
export function readCodexUsage(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now()
): CodexUsage {
  const dir = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const files = listSessionFiles(dir).slice(0, MAX_FILES);
  for (const file of files) {
    let snapshot;
    try {
      snapshot = findLatestSnapshot(readTail(file.path));
    } catch {
      continue;
    }
    if (!snapshot) continue;
    return { ...usageFromLimits(snapshot.limits, snapshot.timestamp ?? file.mtime, nowMs), source: 'session-log' };
  }
  return { available: false, reason: `no Codex usage snapshot found under ${dir}` };
}
