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

/**
 * Removes the lock at `path` only if it still holds `judged`, the content that was found stale.
 *
 * Node has no OS-managed lock (flock/LockFileEx) and no compare-and-delete, so a separate
 * "reaper" sentinel only moves the unlink race one level down. Instead the lock is renamed to a
 * unique tombstone: rename is atomic, so exactly one waiter takes a given file. Its content is
 * then compared with what was judged stale. Every acquisition writes a unique token, so equal
 * content means it really is the dead holder's lock, and the tombstone is deleted. If a live lock
 * was taken by mistake (it replaced the stale one after the judgement), it is put back with
 * linkSync, which never overwrites. Everything after the rename is synchronous, so the only
 * remaining window is the few microseconds in which a wrongly taken live lock is absent.
 */
export function reclaimStale(path: string, judged: string): void {
  const tombstone = `${path}.stale.${randomUUID()}`;
  try {
    renameSync(path, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // another waiter won
    throw error;
  }
  try {
    if (readFileSync(tombstone, 'utf8') !== judged) {
      try {
        linkSync(tombstone, path);
      } catch (error) {
        // EEXIST: a newer lock already took the name, so the wrongly taken one stays gone.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } finally {
    unlinkSync(tombstone);
  }
}

/** Creates the lock with its complete content or not at all, so it is never visible empty. */
function tryAcquire(path: string, content: string): boolean {
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
      if (judged !== undefined) reclaimStale(path, judged);
      else {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the agent-jobs lock');
        await sleep(30);
      }
      continue;
    }
    try {
      return await action();
    } finally {
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
      } catch {
        /* Never mask the action's result; a missing or foreign lock is not ours to remove. */
      }
    }
  }
}
