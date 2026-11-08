import { test } from 'node:test';
import assert from 'node:assert/strict';
import spawn from 'cross-spawn';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

async function setup(f = fixture(), era: 'legacy' | 'modern' = 'legacy', options: { tasks?: boolean; slowInitialize?: boolean } = {}) {
  const detectsPath = join(f.home, 'detects');
  const initializeGate = join(f.home, 'initialize-release');
  const initializeStarted = join(f.home, 'initialize-started');
  const bootstrap = `
    const { codexJobManager: manager } = await import(${JSON.stringify(new URL('./index.js', import.meta.url).href)});
    const { fakeConnector } = await import(${JSON.stringify(new URL('../jobs/test-helpers.js', import.meta.url).href)});
    const { appendFileSync, existsSync, writeFileSync } = await import('node:fs');
    const connector = fakeConnector(${JSON.stringify(f.script)}, 'codex', ${Date.now() + 3600000});
    const detect = connector.detect;
    connector.detect = async () => { appendFileSync(${JSON.stringify(detectsPath)}, 'detect\\n'); return detect(); };
    Object.assign(manager, { connector });
    manager.config.wakeHold = false;
    if (${!!options.slowInitialize}) {
      const initialize = manager.initialize.bind(manager);
      let ready;
      manager.initialize = () => ready ??= (async () => {
        writeFileSync(${JSON.stringify(initializeStarted)}, '');
        while (!existsSync(${JSON.stringify(initializeGate)})) await new Promise(resolve => setTimeout(resolve, 10));
        await initialize();
      })();
    }
    await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    env: { ...process.env, AGENT_JOBS_HOME: f.home, AGENT_JOBS_MAX: '1' },
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
      era === 'modern' ? { ...params, _meta: modernMeta(options.tasks !== false) } : params
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
            capabilities: options.tasks === false ? {} : { tasks: { list: {}, cancel: {} } },
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
    initializeStarted,
    releaseInitialize: () => writeFileSync(initializeGate, ''),
    detects: () => readFileSync(detectsPath, 'utf8'),
    start: (options: any = {}, task?: object) =>
      call(
        'codex_agent',
        {
          cwd: f.home,
          prompt: JSON.stringify({ waitMs: 1800, final: 'task result', ...options }),
        },
        task
      ),
  };
}

const taskIdOf = (response: any): string => response.taskId ?? response.task.taskId;
const eventResult = (response: any) => JSON.parse(response.content[0].text);
const ask = (s: Awaited<ReturnType<typeof setup>>, jobId: string, qid: string) =>
  writeFileSync(join(s.store.dir(jobId), 'question.json'),
    JSON.stringify({ id: qid, question: `Question ${qid}?`, options: ['yes', 'no'], askedAt: Date.now() }));
const noForms = (s: Awaited<ReturnType<typeof setup>>) => {
  assert.ok(s.notifications.every(n => n.method !== 'elicitation/create' &&
    n.params?.status !== 'input_required' && n.params?.inputRequests === undefined));
  assert.doesNotMatch(JSON.stringify(s.notifications), /elicitation\/create|inputRequests/);
};

async function rejectMessage(s: Awaited<ReturnType<typeof setup>>, era: 'legacy' | 'modern', jobId: string, qid: string) {
  const response = await s.raw('tools/call', { name: 'codex_agent_message', arguments: { jobId, message: 'no' },
    ...(era === 'modern' ? { _meta: modernMeta() } : {}) });
  assert.match(response.error?.message ?? response.result.content[0].text, new RegExp(`codex_agent_answer.*${qid}`));
}

for (const era of ['legacy', 'modern'] as const) {
  const taskArg = era === 'legacy' ? {} : undefined;
  test(`${era} question completes a task; answers create new event tasks without elicitation`, async () => {
    const s = await setup(undefined, era);
    const gate = join(s.f.home, 'finish');
    try {
      if (era === 'modern') {
        assert.deepEqual(s.initialized.supportedVersions, [MODERN_PROTOCOL]);
        assert.deepEqual(s.initialized.capabilities.extensions[TASK_EXTENSION], {});
        for (const field of ['resultType', 'ttlMs', 'cacheScope']) assert.equal(s.initialized[field], undefined);
      }
      const tools = (await s.rpc('tools/list')).tools;
      if (era === 'legacy') assert.deepEqual(tools.filter((t: any) => t.execution).map((t: any) => t.name), [
        'codex_agent', 'codex_agent_follow', 'codex_agent_message', 'codex_agent_resume', 'codex_agent_answer', 'codex_agent_retry',
      ]);
      else assert.ok(tools.every((t: any) => t.execution === undefined));
      const created = await s.start({ gate }, taskArg);
      const taskId = taskIdOf(created), jobId = taskId;
      assert.equal((created.task ?? created).status, 'working');
      await until(() => s.store.get(jobId).state === 'running' && !!s.store.get(jobId).sessionId);
      const detects = s.detects();
      for (let i = 0; i < 3; i++) assert.equal((await s.rpc('tasks/get', { taskId })).status, 'working');
      assert.equal(s.detects(), detects);
      const pending = s.rpc('tasks/result', { taskId });
      ask(s, jobId, 'first');
      const first = await pending;
      assert.equal(eventResult(first).event, 'question');
      assert.equal(eventResult(first).jobId, jobId);
      assert.equal(eventResult(first).state, 'running');
      assert.equal(eventResult(first).awaitingInput.qid, 'first');
      assert.equal(eventResult(first).awaitingInput.question, 'Question first?');
      assert.deepEqual(eventResult(first).awaitingInput.options, ['yes', 'no']);
      assert.equal((await s.rpc('tasks/get', { taskId })).status, 'completed');
      await rejectMessage(s, era, jobId, 'first');
      const update = await s.raw('tasks/update', { taskId, inputResponses: { first: { action: 'accept', content: { answer: 'no' } } },
        ...(era === 'modern' ? { _meta: modernMeta() } : {}) });
      assert.equal(update.error.code, -32601);
      assert.equal(existsSync(join(s.store.dir(jobId), 'answer-first.json')), false);
      const answered = await s.call('codex_agent_answer', { jobId, qid: 'first', answer: 'yes' }, taskArg);
      const answerTask = taskIdOf(answered);
      assert.notEqual(answerTask, taskId);
      assert.equal((answered.task ?? answered).status, 'working');
      const waiting = s.rpc('tasks/result', { taskId: answerTask });
      ask(s, jobId, 'second');
      const second = eventResult(await waiting);
      assert.equal(second.event, 'question');
      assert.equal(second.jobId, jobId);
      assert.equal(second.qid, 'first');
      assert.equal(second.awaitingInput.qid, 'second');
      assert.deepEqual(eventResult(await s.rpc('tasks/result', { taskId })), eventResult(first), 'completed question is immutable');
      const finish = await s.call('codex_agent_answer', { jobId, qid: 'second', answer: 'no' }, taskArg);
      const finishTask = taskIdOf(finish);
      assert.notEqual(finishTask, answerTask);
      writeFileSync(gate, '');
      const final = eventResult(await s.rpc('tasks/result', { taskId: finishTask }));
      assert.equal(final.event, 'stopped');
      assert.equal(final.jobId, jobId);
      assert.equal(final.state, 'completed');
      assert.equal(final.final, 'task result');
      assert.equal(final.awaitingInput, undefined);
      assert.equal(eventResult(await s.rpc('tasks/result', { taskId: answerTask })).awaitingInput.qid, 'second');
      const listed = (await s.rpc('tasks/list')).tasks;
      assert.equal(listed.length, 3);
      assert.ok(listed.every((t: any) => t.status === 'completed'));
      await until(() => s.notifications.some(n => n.params?.taskId === taskId && n.params?.status === 'completed'));
      noForms(s);
    } finally { await s.cleanup(); s.f.cleanup(); }
  });

  test(`${era} task cancellation stops the job and saves a stopped result`, async () => {
    const s = await setup(undefined, era);
    try {
      const taskId = taskIdOf(await s.start({ waitMs: 60000 }, taskArg));
      await until(() => s.store.get(taskId).state === 'running' && !!s.store.get(taskId).sessionId);
      const cancelled = await s.rpc('tasks/cancel', { taskId });
      assert.equal(cancelled.status, 'cancelled');
      assert.equal((await s.rpc('tasks/get', { taskId })).status, 'cancelled');
      const result = eventResult(await s.rpc('tasks/result', { taskId }));
      assert.equal(result.state, 'killed');
      assert.equal(result.event, 'stopped');
      assert.equal((await s.raw('tasks/cancel', { taskId })).error.code, -32602);
      if (era === 'modern') { assert.equal(cancelled.ttlMs, null); assert.equal(cancelled.ttl, undefined); }
      else { assert.equal(cancelled.ttl, null); assert.equal(cancelled.ttlMs, undefined); }
      noForms(s);
    } finally { await s.cleanup(); s.f.cleanup(); }
  });

  test(`${era} retry and resume return tasks that complete at a pause or stop`, async () => {
    const s = await setup(undefined, era);
    try {
      const sourceId = taskIdOf(await s.start({ limit: true, once: join(s.f.home, 'once') }, taskArg));
      const paused = await s.rpc('tasks/result', { taskId: sourceId });
      assert.equal(eventResult(paused).event, 'paused');
      assert.equal(eventResult(paused).state, 'paused');
      assert.equal((await s.rpc('tasks/get', { taskId: sourceId })).status, 'completed');
      const retryId = taskIdOf(await s.call('codex_agent_retry', { jobId: sourceId }, taskArg));
      assert.notEqual(retryId, sourceId);
      const retried = eventResult(await s.rpc('tasks/result', { taskId: retryId }));
      assert.equal(retried.event, 'stopped');
      assert.equal(retried.state, 'completed');
      assert.deepEqual(eventResult(await s.rpc('tasks/result', { taskId: sourceId })), eventResult(paused));
      const resumeId = taskIdOf(await s.call('codex_agent_message', {
        jobId: retryId, message: JSON.stringify({ final: 'resumed' }), mode: 'write', model: 'fake', effort: 'high', timeoutMin: 5,
      }, taskArg));
      const job = s.store.get(resumeId);
      assert.equal(job.followUpOf, retryId);
      assert.equal(job.resumeSession, 'fake-session');
      assert.equal(job.mode, 'write'); assert.equal(job.model, 'fake'); assert.equal(job.effort, 'high'); assert.equal(job.timeoutMin, 5);
      const result = eventResult(await s.rpc('tasks/result', { taskId: resumeId }));
      assert.equal(result.event, 'stopped'); assert.equal(result.final, 'resumed');
      assert.equal(result.delivered, 'resumed');
      const explicit = await s.call('codex_agent_resume', { jobId: resumeId, message: JSON.stringify({ final: 'explicit resume' }) }, taskArg);
      assert.equal(eventResult(await s.rpc('tasks/result', { taskId: taskIdOf(explicit) })).final, 'explicit resume');
      noForms(s);
    } finally { await s.cleanup(); s.f.cleanup(); }
  });

  test(`${era} non-task start blocks, reports job progress, and returns completion`, async () => {
    const s = await setup(undefined, era, { tasks: false });
    const gate = join(s.f.home, 'finish');
    try {
      let settled = false;
      const pending = s.raw('tools/call', {
        name: 'codex_agent', arguments: { cwd: s.f.home, prompt: JSON.stringify({ gate, final: 'native wake' }) },
        _meta: { ...(era === 'modern' ? modernMeta(false) : {}), progressToken: 'launch' },
      }).then(value => { settled = true; return value; });
      await until(() => s.store.list().some(job => job.state === 'running' && !!job.sessionId));
      const job = s.store.list()[0];
      await until(() => s.notifications.some(n => n.method === 'notifications/progress' && n.params.message.includes(job.id)));
      assert.equal(settled, false);
      writeFileSync(gate, '');
      const response = await pending;
      assert.equal(response.error, undefined); assert.equal(response.result.isError, false);
      const result = eventResult(response.result);
      assert.equal(result.jobId, job.id); assert.equal(result.state, 'completed'); assert.equal(result.event, 'stopped');
      assert.equal(result.final, 'native wake'); assert.equal(result.timedOut, false);
      assert.deepEqual((await s.rpc('tasks/list')).tasks, []);
      const progress = s.notifications.filter(n => n.method === 'notifications/progress').map(n => n.params);
      assert.ok(progress.every(p => p.message.includes(job.id)));
      assert.deepEqual(progress.map(p => p.progress), progress.map((_, i) => i));
      noForms(s);
    } finally { await s.cleanup(); s.f.cleanup(); }
  });

  test(`${era} non-task start and answers return the next question, then completion`, async () => {
    const s = await setup(undefined, era, { tasks: false });
    const gate = join(s.f.home, 'finish');
    try {
      const start = s.start({ gate });
      await until(() => s.store.list().some(job => job.state === 'running' && !!job.sessionId));
      const jobId = s.store.list()[0].id;
      ask(s, jobId, 'first');
      const initial = eventResult(await start);
      assert.equal(initial.event, 'question'); assert.equal(initial.jobId, jobId); assert.equal(initial.state, 'running');
      assert.equal(initial.awaitingInput.qid, 'first');
      let settled = false;
      const answer = s.call('codex_agent_answer', { jobId, qid: 'first', answer: 'yes' }).then(value => { settled = true; return value; });
      await until(() => existsSync(join(s.store.dir(jobId), 'answer-first.json')));
      await s.call('codex_agent_status', { jobId });
      assert.equal(settled, false);
      ask(s, jobId, 'second');
      const next = eventResult(await answer);
      assert.equal(next.event, 'question'); assert.equal(next.qid, 'first'); assert.equal(next.awaitingInput.qid, 'second');
      await rejectMessage(s, era, jobId, 'second');
      const finish = s.call('codex_agent_answer', { jobId, qid: 'second', answer: 'no' });
      await until(() => existsSync(join(s.store.dir(jobId), 'answer-second.json')));
      writeFileSync(gate, '');
      const final = eventResult(await finish);
      assert.equal(final.event, 'stopped'); assert.equal(final.state, 'completed'); assert.equal(final.awaitingInput, undefined);
      noForms(s);
    } finally { await s.cleanup(); s.f.cleanup(); }
  });

  test(`${era} non-task retry and resume wait on the replacement job`, async () => {
    const s = await setup(undefined, era, { tasks: false });
    const gate = join(s.f.home, 'retry-finish');
    try {
      const source = eventResult(await s.start({ limit: true, once: join(s.f.home, 'once'), gate }));
      assert.equal(source.event, 'paused');
      let retried = false;
      const retry = s.call('codex_agent_retry', { jobId: source.jobId }).then(value => { retried = true; return value; });
      await until(() => s.store.list().some(job => job.requeuedFrom === source.jobId && job.state === 'running' && !!job.sessionId));
      await s.call('codex_agent_list', {}); assert.equal(retried, false);
      writeFileSync(gate, '');
      const result = eventResult(await retry);
      assert.notEqual(result.jobId, source.jobId); assert.equal(result.event, 'stopped');
      const resumeGate = join(s.f.home, 'resume-finish');
      const resume = s.call('codex_agent_resume', { jobId: result.jobId, message: JSON.stringify({ gate: resumeGate }) });
      await until(() => s.store.list().some(job => job.followUpOf === result.jobId && job.state === 'running' && !!job.sessionId));
      const job = s.store.list().find(job => job.followUpOf === result.jobId)!;
      ask(s, job.id, 'resume-question');
      const next = eventResult(await resume);
      assert.equal(next.jobId, job.id); assert.equal(next.event, 'question');
      const finish = s.call('codex_agent_answer', { jobId: job.id, qid: 'resume-question', answer: 'yes' });
      await until(() => existsSync(join(s.store.dir(job.id), 'answer-resume-question.json')));
      writeFileSync(resumeGate, '');
      assert.equal(eventResult(await finish).event, 'stopped');
      noForms(s);
    } finally { await s.cleanup(); s.f.cleanup(); }
  });

  for (const tasks of [true, false]) test(`${era} message resumes a failed session with ${tasks ? 'a new task' : 'a blocking wait'}`, async () => {
    const s = await setup(undefined, era, { tasks });
    const gate = join(s.f.home, 'message-finish');
    try {
      const started = await s.start({ code: 1 }, tasks ? taskArg : undefined);
      const failed = tasks ? eventResult(await s.rpc('tasks/result', { taskId: taskIdOf(started) })) : eventResult(started);
      assert.equal(failed.state, 'failed');
      let settled = false;
      const pending = s.call('codex_agent_message', { jobId: failed.jobId, message: JSON.stringify({ gate, final: 'resumed failed job' }),
        mode: 'write', effort: 'high', timeoutMin: 5 }, tasks ? taskArg : undefined).then(value => { settled = true; return value; });
      await until(() => s.store.list().some(job => job.followUpOf === failed.jobId && job.state === 'running' && !!job.sessionId));
      const job = s.store.list().find(job => job.followUpOf === failed.jobId)!;
      assert.equal(job.resumeSession, 'fake-session');
      assert.equal(job.mode, 'write'); assert.equal(job.effort, 'high'); assert.equal(job.timeoutMin, 5);
      await s.call('codex_agent_status', { jobId: job.id });
      if (!tasks) assert.equal(settled, false, 'message resume stays pending until an event');
      writeFileSync(gate, '');
      const response = await pending;
      const result = tasks ? eventResult(await s.rpc('tasks/result', { taskId: taskIdOf(response) })) : eventResult(response);
      assert.equal(result.delivered, 'resumed'); assert.equal(result.event, 'stopped');
      assert.equal(result.jobId, job.id); assert.equal(result.final, 'resumed failed job');
      noForms(s);
    } finally { await s.cleanup(); s.f.cleanup(); }
  });
}

test('explicit blocking follow keeps its deadline and returns on questions and paused jobs', async () => {
  const s = await setup(undefined, 'modern', { tasks: false });
  const gate = join(s.f.home, 'finish');
  try {
    const start = s.start({ gate });
    await until(() => s.store.list().some(job => job.state === 'running' && !!job.sessionId));
    const jobId = s.store.list()[0].id;
    const timeout = eventResult(await s.call('codex_agent_follow', { jobId, maxWaitSec: 0.01 }));
    assert.equal(timeout.timedOut, true); assert.equal(timeout.event, undefined);
    const follow = s.call('codex_agent_follow', { jobId });
    ask(s, jobId, 'follow-question');
    assert.equal(eventResult(await follow).event, 'question');
    assert.equal(eventResult(await start).event, 'question');
    const finish = s.call('codex_agent_answer', { jobId, qid: 'follow-question', answer: 'yes' });
    await until(() => existsSync(join(s.store.dir(jobId), 'answer-follow-question.json')));
    writeFileSync(gate, ''); await finish;
    s.store.create(meta(s.f.home, { id: 'paused', state: 'paused', resetAt: Date.now() + 3600000, pauseCleared: true }), 'p');
    assert.equal(eventResult(await s.call('codex_agent_follow', { jobId: 'paused' })).event, 'paused');
  } finally { await s.cleanup(); s.f.cleanup(); }
});

test('task follow handles approvals, ignores answered ids, and snapshots the next question', async () => {
  const f = fixture(); const store = new JobStore(f.home);
  const notices: any[] = []; const handlers = new Map<string, any>();
  const server = { setRequestHandler(schema: any, handler: any) { handlers.set(schema.shape.method.value, handler); }, async notification(value: any) { notices.push(value); } };
  let reads = 0;
  const manager = { connector: { id: 'codex' }, store, onTransition: store.onWrite.bind(store), async initialize() {},
    async result(jobId: string) { reads++; return { jobId, state: store.get(jobId).state }; } };
  const registry = [
    { name: 'codex_agent_follow', zodSchema: z.object({ jobId: z.string() }) },
    { name: 'codex_agent_answer', zodSchema: z.object({ jobId: z.string(), decision: z.string() }) },
  ] as any;
  const tasks = registerMcpTasks(server as any, 'codex', manager as any, { capabilities: {} }, async () => JSON.stringify({ responded: true }), registry);
  try {
    const job = meta(f.home, { state: 'running' }); store.create(job, 'p');
    const first = await tasks.call('codex_agent_follow', { jobId: job.id }, modernMeta());
    assert.ok(first.task);
    const approval = { id: 1, kind: 'commandExecution', summary: 'Approve command?', requestedAt: Date.now() };
    store.write({ ...job, pendingApproval: approval });
    const get = (taskId: string) => handlers.get('tasks/get')({ params: { taskId, _meta: modernMeta() } });
    const firstResult = await get(first.task.taskId);
    assert.equal(firstResult.status, 'completed'); assert.equal(eventResult(firstResult.result).event, 'approval');
    assert.deepEqual(eventResult(firstResult.result).pendingApproval, approval);
    const answer = await tasks.call('codex_agent_answer', { jobId: job.id, decision: 'accept' }, modernMeta());
    assert.ok(answer.task);
    assert.notEqual(answer.task.taskId, first.task.taskId); assert.equal(answer.task.status, 'working');
    store.write({ ...job, pendingApproval: { ...approval, requestedAt: approval.requestedAt + 1 } });
    assert.equal((await get(answer.task.taskId)).status, 'working');
    const question = { qid: 'next', question: 'Next question?', askedAt: Date.now() };
    store.write({ ...job, awaitingInput: question });
    const next = await get(answer.task.taskId);
    assert.equal(eventResult(next.result).event, 'question'); assert.deepEqual(eventResult(next.result).awaitingInput, question);
    const count = reads;
    await get(answer.task.taskId); await get(first.task.taskId);
    assert.equal(reads, count, 'completed snapshots do not rebuild job results');
    assert.equal(handlers.has('tasks/update'), false);
    assert.ok(notices.every(n => n.params.status !== 'input_required' && !n.params.inputRequests));
  } finally { tasks.close(); f.cleanup(); }
});

test('completed event tasks survive reconnect; unrelated jobs are not exposed as tasks', async () => {
  const f = fixture(); const first = await setup(f, 'modern');
  let taskId = '';
  let snapshot: any;
  try {
    taskId = taskIdOf(await first.start({ waitMs: 10 }));
    snapshot = eventResult(await first.rpc('tasks/result', { taskId }));
    await first.disconnect();
  } finally { await first.cleanup(); }
  const s = await setup(f, 'modern');
  try {
    s.store.create(meta(f.home, { id: 'other', connector: 'agy', state: 'completed' }), 'fake');
    s.store.write({ ...s.store.get(taskId), state: 'failed', error: 'later edit' });
    const task = await s.rpc('tasks/get', { taskId });
    assert.equal(task.status, 'completed'); assert.deepEqual(eventResult(task.result), snapshot);
    for (const id of ['other', 'missing', '../bad']) assert.equal((await s.raw('tasks/get', { taskId: id })).error.code, -32602);
    assert.deepEqual((await s.rpc('tasks/list')).tasks.map((t: any) => t.taskId), [taskId]);
    assert.equal(s.notifications.length, 0);
  } finally { await s.cleanup(); f.cleanup(); }
});

test('task payloads expose failed/lost stops and pauses without task input states', async () => {
  const s = await setup(undefined, 'modern');
  try {
    for (const state of ['failed', 'lost', 'paused'] as const) {
      const jobId = `seed-${state}`;
      s.store.create(meta(s.f.home, { id: jobId, state, pauseCleared: true }), 'p');
      const created = await s.call('codex_agent_follow', { jobId });
      const reply = await s.rpc('tasks/get', { taskId: taskIdOf(created) });
      assert.equal(reply.status, 'completed');
      assert.equal(eventResult(reply.result).event, state === 'paused' ? 'paused' : 'stopped');
      assert.equal(eventResult(reply.result).state, state);
    }
    noForms(s);
  } finally { await s.cleanup(); s.f.cleanup(); }
});

test('discovery answers during slow initialization while job tools and task reads wait', async () => {
  const s = await setup(undefined, 'modern', { slowInitialize: true });
  try {
    assert.deepEqual(s.initialized.supportedVersions, [MODERN_PROTOCOL]);
    await until(() => existsSync(s.initializeStarted));
    let started = false, listed = false;
    const start = s.start({ waitMs: 10 }).then(value => { started = true; return value; });
    const list = s.rpc('tasks/list').then(value => { listed = true; return value; });
    assert.ok((await s.rpc('tools/list')).tools.length > 0);
    assert.equal(started, false); assert.equal(listed, false); assert.deepEqual(s.store.list(), []);
    s.releaseInitialize();
    const created = await start; assert.equal(created.resultType, 'task'); await list;
    await s.rpc('tasks/result', { taskId: created.taskId });
  } finally { s.releaseInitialize(); await s.cleanup(); s.f.cleanup(); }
});

test('sibling retry and resume tasks preserve their job mapping across reconnects', async () => {
  const f = fixture(); const first = await setup(f, 'modern'); let replacementId = '';
  try {
    first.store.create(meta(f.home, { id: 'handoff-source', state: 'failed' }), 'handoff prompt');
    replacementId = taskIdOf(await first.call('codex_agent_retry', { jobId: 'handoff-source', agent: 'agy' }));
    assert.equal(first.store.get(replacementId).connector, 'agy');
    assert.equal((await first.rpc('tasks/get', { taskId: replacementId })).status, 'working');
    await first.disconnect();
  } finally { await first.cleanup(); }
  const s = await setup(f, 'modern');
  try {
    s.store.write({ ...s.store.get(replacementId), state: 'completed', sessionId: 'foreign-session' });
    const result = eventResult(await s.rpc('tasks/result', { taskId: replacementId }));
    assert.equal(result.event, 'stopped'); assert.equal(result.jobId, replacementId);
    const resumed = await s.call('codex_agent_resume', { jobId: replacementId, message: 'continue handoff' });
    assert.equal(resumed.status, 'working'); assert.equal(s.store.get(resumed.taskId).connector, 'agy');
    assert.equal((await s.rpc('tasks/get', { taskId: resumed.taskId })).status, 'working');
  } finally { await s.cleanup(); f.cleanup(); }
});
