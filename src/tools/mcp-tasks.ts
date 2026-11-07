import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Readable, Writable } from 'node:stream';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CancelTaskRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListTasksRequestSchema,
  McpError,
  ErrorCode,
  type JSONRPCMessage,
  type Task,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { JobManager } from '../jobs/manager.js';
import type { JobMeta } from '../jobs/connector.js';
import { atomicWrite, terminal } from '../jobs/store.js';
import { toolRegistry, executeTool } from './registry.js';
import { progressMessage } from '../jobs/watch.js';
import { clientAgentTaskMeta, clientWireId } from './client-schemas.js';
import { trafficLog, type TrafficLog } from './traffic-log.js';

export const TASK_EXTENSION = 'io.modelcontextprotocol/tasks';
export const MODERN_PROTOCOL = '2026-07-28';
const VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_META = 'io.modelcontextprotocol/clientCapabilities';
const POLL_MS = 15000;
export const taskCapabilities = { list: {}, cancel: {}, requests: { tools: { call: {} } } };
const modern = (params: any) => params?._meta?.[VERSION_META] === MODERN_PROTOCOL;
const supportsTask = (prefix: string, name: string) =>
  name === `${prefix}_job_start` || name === `${prefix}_job_watch`;

function modernTask(task: Task) {
  const { ttl, pollInterval, ...rest } = task;
  return { resultType: 'task', ...rest, ttlMs: ttl, pollIntervalMs: pollInterval };
}

/** The installed SDK speaks 2025 MCP. Project only modern wire envelopes here;
 * keep dispatch, validation, cancellation and the ordinary stdio path in the SDK. */
export class TaskStdioTransport extends StdioServerTransport {
  private readonly requests = new Map<string | number, { method: string; modern: boolean }>();

  constructor(private readonly prefix: string, private readonly log: TrafficLog = trafficLog,
    input?: Readable, output?: Writable) {
    super(input, output);
  }

  async start() {
    const receive = this.onmessage;
    this.onmessage = message => {
      this.log.message('in', message);
      if ('id' in message && 'method' in message) {
        const isModern = message.method === 'server/discover' || modern(message.params);
        this.requests.set(message.id, { method: message.method, modern: isModern });
        // In the new era the per-request client extension grants task permission.
        // Removing it (Claude's allowTask:false path) preserves synchronous behavior.
        const params = message.params;
        const capabilities = params?._meta?.[CLIENT_META] as any;
        if (
          isModern &&
          message.method === 'tools/call' &&
          supportsTask(this.prefix, String(params?.name)) &&
          capabilities?.extensions?.[TASK_EXTENSION] !== undefined
        ) {
          message = { ...message, params: { ...params, task: {} } };
        }
      }
      receive?.(message);
    };
    await super.start();
  }

  async send(message: JSONRPCMessage) {
    if ('id' in message && message.id !== undefined && !('method' in message)) {
      const request = this.requests.get(message.id);
      this.requests.delete(message.id);
      if (request?.modern && 'result' in message) {
        let result: any = message.result;
        if (result.task) result = { ...modernTask(result.task), ...(result._meta ? { _meta: result._meta } : {}) };
        else if (result.resultType !== 'task' && !['tasks/get', 'tasks/cancel', 'tasks/list'].includes(request.method)) {
          result = { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...result };
          if (request.method === 'tools/list') {
            result.tools = result.tools.map(({ execution: _execution, ...tool }: any) => tool);
          }
        }
        message = { ...message, result };
      }
    }
    this.log.message('out', message);
    await super.send(message);
  }
}

/** A task is a projection of a persisted job, never a second worker or scheduler. */
export function registerMcpTasks(
  server: Server,
  prefix: string,
  manager: JobManager,
  discovery: { capabilities: Record<string, unknown>; instructions?: string },
  startTool = executeTool,
  registry = toolRegistry
) {
  for (const tool of registry) {
    if (supportsTask(prefix, tool.name)) tool.execution = { taskSupport: 'optional' };
  }
  const subscribed = new Set<string>();
  const statuses = new Map<string, string>();
  const statusKey = (job: JobMeta) => `${taskFor(job).status}:${job.awaitingInput?.qid ?? ''}:${job.pendingApproval?.id ?? ''}`;
  let unsubscribe: (() => void) | undefined;
  const marker = (id: string) => join(manager.store.dir(id), 'mcp-task.json');
  const jobFor = (id: string) => {
    try {
      const job = manager.store.get(id);
      if (job.connector === manager.connector.id) return job;
    } catch {
      /* Invalid or missing ids are protocol errors, never tool results. */
    }
    throw new McpError(ErrorCode.InvalidParams, `Unknown task: ${id}`);
  };
  const taskFor = (job: JobMeta): Task => {
    let status: Task['status'] = 'working';
    if (job.state === 'running' && (job.pendingApproval || job.awaitingInput)) status = 'input_required';
    if (job.state === 'completed') status = 'completed';
    if (job.state === 'failed' || job.state === 'lost') status = 'failed';
    if (job.state === 'killed') status = 'cancelled';
    const statusMessage = progressMessage(manager, job);
    return {
      taskId: job.id,
      status,
      statusMessage,
      ttl: null,
      pollInterval: POLL_MS,
      createdAt: new Date(job.createdAt).toISOString(),
      lastUpdatedAt: new Date(job.updatedAt).toISOString(),
    };
  };
  const payload = async (id: string): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: JSON.stringify(await manager.result(id)) }],
    isError: false,
  });

  const projection = async (job: JobMeta) => {
    const { resultType: _type, ...base } = modernTask(taskFor(job));
    if (base.status === 'input_required') {
      const input = job.awaitingInput;
      const approval = job.pendingApproval;
      return { ...base, inputRequests: input ? { [input.qid]: {
        method: 'elicitation/create', params: { mode: 'form', message: input.question,
          requestedSchema: { type: 'object', properties: {
            answer: { type: 'string', title: 'Answer', ...(input.options?.length ? { enum: input.options } : {}) },
          }, required: ['answer'] },
        },
      } } : approval ? { [`approval-${approval.requestedAt}`]: {
        method: 'elicitation/create', params: { mode: 'form', message: approval.summary,
          requestedSchema: { type: 'object', properties: { decision: { type: 'string', title: 'Decision',
            enum: ['accept', 'acceptForSession', 'decline', 'cancel'] } }, required: ['decision'] },
        },
      } } : {} };

    }
    if (base.status === 'completed') return { ...base, result: await payload(job.id) };
    if (base.status === 'failed') return {
      ...base, error: { message: `${job.failureReason ?? job.reason ?? job.state}: ${
        (job.error ?? `Job ${job.state}${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}`).replace(/\s+/g, ' ').slice(0, 300)}` },
      result: await payload(job.id),
    };
    return base;
  };
  const agentMeta = (job: JobMeta) => ({
    'com.anthropic/agent-task': clientAgentTaskMeta.parse({
      kind: `${prefix}-agent`, taskId: job.id,
      ...(clientWireId.safeParse(job.sessionId).success ? { sessionId: job.sessionId } : {}),
      modelImmediateResponse: `${prefix === 'codex' ? 'Codex' : prefix} agent "${(job.label ?? 'job').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 80)}" (${(job.model ?? 'default').slice(0, 80)}, ${job.effort ?? 'default'}, ${job.mode}, ${job.transport ?? 'exec'}) started as job ${job.id}. It runs in the background; you'll be woken when it finishes.${job.transport === 'app-server' ? ` Message it mid-work with ${prefix}_job_steer.` : ''} Answer its questions with ${prefix}_job_respond.`.replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, 20000),
    }),
  });

  server.setRequestHandler(
    z.object({
      method: z.literal('server/discover'),
      params: z.object({}).passthrough().optional(),
    }),
    async () => {
      const { tasks: _tasks, ...capabilities } = discovery.capabilities;
      return {
        supportedVersions: [MODERN_PROTOCOL],
        capabilities: { ...capabilities, extensions: { [TASK_EXTENSION]: {} } },
        ...(discovery.instructions ? { instructions: discovery.instructions } : {}),
      };
    }
  );
  server.setRequestHandler(GetTaskRequestSchema, async request => {
    const job = jobFor(request.params.taskId);
    if (!modern(request.params)) return taskFor(job);
    return projection(job);
  });
  server.setRequestHandler(z.object({
    method: z.literal('tasks/update'),
    params: z.object({ taskId: z.string(), inputResponses: z.record(z.unknown()) }).passthrough(),
  }), async request => {
    const job = jobFor(request.params.taskId);
    const entries = Object.entries(request.params.inputResponses);
    if (entries.length !== 1) throw new McpError(ErrorCode.InvalidParams, 'inputResponses must contain exactly one pending question');
    const [qid, raw] = entries[0];
    if (!/^[a-zA-Z0-9-]+$/.test(qid)) throw new McpError(ErrorCode.InvalidParams, 'inputResponses key is invalid');
    if (job.pendingApproval && qid === `approval-${job.pendingApproval.requestedAt}`) {
      const response = z.object({ action: z.enum(['accept', 'decline', 'cancel']),
        content: z.object({ decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']) }).optional() }).safeParse(raw);
      if (!response.success || (response.data.action === 'accept' && !response.data.content))
        throw new McpError(ErrorCode.InvalidParams, 'A valid approval decision is required');
      await manager.respond(job.id, response.data.action === 'accept' ? response.data.content!.decision : response.data.action);
      return {};
    }
    // A retry of an acknowledged answer is harmless; never apply it to a newer qid.
    if (!job.awaitingInput || job.awaitingInput.qid !== qid) {
      if (existsSync(join(manager.store.dir(job.id), `answer-${qid}.json`))) return {};
      throw new McpError(ErrorCode.InvalidParams, 'inputResponses key does not match the pending question');
    }
    const response = z.object({ action: z.enum(['accept', 'decline', 'cancel']),
      content: z.object({ answer: z.string().trim().min(1).max(20000) }).optional() }).safeParse(raw);
    if (!response.success) throw new McpError(ErrorCode.InvalidParams, `inputResponses.${qid}: ${response.error.message}`);
    if (response.data.action === 'accept' && !response.data.content)
      throw new McpError(ErrorCode.InvalidParams, `inputResponses.${qid}.content.answer is required`);
    const answer = response.data.action === 'accept' ? response.data.content!.answer
      : 'The user declined to answer; continue with your best judgement.';
    await manager.respond(job.id, { answer, qid });
    return {};
  });
  server.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
    const id = request.params.taskId;
    jobFor(id);
    // tasks/result blocks until terminal. The timer observes writes by other servers;
    // local transitions wake it immediately. Neither path launches a process.
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      let off = () => {};
      const cleanup = () => {
        clearInterval(timer);
        off();
        extra.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(new McpError(ErrorCode.InvalidRequest, 'Task result wait cancelled'));
      };
      const check = () => {
        try {
          if (extra.signal.aborted) return abort();
          if (terminal(jobFor(id))) {
            cleanup();
            resolve();
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      off = manager.onTransition(job => {
        if (job.id === id) check();
      });
      timer = setInterval(check, 5000);
      extra.signal.addEventListener('abort', abort, { once: true });
      check();
    });
    return payload(id);
  });
  server.setRequestHandler(CancelTaskRequestSchema, async request => {
    const job = jobFor(request.params.taskId);
    if (terminal(job)) throw new McpError(ErrorCode.InvalidParams, 'Cannot cancel a terminal task');
    await manager.cancel(job.id);
    const task = taskFor(jobFor(job.id));
    return modern(request.params) ? projection(jobFor(job.id)) : task;
  });
  server.setRequestHandler(ListTasksRequestSchema, async request => {
    if (request.params?.cursor)
      throw new McpError(ErrorCode.InvalidParams, 'Task list has no further pages');
    return {
      tasks: await Promise.all(manager.store
        .list()
        .filter(job => job.connector === manager.connector.id && existsSync(marker(job.id)))
        .map(job => modern(request.params) ? projection(job) : taskFor(job))),
    };
  });

  return {
    async call(name: string, args: any) {
      if (!supportsTask(prefix, name))
        throw new McpError(ErrorCode.InvalidParams, `Tool ${name} does not support tasks`);
      const tool = registry.find(tool => tool.name === name)!;
      const parsed = tool.zodSchema.safeParse(args);
      if (!parsed.success)
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for ${name}: ${parsed.error.message}`
        );
      const validated = parsed.data;
      const id: string =
        name === `${prefix}_job_start`
          ? JSON.parse((await startTool(name, validated)) as string).jobId
          : validated.jobId;
      const job = jobFor(id);
      if (!existsSync(marker(id))) atomicWrite(marker(id), '{}');
      subscribed.add(id);
      statuses.set(id, statusKey(job));
      // Lazily subscribe so clients making only ordinary calls acquire no listeners.
      unsubscribe ??= manager.onTransition(job => {
        if (!subscribed.has(job.id)) return;
        if (statuses.get(job.id) === statusKey(job)) return;
        statuses.set(job.id, statusKey(job));
        void projection(job).then(params => server
          .notification({ method: 'notifications/tasks/status', params }))
          .catch(error => trafficLog.error('notifications/tasks/status', error));
      });
      return { task: taskFor(job), _meta: agentMeta(job) };
    },
    close() {
      unsubscribe?.();
      unsubscribe = undefined;
      subscribed.clear();
      statuses.clear();
    },
  };
}
