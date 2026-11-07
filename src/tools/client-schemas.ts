import { z } from 'zod';

// Vendored from Claude Code 2.1.319: _ / re / X_a / se / ne.
// Binary schema extraction: ~/.agent-jobs/research/claude-code-2.1.319-tasks.txt.
// WTe and xq in chunk-h29cx855: 128 and printable ASCII without spaces.
export const clientWireId = z.string().max(128).regex(/^[\x21-\x7e]+$/);
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform(value => value ?? undefined).optional();
export const clientTaskBase = z.object({
  taskId: clientWireId.min(1),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  statusMessage: optional(z.string()),
  createdAt: optional(z.string()),
  lastUpdatedAt: optional(z.string()),
  ttlMs: optional(z.number()),
  pollIntervalMs: optional(z.number()),
});
export const clientInputRequest = z.object({
  method: clientWireId.min(1),
  params: optional(z.record(z.string(), z.unknown())),
});
export const clientInputRequests = z.record(z.string().min(1).max(512), clientInputRequest);
export const clientTaskGet = z.discriminatedUnion('status', [
  clientTaskBase.extend({ status: z.literal('working') }),
  clientTaskBase.extend({
    status: z.literal('input_required'),
    inputRequests: clientInputRequests.nullish().transform(value => value ?? {}),
  }),
  clientTaskBase.extend({
    status: z.literal('completed'),
    result: z.record(z.string(), z.unknown()).nullish().transform(value => value ?? {}),
  }),
  clientTaskBase.extend({
    status: z.literal('failed'),
    error: z.object({
      code: optional(z.number()), message: optional(z.string()), data: z.unknown().optional(),
    }).nullish().transform(value => value ?? {}),
  }),
  clientTaskBase.extend({ status: z.literal('cancelled') }),
]);
export const clientCreateTask = clientTaskBase.extend({ resultType: z.literal('task') });
export const clientAgentTaskMeta = z.object({
  sessionId: optional(clientWireId),
  modelImmediateResponse: optional(z.string().max(20000)),
  taskId: optional(clientWireId),
  merged: optional(z.boolean()),
  kind: optional(z.string().max(64).regex(/^[\x21-\x7e]+$/)),
});
export const clientTaskList = z.object({ tasks: z.array(clientTaskGet) });
export const clientTaskNotification = z.object({
  method: z.literal('notifications/tasks/status'), params: clientTaskGet,
});
