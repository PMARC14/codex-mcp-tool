import { test } from 'node:test';
import spawn from 'cross-spawn';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fixture, fakeConnector, until, meta } from './test-helpers.js';
import { JobManager } from './manager.js';
import { registerJobTools } from './tools.js';
import { progressMessage } from './watch.js';
import { registerMcpTasks, TaskStdioTransport, MODERN_PROTOCOL, TASK_EXTENSION, taskCapabilities } from '../tools/mcp-tasks.js';
import { clientTaskGet, clientTaskList, clientTaskNotification, clientCreateTask } from '../tools/client-schemas.js';
import { TrafficLog, installRequestErrorReporting } from '../tools/traffic-log.js';
import type { UnifiedTool } from '../tools/registry.js';

const bridgePath = fileURLToPath(new URL('../bridge/agent-bridge.js', import.meta.url));

function setup() {
  const f = fixture();
  // The worker is an MCP client of the actual built bridge; no Codex process exists.
  writeFileSync(f.script, `
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', async () => {
  const { Client } = await import(${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))});
  const { StdioClientTransport } = await import(${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))});
  const client = new Client({name:'fake-worker',version:'1'});
  try {
    const opts = JSON.parse(prompt);
    const transport = new StdioClientTransport({command:process.execPath,args:[process.argv[5]],
      env:{...process.env,AGENT_JOBS_HOME:process.argv[3],AGENT_JOB_ID:process.argv[4]}});
    await client.connect(transport);
    console.log(JSON.stringify({type:'thread.started',thread_id:'fake-bridge-session'}));
    const tools = await client.listTools();
    if (tools.tools.length !== 2) throw new Error('bridge tools missing');
    await client.callTool({name:'report_progress',arguments:{note:opts.note || 'Milestone reached'}});
    const result = await client.callTool({name:'ask_orchestrator',arguments:{question:opts.question || 'Which option?',options:['A','B'],timeoutSec:opts.timeoutSec || 20}});
    if (opts.holdAfter) await new Promise(resolve => setTimeout(resolve, opts.holdAfter));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result.content[0].text}}));
  } catch(error) { console.error(error); process.exitCode=1; }
  finally { await client.close(); }
});`);
  const connector = fakeConnector(f.script);
  connector.build = job => ({ exe: process.execPath,
    args: [f.script, job.finalPath, f.home, job.id, bridgePath], stdin: job.prompt });
  const manager = new JobManager(connector, f.config);
  const registry: UnifiedTool[] = [];
  registerJobTools(registry, 'codex', manager);
  return { ...f, manager, registry, cleanup: async () => { await manager.dispose(); f.cleanup(); } };
}

async function wire(s: ReturnType<typeof setup>) {
  const notices: any[] = [];
  const input = new PassThrough();
  let id = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const output = new Writable({ write(chunk, _encoding, done) {
    for (const line of String(chunk).trim().split('\n')) {
      const message = JSON.parse(line);
      if (message.id === undefined) { notices.push(message); continue; }
      const entry = pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer); pending.delete(message.id);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error));
      else entry.resolve(message.result);
    }
    done();
  } });
  const server = new Server({ name: 'bridge-contract-test', version: '1' }, { capabilities: { tools: {}, tasks: taskCapabilities } });
  const log = new TrafficLog('codex', s.home);
  installRequestErrorReporting(server, log);
  const tasks = registerMcpTasks(server, 'codex', s.manager, { capabilities: {} },
    async (name, args) => s.registry.find(tool => tool.name === name)!.execute(args), s.registry);
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.task !== undefined) return tasks.call(request.params.name, request.params.arguments, request.params._meta);
    const tool = s.registry.find(item => item.name === request.params.name)!;
    return { content: [{ type: 'text' as const, text: String(await tool.execute((request.params.arguments ?? {}) as any)) }] };
  });
  await server.connect(new TaskStdioTransport('codex', log, input, output));
  const rpc = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`timeout ${method}`)); }, 10000);
    pending.set(next, { resolve, reject, timer });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
      'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASK_EXTENSION]: {} } },
    } } }) + '\n');
  });
  return { rpc, notices, log, async close() { tasks.close(); await server.close(); input.destroy(); output.destroy(); for (const entry of pending.values()) clearTimeout(entry.timer); } };
}

test('fake worker question completes its task; agent_answer creates a new task without user forms', async () => {
  const s = setup();
  const w = await wire(s);
  try {
    const created = await w.rpc('tools/call', { name: 'codex_agent', arguments: {
      cwd: s.home, prompt: JSON.stringify({ question: 'Sensitive question ' + 'x'.repeat(700), note: 'Milestone ' + 'x'.repeat(100) }),
      label: 'bridge-agent', stallTimeoutMin: 0.0001, onStall: 'report',
    } });
    clientCreateTask.parse(created);
    const taskId = created.taskId, jobId = taskId;
    const first = await w.rpc('tasks/result', { taskId });
    const question = JSON.parse(first.content[0].text);
    assert.equal(question.event, 'question');
    assert.equal(question.jobId, jobId);
    assert.equal(question.state, 'running');
    assert.equal(question.awaitingInput.question.length, 500);
    assert.deepEqual(question.awaitingInput.options, ['A', 'B']);
    const job = s.manager.store.get(jobId);
    assert.ok(job.progressNote!.length <= 80);
    assert.match(progressMessage(s.manager, job), /awaiting answer/);
    assert.match(progressMessage(s.manager, job), /Milestone/);
    const poll = await w.rpc('tasks/get', { taskId });
    clientTaskGet.parse(poll);
    assert.equal(poll.status, 'completed');
    assert.equal(poll.inputRequests, undefined);
    const qid = question.awaitingInput.qid;
    clientTaskList.parse(await w.rpc('tasks/list'));
    // Let multiple samples run while pending: no stall killing.
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(s.manager.store.get(jobId).state, 'running');
    await assert.rejects(w.rpc('tasks/update', { taskId, inputResponses: { [qid]: { action: 'accept', content: { answer: 'wrong' } } } }), /method not found/i);
    await assert.rejects(w.rpc('tools/call', { name: 'codex_agent_answer', arguments: { jobId, qid: 'stale', answer: 'wrong' } }), /pending question/);
    assert.equal(s.manager.store.get(jobId).awaitingInput!.qid, qid);
    const answered = await w.rpc('tools/call', { name: 'codex_agent_answer', arguments: { jobId, qid, answer: 'B' } });
    clientCreateTask.parse(answered);
    assert.notEqual(answered.taskId, taskId);
    assert.ok(existsSync(join(s.manager.store.dir(jobId), `answer-${qid}.json`)));
    const final = JSON.parse((await w.rpc('tasks/result', { taskId: answered.taskId })).content[0].text);
    assert.equal(final.event, 'stopped');
    assert.equal(final.jobId, jobId);
    assert.equal(final.final, 'B');
    assert.deepEqual(await w.rpc('tasks/result', { taskId }), first);
    assert.match((await s.manager.read(jobId, 'notes')).text, /Milestone/);
    w.notices.forEach(notice => clientTaskNotification.parse(notice));
    assert.ok(w.notices.every(notice => notice.params?.status !== 'input_required' && !notice.params?.inputRequests));
    assert.doesNotMatch(JSON.stringify(w.notices), /elicitation\/create/);
    assert.doesNotMatch(w.log.tail(200).join('\n'), /Sensitive question|Milestone/);
  } finally { await w.close(); await s.cleanup(); }
});

for (const via of ['answer', 'message'] as const) test(`exec bridge question uses agent_answer; agent_${via} respects that boundary`, async () => {
  const s = setup();
  try {
    const { jobId } = await s.manager.start({ cwd: s.home, prompt: '{}' });
    await until(() => !!s.manager.store.get(jobId).awaitingInput);
    const tool = s.registry.find(tool => tool.name === `codex_agent_${via}`)!;
    if (via === 'message') {
      await assert.rejects(tool.execute({ jobId, message: 'B' }), /codex_agent_answer.*qid/);
      assert.ok(s.manager.store.get(jobId).awaitingInput);
    }
    const answer = s.registry.find(tool => tool.name === 'codex_agent_answer')!;
    const result = JSON.parse(await answer.execute({ jobId, answer: 'A' }) as string);
    assert.equal(result.responded, true);
    await until(() => s.manager.store.get(jobId).state === 'completed');
    assert.equal((await s.manager.result(jobId)).final, 'A');
    assert.equal(s.manager.store.get(jobId).awaitingInput, undefined);
  } finally { await s.cleanup(); }
});

test('bridge timeout returns best judgement and clears the mailbox and pending metadata', async () => {
  const s = setup();
  try {
    const { jobId } = await s.manager.start({ cwd: s.home, prompt: JSON.stringify({ timeoutSec: 0.7 }) });
    await until(() => s.manager.store.get(jobId).state === 'completed');
    assert.equal((await s.manager.result(jobId)).final, 'no answer within 0.7 s; continue with your best judgement');
    assert.equal(existsSync(join(s.manager.store.dir(jobId), 'question.json')), false);
    assert.equal(s.manager.store.get(jobId).awaitingInput, undefined);
  } finally { await s.cleanup(); }
});


test('another manager answers a pending question with qid and rejects stale qid', async () => {
  const s = setup();
  const other = new JobManager(s.manager.connector, s.config);
  try {
    const { jobId } = await s.manager.start({ cwd: s.home, prompt: '{}' });
    await until(() => !!s.manager.store.get(jobId).awaitingInput);
    const qid = s.manager.store.get(jobId).awaitingInput!.qid;
    await assert.rejects(other.respond(jobId, { answer: 'wrong', qid: 'stale' }), /pending question/);
    assert.deepEqual(await other.respond(jobId, { answer: 'A', qid }), { responded: true, qid });
    await until(() => s.manager.store.get(jobId).state === 'completed');
  } finally { await other.dispose(); await s.cleanup(); }
});


test('bridge timeout cannot change the completed question task; follow observes completion', async () => {
  const s = setup();
  const w = await wire(s);
  try {
    const { taskId } = await w.rpc('tools/call', { name: 'codex_agent', arguments: {
      cwd: s.home, prompt: JSON.stringify({ timeoutSec: 2, holdAfter: 600 }),
    } });
    const first = await w.rpc('tasks/result', { taskId });
    const qid = JSON.parse(first.content[0].text).awaitingInput.qid;
    await until(() => s.manager.store.get(taskId).state === 'completed');
    assert.deepEqual(await w.rpc('tasks/result', { taskId }), first);
    const follow = await w.rpc('tools/call', { name: 'codex_agent_follow', arguments: { jobId: taskId } });
    const final = JSON.parse((await w.rpc('tasks/result', { taskId: follow.taskId })).content[0].text);
    assert.equal(final.event, 'stopped');
    assert.match(final.final, /no answer within 2 s/);
    await assert.rejects(w.rpc('tasks/update', { taskId, inputResponses: { [qid]: { action: 'accept', content: { answer: 'late' } } } }), /method not found/i);
    assert.ok(w.notices.every(n => n.params?.status !== 'input_required'));
  } finally { await w.close(); await s.cleanup(); }
});


test('bridge exits after stdin ends with a pending question', async () => {
  const f = fixture();
  const jobId = 'bridge-eof';
  mkdirSync(join(f.home, 'jobs', jobId), { recursive: true });
  const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, AGENT_JOBS_HOME: f.home, AGENT_JOB_ID: jobId }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_orchestrator', arguments: { question: 'Fake?', timeoutSec: 60 } } }) + '\n');
    await until(() => existsSync(join(f.home, 'jobs', jobId, 'question.json')), 'question created', 5000);
    child.stdin!.end();
    await until(() => child.exitCode !== null, 'bridge exit', 2500);
    assert.equal(child.exitCode, 0);
  } finally { if (child.exitCode === null) child.kill(); f.cleanup(); }
});


test('fresh manager answers a dead owner question through a new agent_answer task', async () => {
  const s = setup();
  const jobId = 'restart-tool', qid = 'qid-tool';
  s.manager.store.create(meta(s.home, { id: jobId, state: 'running', owner: { pid: 2147483647, startTime: 'dead' },
    awaitingInput: { qid, question: 'persisted?', askedAt: Date.now() } }), 'fake');
  writeFileSync(join(s.manager.store.dir(jobId), 'question.json'), JSON.stringify({ id: qid, question: 'persisted?', askedAt: Date.now() }));
  const w = await wire(s);
  try {
    await s.manager.initialize();
    const response = await w.rpc('tools/call', { name: 'codex_agent_answer', arguments: { jobId, qid, answer: 'reply' } });
    clientCreateTask.parse(response);
    assert.notEqual(response.taskId, jobId);
    assert.equal(JSON.parse(readFileSync(join(s.manager.store.dir(jobId), `answer-${qid}.json`), 'utf8')).answer, 'reply');
    // This persisted fixture has no worker; publish its next event through the owner's store.
    s.manager.store.write({ ...s.manager.store.get(jobId), state: 'completed', awaitingInput: undefined });
    const result = JSON.parse((await w.rpc('tasks/result', { taskId: response.taskId })).content[0].text);
    assert.equal(result.event, 'stopped');
    assert.equal(result.jobId, jobId);
    assert.equal(result.qid, qid);
  } finally { await w.close(); await s.cleanup(); }
});

test('preserved orphan answer task observes a second bridge question', async () => {
  const s = setup();
  const jobId = 'restart-second', qid = 'first-question';
  s.manager.store.create(meta(s.home, { id: jobId, state: 'running', owner: { pid: 2147483647, startTime: 'dead' },
    awaitingInput: { qid, question: 'First?', askedAt: Date.now() } }), 'fake');
  const questionPath = join(s.manager.store.dir(jobId), 'question.json');
  writeFileSync(questionPath, JSON.stringify({ id: qid, question: 'First?', askedAt: Date.now() }));
  const w = await wire(s);
  try {
    await s.manager.initialize();
    assert.equal(s.manager.store.get(jobId).orphanPreserved, true);
    const response = await w.rpc('tools/call', { name: 'codex_agent_answer', arguments: { jobId, qid, answer: 'reply' } });
    writeFileSync(questionPath, JSON.stringify({ id: 'second-question', question: 'Second?', askedAt: Date.now() }));
    await until(() => s.manager.store.get(jobId).awaitingInput?.qid === 'second-question', 'preserved orphan samples its next question', 3000);
    const result = JSON.parse((await w.rpc('tasks/result', { taskId: response.taskId })).content[0].text);
    assert.equal(result.event, 'question');
    assert.equal(result.awaitingInput.qid, 'second-question');
  } finally { await w.close(); await s.cleanup(); }
});


test('tasks/update cannot answer a worker question or open a user form', async () => {
  const s = setup(); const w = await wire(s);
  try {
    const jobId = 'contract-update', qid = 'contract-question';
    s.manager.store.create(meta(s.home, { id: jobId, state: 'running', awaitingInput: { qid, question: 'fake', askedAt: Date.now() } }), 'fake');
    writeFileSync(join(s.manager.store.dir(jobId), 'question.json'), JSON.stringify({ id: qid, question: 'fake', askedAt: Date.now() }));
    await assert.rejects(w.rpc('tasks/update', { taskId: jobId, inputResponses: { [qid]: { action: 'accept', content: { answer: 'fake' } } } }), /method not found/i);
    assert.equal(existsSync(join(s.manager.store.dir(jobId), `answer-${qid}.json`)), false);
    const followed = await w.rpc('tools/call', { name: 'codex_agent_follow', arguments: { jobId } });
    const next = clientTaskGet.parse(await w.rpc('tasks/get', { taskId: followed.taskId })) as any;
    assert.equal(next.status, 'completed');
    assert.equal(JSON.parse(next.result.content[0].text).event, 'question');
    assert.equal(next.inputRequests, undefined);
    assert.ok(w.notices.every(notice => notice.method !== 'elicitation/create' && notice.params?.status !== 'input_required'));
  } finally { await w.close(); await s.cleanup(); }
});


test('answering an expired mailbox clears stale pending metadata and reports no delivery', async () => {
  const s = setup();
  try {
    await s.manager.initialize();
    const jobId = 'expired-mailbox', qid = 'expired-question';
    s.manager.store.create(meta(s.home, { id: jobId, state: 'running',
      awaitingInput: { qid, question: 'expired?', askedAt: Date.now() } }), 'fake');
    await assert.rejects(s.manager.respond(jobId, { answer: 'late', qid }), /question expired; no answer delivered/i);
    // Foreign: reported, answer not delivered, metadata left for the owner's sampler to clear.
    assert.equal(existsSync(join(s.manager.store.dir(jobId), `answer-${qid}.json`)), false);
  } finally { await s.cleanup(); }
});
