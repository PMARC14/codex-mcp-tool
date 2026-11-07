import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import net from 'node:net';
import type { Owner } from './connector.js';
import { currentOwner, ownerAlive } from './proc.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface MutexHandle {
  address: string;
  release: () => Promise<void>;
}

/** Test seams for forcing the interleavings of two processes inside one. Never set in production. */
export const lockTestHooks: {
  beforeReread?: () => void;
  afterReread?: () => void;
  afterTombstone?: () => void;
  beforeRelease?: () => void;
} = {};

/**
 * Returns the OS-managed mutex address for a given key or lock path.
 * - Windows: named pipe `\\.\pipe\agent-jobs-<sha8>`
 * - Linux: abstract namespace Unix domain socket `\0agent-jobs-<sha8>`
 * - macOS: socket file under the jobs home
 */
export function mutexAddress(key: string, home?: string): string {
  const sha8 = createHash('sha256').update(key).digest('hex').slice(0, 8);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agent-jobs-${sha8}`;
  }
  if (process.platform === 'linux') {
    return `\0agent-jobs-${sha8}`;
  }
  const baseDir = home ?? (key.includes('/') || key.includes('\\') ? dirname(key) : join(homedir(), '.agent-jobs'));
  return join(baseDir, `.agent-jobs-${sha8}.sock`);
}

async function checkSocketLiveness(sockPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(sockPath);
    socket.once('connect', () => {
      socket.end();
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

/**
 * Attempts to acquire an OS-managed mutex immediately.
 * Returns a MutexHandle if acquired, or null if already held.
 */
export async function tryAcquireMutex(key: string, home?: string): Promise<MutexHandle | null> {
  const address = mutexAddress(key, home);
  const isFileSocket = process.platform !== 'win32' && !address.startsWith('\0');

  if (isFileSocket) {
    try {
      mkdirSync(dirname(address), { recursive: true });
    } catch {}
  }

  return new Promise(resolve => {
    const server = net.createServer(socket => {
      socket.end();
      socket.destroy();
    });
    server.unref();

    let settled = false;
    const cleanup = () => {
      server.removeAllListeners();
    };

    server.once('error', async (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        server.close();
      } catch {}

      if (error.code === 'EADDRINUSE' && isFileSocket) {
        // macOS: connection refused means stale holder, unlink and retry
        const alive = await checkSocketLiveness(address);
        if (!alive) {
          try {
            unlinkSync(address);
          } catch {}
        }
      }
      resolve(null);
    });

    server.listen(address, () => {
      if (settled) return;
      settled = true;
      cleanup();

      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        await new Promise<void>(r => {
          server.close(() => {
            if (isFileSocket) {
              try {
                unlinkSync(address);
              } catch {}
            }
            r();
          });
        });
      };

      resolve({ address, release });
    });
  });
}

/**
 * Synchronous attempt to acquire an OS-managed mutex for callers that cannot await.
 */
export function tryAcquireMutexSync(key: string, home?: string): MutexHandle | null {
  const address = mutexAddress(key, home);
  const isFileSocket = process.platform !== 'win32' && !address.startsWith('\0');

  if (isFileSocket) {
    try {
      mkdirSync(dirname(address), { recursive: true });
    } catch {}
  }

  const server = net.createServer(socket => {
    socket.end();
    socket.destroy();
  });
  server.unref();
  server.on('error', () => {});
  server.listen(address);

  if (server.listening) {
    let released = false;
    return {
      address,
      release: async () => {
        if (released) return;
        released = true;
        await new Promise<void>(r => {
          server.close(() => {
            if (isFileSocket) {
              try {
                unlinkSync(address);
              } catch {}
            }
            r();
          });
        });
      },
    };
  }

  return null;
}

/**
 * Acquires the OS-managed mutex, retrying with backoff up to timeoutMs.
 */
export async function acquireMutex(
  key: string,
  options: { timeoutMs?: number; home?: string } = {}
): Promise<MutexHandle> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let delay = 5;

  while (true) {
    const handle = await tryAcquireMutex(key, options.home);
    if (handle) return handle;

    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the agent-jobs lock');
    }

    await sleep(Math.min(delay, 50));
    delay = Math.min(delay * 2, 50);
  }
}

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

const REAPER_STALE_MS = 10_000;

export function reclaimStale(path: string, judged: string): 'reclaimed' | 'changed' | 'busy' {
  const reaper = `${path}.reaper`;
  try {
    writeFileSync(reaper, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(reaper).mtimeMs > REAPER_STALE_MS) unlinkSync(reaper);
    } catch {}
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
    lockTestHooks.afterReread?.();
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
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    } finally {
      try {
        unlinkSync(tombstone);
      } catch {}
    }
    return result;
  } finally {
    try {
      unlinkSync(reaper);
    } catch {}
  }
}

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
  } catch {}
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
  } catch {}
  return ours;
}

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
    try {
      unlinkSync(temp);
    } catch {}
  }
}

const TEMP_FILE = /^lock\.[0-9a-f-]{36}\.tmp$/;
const STALE_TEMP_MS = 10 * 60 * 1000;

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
    } catch {}
  }
}

export async function withLock<T>(
  home: string,
  action: () => T | Promise<T>,
  timeoutMs = 60000
): Promise<T> {
  const path = join(home, 'lock');
  sweepStaleTemps(home);
  const mutex = await acquireMutex(path, { timeoutMs, home });
  const token = randomUUID();
  const content = JSON.stringify({ pid: process.pid, token, time: Date.now() });
  try {
    writeFileSync(path, content);
  } catch {}
  try {
    return await action();
  } finally {
    try {
      if (existsSync(path)) {
        try {
          if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
        } catch {
          unlinkSync(path);
        }
      }
    } catch {}
    finally {
      await mutex.release();
    }
  }
}
