import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { JobManager } from './manager.js';
import { fixture, fakeConnector, meta, until } from './test-helpers.js';
import { registerJobTools, type JobTool } from './tools.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function setup(heartbeatMs = 20) {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  const tools: JobTool[] = [];
  registerJobTools(tools, 'codex', manager, { watchHeartbeatMs: heartbeatMs });
  const watch = tools.find(tool => tool.name === 'codex_agent_follow')!;
  return {
    f,
    manager,
    watch,
    async cleanup() {
      await manager.dispose();
      f.cleanup();
    },
  };
}

test('watch resolves on fake-worker completion with the agent_result shape and watch metadata', async () => {
  const s = setup();
  try {
    const job = await s.manager.start({
      prompt: JSON.stringify({ final: 'watched answer', waitMs: 100 }),
      cwd: s.f.home,
    });
    const messages: string[] = [];
    const result = JSON.parse(
      await s.watch.execute({ jobId: job.jobId }, text => messages.push(text))
    );
    assert.deepEqual(result, {
      ...JSON.parse(JSON.stringify(await s.manager.result(job.jobId))),
      event: 'stopped',
      watchedSec: result.watchedSec,
      timedOut: false,
    });
    assert.equal(result.final, 'watched answer');
    assert.equal(result.sessionId, 'fake-session');
    assert.ok(result.watchedSec >= 0);
    assert.ok(messages.some(text => text.includes(' | completed | ')));
    const count = messages.length;
    await delay(60);
    assert.equal(messages.length, count, 'progress stops after completion');
  } finally {
    await s.cleanup();
  }
});

test('watch wakes immediately on transitions and emits heartbeat summaries capped at 120 characters', async () => {
  const s = setup(30);
  const controller = new AbortController();
  try {
    await s.manager.initialize();
    const job = meta(s.f.home, { state: 'running' });
    s.manager.store.create(job, 'p');
    appendFileSync(
      s.manager.store.path(job.id, 'stdout'),
      JSON.stringify({
        type: 'item.completed',
        item: { text: `Step one\n${'x'.repeat(200)}` },
      }) + '\n'
    );
    const messages: string[] = [];
    const pending = s.watch.execute(
      { jobId: job.id },
      text => messages.push(text),
      controller.signal
    );
    await until(() => messages.length >= 2, 'initial progress and heartbeat');
    assert.match(messages[0], /^codex test-job default \u00b7 job \| running \| \d+s \| Step one x/);
    assert.ok(messages.every(text => text.length <= 120 && !text.includes('\n')));
    const before = messages.length;
    s.manager.store.write({ ...job, state: 'paused' });
    assert.equal(
      messages.length,
      before + 1,
      'transition emits synchronously without a heartbeat tick'
    );
    const result = JSON.parse(await pending);
    assert.equal(result.state, 'paused');
    assert.equal(result.timedOut, false);
  } finally {
    controller.abort();
    await s.cleanup();
  }
});

test('watch timeout leaves the job running and emits nothing when no progress callback is provided', async () => {
  const s = setup(5);
  try {
    const job = await s.manager.start({
      prompt: JSON.stringify({ waitMs: 10000 }),
      cwd: s.f.home,
    });
    await until(() => s.manager.store.get(job.jobId).state === 'running');
    const result = JSON.parse(await s.watch.execute({ jobId: job.jobId, maxWaitSec: 0.05 }));
    assert.equal(result.timedOut, true);
    assert.equal(result.state, 'running');
    assert.ok(result.watchedSec >= 0.04);
    assert.equal(s.manager.store.get(job.jobId).state, 'running');
  } finally {
    await s.cleanup();
  }
});

test('cancelling a watch removes transition/abort listeners and both timers without stopping the job', async t => {
  const s = setup(10);
  const controller = new AbortController();
  try {
    await s.manager.initialize();
    // Freeze only timers created by the watch; manager initialization is already complete.
    (t.mock as any).timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const job = meta(s.f.home, { state: 'running' });
    s.manager.store.create(job, 'p');
    let listeners = 0;
    let removals = 0;
    let reads = 0;
    const subscribe = s.manager.onTransition.bind(s.manager);
    s.manager.onTransition = listener => {
      listeners++;
      const off = subscribe(listener);
      return () => {
        if (listeners) {
          listeners--;
          removals++;
        }
        off();
      };
    };
    const get = s.manager.store.get.bind(s.manager.store);
    s.manager.store.get = id => {
      reads++;
      return get(id);
    };
    const messages: string[] = [];
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = s.watch.execute(
      { jobId: job.id, maxWaitSec: 0.08 },
      text => { messages.push(text); started(); },
      controller.signal
    );
    await ready;
    assert.equal(listeners, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(listeners, 0);
    assert.equal(removals, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const readsAtCancel = reads;
    const messagesAtCancel = messages.length;
    (t.mock as any).timers.tick(1000); // Deterministically pass both cleared timers.
    assert.equal(reads, readsAtCancel, 'neither timer reads the store after cancellation');
    assert.equal(messages.length, messagesAtCancel);
    assert.equal(get(job.id).state, 'running');
    s.manager.store.write({ ...job, state: 'paused' });
    assert.equal(messages.length, messagesAtCancel);
  } finally {
    controller.abort();
    (t.mock as any).timers.reset();
    await s.cleanup();
  }
});

test('watch supports pre-cancellation, zero wait, missing jobs and manager shutdown', async () => {
  const s = setup();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(s.watch.execute({ jobId: 'missing' }, undefined, controller.signal), {
      name: 'AbortError',
    });
    await s.manager.initialize();
    const job = meta(s.f.home, { state: 'running' });
    s.manager.store.create(job, 'p');
    assert.equal((await s.manager.watch(job.id, 0)).timedOut, true);
    await assert.rejects(s.manager.watch('missing'), /ENOENT/);
    await assert.rejects(s.manager.watch(job.id, 7201), /maxWaitSec/);
    const pending = s.manager.watch(job.id);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await s.manager.dispose();
    await rejected;
  } finally {
    await s.cleanup();
  }
});

test('heartbeat observes transitions persisted through another store instance', async () => {
  const s = setup(10);
  try {
    await s.manager.initialize();
    const job = meta(s.f.home, { state: 'running' });
    s.manager.store.create(job, 'p');
    const { JobStore } = await import('./store.js');
    const other = new JobStore(s.f.home);
    let messages = 0;
    const pending = s.manager.watch(job.id, 1, { heartbeatMs: 10, onProgress: () => messages++ });
    await until(() => messages > 0);
    other.write({ ...job, state: 'completed' });
    const result = await pending;
    assert.equal(result.state, 'completed');
    assert.equal(result.timedOut, false);
  } finally {
    await s.cleanup();
  }
});

test('new approval wakes a watch while its answered question remains pending', async () => {
  const s = setup();
  const controller = new AbortController();
  try {
    await s.manager.initialize();
    const job = meta(s.f.home, { state: 'running', awaitingInput: { qid: 'answered', question: 'Question?', askedAt: Date.now() } });
    s.manager.store.create(job, 'p');
    let samples = 0;
    const pending = s.manager.watch(job.id, 5, { untilNextEvent: { qid: 'answered' }, signal: controller.signal, onProgress() { samples++; } });
    void pending.catch(() => {});
    await until(() => samples > 0);
    const before = samples;
    s.manager.store.write({ ...job, pendingApproval: { id: 'new', kind: 'command', summary: 'Approve?', requestedAt: Date.now() } });
    assert.equal(samples, before + 1, 'approval must be sampled synchronously, before the heartbeat');
    const result = await pending;
    assert.equal(result.event, 'approval');
    assert.equal(result.pendingApproval?.id, 'new');
  } finally { controller.abort(); await s.cleanup(); }
});
