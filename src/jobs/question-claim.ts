import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MutexHandle, tryAcquireMutexSync } from './lock.js';

interface Claim { owner: string; id: string; ts: number; timeoutMs: number }

const activeClaims = new Map<string, { id: string; mutex: MutexHandle }>();

/** Publish a complete claim while holding its mutex; a file without a mutex holder is stale. */
export function claimQuestion(dir: string, claim: Claim): boolean {
  const path = join(dir, 'question.lock');
  const active = activeClaims.get(dir);
  // A local timeout may release our own holder. Foreign holders must release their mutex themselves.
  if (active) {
    try {
      const raw = readFileSync(path, 'utf8');
      let expired: boolean;
      const old = (() => { try { return JSON.parse(raw) as Partial<Claim> | null; } catch { return null; } })();
      if (old && typeof old === 'object' && Number.isFinite(old.ts) && Number.isFinite(old.timeoutMs))
        expired = Date.now() >= old.ts! + old.timeoutMs!;
      else expired = Date.now() - statSync(path).mtimeMs >= 30 * 60 * 1000;
      if (expired) {
        void active.mutex.release();
        activeClaims.delete(dir);
      }
    } catch (error) {
      try {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && Date.now() - statSync(path).mtimeMs < 30 * 60 * 1000) return false;
      } catch { return false; }
      void active.mutex.release();
      activeClaims.delete(dir);
    }
  }

  // Try the OS mutex before trusting any file timestamp: a dead bridge can leave an unexpired claim.
  const mutex = tryAcquireMutexSync(path, dir);
  if (!mutex) return false;

  try {
    writeFileSync(path, JSON.stringify(claim));
    activeClaims.set(dir, { id: claim.id, mutex });
    return true;
  } catch {
    void mutex.release();
    return false;
  }
}

/**
 * Releases the claim only if it is still ours. Returns whether our claim was removed.
 */
export function releaseQuestion(dir: string, id: string): boolean {
  const path = join(dir, 'question.lock');
  let ours = false;
  try {
    const raw = readFileSync(path, 'utf8');
    ours = JSON.parse(raw).id === id;
  } catch {
    ours = false;
  }
  if (!ours) return false;

  try { unlinkSync(path); } catch {}
  const active = activeClaims.get(dir);
  if (active && active.id === id) {
    void active.mutex.release();
    activeClaims.delete(dir);
  }
  return true;
}

/** Errors worth retrying on the next poll tick (Windows scanners/indexers briefly hold files). */
export const TRANSIENT_FS_CODES = ['ENOENT', 'EBUSY', 'EPERM', 'EACCES'];

/**
 * The answer text if `answer-<qid>.json` exists and is readable, undefined if it is absent or
 * momentarily busy (retry next tick). Any other failure, including a malformed answer, throws.
 */
export function readAnswerFile(
  path: string,
  io: { stat: (p: string) => { isFile(): boolean }; read: (p: string) => string } = { stat: statSync, read: p => readFileSync(p, 'utf8') }
): string | undefined {
  try {
    if (!io.stat(path).isFile()) return undefined;
    const answer = JSON.parse(io.read(path));
    if (typeof answer.answer !== 'string') throw new Error('answer field must be a string');
    return answer.answer;
  } catch (error) {
    if (TRANSIENT_FS_CODES.includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}
