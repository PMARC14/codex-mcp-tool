import { openSync, closeSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Owner } from './connector.js';
import { currentOwner, ownerAlive } from './proc.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function stale(path: string): Promise<boolean> {
  try {
    const raw = readFileSync(path, 'utf8');
    const record = JSON.parse(raw) as Owner;
    if (!Number.isInteger(record.pid) || record.pid < 1 || typeof record.startTime !== 'string')
      throw new Error('Incomplete lock');
    const alive = await ownerAlive(record);
    return !alive && readFileSync(path, 'utf8') === raw;
  } catch {
    try {
      return Date.now() - statSync(path).mtimeMs > 30000;
    } catch {
      return false;
    }
  }
}

export async function withLock<T>(home: string, action: () => T | Promise<T>): Promise<T> {
  const path = join(home, 'lock');
  const owner = await currentOwner();
  const token = randomUUID();
  const deadline = Date.now() + 60000;
  while (true) {
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await stale(path)) {
        // Serialize stale reclamation so two waiters cannot unlink a new lock.
        const reap = `${path}.reap`;
        let reaper: number | undefined;
        try {
          reaper = openSync(reap, 'wx');
          writeFileSync(reaper, JSON.stringify(owner));
          if (await stale(path)) unlinkSync(path);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'EEXIST' &&
            (error as NodeJS.ErrnoException).code !== 'ENOENT'
          )
            throw error;
          if (reaper === undefined && (await stale(reap))) {
            try {
              unlinkSync(reap);
            } catch {
              /* Another waiter reclaimed it. */
            }
          }
        } finally {
          if (reaper !== undefined) {
            closeSync(reaper);
            unlinkSync(reap);
          }
        }
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the agent-jobs lock');
      await sleep(30);
      continue;
    }
    try {
      writeFileSync(fd, JSON.stringify({ ...owner, token }));
      return await action();
    } finally {
      closeSync(fd);
      if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
    }
  }
}
