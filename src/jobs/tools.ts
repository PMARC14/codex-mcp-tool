import { z, type ZodTypeAny } from 'zod';
import { JobManager, type StartOptions } from './manager.js';

// Structural registry contract keeps this directory independent of either fork.
export interface JobTool {
  name: string;
  description: string;
  zodSchema: ZodTypeAny;
  execute(args: any): Promise<string>;
}

export function registerJobTools(
  registry: { push(...tools: JobTool[]): unknown },
  prefix: string,
  manager: JobManager
): void {
  const jobId = z
    .string()
    .min(1)
    .describe(
      'Job ID returned by job_start or job_requeue. Jobs are persisted across client reconnects.'
    );
  const add = (
    name: string,
    description: string,
    schema: ZodTypeAny,
    execute: (args: any) => Promise<unknown>
  ) => {
    registry.push({
      name: `${prefix}_${name}`,
      description,
      zodSchema: schema,
      execute: async args => JSON.stringify(await execute(schema.parse(args))),
    });
  };
  add(
    'job_start',
    'Start a background CLI job and return its ID immediately. Default mode is read; full mode bypasses approvals and sandboxing and must be explicitly requested. Use status/result to check completion.',
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
          .enum(['read', 'write', 'full'])
          .default('read')
          .describe(
            'read: inspect only; write: edit in workspace sandbox; full: explicitly bypass all sandboxing and approvals.'
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
    'job_status',
    'Read job state, elapsed time, session ID, reason, and recent stderr/events. With no ID, lists live jobs across the common store.',
    z.object({ jobId: jobId.optional() }),
    args => manager.status(args.jobId)
  );
  add(
    'job_result',
    'Get final text (up to 20,000 characters), full file path, session ID and diagnostics. Optional wait is limited to 10 seconds.',
    z.object({
      jobId,
      waitSec: z
        .number()
        .min(0)
        .max(10)
        .default(0)
        .describe('Seconds to wait for a quick job, 0 to poll immediately.'),
    }),
    args => manager.result(args.jobId, args.waitSec)
  );
  add(
    'job_cancel',
    'Cancel an owned job and kill its process tree. Waits up to 10 seconds for termination; reports kill-failed if termination cannot be confirmed. Another server cannot cancel your job.',
    z.object({ jobId }),
    args => manager.cancel(args.jobId)
  );
  add(
    'job_list',
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
    'job_read',
    'Read a page of a saved job file when the client cannot access server-local paths. Offsets and limits count characters.',
    z.object({
      jobId,
      name: z
        .enum(['final', 'stdout', 'stderr', 'patch', 'prompt'])
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
    'job_requeue',
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
    'worktree_collect',
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
