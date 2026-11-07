import { z, type ZodTypeAny } from 'zod';
import { JobManager, type StartOptions } from './manager.js';

// Structural registry contract keeps this directory independent of either fork.
export interface JobTool {
  name: string;
  title?: string;
  description: string;
  zodSchema: ZodTypeAny;
  execute(args: any, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<string>;
}

export function registerJobTools(
  registry: { push(...tools: JobTool[]): unknown },
  prefix: string,
  manager: JobManager,
  options: { watchHeartbeatMs?: number } = {}
): void {
  const jobId = z
    .string()
    .min(1)
    .describe(
      `Job ID returned by ${prefix}_agent or ${prefix}_agent_retry. Jobs persist across client reconnects.`
    );
  const add = (
    name: string,
    description: string,
    schema: ZodTypeAny,
    execute: (
      args: any,
      onProgress?: (message: string) => void,
      signal?: AbortSignal
    ) => Promise<unknown>
  ) => {
    registry.push({
      name: `${prefix}_${name}`,
      title: `${prefix === 'codex' ? 'Codex' : prefix} agent${name === 'agent' ? '' : `: ${name.slice('agent_'.length)}`}`,
      description,
      zodSchema: schema,
      execute: async (args, onProgress, signal) =>
        JSON.stringify(await execute(schema.parse(args), onProgress, signal)),
    });
  };
  add(
    'agent',
    `Launch a background ${prefix === 'codex' ? 'Codex' : prefix} agent and return its ID immediately. Default mode is read; full mode bypasses approvals and sandboxing and must be explicitly requested. Use ${prefix}_agent_status or ${prefix}_agent_result to check completion.${prefix === 'codex' ? ` Use transport: app-server to message it mid-work with ${prefix}_agent_message; exec agents can answer pending questions but cannot otherwise be steered.` : ''}`,
    z
      .object({
        prompt: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Full instructions, sent to the CLI through stdin. Supply prompt OR promptFile.'
          ),
        promptFile: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Server-local UTF-8 prompt file; use instead of prompt for large instructions.'
          ),
        cwd: z
          .string()
          .min(1)
          .describe('Absolute working directory. Resume runs in this directory too.'),
        mode: z
          .enum(['read', 'write', 'trusted', 'full'])
          .default('read')
          .describe(
            "read: inspect only; write: edit in workspace sandbox; trusted: edit and run commands with no sandbox (needed for bash/npm tests on Windows), for worktree jobs on the user's own repos; full: explicitly bypass all sandboxing and approvals."
          ),
        model: z
          .string()
          .optional()
          .describe('Explicit CLI model; omitted uses the configured default.'),
        effort: z
          .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
          .optional()
          .describe('Requested model reasoning effort.'),
        label: z
          .string()
          .optional()
          .describe(
            'Human-readable job/worktree label; sanitized to at most 40 lowercase letters, digits and hyphens.'
          ),
        worktree: z
          .boolean()
          .default(false)
          .describe(
            'Create an isolated git worktree based on HEAD. Uncommitted main-checkout changes are excluded.'
          ),
        resumeSession: z
          .string()
          .optional()
          .describe('Native CLI session ID to resume, from an earlier result.'),
        ...(prefix === 'codex' ? {
          transport: z.enum(['exec', 'app-server']).optional().describe('Use app-server for steering and interactive approvals; omitted uses the configured default (exec).'),
          approvalTimeoutMin: z.number().positive().default(30),
        } : {}),
        idempotencyKey: z.string().min(1).optional(),
        priority: z.enum(['normal', 'optional']).default('normal'),
        stallTimeoutMin: z.number().min(0).default(10),
        onStall: z.enum(['report', 'kill']).default('report'),
        verify: z.string().min(1).optional().describe('Shell command to run after successful completion.'),
        verifyTimeoutMin: z.number().positive().default(10),
        timeoutMin: z
          .number()
          .positive()
          .default(120)
          .describe('Wall-clock limit in minutes; timeout kills the whole process tree.'),
      })
      .refine(args => (args.prompt === undefined) !== (args.promptFile === undefined), {
        message: 'Provide exactly one of prompt or promptFile',
      }),
    args => manager.start(args as StartOptions)
  );
  add(
    'agent_status',
    'Read job state, elapsed time, session ID, reason, and recent stderr/events. With no ID, lists live jobs across the common store.',
    z.object({ jobId: jobId.optional() }),
    args => manager.status(args.jobId)
  );
  add(
    'agent_result',
    'Get final text (up to 20,000 characters), full file path, session ID and diagnostics. Optional wait is limited to 10 seconds.',
    z.object({
      jobId,
      includeReasoning: z.boolean().default(false),
      waitSec: z
        .number()
        .min(0)
        .max(10)
        .default(0)
        .describe('Seconds to wait for a quick job, 0 to poll immediately.'),
    }),
    args => manager.result(args.jobId, args.waitSec, args.includeReasoning, { markCollected: true })
  );
  add(
    'agent_follow',
    'Follow an agent until it stops or pauses, with progress every 20 seconds and on state changes. Cancelling the follow leaves the agent running. Returns agent_result plus watchedSec and timedOut.',
    z.object({
      jobId,
      showReasoning: z.boolean().default(false),
      maxWaitSec: z
        .number()
        .min(0)
        .max(7200)
        .default(1800)
        .describe('Maximum seconds to watch, default 1800, at most 7200.'),
    }),
    (args, onProgress, signal) =>
      manager.watch(args.jobId, args.maxWaitSec, {
        onProgress,
        markCollected: true,
        showReasoning: args.showReasoning,
        signal,
        heartbeatMs: options.watchHeartbeatMs,
      })
  );
  add(
    'agent_message',
    'Message an agent: steer a running agent or answer its pending question; resume a stopped agent session as a new follow-up job. Returns delivered (mid-turn, queued, answer, or resumed) and jobId (the follow-up ID when resumed). Optional mode, model, effort and timeoutMin apply only when resuming. Queued agents must start or stop first.',
    z.object({
      jobId,
      message: z
        .string()
        .min(1)
        .refine(message => message.trim().length > 0, 'Message must not be blank')
        .describe('Instructions or an answer for the agent; stopped sessions resume with this prompt.'),
      mode: z.enum(['read', 'write', 'trusted', 'full']).optional(),
      model: z.string().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
      timeoutMin: z.number().positive().optional(),
    }),
    ({ jobId, message, ...overrides }) => manager.message(jobId, message, overrides)
  );
  add(
    'agent_answer',
    `Answer an agent question with answer and optional qid, or an app-server approval with decision. Inspect awaitingInput/pendingApproval in ${prefix}_agent_status first.`,
    z.object({ jobId, decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']).optional(), answer: z.string().trim().min(1).max(20000).optional(), qid: z.string().optional() })
      .refine(args => (args.decision === undefined) !== (args.answer === undefined), { message: 'Provide exactly one of answer or decision' }),
    args => manager.respond(args.jobId, args.answer !== undefined ? { answer: args.answer, qid: args.qid } : args.decision)
  );
  add(
    'agent_stop',
    'Cancel an owned job and kill its process tree. Waits up to 10 seconds for termination; reports kill-failed if termination cannot be confirmed. Another server cannot cancel your job.',
    z.object({ jobId }),
    args => manager.cancel(args.jobId)
  );
  add(
    'agent_list',
    'List recent jobs in the shared store, newest first, including jobs from the sibling connector.',
    z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .describe('Maximum number of recent jobs to return.'),
    }),
    args => manager.list(args.limit)
  );
  add(
    'agent_read',
    'Read a page of a saved job file when the client cannot access server-local paths. Offsets and limits count characters.',
    z.object({
      jobId,
      name: z
        .enum(['final', 'stdout', 'stderr', 'patch', 'prompt', 'verify', 'reasoning', 'notes'])
        .describe('Saved output or full original prompt to read.'),
      offset: z.number().int().min(0).default(0).describe('Zero-based character offset.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20000)
        .default(20000)
        .describe('Page size, at most 20,000 characters.'),
    }),
    args => manager.read(args.jobId, args.name, args.offset, args.limit)
  );
  add(
    'agent_retry',
    'Create a new queued job from a paused, lost or failed job using its saved full prompt. Optionally choose a different model or hand off to the sibling server; it must be enabled to pick up the job.',
    z.object({
      jobId,
      model: z.string().optional().describe('Explicit replacement model.'),
      agent: z
        .string()
        .optional()
        .describe(
          'Optional target connector (codex or agy) for a handoff. Omitted stays on this server.'
        ),
    }),
    args => manager.requeue(args.jobId, args.model, args.agent)
  );
  add(
    'agent_collect',
    'Collect stopped worktree changes, including new/binary files and worker commits. Saves patch.diff before any removal. Returns diff stat, capped patch, full patch path and removal errors.',
    z.object({
      jobId,
      remove: z
        .enum(['none', 'worktree', 'worktree+branch'])
        .default('none')
        .describe('What to remove AFTER saving the patch. none preserves the worktree and branch.'),
    }),
    args => manager.collect(args.jobId, args.remove)
  );
}
