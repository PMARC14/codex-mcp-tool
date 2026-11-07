import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { reclaimStale, releaseOwned } from './lock.js';

interface Claim { owner: string; id: string; ts: number; timeoutMs: number }

/** Publish a complete claim atomically; an unexpired claim always wins over another asker. */
export function claimQuestion(dir: string, claim: Claim): boolean {
  const path = join(dir, 'question.lock');
  const temp = join(dir, `question-lock-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(claim), { flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { linkSync(temp, path); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      try {
        const raw = readFileSync(path, 'utf8');
        let expired: boolean;
        const old = (() => { try { return JSON.parse(raw) as Partial<Claim> | null; } catch { return null; } })();
        // Structurally invalid claims (garbage, `{}`, wrong types) fall back to the file's age.
        if (old && typeof old === 'object' && Number.isFinite(old.ts) && Number.isFinite(old.timeoutMs))
          expired = Date.now() >= old.ts! + old.timeoutMs!;
        else expired = Date.now() - statSync(path).mtimeMs >= 30 * 60 * 1000;
        if (!expired) return false;
        // 'busy' means another reclaimer is working: the claim stays held for this asker.
        if (reclaimStale(path, raw) === 'busy') return false;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return false;
  } finally { try { unlinkSync(temp); } catch { /* A temp file does not hold the claim. */ } }
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Releases the claim only if it is still ours (checked after an atomic rename, never from a
 * stale read). Transient Windows sharing violations are retried briefly and then swallowed: a
 * claim that cannot be removed expires on its own deadline and must never turn a delivered
 * answer into an error. Returns whether our claim was removed.
 */
export function releaseQuestion(dir: string, id: string): boolean {
  const path = join(dir, 'question.lock');
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return releaseOwned(path, raw => JSON.parse(raw).id === id); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) return false;
      pause(20 * (attempt + 1));
    }
  }
  return false;
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
