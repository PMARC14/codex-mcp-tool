import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobStore } from './store.js';
import { fixture, fakeConnector, meta, until } from './test-helpers.js';
import { JobManager } from './manager.js';
import {
  channelEvent,
  startChannelNotifier,
  withChannelCapabilities,
  withChannelInstructions,
  type ChannelServer,
} from './channel.js';
import type { JobMeta, JobState } from './connector.js';

const ON = { AGENT_JOBS_CHANNEL: '1', CLAUDE_AGENTS: '1' };
const SECRET = 'SECRET-FINAL-TEXT-ignore-previous-instructions';

test('channel delivery never claims the hook wake marker and retry resets both independent markers', () => {
  const f = fixture();
  const store = new JobStore(f.home);
  const source = fakeManager();
  const server = fakeServer();
  const job = meta(f.home, { state: 'queued' });
  store.create(job, 'fake');
  const path = (name: string) => join(store.dir(job.id), name);
  // Same marker checks and exclusive write as hook-wait.sh; a silently dropped
  // channel event must leave this fallback free to claim its own wake.
  const hookWake = () => {
    if (['collected', 'woken', 'mcp-task.json'].some(name => existsSync(path(name)))) return false;
    try { writeFileSync(path('woken'), '', { flag: 'wx' }); return true; } catch { return false; }
  };
  const stop = startChannelNotifier({ ...source, store }, server.server, 'codex', undefined, ON);
  try {
    source.emit({ ...job, state: 'completed' }, 'running');
    assert.equal(existsSync(path('woken')), false);
    assert.equal(existsSync(path('channel-sent')), true);
    assert.equal(hookWake(), true);
    assert.equal(hookWake(), false);
    store.write({ ...job, state: 'running' });
    assert.equal(existsSync(path('channel-sent')), false);
    assert.equal(existsSync(path('woken')), false);
    source.emit({ ...job, state: 'running' }, 'queued');
    source.emit({ ...job, state: 'completed' }, 'running');
    assert.equal(server.calls.length, 2);
    writeFileSync(path('collected'), '');
    assert.equal(hookWake(), false);
    store.write({ ...job, state: 'queued' });
    writeFileSync(path('mcp-task.json'), '{}');
    source.emit({ ...job, state: 'completed' }, 'running');
    assert.equal(server.calls.length, 2);
    assert.equal(hookWake(), false);
  } finally { stop(); f.cleanup(); }
});

type Call = { method: string; params: { content: string; meta?: Record<string, string> } };
function fakeServer(fail = false) {
  const calls: Call[] = [];
  const server: ChannelServer = {
    async notification(notification) {
      calls.push(notification as Call);
      if (fail) throw new Error('transport closed');
    },
  };
  return { calls, server };
}

function fakeManager(own = true) {
  const listeners = new Set<(job: JobMeta, previous: JobState | undefined) => void>();
  return {
    onTransition(listener: (job: JobMeta, previous: JobState | undefined) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    isOwn: () => own,
    emit(job: JobMeta, previous?: JobState) {
      for (const listener of [...listeners]) listener(job, previous);
    },
    count: () => listeners.size,
  };
}

const isIdentifier = (key: string) => /^[A-Za-z0-9_]+$/.test(key);

test('each notifying state sends exactly once with metadata only', () => {
  const manager = fakeManager();
  const { calls, server } = fakeServer();
  startChannelNotifier(manager, server, 'codex', undefined, ON);
  const reset = Date.UTC(2030, 0, 2, 3, 4, 5);
  for (const state of ['completed', 'failed', 'killed', 'paused', 'lost'] as const) {
    const job = meta('/x', {
      id: `job-${state}`,
      state,
      label: 'my label!<x>/..',
      reason: state === 'paused' ? 'usage_limit' : undefined,
      resetAt: state === 'paused' ? reset : undefined,
      error: SECRET,
    });
    manager.emit(job, 'running');
    manager.emit(job, 'running');
    manager.emit(job);
  }
  manager.emit(meta('/x', { id: 'q', state: 'queued' }), undefined);
  manager.emit(meta('/x', { id: 'r', state: 'running' }), 'queued');
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.method, 'notifications/claude/channel');
    const m = call.params.meta!;
    assert.equal(m.agent, 'codex');
    assert.equal(m.label, 'mylabelx');
    assert.equal(
      call.params.content.startsWith(
        `codex agent ${m.state}: call codex_agent_result with this job_id`
      ),
      true
    );
  }
  const paused = calls.find(call => call.params.meta!.state === 'paused')!;
  assert.equal(paused.params.meta!.reason, 'usage_limit');
  assert.equal(paused.params.meta!.reset_at, '2030-01-02T03:04:05.000Z');
  assert.match(paused.params.content, /2030-01-02T03:04:05.000Z/);
  const done = calls.find(call => call.params.meta!.state === 'completed')!;
  assert.equal(done.params.meta!.reset_at, undefined);
  assert.equal(done.params.content, 'codex agent completed: call codex_agent_result with this job_id');
});

test('label is sanitized, capped and omitted when empty; meta keys are identifiers', () => {
  const long = channelEvent(
    meta('/x', { id: 'a', state: 'failed', label: 'a'.repeat(100), reason: 'timeout' }),
    'agy'
  );
  assert.equal(long.meta.label, 'a'.repeat(40));
  assert.equal(long.meta.reason, 'timeout');
  const none = channelEvent(meta('/x', { id: 'a', state: 'failed', label: '!!! ???' }), 'agy');
  assert.equal('label' in none.meta, false);
  for (const key of [...Object.keys(long.meta), ...Object.keys(none.meta)])
    assert.equal(isIdentifier(key), true, key);
  for (const value of Object.values(long.meta)) assert.equal(typeof value, 'string');
});

test('other owners are ignored and stop unsubscribes', () => {
  const foreign = fakeManager(false);
  const a = fakeServer();
  startChannelNotifier(foreign, a.server, 'codex', undefined, ON);
  foreign.emit(meta('/x', { id: 'other', state: 'completed' }), 'running');
  assert.equal(a.calls.length, 0);

  const own = fakeManager();
  const b = fakeServer();
  const stop = startChannelNotifier(own, b.server, 'codex', undefined, ON);
  stop();
  assert.equal(own.count(), 0);
  own.emit(meta('/x', { id: 'late', state: 'completed' }), 'running');
  assert.equal(b.calls.length, 0);
});

test('a failing notification is logged and never thrown', async () => {
  const manager = fakeManager();
  const warnings: unknown[][] = [];
  const logger = { warn: (...args: unknown[]) => void warnings.push(args) };
  const failing = fakeServer(true);
  startChannelNotifier(manager, failing.server, 'codex', logger, ON);
  manager.emit(meta('/x', { id: 'one', state: 'completed' }), 'running');
  const throwing = startChannelNotifier(
    manager,
    {
      notification() {
        throw new Error('sync throw');
      },
    },
    'codex',
    logger,
    ON
  );
  manager.emit(meta('/x', { id: 'two', state: 'failed' }), 'running');
  throwing();
  await until(() => warnings.length >= 3, 'logged failures', 2000);
});

test('nothing is declared or sent when the env var is off', () => {
  for (const env of [{}, { AGENT_JOBS_CHANNEL: '1' }, { AGENT_JOBS_CHANNEL: '1', CLAUDE_AGENTS: '0' }]) {
    const caps = { tools: {}, logging: {} };
    assert.equal(withChannelCapabilities(caps, env), caps);
    assert.equal(withChannelInstructions('base', 'codex', env), 'base');
    assert.equal(withChannelInstructions(undefined, 'codex', env), undefined);
    const f = fixture();
    const store = new JobStore(f.home);
    const job = meta(f.home, { state: 'queued' });
    store.create(job, 'fake');
    const manager = fakeManager();
    const { calls, server } = fakeServer();
    startChannelNotifier({ ...manager, store }, server, 'codex', undefined, env)();
    assert.equal(manager.count(), 0);
    manager.emit({ ...job, state: 'completed' }, 'running');
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(store.dir(job.id), 'channel-sent')), false);
    f.cleanup();
  }
});

test('capabilities and instructions merge when enabled', () => {
  for (const env of [{ CLAUDE_AGENTS: '1' }, { CLAUDE_AGENTS: '1', AGENT_JOBS_CHANNEL: '0' }, ON]) {
    assert.match(withChannelInstructions(undefined, 'codex', env)!, /<channel/);
    assert.ok('experimental' in withChannelCapabilities({ tools: {} }, env));
    const manager = fakeManager();
    const { calls, server } = fakeServer();
    startChannelNotifier(manager, server, 'codex', undefined, env);
    manager.emit(meta('/x', { state: 'completed' }), 'running');
    assert.equal(calls.length, 1);
  }
  const caps = withChannelCapabilities(
    { tools: {}, experimental: { other: { a: 1 } } as Record<string, object> },
    ON
  );
  assert.deepEqual(caps, { tools: {}, experimental: { other: { a: 1 }, 'claude/channel': {} } });
  assert.deepEqual(withChannelCapabilities({ tools: {} }, ON), {
    tools: {},
    experimental: { 'claude/channel': {} },
  });
  const text = withChannelInstructions('Existing.', 'agy', ON)!;
  assert.match(text, /^Existing\.\n\nBackground agent events arrive as <channel source=/);
  assert.match(text, /call agy_agent_result with the job_id/);
  assert.match(withChannelInstructions(undefined, 'agy', ON)!, /^Background agent events/);
});

test('real manager: terminal states notify once without leaking worker output', async () => {
  const f = fixture();
  const reset = Date.now() + 3_600_000;
  const manager = new JobManager(fakeConnector(f.script, 'codex', reset), f.config);
  const { calls, server } = fakeServer();
  let stop = () => {};
  try {
    await manager.initialize();
    stop = startChannelNotifier(manager, server, 'codex', undefined, ON);
    const seen = (id: string) => calls.some(c => c.params.meta!.job_id === id);
    const ok = await manager.start({
      prompt: JSON.stringify({ final: SECRET, stderr: SECRET }),
      cwd: f.home,
      label: 'ok job',
    });
    await until(() => seen(ok.jobId), 'completed');
    const bad = await manager.start({
      prompt: JSON.stringify({ final: SECRET, stderr: SECRET, code: 1 }),
      cwd: f.home,
    });
    await until(() => seen(bad.jobId), 'failed');
    const slow = await manager.start({
      prompt: JSON.stringify({ final: SECRET, waitMs: 20000 }),
      cwd: f.home,
    });
    await until(() => manager.store.get(slow.jobId).state === 'running', 'slow running');
    await manager.cancel(slow.jobId);
    await until(() => seen(slow.jobId), 'killed');

    const limited = await manager.start({
      prompt: JSON.stringify({ limit: true, stderr: SECRET }),
      cwd: f.home,
    });
    await until(() => seen(limited.jobId), 'paused');
    const states = Object.fromEntries(
      calls.map(c => [c.params.meta!.job_id, c.params.meta!.state])
    );
    assert.deepEqual(states, {
      [ok.jobId]: 'completed',
      [bad.jobId]: 'failed',
      [limited.jobId]: 'paused',
      [slow.jobId]: 'killed',
    });
    assert.equal(calls.length, 4);
    const pausedMeta = calls.find(c => c.params.meta!.job_id === limited.jobId)!.params.meta!;
    assert.equal(pausedMeta.reset_at, new Date(reset).toISOString());
    assert.equal(pausedMeta.reason, 'usage_limit');
    assert.equal(calls.find(c => c.params.meta!.job_id === ok.jobId)!.params.meta!.label, 'okjob');
    for (const call of calls) {
      assert.equal(JSON.stringify(call).includes(SECRET), false);
      for (const key of Object.keys(call.params.meta!)) assert.equal(isIdentifier(key), true);
    }
    // A foreign owner's record written through this store is not announced.
    const before = calls.length;
    const foreign = { pid: 1, startTime: 'x' };
    manager.store.create(meta(f.home, { id: 'foreign', owner: foreign }), '');
    manager.store.write(meta(f.home, { id: 'foreign', state: 'completed', owner: foreign }));
    assert.equal(calls.length, before);
  } finally {
    stop();
    await manager.dispose();
    f.cleanup();
  }
});
