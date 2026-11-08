import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CodexConnector } from './codex.js';
import { buildAppServer, parseAppServer } from './codexAppServer.js';
import { JobManager } from '../jobs/manager.js';
import { fixture, fakeConnector, until } from '../jobs/test-helpers.js';
import { registerMcpTasks } from '../tools/mcp-tasks.js';
import { registerJobTools, type JobTool } from '../jobs/tools.js';
import { progressMessage } from '../jobs/watch.js';
import type { JobSpec } from '../jobs/connector.js';

// A local protocol peer, never a Codex model turn. Checks the discovered wire shapes.
const fakeAppServer = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const log = path.join(__dirname, 'wire.log');
const send = value => console.log(JSON.stringify(value));
const reply = (id, result) => send({id, result});
const notify = (method, params) => send({method, params});
let threadId, turnId, options, count = 0, gate;
const turn = (status = 'inProgress') => ({id: turnId, status, items: [], error: null});
const complete = (text = 'fake final') => {
  clearInterval(gate);
  notify('item/completed', {threadId, turnId, item: {type: 'reasoning', id: 'r', summary: ['fake reasoning'], content: []}, completedAtMs: Date.now()});
  notify('item/completed', {threadId, turnId, item: {type: 'agentMessage', id: 'a', text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null}, completedAtMs: Date.now()});
  notify('turn/completed', {threadId, turn: turn('completed')});
};
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(m) + '\n');
  if (m.method === 'initialize') {
    assert.equal(m.params.clientInfo.name, 'codex-mcp-tool');
    reply(m.id, {userAgent: 'fake'});
  } else if (m.method === 'initialized') {
    assert.equal(m.id, undefined);
  } else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    assert.ok(m.params.cwd);
    assert.ok(['read-only','workspace-write','danger-full-access'].includes(m.params.sandbox));
    assert.ok(['never','on-request'].includes(m.params.approvalPolicy));
    threadId = m.params.threadId || 'fake-thread';
    reply(m.id, {thread: {id: threadId}});
    notify('thread/started', {thread: {id: threadId}});
  } else if (m.method === 'turn/start') {
    assert.equal(m.params.threadId, threadId);
    assert.equal(m.params.input[0].type, 'text');
    assert.deepEqual(m.params.input[0].text_elements, []);
    turnId = 'turn-' + ++count;
    try { options = JSON.parse(m.params.input[0].text.replace(/^If you need a decision[^\n]*\n\n/, '')); } catch { options = {}; }
    reply(m.id, {turn: turn()});
    notify('turn/started', {threadId, turn: turn()});
    if (options.question) {
      send({id:'native-question',method:'item/tool/requestUserInput',params:{threadId,turnId,itemId:'native-item',isBlocking:true,
        questions:[{id:'choice',header:'Choice',question:'Native question?',options:[{label:'A',description:'first'},{label:'B',description:'second'}]}]}});
    } else if (options.approval) {
      const kind = options.approval;
      send({id: 'approval-1', method: 'item/' + kind + '/requestApproval', params: {
        threadId, turnId, itemId: 'item', kind: 'command', startedAtMs: Date.now(),
        environmentId: null, command: 'echo ' + 'x'.repeat(400), reason: 'fake approval', cwd: __dirname,
        permissions: {network: {enabled: true}, fileSystem: null},
      }});
    } else if (options.gate) {
      gate = setInterval(() => { if (fs.existsSync(options.gate)) complete(); }, 20);
    } else if (!options.hold && !options.race) setTimeout(() => complete(), 10);
  } else if (m.method === 'turn/steer') {
    assert.equal(m.params.expectedTurnId, turnId);
    assert.equal(m.params.threadId, threadId);
    assert.equal(m.params.turnId, undefined);
    if (options.race) {
      complete('first final');
      send({id: m.id, error: {code: -32600, message: 'No active turn'}});
    } else if (options.steerError) {
      send({id: m.id, error: {code: -32600, message: 'Steering is disabled'}});
    } else {
      reply(m.id, {turnId});
      setTimeout(() => complete(m.params.input[0].text), 10);
    }
  } else if (m.method === 'turn/interrupt') {
    assert.equal(m.params.turnId, turnId);
    reply(m.id, {});
    if (!options.ignoreInterrupt) notify('turn/completed', {threadId, turn: turn('interrupted')});
  } else if (m.id === 'native-question' && !m.method) {
    assert.deepEqual(Object.keys(m.result.answers), ['choice']);
    complete(m.result.answers.choice.answers[0]);
  } else if (m.id === 'approval-1' && !m.method) {
    complete('approval answered');
  } else throw new Error('Unexpected method ' + m.method);
}).on('close', () => { clearInterval(gate); fs.appendFileSync(log, JSON.stringify({eof: true}) + '\n'); });
`;

function setup() {
  const f = fixture();
  writeFileSync(f.script, fakeAppServer);
  const connector = new CodexConnector(undefined, () => ({ resolved: true, command: f.script, source: 'explicit-path', searchedPaths: [] }));
  connector.detect = async () => ({ available: true, exe: f.script, version: 'fake' });
  const manager = new JobManager(connector, f.config);
  const messages = (): any[] => {
    try { return readFileSync(join(f.home, 'wire.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  const ready = async (id: string) => until(() => manager.store.get(id).state === 'running' && messages().some(m => m.method === 'turn/start'));
  return { ...f, manager, messages, ready, cleanup: async () => { await manager.dispose(); f.cleanup(); } };
}

test('trusted app-server honors requested approvals while full always bypasses them', async () => {
  for (const mode of ['trusted', 'full'] as const) {
    for (const approvals of [undefined, 'never', 'on-request'] as const) {
      const writes: any[] = [];
      const job = { id: 'fake', connector: 'codex', prompt: 'hi', cwd: '/fake', mode, approvals, timeoutMin: 1, finalPath: '/fake/final' };
      const handler = buildAppServer(job, '/fake').stdinPlan({ apply(action) { if (action.write) writes.push(JSON.parse(action.write)); }, emit() {} });
      try {
        handler(JSON.stringify({ id: 1, result: {} }), 'stdout');
        await new Promise<void>(resolve => setImmediate(resolve));
        const thread = writes.find(m => m.method === 'thread/start');
        assert.equal(thread.params.approvalPolicy, mode === 'full' ? 'never' : (approvals ?? 'never'));
      } finally { handler.dispose!(); }
    }
  }
});

test('Codex connector classifies only background app-server notifications as noise', () => {
  const connector = new CodexConnector();
  for (const method of ['skills/changed', 'account/rateLimits/updated', 'mcpServer/startupStatus/updated'])
    assert.equal(connector.isNoise(JSON.stringify({ method, params: {} })), true);
  for (const line of ['plain stderr', '{bad', JSON.stringify({ method: 'item/agentMessage/delta' }), JSON.stringify({ id: 9, method: 'skills/changed' })])
    assert.equal(connector.isNoise(line), false);
});

test('app-server start, final, reasoning, resume and inherited transport on send/requeue', async () => {
  const f = setup();
  try {
    const first = await f.manager.start({ prompt: 'hello', cwd: f.home, transport: 'app-server', model: 'fake-model', effort: 'high', approvalTimeoutMin: 4 });
    const result = await f.manager.watch(first.jobId, 20);
    assert.equal(result.state, 'completed');
    assert.equal(result.final, 'fake final');
    assert.equal(result.sessionId, 'fake-thread');
    assert.equal((await f.manager.read(first.jobId, 'reasoning')).text, 'fake reasoning\n');
    const follow = await f.manager.send(first.jobId, 'follow up');
    assert.equal(f.manager.store.get(follow.jobId).transport, 'app-server');
    assert.equal(f.manager.store.get(follow.jobId).approvalTimeoutMin, 4);
    assert.equal((await f.manager.watch(follow.jobId, 20)).state, 'completed');
    assert.equal(f.messages().find(m => m.method === 'thread/resume').params.threadId, 'fake-thread');
    const meta = f.manager.store.get(follow.jobId);
    f.manager.store.write({ ...meta, state: 'failed' });
    const retry = await f.manager.requeue(follow.jobId);
    assert.equal(f.manager.store.get(retry.jobId).transport, 'app-server');
    assert.equal((await f.manager.watch(retry.jobId, 20)).state, 'completed');
    assert.equal(f.messages()[0].method, 'initialize');
    const start = f.messages().find(m => m.method === 'thread/start');
    assert.equal(start.params.model, 'fake-model');
    assert.equal(start.params.config.model_reasoning_effort, 'high');
  } finally { await f.cleanup(); }
});

test('app-server steers mid-turn and queues a new turn when completion races the steer', async () => {
  for (const race of [false, true]) {
    const f = setup();
    try {
      const { jobId } = await f.manager.start({ prompt: JSON.stringify({ hold: true, race }), cwd: f.home, transport: 'app-server' });
      await f.ready(jobId);
      const tools: JobTool[] = []; registerJobTools(tools, 'codex', f.manager);
      const message = tools.find(t => t.name === 'codex_agent_message')!;
      assert.deepEqual(JSON.parse(await message.execute({ jobId, message: 'new instruction',
        mode: 'full', model: 'ignored', effort: 'ultra', timeoutMin: 500 })),
        { delivered: race ? 'queued' : 'mid-turn', jobId });
      const saved = f.manager.store.get(jobId);
      assert.equal(saved.mode, 'read');
      assert.notEqual(saved.model, 'ignored');
      assert.notEqual(saved.effort, 'ultra');
      assert.equal(saved.timeoutMin, 120);
      assert.equal((await f.manager.watch(jobId, 20)).state, 'completed');
      assert.equal((await f.manager.status(jobId) as any).steers, 1);
      const log = JSON.parse(readFileSync(join(f.manager.store.dir(jobId), 'steer.log'), 'utf8'));
      assert.equal(log.message, 'new instruction');
      assert.ok(Number.isFinite(Date.parse(log.timestamp)));
      assert.equal(f.messages().filter(m => m.method === 'turn/start').length, race ? 2 : 1);
    } finally { await f.cleanup(); }
  }
});

test('exec rejects steering clearly and remains write-and-close', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const { jobId } = await manager.start({ cwd: f.home, prompt: JSON.stringify({ waitMs: 2000 }) });
    await until(() => manager.store.get(jobId).state === 'running');
    await assert.rejects(() => manager.steer(jobId, 'hello'), /this job can't take mid-turn messages; use codex_agent_message after it stops, or start it with transport: app-server/);
    assert.equal((await manager.watch(jobId, 20)).state, 'completed');
    assert.equal(manager.store.get(jobId).steers, 0);
  } finally { await manager.dispose(); f.cleanup(); }
});

test('app-server cancel sends interrupt, waits for completion, then cleans up', async () => {
  const f = setup();
  try {
    const { jobId } = await f.manager.start({ prompt: JSON.stringify({ hold: true }), cwd: f.home, transport: 'app-server' });
    await f.ready(jobId);
    await f.manager.cancel(jobId);
    assert.equal(f.manager.store.get(jobId).state, 'killed');
    assert.equal(f.manager.store.get(jobId).reason, 'cancelled');
    const interrupt = f.messages().find(m => m.method === 'turn/interrupt');
    assert.deepEqual(interrupt.params, { threadId: 'fake-thread', turnId: 'turn-1' });
    assert.equal(f.messages().at(-1).eof, true);
  } finally { await f.cleanup(); }
});

test('app-server cancel falls back after three seconds if interrupt is ignored', async () => {
  const f = setup();
  try {
    const { jobId } = await f.manager.start({ prompt: JSON.stringify({ hold: true, ignoreInterrupt: true }), cwd: f.home, transport: 'app-server' });
    await f.ready(jobId);
    const started = Date.now();
    await f.manager.cancel(jobId);
    assert.ok(Date.now() - started >= 2900);
    assert.equal(f.manager.store.get(jobId).state, 'killed');
    assert.equal(f.manager.store.get(jobId).reserved, false);
    assert.ok(f.messages().some(m => m.method === 'turn/interrupt'));
  } finally { await f.cleanup(); }
});

test('app-server rejects foreign control, blank messages and non-completion steer errors', async () => {
  const f = setup();
  const foreign = new JobManager(f.manager.connector, f.config);
  try {
    const { jobId } = await f.manager.start({ prompt: JSON.stringify({ hold: true, steerError: true }), cwd: f.home, transport: 'app-server' });
    await f.ready(jobId);
    await assert.rejects(() => foreign.steer(jobId, 'hello'), /owning server/);
    await assert.rejects(() => foreign.respond(jobId, 'accept'), /owning server/);
    await assert.rejects(() => f.manager.steer(jobId, '  '), /blank/);
    await assert.rejects(() => f.manager.steer(jobId, 'hello'), /Steering is disabled/);
    assert.equal(f.messages().filter(m => m.method === 'turn/start').length, 1);
    assert.equal(f.manager.store.get(jobId).steers, 0);
  } finally { await foreign.dispose(); await f.cleanup(); }
});

test('approvals persist, complete event tasks, and accept through agent_answer', async () => {
  for (const kind of ['commandExecution', 'fileChange', 'permissions']) {
    const f = setup();
    const handlers = new Map<string, any>();
    const notices: any[] = [];
    const registry: JobTool[] = [];
    registerJobTools(registry, 'codex', f.manager);
    const tasks = registerMcpTasks({
      setRequestHandler(schema: any, handler: any) { handlers.set(schema.shape.method.value, handler); },
      async notification(notice: any) { notices.push(notice); },
    } as unknown as Server, 'codex', f.manager, { capabilities: {} },
    async (name, args) => registry.find(tool => tool.name === name)!.execute(args), registry);
    try {
      const { jobId } = await f.manager.start({ prompt: JSON.stringify({ approval: kind }), cwd: f.home, transport: 'app-server', mode: 'write' });
      await until(() => !!f.manager.store.get(jobId).pendingApproval && f.manager.store.get(jobId).state === 'running');
      const job = f.manager.store.get(jobId);
      assert.equal(job.pendingApproval!.kind, kind);
      assert.ok(job.pendingApproval!.summary.length <= 300);
      assert.match(progressMessage(f.manager, job), /awaiting approval/);
      const followed = await tasks.call('codex_agent_follow', { jobId });
      assert.ok(followed.task);
      const task = await handlers.get('tasks/get')({ params: { taskId: followed.task.taskId, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
      assert.equal(task.status, 'completed');
      const event = JSON.parse(task.result.content[0].text);
      assert.equal(event.event, 'approval');
      assert.equal(event.jobId, jobId);
      assert.deepEqual(event.pendingApproval, job.pendingApproval);
      assert.equal(task.inputRequests, undefined);
      assert.equal(handlers.has('tasks/update'), false);
      const answered = await tasks.call('codex_agent_answer', { jobId, decision: 'accept' });
      assert.ok(answered.task);
      assert.notEqual(answered.task.taskId, followed.task.taskId);
      const final = await handlers.get('tasks/result')({ params: { taskId: answered.task.taskId } }, { signal: new AbortController().signal });
      assert.equal(JSON.parse(final.content[0].text).event, 'stopped');
      assert.equal(f.manager.store.get(jobId).pendingApproval, undefined);
      const response = f.messages().find(m => m.id === 'approval-1');
      assert.deepEqual(response.result, kind === 'permissions' ? { permissions: { network: { enabled: true } }, scope: 'turn' } : { decision: 'accept' });
      assert.ok(notices.every(notice => notice.method !== 'elicitation/create' && notice.params.status !== 'input_required' && !notice.params.inputRequests));
    } finally { tasks.close(); await f.cleanup(); }
  }
});

test('approval timeout automatically declines and records approval_timeout', async () => {
  const f = setup();
  try {
    const { jobId } = await f.manager.start({ prompt: JSON.stringify({ approval: 'commandExecution' }), cwd: f.home, transport: 'app-server', approvalTimeoutMin: 0.025 });
    await until(() => !!f.manager.store.get(jobId).pendingApproval);
    assert.equal((await f.manager.watch(jobId, 20)).state, 'completed');
    assert.equal(f.manager.store.get(jobId).approvalReason, 'approval_timeout');
    assert.equal(f.manager.store.get(jobId).reason, 'approval_timeout');
    assert.equal(f.manager.store.get(jobId).pendingApproval, undefined);
    assert.deepEqual(f.messages().find(m => m.id === 'approval-1').result, { decision: 'decline' });
  } finally { await f.cleanup(); }
});

test('approval session, decline and cancel decisions follow command and permissions schemas', async () => {
  for (const kind of ['commandExecution', 'permissions']) {
    for (const decision of ['acceptForSession', 'decline', 'cancel'] as const) {
      const f = setup();
      try {
        const { jobId } = await f.manager.start({ prompt: JSON.stringify({ approval: kind }), cwd: f.home, transport: 'app-server' });
        await until(() => !!f.manager.store.get(jobId).pendingApproval && f.manager.store.get(jobId).state === 'running');
        await f.manager.respond(jobId, decision);
        await f.manager.watch(jobId, 20);
        const response = f.messages().find(m => m.id === 'approval-1').result;
        assert.deepEqual(response, kind === 'permissions' ? {
          permissions: decision === 'acceptForSession' ? { network: { enabled: true } } : {},
          scope: decision === 'acceptForSession' ? 'session' : 'turn',
        } : { decision });
        if (kind === 'permissions' && decision === 'cancel') assert.ok(f.messages().some(m => m.method === 'turn/interrupt'));
      } finally { await f.cleanup(); }
    }
  }
});

test('app-server settings match sandbox modes and default to never approving', () => {
  for (const mode of ['read', 'write', 'trusted', 'full'] as const) {
    const job: JobSpec = { id: 'test', connector: 'codex', prompt: 'hello', cwd: '/repo', mode, timeoutMin: 1, finalPath: '/final' };
    const command = buildAppServer(job, '/fake');
    const writes: any[] = [];
    const handler = command.stdinPlan({ apply: action => { if (action.write) writes.push(...action.write.trim().split('\n').map(line => JSON.parse(line))); }, emit() {} });
    handler('{"id":1,"result":{}}', 'stdout');
    const settings = writes.find(m => m.method === 'thread/start').params;
    assert.equal(settings.sandbox, { read: 'read-only', write: 'workspace-write', trusted: 'danger-full-access', full: 'danger-full-access' }[mode]);
    assert.equal(settings.approvalPolicy, 'never', 'headless jobs never ask by default, like exec');
    handler.dispose!();
    if (mode === 'read' || mode === 'write') {
      const optIn = buildAppServer({ ...job, approvals: 'on-request' }, '/fake');
      const opened: any[] = [];
      const h = optIn.stdinPlan({ apply: action => { if (action.write) opened.push(...action.write.trim().split(String.fromCharCode(10)).map(line => JSON.parse(line))); }, emit() {} });
      h('{"id":1,"result":{}}', 'stdout');
      assert.equal(opened.find(m => m.method === 'thread/start').params.approvalPolicy, 'on-request');
      h.dispose!();
    }
  }
  assert.ok(parseAppServer(JSON.stringify({ method: 'error', params: { error: { message: 'You have hit your usage limit' }, willRetry: false } }), 'stdout')?.usageLimit);
  assert.equal(parseAppServer(JSON.stringify({ method: 'error', params: { error: { message: 'retry' }, willRetry: true } }), 'stdout'), null);
});
test('subagent turns on other threads cannot hide the root turn completion', async () => {
  const writes: any[] = [];
  let closes = 0;
  const command = buildAppServer({ id: 'fake', connector: 'codex', prompt: 'hi', cwd: '/fake', mode: 'read', timeoutMin: 1, finalPath: '/fake/final' }, '/fake');
  const handler = command.stdinPlan({ apply(action) { if (action.close) closes++; if (action.write) writes.push(JSON.parse(action.write)); }, emit() {} });
  const feed = (value: any) => handler(JSON.stringify(value), 'stdout');
  const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    feed({ id: 1, result: {} });
    feed({ id: writes.at(-1).id, result: { thread: { id: 'root' } } });
    await flush();
    feed({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'main' } } });
    feed({ id: writes.at(-1).id, result: { turn: { id: 'main' } } });
    await flush();
    // A subagent spawned by the worker runs its own turn on another thread.
    feed({ method: 'turn/started', params: { threadId: 'sub', turn: { id: 'sub-turn' } } });
    feed({ method: 'turn/completed', params: { threadId: 'sub', turn: { id: 'sub-turn' } } });
    await flush();
    assert.equal(closes, 0, 'a subagent completion must not finish the job');
    feed({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'main' } } });
    await flush();
    assert.equal(closes, 1, 'the root turn completion finishes the job');
  } finally { handler.dispose!(); }
});

test('late completion cannot close a replacement turn and failed replacement closes the idle peer', async () => {
  for (const fail of [false, true]) {
    const writes: any[] = [];
    let closes = 0;
    const command = buildAppServer({ id: 'fake', connector: 'codex', prompt: 'hi', cwd: '/fake', mode: 'read', timeoutMin: 1, finalPath: '/fake/final' }, '/fake');
    const handler = command.stdinPlan({ apply(action) { if (action.close) closes++; if (action.write) writes.push(JSON.parse(action.write)); }, emit() {} });
    const feed = (value: any) => handler(JSON.stringify(value), 'stdout');
    const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
    const complete = (id: string) => feed({ method: 'turn/completed', params: { threadId: 'thread', turn: { id } } });
    try {
      feed({ id: 1, result: {} });
      feed({ id: writes.at(-1).id, result: { thread: { id: 'thread' } } });
      await flush();
      feed({ id: writes.at(-1).id, result: { turn: { id: 'one' } } });
      await flush();
      const steering = Promise.resolve(handler.onSteer!('next'));
      feed({ id: writes.at(-1).id, error: { message: 'No active turn' } });
      await flush();
      assert.equal(writes.at(-1).method, 'turn/start');
      complete('one');
      if (fail) {
        feed({ id: writes.at(-1).id, error: { message: 'usage limit' } });
        await assert.rejects(steering, /usage limit/);
        await flush();
        assert.equal(closes, 1, 'failed replacement leaves no running turn');
      } else {
        feed({ id: writes.at(-1).id, result: { turn: { id: 'two' } } });
        await steering;
        await flush();
        assert.equal(closes, 0, 'old completion must not close the new turn');
        complete('two');
        await flush();
        assert.equal(closes, 1);
      }
    } finally { handler.dispose!(); }
  }
});


test('native app-server requestUserInput uses the same question mailbox and response flow', async () => {
  const f = setup();
  try {
    const { jobId } = await f.manager.start({ cwd: f.home, prompt: JSON.stringify({ question: true }), transport: 'app-server' });
    await until(() => !!f.manager.store.get(jobId).awaitingInput, 'native question');
    const job = f.manager.store.get(jobId);
    assert.match(job.awaitingInput!.question, /Native question/);
    assert.deepEqual(job.awaitingInput!.options, ['A', 'B']);
    assert.match(progressMessage(f.manager, job), /awaiting answer/);
    await f.manager.respond(jobId, { answer: 'B' });
    await until(() => f.manager.store.get(jobId).state === 'completed');
    assert.equal((await f.manager.result(jobId)).final, 'B');
    assert.deepEqual(f.messages().find(m => m.id === 'native-question' && m.result).result, { answers: { choice: { answers: ['B'] } } });
  } finally { await f.cleanup(); }
});


test('native question replies on malformed answer file and primitive multi-answer', async () => {
  for (const raw of ['{bad', JSON.stringify({ answer: 'null' })]) {
    const f = fixture();
    const writes: any[] = [];
    const job = { finalPath: join(f.home, 'final'), cwd: f.home, mode: 'write', prompt: 'fake' } as JobSpec;
    const plan = buildAppServer(job, 'fake', { config: {}, prompt: 'fake' } as any, { questionPollMs: 10 }).stdinPlan;
    const handler = plan({ apply(action: any) { if (action.write) writes.push(JSON.parse(action.write)); }, emit() {} });
    try {
      handler(JSON.stringify({ id: 'q', method: 'item/tool/requestUserInput', params: { questions: [
        { id: 'one', question: 'One?' }, { id: 'two', question: 'Two?' },
      ] } }), 'stdout');
      const qid = JSON.parse(readFileSync(join(f.home, 'question.json'), 'utf8')).id;
      writeFileSync(join(f.home, `answer-${qid}.json`), raw);
      await until(() => writes.some(m => m.id === 'q'), 'native reply', 10000);
      assert.ok(writes.find(m => m.id === 'q').result || writes.find(m => m.id === 'q').error);
    } finally { handler.dispose?.(); f.cleanup(); }
  }
});



for (const decision of ['decline', 'acceptForSession'] as const) test(`task approval completes with details and agent_answer routes ${decision}`, async () => {
  const f = setup();
  const handlers = new Map<string, any>();
  const notices: any[] = [];
  const registry: JobTool[] = [];
  registerJobTools(registry, 'codex', f.manager);
  const tasks = registerMcpTasks({
    setRequestHandler(schema: any, handler: any) { handlers.set(schema.shape.method.value, handler); },
    async notification(notice: any) { notices.push(notice); },
  } as unknown as Server, 'codex', f.manager, { capabilities: {} },
  async (name, args) => registry.find(tool => tool.name === name)!.execute(args), registry);
  try {
    const { jobId } = await f.manager.start({ prompt: JSON.stringify({ approval: 'commandExecution' }), cwd: f.home, transport: 'app-server', mode: 'write' });
    await until(() => !!f.manager.store.get(jobId).pendingApproval && f.manager.store.get(jobId).state === 'running');
    const followed = await tasks.call('codex_agent_follow', { jobId });
    assert.ok(followed.task);
    const task = await handlers.get('tasks/get')({ params: { taskId: followed.task.taskId, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
    assert.equal(task.status, 'completed');
    assert.equal(JSON.parse(task.result.content[0].text).event, 'approval');
    assert.equal(task.inputRequests, undefined);
    const answered = await tasks.call('codex_agent_answer', { jobId, decision });
    assert.ok(answered.task);
    await handlers.get('tasks/result')({ params: { taskId: answered.task.taskId } }, { signal: new AbortController().signal });
    assert.equal(f.messages().find(m => m.id === 'approval-1').result.decision, decision);
    assert.ok(notices.every(notice => notice.params.status !== 'input_required' && !notice.params.inputRequests));
  } finally { tasks.close(); await f.cleanup(); }
});
