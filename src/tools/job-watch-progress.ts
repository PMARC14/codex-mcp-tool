import type { ToolArguments } from '../constants.js';
import { ProgressReporter } from '../utils/progress.js';
import { executeTool } from './registry.js';
import type { JobManager } from '../jobs/manager.js';

/** Calls without a task must stay pending so the client can deliver their next wake. */
export function needsJobWatch(name: string) {
  return /_agent(?:_follow|_retry|_resume|_answer|_message)?$/.test(name);
}

/** Watch tools supply their own heartbeat instead of the server's generic keepalive. */
export async function executeJobWatch(
  name: string,
  args: ToolArguments,
  options: {
    progressToken?: string | number;
    signal: AbortSignal;
    /** Present for implicit waits; explicit follow already watches in its tool handler. */
    manager?: JobManager;
    notify: (params: {
      progressToken: string | number;
      progress: number;
      message?: string;
    }) => Promise<void>;
  }
) {
  let active = true;
  const reporter = new ProgressReporter(options.progressToken, async params => {
    if (active && !options.signal.aborted) await options.notify(params);
  });
  try {
    const onProgress = options.progressToken === undefined
      ? undefined
      : (message: string) => {
          // A broken notification transport must not affect the watched job or leave its wait hanging.
          void reporter.send(message).catch(() => {});
        };
    const manager = options.manager;
    const implicit = manager && !name.endsWith('_agent_follow');
    if (implicit) await manager.initialize();
    const previous = implicit && name.endsWith('_agent_answer')
      ? manager.store.get(String((args as any).jobId)) : undefined;
    const result = await executeTool(name, args, onProgress, options.signal);
    if (!implicit) return result;
    const advanced = JSON.parse(result as string);
    if (name.endsWith('_agent_message') && advanced.delivered !== 'resumed') return result;
    const jobId = advanced.jobId ?? (args as any).jobId;
    const watched = await manager.watch(jobId, undefined, {
      unlimited: true,
      untilNextEvent: {
        qid: advanced.qid ?? previous?.awaitingInput?.qid,
        approvalId: previous?.pendingApproval?.id,
      },
      onProgress,
      signal: options.signal,
    });
    return JSON.stringify({ ...advanced, ...watched });
  } finally {
    active = false;
  }
}
