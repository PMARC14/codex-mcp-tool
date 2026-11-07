import { test } from 'node:test';
import assert from 'node:assert/strict';
import spawn from 'cross-spawn';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, meta, until } from '../jobs/test-helpers.js';
import { JobStore } from '../jobs/store.js';
import { MODERN_PROTOCOL, TASK_EXTENSION, registerMcpTasks } from './mcp-tasks.js';
import { toolRegistry } from './registry.js';
import { clientTaskGet, clientCreateTask, clientAgentTaskMeta, clientTaskList, clientTaskNotification } from './client-schemas.js';
import { z } from 'zod';

const modernMeta = (tasks = true) => ({
  'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
  'io.modelcontextprotocol/clientInfo': { name: 'raw-task-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': tasks
    ? { extensions: { [TASK_EXTENSION]: {} } }
    : {},
});

async function setup(f = fixture(), era: 'legacy' | 'modern' = 'legacy') {
  const detectsPath = join(f.home, 'detects');
  const bootstrap = `
    const { codexJobManager: manager } = await import(${JSON.stringify(new URL('./index.js', import.meta.url).href)});
    const { fakeConnector } = await import(${JSON.stringify(new URL('../jobs/test-helpers.js', import.meta.url).href)});
    const { appendFileSync } = await import('node:fs');
    const connector = fakeConnector(${JSON.stringify(f.script)}, 'codex', ${Date.now() + 3600000});
    const detect = connector.detect;
    connector.detect = async () => { appendFileSync(${JSON.stringify(detectsPath)}, 'detect\\n'); return detect(); };
    Object.assign(manager, { connector });
    manager.config.wakeHold = false;
    await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    env: { ...process.env, AGENT_JOBS_HOME: f.home, AGENT_JOBS_MAX: '1', AGENT_JOBS_CHANNEL: '0' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0;
  let output = '';
  let stderr = '';
  const notifications: any[] = [];
  const pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  const exited = new Promise<void>(resolve =>
    child.once('close', () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Server exited: ${stderr}`));
      }
      pending.clear();
      resolve();
    })
  );
  child.stderr!.on('data', chunk => {
    stderr += String(chunk);
  });
  child.stdin!.on('error', () => {});
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', chunk => {
    output += chunk;
    let end: number;
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) {
        if (message.method === 'notifications/tasks/status') clientTaskNotification.parse(message);
        notifications.push(message);
      }
      else {
        const entry = pending.get(message.id);
        if (!entry) continue;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        entry.resolve(message);
      }
    }
  });
  const raw = (method: string, params?: any) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}\n${stderr}`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      child.stdin!.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }) + '\n'
      );
    });
  const rpc = async (method: string, params: any = {}) => {
    const response = await raw(
      method,
      era === 'modern' ? { ...params, _meta: modernMeta() } : params
    );
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    if (era === 'modern') {
      if (method === 'tasks/get' || method === 'tasks/cancel') clientTaskGet.parse(response.result);
      if (method === 'tasks/list') clientTaskList.parse(response.result);
      if (response.result.resultType === 'task') {
        clientCreateTask.parse(response.result);
        clientAgentTaskMeta.parse(response.result._meta['com.anthropic/agent-task']);
      }
    }
    return response.result;
  };
  const call = (name: string, args: any, task?: object) =>
    rpc('tools/call', {
      name,
      arguments: args,
      ...(task ? { task } : {}),
    });
  const store = new JobStore(f.home);
  const disconnect = async () => {
    child.stdin!.end();
    await exited;
  };
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  let initialized: any;
  try {
    initialized =
      era === 'legacy'
        ? await rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: { tasks: { list: {}, cancel: {} } },
            clientInfo: { name: 'raw-task-test', version: '1' },
          })
        : await rpc('server/discover');
    if (era === 'legacy')
      child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      );
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    f,
    initialized,
    store,
    notifications,
    raw,
    rpc,
    call,
    cleanup,
    disconnect,
    detects: () => readFileSync(detectsPath, 'utf8'),
    start: (options: any = {}, task?: object) =>
      call(
        'codex_job_start',
        {
          cwd: f.home,
          prompt: JSON.stringify({ waitMs: 1800, final: 'task result', ...options }),
        },
        task
      ),
  };
}

test('legacy task start returns immediately, polls metadata, notifies, and returns job_result verbatim', async () => {
  const s = await setup();
  try {
    assert.equal(s.initialized.protocolVersion, '2025-11-25');
    assert.deepEqual(s.initialized.capabilities.tasks.requests, { tools: { call: {} } });
    const created = await s.start({}, { ttl: 60000 });
    assert.deepEqual(Object.keys(created).sort(), ['_meta', 'task']);
    const { taskId } = created.task;
    assert.equal(created.task.status, 'working');
    assert.equal(created.task.pollInterval, 15000);
    assert.equal(created.task.ttl, null);
    assert.ok(Date.parse(created.task.createdAt));
    assert.equal((await s.rpc('tasks/get', { taskId })).status, 'working');
    const detects = s.detects();
    for (let i = 0; i < 12; i++) await s.rpc('tasks/get', { taskId });
    assert.equal(s.detects(), detects, 'polls do not detect or start CLI processes');
    const pendingResult = s.rpc('tasks/result', { taskId });
    await until(() => s.store.get(taskId).state === 'completed');
    const result = await pendingResult;
    assert.deepEqual(result, await s.call('codex_job_result', { jobId: taskId }));
    assert.equal(JSON.parse(result.content[0].text).final, 'task result');
    assert.equal((await s.rpc('tasks/get', { taskId })).status, 'completed');
    await until(() =>
      s.notifications.some(
        n => n.method === 'notifications/tasks/status' && n.params.status === 'completed'
      )
    );
    assert.ok(
      s.notifications
        .filter(n => n.method === 'notifications/tasks/status')
        .every(n => n.params.taskId === taskId)
    );
    assert.equal((await s.rpc('tasks/list')).tasks[0].taskId, taskId);
  } finally {
    await s.cleanup();
    s.f.cleanup();
  }
});

test('task cancel stops a running fake worker and returns cancelled', async () => {
  const s = await setup();
  try {
    const {
      task: { taskId },
    } = await s.start({ waitMs: 60000 }, {});
    await until(() => s.store.get(taskId).state === 'running' && !!s.store.get(taskId).sessionId);
    const result = await s.rpc('tasks/cancel', { taskId });
    assert.equal(result.status, 'cancelled');
    assert.equal(s.store.get(taskId).state, 'killed');
    assert.equal((await s.rpc('tasks/get', { taskId })).status, 'cancelled');
    assert.equal(
      JSON.parse((await s.rpc('tasks/result', { taskId })).content[0].text).state,
      'killed'
    );
    await until(() =>
      s.notifications.some(
        n => n.method === 'notifications/tasks/status' && n.params.status === 'cancelled'
      )
    );
    assert.equal((await s.raw('tasks/cancel', { taskId })).error.code, -32602);
  } finally {
    await s.cleanup();
    s.f.cleanup();
  }
});

test('paused tasks stay working until reset, and superseded jobs name their replacement', async () => {
  const s = await setup();
  try {
    const {
      task: { taskId },
    } = await s.start({ limit: true }, {});
    await until(() => s.store.get(taskId).state === 'paused');
    const paused = await s.rpc('tasks/get', { taskId });
    assert.equal(paused.status, 'working');
    assert.match(paused.statusMessage, /Paused until /);
    assert.ok(paused.statusMessage.includes(new Date(s.store.get(taskId).resetAt!).toISOString()));
    const replacement = await s.call('codex_job_requeue', { jobId: taskId });
    const supersededBy = JSON.parse(replacement.content[0].text).jobId;
    const superseded = await s.rpc('tasks/get', { taskId });
    assert.equal(superseded.status, 'cancelled');
    assert.ok(superseded.statusMessage.includes(supersededBy));
    await until(() => s.store.get(supersededBy).state === 'paused');
  } finally {
    await s.cleanup();
    s.f.cleanup();
  }
});

test('ordinary calls stay unchanged; task watch adopts the job immediately; execution is limited to two tools', async () => {
  const s = await setup();
  try {
    const tools = (await s.rpc('tools/list')).tools;
    assert.deepEqual(
      tools.filter((tool: any) => tool.execution).map((tool: any) => [tool.name, tool.execution]),
      [
        ['codex_job_start', { taskSupport: 'optional' }],
        ['codex_job_watch', { taskSupport: 'optional' }],
      ]
    );
    const started = await s.start();
    assert.equal(started.isError, false);
    assert.equal(started.task, undefined);
    const { jobId } = JSON.parse(started.content[0].text);
    assert.deepEqual((await s.rpc('tasks/list')).tasks, []);
    const watched = await s.call('codex_job_watch', { jobId, maxWaitSec: 0 });
    const watchResult = JSON.parse(watched.content[0].text);
    assert.equal(watchResult.timedOut, true);
    assert.equal(watchResult.jobId, jobId);
    assert.equal(s.notifications.filter(n => n.method === 'notifications/tasks/status').length, 0);
    const taskWatch = await s.call('codex_job_watch', { jobId }, {});
    assert.equal(taskWatch.task.taskId, jobId);
    assert.equal(taskWatch.task.status, 'working');
    await until(() => s.store.get(jobId).state === 'completed');
    assert.deepEqual(
      await s.rpc('tasks/result', { taskId: jobId }),
      await s.call('codex_job_result', { jobId })
    );
    const invalid = await s.raw('tools/call', { name: 'ping', arguments: {}, task: {} });
    assert.equal(invalid.error.code, -32602);
  } finally {
    await s.cleanup();
    s.f.cleanup();
  }
});

test('tasks survive reconnect; read-only lookup does not subscribe and other connectors are excluded', async () => {
  const f = fixture();
  const first = await setup(f);
  let taskId: string;
  try {
    taskId = (await first.start({ waitMs: 10 }, {})).task.taskId;
    await until(() => first.store.get(taskId).state === 'completed');
    await first.disconnect();
  } finally {
    await first.cleanup();
  }
  const s = await setup(f);
  try {
    s.store.create(meta(f.home, { id: 'other', connector: 'agy', state: 'completed' }), 'fake');
    assert.equal((await s.rpc('tasks/get', { taskId })).status, 'completed');
    assert.deepEqual(
      await s.rpc('tasks/result', { taskId }),
      await s.call('codex_job_result', { jobId: taskId })
    );
    assert.deepEqual(
      (await s.rpc('tasks/list')).tasks.map((t: any) => t.taskId),
      [taskId]
    );
    for (const id of ['other', 'missing', '../bad']) {
      assert.equal((await s.raw('tasks/get', { taskId: id })).error.code, -32602);
    }
    await s.start({ waitMs: 10 });
    await until(() =>
      s.store
        .list()
        .filter(j => j.connector === 'codex')
        .every(j => j.state === 'completed')
    );
    assert.equal(s.notifications.filter(n => n.method === 'notifications/tasks/status').length, 0);
  } finally {
    await s.cleanup();
    f.cleanup();
  }
});

test('modern discovery, extension opt-in, task get, and complete envelopes match Claude v2 shapes', async () => {
  const s = await setup(undefined, 'modern');
  try {
    assert.deepEqual(s.initialized.supportedVersions, [MODERN_PROTOCOL]);
    assert.deepEqual(s.initialized.capabilities.extensions[TASK_EXTENSION], {});
    assert.equal(s.initialized.capabilities.tasks, undefined);
    assert.equal(s.initialized.resultType, 'complete');
    const tools = await s.rpc('tools/list');
    assert.equal(tools.resultType, 'complete');
    assert.equal(tools.ttlMs, 0);
    assert.equal(tools.cacheScope, 'private');
    assert.ok(tools.tools.every((tool: any) => tool.execution === undefined));
    const created = await s.start(); // Modern augmentation is requested by the envelope extension.
    assert.equal(created.resultType, 'task');
    assert.equal(created.status, 'working');
    assert.equal(created.pollIntervalMs, 15000);
    assert.equal(created.task, undefined);
    const { taskId } = created;
    clientTaskGet.parse(await s.rpc('tasks/get', { taskId }));
    await until(() => s.store.get(taskId).state === 'completed');
    const result = await s.rpc('tasks/get', { taskId });
    assert.equal(result.status, 'completed');
    assert.equal(result.resultType, undefined);
    assert.equal(
      result.result.content[0].text,
      (await s.call('codex_job_result', { jobId: taskId })).content[0].text
    );
    const ordinary = await s.raw('tools/call', {
      name: 'codex_job_start',
      arguments: { prompt: JSON.stringify({ waitMs: 10 }), cwd: s.f.home },
      _meta: modernMeta(false),
    });
    assert.equal(ordinary.result.resultType, 'complete');
    assert.ok(JSON.parse(ordinary.result.content[0].text).jobId);
    const watch = await s.call('codex_job_watch', { jobId: taskId });
    assert.equal(watch.resultType, 'task');
    assert.equal(watch.taskId, taskId);
    assert.equal(watch.status, 'completed');
    await until(() => s.store.list().every(j => j.state === 'completed'));
  } finally {
    await s.cleanup();
    s.f.cleanup();
  }
});

test('failed and lost jobs map to failed, and pause without reset remains working', async () => {
  const s = await setup();
  try {
    for (const state of ['failed', 'lost', 'paused', 'queued'] as const) {
      s.store.create(meta(s.f.home, { id: `seed-${state}`, state, pauseCleared: true }), 'fake');
      const task = await s.rpc('tasks/get', { taskId: `seed-${state}` });
      assert.equal(task.status, ['failed', 'lost'].includes(state) ? 'failed' : 'working');
      if (state === 'paused') assert.match(task.statusMessage, /reset time unknown/);
    }
  } finally {
    await s.cleanup();
    s.f.cleanup();
  }
});
test('task notifications follow derived approval status and suppress unchanged projections', async () => {
  const f = fixture();
  const store = new JobStore(f.home);
  const notices: any[] = [];
  const manager = { connector: { id: 'codex' }, store, onTransition: store.onWrite.bind(store) };
  const server = { setRequestHandler() {}, async notification(value: any) { notices.push(value); } };
  const before = toolRegistry.length;
  toolRegistry.push({ name: 'codex_job_watch', zodSchema: z.object({ jobId: z.string() }) } as any);
  const tasks = registerMcpTasks(server as any, 'codex', manager as any, { capabilities: {} });
  try {
    const job = meta(f.home, { state: 'running' });
    store.create(job, 'fake');
    await tasks.call('codex_job_watch', { jobId: job.id });
    const approval = { id: 'a', kind: 'commandExecution', summary: 'fake', requestedAt: 1 };
    store.write({ ...job, pendingApproval: approval });
    store.write({ ...job, pendingApproval: approval });
    store.write(job);
    store.write({ ...job, state: 'paused' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(notices.map(n => n.params.status), ['input_required', 'working']);
    notices.forEach(notice => clientTaskNotification.parse(notice));
  } finally { tasks.close(); toolRegistry.splice(before); f.cleanup(); }
});

test('modern cancel returns a task projection with modern timing fields', async () => {
  const s = await setup(undefined, 'modern');
  try {
    const { taskId } = await s.start({ waitMs: 60000 });
    await until(() => s.store.get(taskId).state === 'running' && !!s.store.get(taskId).sessionId);
    const cancelled = await s.rpc('tasks/cancel', { taskId });
    assert.equal(cancelled.resultType, undefined);
    assert.equal(cancelled.taskId, taskId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.ttlMs, null);
    assert.equal(cancelled.pollIntervalMs, 15000);
    for (const key of ['ttl', 'pollInterval', 'cacheScope', 'content']) assert.equal(key in cancelled, false);
    const result = await s.rpc('tasks/get', { taskId });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.resultType, undefined);
  } finally { await s.cleanup(); s.f.cleanup(); }
});
