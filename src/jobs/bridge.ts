import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { JobMeta } from './connector.js';
import type { JobStore } from './store.js';
import { atomicWrite } from './store.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch (error) { if (missing(error)) return false; throw error; } };

/** One sampler per worker. Unchanged files cost only stat calls, never child processes. */
export function bridgeSampler(store: JobStore, job: JobMeta) {
  let questionStamp = '';
  let noteStamp = '';
  return () => {
    let changed = false;
    const questionPath = join(store.dir(job.id), 'question.json');
    try {
      const info = statSync(questionPath);
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp !== questionStamp) {
        const question = JSON.parse(readFileSync(questionPath, 'utf8'));
        if (typeof question.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(question.id) ||
          typeof question.question !== 'string' || !Number.isFinite(question.askedAt))
          throw new Error('question.json requires id, question and askedAt');
        questionStamp = stamp;
        if (!isFile(join(store.dir(job.id), `answer-${question.id}.json`))) {
          job.stalled = false; job.stalledSince = undefined;
          job.awaitingInput = { qid: question.id, question: question.question.slice(0, 500),
            options: Array.isArray(question.options) ? question.options.filter((option: unknown) => typeof option === 'string').slice(0, 50).map((option: string) => option.slice(0, 500)) : undefined,
            askedAt: question.askedAt };
          changed = true;
        }
      }
      if (job.awaitingInput && isFile(join(store.dir(job.id), `answer-${job.awaitingInput.qid}.json`))) {
        job.awaitingInput = undefined; changed = true;
      }
    } catch (error) {
      if (!missing(error)) throw error;
      questionStamp = '';
      if (job.awaitingInput) { job.awaitingInput = undefined; changed = true; }
    }
    try {
      const info = statSync(store.path(job.id, 'notes'));
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp !== noteStamp) {
        noteStamp = stamp;
        const line = store.tail(job.id, 'notes', 2).trim().split('\n').pop();
        if (line) {
          try {
            const note = JSON.parse(line).note;
            if (typeof note === 'string') {
              job.progressNote = note.replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
              changed = true;
            }
          } catch { /* An append in flight is retried on the next size change. */ }
        }
      }
    } catch (error) { if (!missing(error)) throw error; }
    return changed;
  };
}

/** Optional expected qid prevents a delayed elicitation response answering a newer question. */
export function answerBridge(store: JobStore, job: JobMeta, answer: string, expectedQid?: string) {
  if (!answer.trim()) throw new Error('answer must not be blank');
  if (!job.awaitingInput) throw new Error('No pending question for this running job');
  const { qid } = job.awaitingInput;
  if (expectedQid !== undefined && expectedQid !== qid) throw new Error('inputResponses key does not match the pending question');
  const question = JSON.parse(readFileSync(join(store.dir(job.id), 'question.json'), 'utf8'));
  if (question.id !== qid) throw new Error('question changed before answer was delivered');
  atomicWrite(join(store.dir(job.id), `answer-${qid}.json`), JSON.stringify({ answer, answeredAt: Date.now() }));
  job.awaitingInput = undefined;
}
