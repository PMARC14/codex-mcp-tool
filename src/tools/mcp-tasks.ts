import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
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

export const TASK_EXTENSION = 'io.modelcontextprotocol/tasks';
export const MODERN_PROTOCOL = '2026-07-28';
const VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_META = 'io.modelcontextprotocol/clientCapabilities';
const POLL_MS = 5000;
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

  constructor(private readonly prefix: string) {
    super();
  }

  async start() {
    const receive = this.onmessage;
    this.onmessage = message => {
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
        if (result.task) result = modernTask(result.task);
        else {
          result = { resultType: 'complete', ttlMs: 0, cacheScope: 'private', ...result };
          if (request.method === 'tools/list') {
            result.tools = result.tools.map(({ execution: _execution, ...tool }: any) => tool);
          }
        }
        message = { ...message, result };
      }
    }
    await super.send(message);
  }
}

/** A task is a projection of a persisted job, never a second worker or scheduler. */
export function registerMcpTasks(
  server: Server,
  prefix: string,
  manager: JobManager,
  discovery: { capabilities: Record<string, unknown>; instructions?: string }
) {
  for (const tool of toolRegistry) {
    if (supportsTask(prefix, tool.name)) tool.execution = { taskSupport: 'optional' };
  }
  const subscribed = new Set<string>();
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
    if (job.state === 'completed') status = 'completed';
    if (job.state === 'failed' || job.state === 'lost') status = 'failed';
    if (job.state === 'killed') status = 'cancelled';
    // Match job_watch's bounded progress line without probing process liveness.
    const line = manager.store.tail(job.id, 'stdout', 20).slice(-10000).trim().split(/\r?\n/).pop();
    let summary = line ?? '';
    try {
      const event = JSON.parse(summary);
      const text =
        event.item?.text ?? event.item?.summary ?? event.summary ?? event.message ?? event.type;
      if (typeof text === 'string') summary = text;
    } catch {
      /* A plain text step summary is valid too. */
    }
    const elapsed = Math.max(
      0,
      Math.floor(((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000)
    );
    let statusMessage =
      `${job.state} | ${elapsed}s${summary ? ` | ${summary.replace(/\s+/g, ' ').trim()}` : ''}`.slice(
        0,
        120
      );
    if (job.state === 'paused')
      statusMessage = job.resetAt
        ? `Paused until ${new Date(job.resetAt).toISOString()}`
        : 'Paused until the usage limit is reset; reset time unknown';
    if (job.reason === 'superseded')
      statusMessage = `Superseded by ${job.supersededBy ?? 'a replacement job'}`;
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
    return terminal(job)
      ? { resultType: 'complete', ...(await payload(job.id)) }
      : modernTask(taskFor(job));
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
      timer = setInterval(check, POLL_MS);
      extra.signal.addEventListener('abort', abort, { once: true });
      check();
    });
    return payload(id);
  });
  server.setRequestHandler(CancelTaskRequestSchema, async request => {
    const job = jobFor(request.params.taskId);
    if (terminal(job)) throw new McpError(ErrorCode.InvalidParams, 'Cannot cancel a terminal task');
    await manager.cancel(job.id);
    return taskFor(jobFor(job.id));
  });
  server.setRequestHandler(ListTasksRequestSchema, async request => {
    if (request.params?.cursor)
      throw new McpError(ErrorCode.InvalidParams, 'Task list has no further pages');
    return {
      tasks: manager.store
        .list()
        .filter(job => job.connector === manager.connector.id && existsSync(marker(job.id)))
        .map(taskFor),
    };
  });

  return {
    async call(name: string, args: any) {
      if (!supportsTask(prefix, name))
        throw new McpError(ErrorCode.InvalidParams, `Tool ${name} does not support tasks`);
      const tool = toolRegistry.find(tool => tool.name === name)!;
      const parsed = tool.zodSchema.safeParse(args);
      if (!parsed.success)
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments for ${name}: ${parsed.error.message}`
        );
      const validated = parsed.data;
      const id: string =
        name === `${prefix}_job_start`
          ? JSON.parse((await executeTool(name, validated)) as string).jobId
          : validated.jobId;
      const job = jobFor(id);
      if (!existsSync(marker(id))) atomicWrite(marker(id), '{}');
      subscribed.add(id);
      // Lazily subscribe so clients making only ordinary calls acquire no listeners.
      unsubscribe ??= manager.onTransition((job, previous) => {
        if (!subscribed.has(job.id) || job.state === previous) return;
        void server
          .notification({ method: 'notifications/tasks/status', params: taskFor(job) })
          .catch(() => {});
      });
      return { task: taskFor(job) };
    },
    close() {
      unsubscribe?.();
      unsubscribe = undefined;
      subscribed.clear();
    },
  };
}
