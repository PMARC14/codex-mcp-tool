import type { JobMeta } from './connector.js';
import type { JobManager } from './manager.js';

export type JobEvent = 'stopped' | 'paused' | 'question' | 'approval';
export interface AnsweredInput { qid?: string; approvalId?: string | number }
const inputKey = (job: JobMeta) => JSON.stringify([job.awaitingInput?.qid, job.pendingApproval?.id, job.pendingApproval?.requestedAt]);

export function nextJobEvent(job: JobMeta, answered: AnsweredInput = {}): JobEvent | undefined {
  if (job.state === 'paused') return 'paused';
  if (job.state !== 'queued' && job.state !== 'running') return 'stopped';
  if (job.awaitingInput && job.awaitingInput.qid !== answered.qid) return 'question';
  if (job.pendingApproval && job.pendingApproval.id !== answered.approvalId)
    return job.pendingApproval.kind === 'userInput' ? 'question' : 'approval';
  return undefined;
}

export interface WatchOptions {
  /** Implicit waits have no deadline; explicit follow keeps its bounded maxWaitSec. */
  unlimited?: boolean;
  /** Return on pauses or input, ignoring only the question/approval just answered. */
  untilNextEvent?: AnsweredInput;
  /** Explicit follow tool collection; internal waits leave wake markers untouched. */
  markCollected?: boolean;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  showReasoning?: boolean;
  /** Injectable for tests; production heartbeats never exceed 20 seconds. */
  heartbeatMs?: number;
}

/** A paused job whose quota reset time is known is retried by the queue without any action. */
export const autoRetries = (job: JobMeta) => job.state === 'paused' && !job.pauseCleared && !!job.resetAt;

export function progressMessage(manager: JobManager, job: JobMeta, showReasoning = false): string {
  // Match agent_status's stdout window, without reading the whole log or probing processes.
  const line = manager.store.tail(job.id, 'stdout', 20).slice(-10000).trim().split(/\r?\n/).pop();
  let summary = line ?? '';
  try {
    const event = JSON.parse(summary);
    const text =
      (event.item?.type === 'reasoning' ? 'reasoning' : undefined) ?? event.item?.text ?? event.item?.summary ?? event.summary ?? event.message ?? event.type;
    if (typeof text === 'string') summary = text;
  } catch {
    // A truncated JSON event may contain raw reasoning.
    if (summary.endsWith('"}}')) summary = '';
  }
  if (showReasoning) {
    try {
      const reasoning = manager.store.tail(job.id, 'reasoning', 100).trim();
      if (reasoning) summary = reasoning.match(/[^.!?\n]+[.!?]?(?=\s|$)/g)?.pop()?.trim() ?? reasoning;
    } catch { /* Older jobs may not have a reasoning file. */ }
  }
  const elapsed = Math.max(
    0,
    Math.floor(((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000)
  );
  const model = (job.model ?? 'default').split('/').pop()!.replace(/^gpt-[0-9.]+-/, '').replace(/^gemini-[0-9.]+-/, '');
  const identity = `${job.connector} ${job.id} ${model} \u00b7 ${job.label ?? 'job'}`;
  const state = job.awaitingInput ? 'awaiting answer' : job.pendingApproval ? (job.pendingApproval.kind === 'userInput' ? 'awaiting answer' : 'awaiting approval') : job.stalled && job.state === 'running' ? `stalled ${Math.floor((Date.now() - (job.stalledSince ?? Date.now())) / 60000)}m` : job.state;
  const suffix = ` | ${state} | ${elapsed}s`;
  if (job.progressNote) summary = job.progressNote;
  if (job.state === 'paused') summary = job.resetAt ? `Paused until ${new Date(job.resetAt).toISOString()}` : 'Paused until the usage limit is reset; reset time unknown';
  if (job.reason === 'superseded') summary = `Superseded by ${job.supersededBy ?? 'a replacement job'}`;
  const step = (summary || (job.state === 'queued' ? 'waiting for slot' : job.state === 'running' ? 'working' : job.state)).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Variation_Selector}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const reserveStep = Math.min(job.reason === 'superseded' ? 60 : 40, step.length) + 3;
  const head = identity.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Variation_Selector}]+/gu, ' ').slice(0, Math.max(0, 120 - suffix.length - reserveStep)) + suffix;
  return head + ' | ' + step.slice(0, 120 - head.length - 3);
}

/** Wait using store transitions and a heartbeat only; never start or inspect a process here. */
export async function watchJob(
  manager: JobManager,
  jobId: string,
  maxWaitSec = 1800,
  options: WatchOptions = {},
  shutdown?: AbortSignal
) {
  if (!Number.isFinite(maxWaitSec) || maxWaitSec < 0 || maxWaitSec > 7200)
    throw new Error('maxWaitSec must be between 0 and 7200');
  const started = Date.now();
  const signals = [options.signal, shutdown].filter((signal): signal is AbortSignal => !!signal);
  const checkAbort = () => {
    if (signals.some(signal => signal.aborted)) {
      const error = new Error('Job watch cancelled; the job keeps running');
      error.name = 'AbortError';
      throw error;
    }
  };
  checkAbort();
  await manager.initialize();
  checkAbort();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  let approvalKey: string | undefined;
  let input: Pick<JobMeta, 'awaitingInput' | 'pendingApproval'> | undefined;
  let event: JobEvent | undefined;
  let eventState: JobMeta['state'] | undefined;
  let ended = false;
  const cleanup = () => {
    if (ended) return;
    ended = true;
    unsubscribe();
    clearInterval(heartbeat);
    clearTimeout(deadline);
    for (const signal of signals) signal.removeEventListener('abort', abort);
  };
  let timedOut: boolean;
  try {
    timedOut = await new Promise<boolean>((resolve, reject) => {
      const finish = (timeout: boolean) => {
        cleanup();
        resolve(timeout);
      };
      const sample = (timeout = false) => {
        if (ended) return;
        try {
          checkAbort();
          const job = manager.store.get(jobId);
          approvalKey = inputKey(job);
          options.onProgress?.(progressMessage(manager, job, options.showReasoning));
          if (ended) return; // The callback may cancel the request.
          // Event waits return on every pause; other internal watches may follow automatic retries.
          const nextEvent = options.untilNextEvent;
          event = nextEvent ? nextJobEvent(job, nextEvent) : undefined;
          if (event) {
            eventState = job.state;
            input = { awaitingInput: job.awaitingInput, pendingApproval: job.pendingApproval };
            finish(false);
          } else if (job.state !== 'queued' && job.state !== 'running' && (nextEvent || !autoRetries(job))) finish(false);
          else if (timeout) finish(true);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      abort = () => {
        try {
          checkAbort();
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      unsubscribe = manager.onTransition((job, previous) => {
        const nextApproval = inputKey(job);
        if (job.id === jobId && (job.state !== previous || nextApproval !== approvalKey)) sample();
      });
      for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
      heartbeat = setInterval(
        () => sample(),
        Math.min(20000, Math.max(1, options.heartbeatMs ?? 20000))
      );
      if (!options.unlimited) deadline = setTimeout(() => sample(true), maxWaitSec * 1000);
      sample(!options.unlimited && maxWaitSec === 0);
    });
  } finally {
    cleanup();
  }
  const result = await manager.result(jobId);
  checkAbort();
  const response = { ...result, ...input, ...(event ? { event, state: eventState! } : {}), watchedSec: (Date.now() - started) / 1000, timedOut };
  if (options.markCollected && !['queued', 'running'].includes(response.state)) manager.markCollected(jobId);
  return response;
}
