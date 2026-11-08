import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, meta } from '../jobs/test-helpers.js';
import { JobStore } from '../jobs/store.js';
import { nextJobEvent, progressMessage, watchJob } from '../jobs/watch.js';
import type { JobManager } from '../jobs/manager.js';
import { executeJobWatch, needsJobWatch } from './job-watch-progress.js';
import { registerJobTools } from '../jobs/tools.js';
import { registerMcpTasks } from './mcp-tasks.js';
import { toolRegistry, executeTool } from './registry.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

test('implicit watches have no two-hour cap and ignore only the input being answered', async t => {
  const f = fixture();
  const store = new JobStore(f.home);
  const question = { qid: 'answered', question: 'Old question?', askedAt: Date.now() };
  const approval = { id: 1, kind: 'commandExecution', summary: 'Old approval', requestedAt: Date.now() };
  const job = meta(f.home, { id: '12345678-1234-1234-1234-123456789012',
    state: 'running', awaitingInput: question, pendingApproval: approval });
  store.create(job, 'p');
  const manager = {
    store,
    async initialize() {},
    onTransition: store.onWrite.bind(store),
    async result(jobId: string) { return { jobId, state: store.get(jobId).state }; },
  } as unknown as JobManager;
  const progress = progressMessage(manager, { ...job, model: 'long-model-name'.repeat(20), label: 'long-label'.repeat(20),
    awaitingInput: { ...question, qid: 'long-question-id'.repeat(10) } });
  assert.ok(progress.includes(job.id), 'progress preserves the full job id with long input, model and label');
  assert.ok(progress.length <= 120);
  (t.mock as any).timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    let sampled!: () => void;
    const initial = new Promise<void>(resolve => { sampled = resolve; });
    let settled = false;
    const pending = watchJob(manager, job.id, undefined, {
      unlimited: true,
      untilNextEvent: { qid: question.qid, approvalId: approval.id },
      onProgress: sampled,
    }).then(result => { settled = true; return result; });
    await initial;
    (t.mock as any).timers.tick(7_201_000);
    await Promise.resolve();
    assert.equal(settled, false, 'no maxWait timer for implicit calls');
    store.write({ ...job, pendingApproval: { ...approval, requestedAt: approval.requestedAt + 1 } });
    await Promise.resolve();
    assert.equal(settled, false, 'same approval id and old question cannot finish the wait');
    const next = { ...approval, id: 2, summary: 'Approve the next command?' };
    store.write({ ...job, awaitingInput: undefined, pendingApproval: next });
    const result = await pending;
    assert.equal(result.jobId, job.id);
    assert.equal(result.state, 'running');
    assert.equal(result.timedOut, false);
    assert.equal(result.event, 'approval');
    assert.deepEqual(result.pendingApproval, next);
    assert.equal(result.awaitingInput, undefined);
  } finally { (t.mock as any).timers.reset(); f.cleanup(); }
});

test('only advancing calls and follow use native pending-call progress', () => {
  for (const prefix of ['codex', 'agy']) {
    for (const suffix of ['', '_retry', '_resume', '_follow', '_message'])
      assert.equal(needsJobWatch(`${prefix}_agent${suffix}`), true);
    assert.equal(needsJobWatch(`${prefix}_agent_answer`), true);
    for (const suffix of ['status', 'result', 'read', 'stop', 'collect', 'list'])
      assert.equal(needsJobWatch(`${prefix}_agent_${suffix}`), false);
  }
});

test('message steering returns immediately through both task and non-task dispatch', async () => {
  const f = fixture();
  const store = new JobStore(f.home);
  const job = meta(f.home, { state: 'running' });
  store.create(job, 'p');
  let steers = 0;
  const manager = {
    connector: { id: 'codex' }, store,
    async initialize() {},
    async steer() { steers++; return { delivered: 'mid-turn' }; },
    watch() { throw new Error('Steering must not start a watch'); },
  } as unknown as JobManager;
  const before = toolRegistry.length;
  registerJobTools(toolRegistry, 'codex', manager);
  const server = { setRequestHandler() {}, async notification() { throw new Error('No task should be created'); } };
  const tasks = registerMcpTasks(server as any, 'codex', manager, { capabilities: {} }, executeTool, toolRegistry);
  try {
    const direct = await executeJobWatch('codex_agent_message', { jobId: job.id, message: 'continue' } as any,
      { manager, signal: new AbortController().signal, notify: async () => {} });
    assert.deepEqual(JSON.parse(direct as string), { jobId: job.id, delivered: 'mid-turn' });
    const promoted = await tasks.call('codex_agent_message', { jobId: job.id, message: 'continue' });
    assert.equal(promoted.task, undefined);
    assert.deepEqual(JSON.parse(promoted.content![0].text!), { jobId: job.id, delivered: 'mid-turn' });
    assert.equal(steers, 2);
    assert.equal(existsSync(join(f.home, 'tasks')), false);
    store.write({ ...job, pendingApproval: { id: 'approval-1', kind: 'commandExecution', summary: 'Approve?', requestedAt: Date.now() } });
    await assert.rejects(tasks.call('codex_agent_message', { jobId: job.id, message: 'yes' }), /codex_agent_answer.*approval-1/);
    assert.equal(steers, 2);
  } finally { tasks.close(); toolRegistry.splice(before); f.cleanup(); }
});

test('native user-input requests are question events', () => {
  const job = meta('fixture', { state: 'running', pendingApproval: { id: 'native-question', kind: 'userInput', summary: 'Which option?', requestedAt: 1 } });
  assert.equal(nextJobEvent(job), 'question');
  assert.equal(nextJobEvent(job, { approvalId: 'native-question' }), undefined);
});
