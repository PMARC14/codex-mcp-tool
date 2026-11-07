import { linkSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Owner } from './connector.js';
import { currentOwner, ownerAlive } from './proc.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The raw content of the lock when its owner is dead (or it is abandoned garbage), else undefined. */
async function staleContent(path: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const record = JSON.parse(raw) as Owner;
    if (!Number.isInteger(record.pid) || record.pid < 1 || typeof record.startTime !== 'string')
      throw new Error('Incomplete lock');
    const alive = await ownerAlive(record);
    return !alive && readFileSync(path, 'utf8') === raw ? raw : undefined;
  } catch {
    try {
      return Date.now() - statSync(path).mtimeMs > 30000 ? raw : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Test seams for forcing the interleavings of two processes inside one. Never set in production. */
export const lockTestHooks: { beforeReread?: () => void; afterTombstone?: () => void; beforeRelease?: () => void } = {};

const REAPER_STALE_MS = 10_000;

/**
 * Removes the lock at `path` only if it still holds `judged`, the content that was found stale.
 *
 * Node has no OS-managed lock (flock/LockFileEx) and no compare-and-delete. Three layers keep
 * exactly one owner anyway:
 *  1. Reclaimers are serialized by a short-lived `<path>.reaper` file created with `wx`, so two
 *     waiters that judged the same stale content cannot both act on it (one would otherwise
 *     rename away the fresh lock the other just acquired).
 *  2. Under the reaper the lock is re-read; if it no longer holds `judged`, someone else already
 *     replaced it and nothing is touched.
 *  3. The lock is then renamed to a unique tombstone (atomic) and the tombstone's content is
 *     checked against `judged`. A live lock taken by mistake is put back with linkSync, which
 *     never overwrites. Acquirers never remove locks, so the only remaining window is the few
 *     microseconds between the re-read and the rename, and only if the judged lock's owner
 *     released it and another process acquired a new one in exactly that gap.
 *
 * Returns 'reclaimed' (the stale lock is gone), 'changed' (it had already been replaced or
 * removed) or 'busy' (another reclaimer is working; treat the lock as held and retry later).
 */
export function reclaimStale(path: string, judged: string): 'reclaimed' | 'changed' | 'busy' {
  const reaper = `${path}.reaper`;
  try {
    writeFileSync(reaper, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(reaper).mtimeMs > REAPER_STALE_MS) unlinkSync(reaper); // crashed reaper
    } catch {
      /* gone already */
    }
    return 'busy';
  }
  try {
    lockTestHooks.beforeReread?.();
    let current: string;
    try {
      current = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'changed';
      throw error;
    }
    if (current !== judged) return 'changed';
    const tombstone = `${path}.stale.${randomUUID()}`;
    try {
      renameSync(path, tombstone);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'changed';
      throw error;
    }
    lockTestHooks.afterTombstone?.();
    let result: 'reclaimed' | 'changed' = 'reclaimed';
    try {
      if (readFileSync(tombstone, 'utf8') !== judged) {
        result = 'changed';
        try {
          linkSync(tombstone, path);
        } catch (error) {
          // EEXIST: a newer lock already took the name, so the wrongly taken one stays gone.
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    } finally {
      try {
        unlinkSync(tombstone);
      } catch {
        /* swept with the other temp files */
      }
    }
    return result;
  } finally {
    try {
      unlinkSync(reaper);
    } catch {
      /* already reclaimed as stale */
    }
  }
}

/**
 * Removes the lock at `path` only if `isMine(content)` holds. The lock is first renamed to a
 * unique name, so what is checked is exactly what is removed: a lock that someone else
 * acquired in the meantime is put back untouched instead of being unlinked by a stale read.
 * Returns true when our lock was removed. EBUSY/EPERM (Windows sharing violations) propagate
 * so the caller can retry.
 */
export function releaseOwned(path: string, isMine: (content: string) => boolean): boolean {
  lockTestHooks.beforeRelease?.();
  const mine = `${path}.rel.${randomUUID()}`;
  try {
    renameSync(path, mine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let content = '';
  try {
    content = readFileSync(mine, 'utf8');
  } catch {
    /* unreadable counts as not ours */
  }
  let ours = false;
  try {
    ours = isMine(content);
  } catch {
    ours = false;
  }
  if (!ours) {
    try {
      linkSync(mine, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  try {
    unlinkSync(mine);
  } catch {
    /* left for the sweep */
  }
  return ours;
}

/** Creates the lock with its complete content or not at all, so it is never visible empty. */
export function tryAcquire(path: string, content: string): boolean {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { flag: 'wx' });
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    // On Windows Defender can briefly hold the just-written file; a failed delete must not
    // replace the real outcome. withLock sweeps any temp file left behind.
    try {
      unlinkSync(temp);
    } catch {
      /* swept later */
    }
  }
}

const TEMP_FILE = /^lock\.[0-9a-f-]{36}\.tmp$/;
const STALE_TEMP_MS = 10 * 60 * 1000;

/** Deletes lock temp files older than STALE_TEMP_MS; a fresh one may still be in use. */
function sweepStaleTemps(home: string): void {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return;
  }
  for (const name of names) {
    if (!TEMP_FILE.test(name)) continue;
    const file = join(home, name);
    try {
      if (Date.now() - statSync(file).mtimeMs > STALE_TEMP_MS) unlinkSync(file);
    } catch {
      /* in use or already gone */
    }
  }
}

export async function withLock<T>(home: string, action: () => T | Promise<T>): Promise<T> {
  const path = join(home, 'lock');
  const owner = await currentOwner();
  const token = randomUUID();
  const content = JSON.stringify({ ...owner, token });
  const deadline = Date.now() + 60000;
  sweepStaleTemps(home);
  while (true) {
    if (!tryAcquire(path, content)) {
      const judged = await staleContent(path);
      if (judged !== undefined) {
        if (reclaimStale(path, judged) === 'busy') await sleep(30);
      } else {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the agent-jobs lock');
        await sleep(30);
      }
      continue;
    }
    try {
      return await action();
    } finally {
      try {
        releaseOwned(path, raw => JSON.parse(raw).token === token);
      } catch {
        /* Never mask the action's result; a missing or foreign lock is not ours to remove. */
      }
    }
  }
}
