import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { atomicWrite } from '../jobs/store.js';
import { toolRegistry, executeTool } from './registry.js';
import { nextJobEvent, progressMessage, watchJob, type AnsweredInput } from '../jobs/watch.js';
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
  ['agent', 'agent_follow', 'agent_retry', 'agent_resume', 'agent_answer', 'agent_message'].some(suffix => name === `${prefix}_${suffix}`);

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
        else if (result.resultType !== 'task' && !['server/discover', 'tasks/get', 'tasks/cancel', 'tasks/list'].includes(request.method)) {
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

interface EventTask {
  taskId: string;
  jobId: string;
  connector: string;
  createdAt: number;
  updatedAt: number;
  modern: boolean;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  statusMessage: string;
  answered: AnsweredInput;
  context: Record<string, unknown>;
  result?: CallToolResult;
  error?: string;
}

/** Each task observes one job event. Its persisted result is immutable after completion. */
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
  const directory = join(manager.store.home, 'tasks');
  const records = new Map<string, EventTask>();
  const watches = new Map<string, { controller: AbortController; done: Promise<void>; cancelling: boolean }>();
  let closed = false;
  const path = (id: string) => {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new McpError(ErrorCode.InvalidParams, 'Invalid task id');
    return join(directory, `${id}.json`);
  };
  const save = (record: EventTask) => {
    mkdirSync(directory, { recursive: true });
    atomicWrite(path(record.taskId), JSON.stringify(record));
    records.set(record.taskId, record);
  };
  const read = (id: string): EventTask => {
    try {
      const record: EventTask = JSON.parse(readFileSync(path(id), 'utf8'));
      if (record.taskId === id && record.connector === manager.connector.id) return record;
    } catch { /* Invalid or foreign ids are protocol errors. */ }
    throw new McpError(ErrorCode.InvalidParams, `Unknown task: ${id}`);
  };
  const load = (id: string) => {
    const cached = records.get(id);
    if (cached && watches.has(id)) return cached;
    const record = read(id);
    records.set(id, record);
    return record;
  };
  const base = (record: EventTask): Task => ({
    taskId: record.taskId, status: record.status, statusMessage: record.statusMessage,
    ttl: null, pollInterval: POLL_MS,
    createdAt: new Date(record.createdAt).toISOString(),
    lastUpdatedAt: new Date(record.updatedAt).toISOString(),
  });
  const projection = (record: EventTask) => {
    const { resultType: _type, ...task } = modernTask(base(record));
    return { ...task,
      ...(record.status === 'completed' ? { result: record.result } : {}),
      ...(record.status === 'failed' ? { error: { code: -32000, message: record.error } } : {}),
    };
  };
  const notify = (record: EventTask) => {
    if (closed) return;
    void server.notification({ method: 'notifications/tasks/status',
      params: record.modern ? projection(record) : base(record) })
      .catch(error => trafficLog.error('notifications/tasks/status', error));
  };
  const ensureWatch = (record: EventTask) => {
    let active = watches.get(record.taskId);
    if (active || record.status !== 'working' || closed) return active;
    const controller = new AbortController();
    const entry = { controller, done: Promise.resolve(), cancelling: false };
    watches.set(record.taskId, entry);
    entry.done = watchJob(manager, record.jobId, undefined, {
      unlimited: true, untilNextEvent: record.answered, signal: controller.signal,
      onProgress(message) {
        if (record.status !== 'working' || message === record.statusMessage) return;
        record.statusMessage = message;
        record.updatedAt = Date.now();
        notify(record);
      },
    }).then(result => {
      // Another connection may have collected this event first. Never overwrite that snapshot.
      const persisted = read(record.taskId);
      if (persisted.status !== 'working') { Object.assign(record, persisted); return; }
      record.result = { content: [{ type: 'text', text: JSON.stringify({ ...record.context, ...result }) }], isError: false };
      record.status = entry.cancelling ? 'cancelled' : 'completed';
      record.statusMessage = `${record.jobId}: ${result.event}`;
      record.updatedAt = Date.now();
      save(record);
      notify(record);
    }).catch(error => {
      if (controller.signal.aborted) return; // Reconnect can resume a pending observation.
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.statusMessage = `${record.jobId}: ${record.error}`;
      record.updatedAt = Date.now();
      save(record);
      notify(record);
    }).finally(() => { watches.delete(record.taskId); records.delete(record.taskId); });
    return entry;
  };
  const refresh = async (record: EventTask) => {
    const active = ensureWatch(record);
    if (active && nextJobEvent(manager.store.get(record.jobId), record.answered)) await active.done;
    return record;
  };
  const get = async (id: string) => {
    await manager.initialize?.();
    return refresh(load(id));
  };
  const agentMeta = (record: EventTask, job: JobMeta) => ({
    'com.anthropic/agent-task': clientAgentTaskMeta.parse({
      kind: `${prefix}-agent`, taskId: record.taskId,
      ...(clientWireId.safeParse(job.sessionId).success ? { sessionId: job.sessionId } : {}),
      modelImmediateResponse: `${prefix === 'codex' ? 'Codex' : prefix} agent "${(job.label ?? 'job').slice(0, 80)}" (${(job.model ?? 'default').slice(0, 80)}, ${job.effort ?? 'default'}, ${job.mode}) is job ${job.id}. Task ${record.taskId} returns its next stop, pause, question or approval to you. Answer questions and approvals with ${prefix}_agent_answer using jobId ${job.id}; use ${prefix}_agent_message to steer or resume stopped jobs.`.replace(/[\p{C}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, 20000),
    }),
  });

  server.setRequestHandler(z.object({ method: z.literal('server/discover'), params: z.object({}).passthrough().optional() }),
    async () => {
      const { tasks: _tasks, ...capabilities } = discovery.capabilities;
      return { supportedVersions: [MODERN_PROTOCOL],
        capabilities: { ...capabilities, extensions: { [TASK_EXTENSION]: {} } },
        ...(discovery.instructions ? { instructions: discovery.instructions } : {}) };
    });
  server.setRequestHandler(GetTaskRequestSchema, async request => {
    const record = await get(request.params.taskId);
    return modern(request.params) ? projection(record) : base(record);
  });
  server.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
    const record = await get(request.params.taskId);
    const active = ensureWatch(record);
    if (active) await new Promise<void>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new McpError(ErrorCode.InvalidRequest, 'Task result wait cancelled')); };
      const cleanup = () => extra.signal.removeEventListener('abort', abort);
      extra.signal.addEventListener('abort', abort, { once: true });
      if (extra.signal.aborted) return abort();
      void active.done.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
    });
    if (!record.result) throw new McpError(ErrorCode.InternalError, record.error ?? 'Task has no event result');
    return record.result;
  });
  server.setRequestHandler(CancelTaskRequestSchema, async request => {
    const record = await get(request.params.taskId);
    if (record.status !== 'working') throw new McpError(ErrorCode.InvalidParams, 'Cannot cancel a terminal task');
    const active = ensureWatch(record)!;
    active.cancelling = true;
    try { await manager.cancel(record.jobId); }
    catch (error) { active.cancelling = false; throw error; }
    await active.done;
    return modern(request.params) ? projection(record) : base(record);
  });
  server.setRequestHandler(ListTasksRequestSchema, async request => {
    await manager.initialize?.();
    if (request.params?.cursor) throw new McpError(ErrorCode.InvalidParams, 'Task list has no further pages');
    const tasks = [];
    const files = existsSync(directory) ? readdirSync(directory) : [];
    for (const file of files.filter(file => file.endsWith('.json'))) {
      let record: EventTask;
      try { record = load(file.slice(0, -5)); } catch { continue; }
      await refresh(record);
      tasks.push(modern(request.params) ? projection(record) : base(record));
    }
    return { tasks };
  });

  return {
    async call(name: string, args: any, requestMeta?: Record<string, unknown>) {
      if (!supportsTask(prefix, name)) throw new McpError(ErrorCode.InvalidParams, `Tool ${name} does not support tasks`);
      const tool = registry.find(tool => tool.name === name)!;
      const parsed = tool.zodSchema.safeParse(args);
      if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${name}: ${parsed.error.message}`);
      await manager.initialize?.();
      const validated = parsed.data;
      const before = name === `${prefix}_agent_answer` ? manager.store.get(validated.jobId) : undefined;
      const context = name === `${prefix}_agent_follow` ? {} : JSON.parse(await startTool(name, validated) as string);
      if (name === `${prefix}_agent_message` && context.delivered !== 'resumed')
        return { content: [{ type: 'text' as const, text: JSON.stringify(context) }], isError: false };
      const jobId = context.jobId ?? validated.jobId;
      const job = manager.store.get(jobId);
      const taskId = name === `${prefix}_agent_answer` || existsSync(path(jobId)) ? randomUUID() : jobId;
      const record: EventTask = {
        taskId, jobId, connector: manager.connector.id, createdAt: Date.now(), updatedAt: Date.now(),
        modern: modern({ _meta: requestMeta }), status: 'working', statusMessage: progressMessage(manager, job),
        answered: { qid: context.qid ?? before?.awaitingInput?.qid, approvalId: before?.pendingApproval?.id }, context,
      };
      save(record);
      const marker = join(manager.store.dir(jobId), 'mcp-task.json');
      if (!existsSync(marker)) atomicWrite(marker, '{}');
      await refresh(record);
      return { task: base(record), _meta: agentMeta(record, job) };
    },
    close() {
      closed = true;
      for (const active of watches.values()) active.controller.abort();
      watches.clear();
      records.clear();
    },
  };
}
