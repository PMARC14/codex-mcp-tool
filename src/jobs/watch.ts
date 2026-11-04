import type { JobMeta } from './connector.js';
import type { JobManager } from './manager.js';

export interface WatchOptions {
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  /** Injectable for tests; production heartbeats never exceed 20 seconds. */
  heartbeatMs?: number;
}

function progressMessage(manager: JobManager, job: JobMeta): string {
  // Match job_status's stdout window, without reading the whole log or probing processes.
  const line = manager.store.tail(job.id, 'stdout', 20).slice(-10000).trim().split(/\r?\n/).pop();
  let summary = line ?? '';
  try {
    const event = JSON.parse(summary);
    const text =
      event.item?.text ?? event.item?.summary ?? event.summary ?? event.message ?? event.type;
    if (typeof text === 'string') summary = text;
  } catch {
    // Plain-text step summaries are also supported.
  }
  const elapsed = Math.max(
    0,
    Math.floor(((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000)
  );
  return `${job.state} | ${elapsed}s${summary ? ` | ${summary.replace(/\s+/g, ' ').trim()}` : ''}`.slice(
    0,
    120
  );
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
          options.onProgress?.(progressMessage(manager, job));
          if (ended) return; // The callback may cancel the request.
          if (job.state !== 'queued' && job.state !== 'running') finish(false);
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
        if (job.id === jobId && job.state !== previous) sample();
      });
      for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
      heartbeat = setInterval(
        () => sample(),
        Math.min(20000, Math.max(1, options.heartbeatMs ?? 20000))
      );
      deadline = setTimeout(() => sample(true), maxWaitSec * 1000);
      sample(maxWaitSec === 0);
    });
  } finally {
    cleanup();
  }
  const result = await manager.result(jobId);
  checkAbort();
  return { ...result, watchedSec: (Date.now() - started) / 1000, timedOut };
}
