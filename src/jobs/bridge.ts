import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { JobMeta } from './connector.js';
import type { JobStore } from './store.js';

/** Default wait of a question whose claim file is missing (matches the bridge's default timeout). */
export const LEGACY_QUESTION_MS = 1_800_000;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch (error) { if (missing(error)) return false; throw error; } };

/** One sampler per worker. Unchanged files cost only stat calls, never child processes. */
export function bridgeSampler(store: JobStore, job: JobMeta) {
  let questionStamp = '';
  let noteStamp = '';
  // When the observed question's claim runs out; an abandoned mailbox must not advertise forever.
  let deadline = Infinity;
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
        deadline = question.askedAt + LEGACY_QUESTION_MS;
        try {
          const claim = JSON.parse(readFileSync(join(store.dir(job.id), 'question.lock'), 'utf8'));
          if (claim.id === question.id && Number.isFinite(claim.ts) && Number.isFinite(claim.timeoutMs)) deadline = claim.ts + claim.timeoutMs;
        } catch { /* A mailbox without a claim uses the default timeout. */ }
        if (!isFile(join(store.dir(job.id), `answer-${question.id}.json`))) {
          job.stalled = false; job.stalledSince = undefined;
          job.awaitingInput = { qid: question.id, question: question.question.slice(0, 500),
            options: Array.isArray(question.options) ? question.options.filter((option: unknown) => typeof option === 'string').slice(0, 50).map((option: string) => option.slice(0, 500)) : undefined,
            askedAt: question.askedAt };
          changed = true;
        }
      }
      if (job.awaitingInput && (isFile(join(store.dir(job.id), `answer-${job.awaitingInput.qid}.json`)) || Date.now() > deadline + 5000)) {
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
  let question;
  try { question = JSON.parse(readFileSync(join(store.dir(job.id), 'question.json'), 'utf8')); }
  catch (error) {
    if (!missing(error)) throw error;
    job.awaitingInput = undefined;
    throw new Error('Question expired; no answer delivered');
  }
  if (question.id !== qid) throw new Error('question changed before answer was delivered');
  publishAnswer(store.dir(job.id), qid, answer);
  job.awaitingInput = undefined;
}

/**
 * First writer wins: the complete answer is written to a temp file and hard-linked to its final
 * name, which fails with EEXIST if an answer is already there. An identical answer is an
 * idempotent retry; a different one is an error, so the worker never sees an answer that was
 * replaced after (or while) it was read.
 */
export function publishAnswer(dir: string, qid: string, answer: string): void {
  const final = join(dir, `answer-${qid}.json`);
  const temp = join(dir, `answer-${qid}.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify({ answer, answeredAt: Date.now() }), { flag: 'wx' });
  try {
    linkSync(temp, final);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let existing: unknown;
    try { existing = JSON.parse(readFileSync(final, 'utf8')).answer; } catch { existing = undefined; }
    if (existing !== answer) throw new Error('A different answer was already delivered for this question');
  } finally {
    try { unlinkSync(temp); } catch { /* A leftover temp file holds nothing. */ }
  }
}
