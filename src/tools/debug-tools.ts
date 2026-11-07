import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { JobManager } from '../jobs/manager.js';
import type { JobMeta } from '../jobs/connector.js';
import { JobStore } from '../jobs/store.js';
import { registerJobTools } from '../jobs/tools.js';
import { MODERN_PROTOCOL, TASK_EXTENSION, TaskStdioTransport, registerMcpTasks, taskCapabilities } from './mcp-tasks.js';
import { clientAgentTaskMeta, clientCreateTask, clientTaskGet, clientTaskList, clientTaskNotification } from './client-schemas.js';
import { installRequestErrorReporting, trafficLog, type TrafficLog } from './traffic-log.js';
import type { UnifiedTool } from './registry.js';

/** Run the real stdio adapter and request handlers against an isolated fake manager.
 * No JobManager.initialize, connector, CLI, process, or model is involved. */
export async function runSelftest(log: TrafficLog = trafficLog) {
  const home = mkdtempSync(join(tmpdir(), 'agent-jobs-selftest-'));
  const store = new JobStore(home);
  const steps: { step: string; pass: boolean; error?: string }[] = [];
  const notices: any[] = [];
  const manager = {
    connector: { id: 'codex' }, store, onTransition: store.onWrite.bind(store),
    async start() {
      const id = randomUUID();
      const job: JobMeta = { id, connector: 'codex', cwd: home, mode: 'read', transport: 'exec',
        label: 'selftest', timeoutMin: 1, finalPath: store.path(id, 'final'),
        state: 'running', createdAt: Date.now(), updatedAt: Date.now() };
      store.create(job, 'fake selftest');
      return { jobId: id, state: job.state };
    },
    async result(id: string) { return { jobId: id, state: store.get(id).state, final: 'fake selftest result' }; },
    async cancel(id: string) { store.write({ ...store.get(id), state: 'killed' }); },
  } as unknown as JobManager;
  const registry: UnifiedTool[] = [];
  registerJobTools(registry, 'codex', manager);
  const input = new PassThrough();
  let sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; timer: NodeJS.Timeout }>();
  const output = new Writable({ write(chunk, _encoding, done) {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line);
      if (message.id === undefined) notices.push(message);
      else {
        const entry = pending.get(message.id);
        if (entry) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message); }
      }
    }
    done();
  } });
  const server = new Server({ name: 'codex-selftest', version: '1' }, { capabilities: { tasks: taskCapabilities, tools: {} } });
  installRequestErrorReporting(server, log);
  const tasks = registerMcpTasks(server, 'codex', manager, { capabilities: {} },
    async (name, args) => registry.find(tool => tool.name === name)!.execute(args), registry);
  server.setRequestHandler(CallToolRequestSchema, request => tasks.call(request.params.name, request.params.arguments));
  const transport = new TaskStdioTransport('codex', log, input, output);
  const rpc = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} response timeout`)); }, 3000);
    pending.set(id, { resolve: message => message.error ? reject(new Error(message.error.message)) : resolve(message.result), timer });
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
      'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASK_EXTENSION]: {} } },
    } } }) + '\n');
  });
  const check = async (step: string, action: () => Promise<void>) => {
    try { await action(); steps.push({ step, pass: true }); }
    catch (error) { steps.push({ step, pass: false, error: (error as Error).message }); }
  };
  let taskId = '';
  const start = async () => {
    const created = await rpc('tools/call', { name: 'codex_agent', arguments: { prompt: 'fake selftest', cwd: home } });
    clientCreateTask.parse(created);
    clientAgentTaskMeta.parse(created._meta['com.anthropic/agent-task']);
    return created.taskId as string;
  };
  try {
    await server.connect(transport);
    await check('start', async () => { taskId = await start(); });
    await check('get working', async () => { clientTaskGet.parse(await rpc('tasks/get', { taskId })); });
    await check('list', async () => { clientTaskList.parse(await rpc('tasks/list')); });
    for (const state of ['queued', 'paused', 'running'] as const) {
      await check(`get ${state === 'running' ? 'input_required' : state}`, async () => {
        store.write({ ...store.get(taskId), state,
          pendingApproval: state === 'running' ? { id: 'fake', kind: 'userInput', summary: 'fake question', requestedAt: Date.now() } : undefined });
        const reply = await rpc('tasks/get', { taskId });
        clientTaskGet.parse(reply);
        if (reply.status !== (state === 'running' ? 'input_required' : 'working')) throw new Error('wrong status');
        if (state === 'running' && !reply.statusMessage.includes('awaiting answer')) throw new Error('missing awaiting answer');
      });
    }

    for (const state of ['completed', 'failed', 'lost'] as const) {
      await check(`get ${state}`, async () => {
        store.write({ ...store.get(taskId), state, pendingApproval: undefined, failureReason: state === 'lost' ? 'lost' : 'cli_error', error: 'fake failure' });
        const reply = await rpc('tasks/get', { taskId });
        clientTaskGet.parse(reply);
        CallToolResultSchema.parse(reply.result);
        if (reply.status !== (state === 'completed' ? 'completed' : 'failed')) throw new Error('wrong status');
      });
    }
    await check('result', async () => { CallToolResultSchema.parse(await rpc('tasks/result', { taskId })); });
    await check('cancel', async () => {
      const id = await start();
      const reply = await rpc('tasks/cancel', { taskId: id });
      clientTaskGet.parse(reply);
      if (reply.status !== 'cancelled') throw new Error('cancel did not cancel');
    });
    await check('notifications', async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (!notices.length) throw new Error('no status notifications');
      notices.forEach(notice => clientTaskNotification.parse(notice));
    });
    return { pass: steps.every(step => step.pass), steps, logPath: log.path };
  } finally {
    tasks.close();
    await server.close();
    for (const entry of pending.values()) clearTimeout(entry.timer);
    input.destroy(); output.destroy();
    rmSync(home, { recursive: true, force: true });
  }
}

export const selftestTool: UnifiedTool = {
  name: 'codex_selftest', description: 'Validate this server task transport end-to-end against Claude Code 2.1.319 schemas using isolated in-process fake jobs. Starts no CLI or model.',
  zodSchema: z.object({}), execute: async () => JSON.stringify(await runSelftest()),
};
export const debugLogTool: UnifiedTool = {
  name: 'codex_debug_log', description: 'Return the last N lines of this server traffic log, including structured handler errors. Prompts and worker content are redacted.',
  zodSchema: z.object({ lines: z.number().int().min(1).max(200).default(50) }),
  execute: async args => JSON.stringify({ logPath: trafficLog.path, lines: trafficLog.tail((args as any).lines) }),
};
