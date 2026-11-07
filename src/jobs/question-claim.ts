import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { reclaimStale } from './lock.js';

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
        let expired = false;
        try {
          const old = JSON.parse(raw) as Claim;
          expired = Number.isFinite(old.ts) && Number.isFinite(old.timeoutMs) && Date.now() >= old.ts + old.timeoutMs;
        } catch { expired = Date.now() - statSync(path).mtimeMs >= 30 * 60 * 1000; }
        if (!expired) return false;
        reclaimStale(path, raw);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return false;
  } finally { try { unlinkSync(temp); } catch { /* A temp file does not hold the claim. */ } }
}

export function releaseQuestion(dir: string, id: string): void {
  const path = join(dir, 'question.lock');
  try { if (JSON.parse(readFileSync(path, 'utf8')).id === id) unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
