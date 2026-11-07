import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, fakeConnector, meta, until } from './test-helpers.js';
import { JobManager } from './manager.js';
import type { JobMeta, JobState } from './connector.js';
import { progressMessage } from './watch.js';
import { startChannelNotifier } from './channel.js';
import { registerJobTools, type JobTool } from './tools.js';
import { getToolDefinitions, toolRegistry } from '../tools/registry.js';

 test('reasoning is bounded and opt-in; progress identifies the agent', async () => {
  const f = fixture();
  const connector = fakeConnector(f.script);
  connector.parse = (line, stream) => {
    if (stream !== 'stdout') return null;
    try { const e = JSON.parse(line); return e.item?.type === 'reasoning' ? { reasoning: e.item.text } : e.type === 'thread.started' ? { sessionId: e.thread_id } : e.item?.type === 'agent_message' ? { final: e.item.text } : null; } catch { return null; }
  };
  writeFileSync(f.script, `process.stdin.resume(); process.stdin.on('end', () => { console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'a'.repeat(270000)+'. Last sentence.'}})); setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})), 5000); });`);
  const manager = new JobManager(connector, f.config);
  try {
    const { jobId } = await manager.start({ prompt: 'p', cwd: f.home, model: 'gpt-6.1-sol', label: 'check' });
    await until(() => statSync(manager.store.path(jobId, 'reasoning')).size > 0, 'reasoning');
    assert.ok(statSync(manager.store.path(jobId, 'reasoning')).size <= 256 * 1024);
    assert.equal('reasoningTail' in await manager.result(jobId), false);
    assert.ok((await manager.result(jobId, 0, true)).reasoningTail!.endsWith('Last sentence.\n'));
    await until(() => manager.store.get(jobId).state === 'running', 'running');
    const job = manager.store.get(jobId);
    const progress = progressMessage(manager, job, true);
    assert.match(progress, /^codex sol · check \| running \| \d+s \| Last sentence\./);
    assert.ok(progress.length <= 120);
    assert.ok(!progressMessage(manager, job).includes('Last sentence.'));
    const messages: string[] = [];
    await manager.watch(jobId, 10, { showReasoning: true, heartbeatMs: 20, onProgress: message => messages.push(message) });
    assert.ok(messages.some(message => message.includes('Last sentence.')));
    assert.ok(existsSync(join(manager.store.dir(jobId), 'collected')));
  } finally { await manager.dispose(); f.cleanup(); }
});

test('tool titles reach MCP definitions', () => {
  const f = fixture(); const manager = new JobManager(fakeConnector(f.script), f.config);
  const jobs: JobTool[] = []; registerJobTools(jobs, 'codex', manager);
  const before = toolRegistry.length;
  try {
    toolRegistry.push(...jobs);
    const tool = getToolDefinitions().find(t => t.name === 'codex_job_watch')!;
    assert.equal(tool.title, 'Codex agent: watch job');
    assert.equal(tool.annotations?.title, tool.title);
  } finally { toolRegistry.splice(before); f.cleanup(); }
});

test('channel marker deduplicates across notifier instances', async () => {
  const f = fixture(); const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    const job = meta(f.home, { state: 'queued' }); manager.store.create(job, 'p');
    let calls = 0; const server = { async notification() { calls++; } };
    // Synthetic transition source keeps ownership independent from process scheduling.
    let emit!: (item: JobMeta, previous: JobState | undefined) => void;
    const source = { store: manager.store, isOwn: () => true, onTransition(listener: typeof emit) { emit = listener; return () => {}; } };
    startChannelNotifier(source, server, 'codex', undefined, { AGENT_JOBS_CHANNEL: '1' });
    emit({ ...job, state: 'completed' }, 'running');
    startChannelNotifier(source, server, 'codex', undefined, { AGENT_JOBS_CHANNEL: '1' });
    emit({ ...job, state: 'completed' }, 'running');
    assert.equal(calls, 1); assert.ok(existsSync(join(manager.store.dir(job.id), 'channel-sent')));
    assert.equal(existsSync(join(manager.store.dir(job.id), 'woken')), false);
  } finally { await manager.dispose(); f.cleanup(); }
});

test('stall reports and clears on output, and kill permits requeue', async () => {
  const f = fixture(); const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const { jobId } = await manager.start({ prompt: JSON.stringify({ waitMs: 10000 }), cwd: f.home, stallTimeoutMin: 0.005 });
    await until(() => !!manager.store.get(jobId).stalled, 'stall');
    appendFileSync(manager.store.path(jobId, 'stderr'), 'activity');
    await until(() => manager.store.get(jobId).stalled === false, 'stall clear');
    await manager.cancel(jobId);
    const killed = await manager.start({ prompt: JSON.stringify({ waitMs: 10000 }), cwd: f.home, stallTimeoutMin: 0.005, onStall: 'kill' });
    await until(() => manager.store.get(killed.jobId).reason === 'stalled', 'stall kill');
    const replacement = await manager.requeue(killed.jobId);
    assert.equal(manager.store.get(replacement.jobId).onStall, 'kill');
    assert.equal(manager.store.get(replacement.jobId).stallTimeoutMin, 0.005);
  } finally { await manager.dispose(); f.cleanup(); }
});

test('idempotency and optional quota guard use cached usage', async () => {
  const f = fixture(); let reads = 0; let used = 95;
  const connector = { ...fakeConnector(f.script), async usagePercent() { reads++; return used; } };
  const manager = new JobManager(connector, f.config);
  try {
    const first = await manager.start({ prompt: 'hello', cwd: f.home, idempotencyKey: 'same' });
    const again = await manager.start({ prompt: 'other', cwd: f.home, idempotencyKey: 'same', priority: 'optional' });
    assert.equal(again.jobId, first.jobId);
    await assert.rejects(manager.start({ prompt: 'x', cwd: f.home, priority: 'optional' }), /5-hour or weekly.*95%/);
    used = 0;
    await assert.rejects(manager.start({ prompt: 'x', cwd: f.home, priority: 'optional' }), /95%/);
    assert.equal(reads, 1);
  } finally { await manager.dispose(); f.cleanup(); }
});

test('task markers suppress channels and retry clears delivery markers', async () => {
  const f = fixture(); const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    const job = meta(f.home); manager.store.create(job, 'p');
    let calls = 0;
    startChannelNotifier({ store: manager.store, isOwn: () => true, onTransition: manager.onTransition.bind(manager) }, { async notification() { calls++; } }, 'codex', undefined, { AGENT_JOBS_CHANNEL: '1' });
    const dir = manager.store.dir(job.id);
    writeFileSync(join(dir, 'mcp-task.json'), '{}');
    manager.store.write({ ...job, state: 'paused', reason: 'usage_limit' });
    assert.equal(calls, 0);
    assert.equal(manager.store.get(job.id).failureReason, 'quota_exhausted');
    writeFileSync(join(dir, 'woken'), ''); writeFileSync(join(dir, 'collected'), '');
    manager.store.write({ ...job, state: 'queued' });
    assert.equal(existsSync(join(dir, 'woken')), false);
    assert.equal(existsSync(join(dir, 'collected')), false);
  } finally { await manager.dispose(); f.cleanup(); }
});

test('failed verification is categorized and can be requeued', async () => {
  const f = fixture(); const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const { jobId } = await manager.start({ prompt: 'done', cwd: f.home, mode: 'write', verify: 'exit 1' });
    await until(() => manager.store.get(jobId).state === 'completed', 'verification', 60000);
    assert.equal((await manager.result(jobId)).failureReason, 'verify_failed');
    const replacement = await manager.requeue(jobId);
    assert.equal(manager.store.get(replacement.jobId).requeuedFrom, jobId);
  } finally { await manager.dispose(); f.cleanup(); }
});

test('stopped failure categories and partial output are persisted', async () => {
  const f = fixture(); const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const cases = [
      ['usage_limit', 'paused', 'quota_exhausted'], ['timeout', 'failed', 'timeout'],
      ['cancelled', 'killed', 'cancelled'], ['stalled', 'killed', 'stalled'],
      ['kill-failed', 'failed', 'kill_failed'], ['owner_gone', 'lost', 'lost'],
      ['superseded', 'killed', 'superseded'], ['cli_error', 'failed', 'cli_error'],
    ] as const;
    const job = meta(f.home); manager.store.create(job, 'p');
    writeFileSync(manager.store.path(job.id, 'stdout'), 'partial output');
    for (const [reason, state, expected] of cases) {
      manager.store.write({ ...job, state, reason });
      assert.equal(manager.store.get(job.id).failureReason, expected);
      assert.equal(manager.store.get(job.id).partial, true);
    }
    manager.store.write({ ...job, state: 'failed', reason: 'cli_error', error: 'Please sign in' });
    assert.equal(manager.store.get(job.id).failureReason, 'auth');
  } finally { await manager.dispose(); f.cleanup(); }
});

test('concurrent idempotency keys create only one job and unknown usage fails open', async () => {
  const f = fixture(); const manager = new JobManager({ ...fakeConnector(f.script), async usagePercent() { return undefined; } }, f.config);
  try {
    const jobs = await Promise.all(Array.from({ length: 3 }, () => manager.start({ prompt: 'hello', cwd: f.home, priority: 'optional', idempotencyKey: 'one' })));
    assert.equal(new Set(jobs.map(job => job.jobId)).size, 1);
    assert.equal(manager.store.list().length, 1);
  } finally { await manager.dispose(); f.cleanup(); }
});

test('cancellation while preparing verification prevents the verify process', async () => {
  const f = fixture(); let preparing = false; let release!: (shell: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  const manager = new JobManager(fakeConnector(f.script), f.config, undefined, { verifyShell: async () => { preparing = true; return gate; } });
  try {
    const { jobId } = await manager.start({ prompt: 'answer', cwd: f.home, mode: 'write', verify: 'echo should-not-run' });
    await until(() => preparing, 'verify preparation', 60000);
    const cancelling = manager.cancel(jobId);
    await until(() => (manager as any).active.get(jobId)?.cancelled === true, 'cancel registered', 60000);
    release('bash');
    await cancelling;
    const result = await manager.result(jobId);
    assert.equal(result.state, 'killed');
    assert.equal(result.failureReason, 'cancelled');
    assert.equal(manager.store.read(jobId, 'verify'), '');
  } finally { release('bash'); await manager.dispose(); f.cleanup(); }
});
