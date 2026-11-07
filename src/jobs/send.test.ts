import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { JobManager } from './manager.js';
import type { JobSpec } from './connector.js';
import { fixture, fakeConnector, meta, until } from './test-helpers.js';
import { registerJobTools, type JobTool } from './tools.js';

test('send creates a new resumed follow-up through start, inheriting execution settings', async () => {
  const f = fixture();
  const built: JobSpec[] = [];
  const connector = fakeConnector(f.script);
  const build = connector.build;
  connector.build = job => {
    built.push(job);
    return build(job);
  };
  const manager = new JobManager(connector, f.config);
  try {
    const original = await manager.start({
      prompt: 'first turn',
      cwd: f.home,
      mode: 'trusted',
      model: 'fake',
      effort: 'high',
      timeoutMin: 3,
    });
    assert.equal((await manager.result(original.jobId, 10)).sessionId, 'fake-session');
    const tools: JobTool[] = [];
    registerJobTools(tools, 'codex', manager);
    const send = tools.find(tool => tool.name === 'codex_agent_message')!;
    const message = '\nsecond turn\n';
    const result = JSON.parse(await send.execute({ jobId: original.jobId, message }));
    assert.notEqual(result.jobId, original.jobId);
    assert.deepEqual(result, { delivered: 'resumed', jobId: result.jobId });
    const saved = manager.store.get(result.jobId);
    assert.equal(saved.followUpOf, original.jobId);
    assert.equal(saved.resumeSession, 'fake-session');
    assert.equal(saved.connector, 'codex');
    assert.equal(saved.cwd, f.home);
    assert.equal(saved.mode, 'trusted');
    assert.equal(saved.model, 'fake');
    assert.equal(saved.effort, 'high');
    assert.equal(saved.timeoutMin, 3);
    assert.equal(manager.store.read(saved.id, 'prompt'), message);
    assert.equal((await manager.result(saved.id, 10)).final, message);
    assert.equal(built[1].resumeSession, 'fake-session');
    assert.equal(built[1].prompt, message);
    const overridden = JSON.parse(await send.execute({ jobId: saved.id, message: 'third turn',
      mode: 'read',
      model: 'replacement',
      effort: 'low',
      timeoutMin: 2,
    }));
    const third = manager.store.get(overridden.jobId);
    assert.equal(third.mode, 'read');
    assert.equal(third.model, 'replacement');
    assert.equal(third.effort, 'low');
    assert.equal(third.timeoutMin, 2);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('send revalidates a paused source under the lock after an availability check', async () => {
  const f = fixture();
  const connector = fakeConnector(f.script);
  const manager = new JobManager(connector, f.config);
  try {
    await manager.initialize();
    const source = meta(f.home, { id: 'source', state: 'paused', sessionId: 'session' });
    manager.store.create(source, 'old prompt');
    const detect = connector.detect;
    connector.detect = async () => {
      manager.store.write({ ...source, state: 'running', reserved: true });
      return detect();
    };
    await assert.rejects(manager.send(source.id, 'new prompt'), /agent_follow.*agent_stop/);
    assert.equal(manager.store.list().length, 1);
    assert.equal(manager.store.get(source.id).pauseCleared, undefined);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('send rejects running, queued, reserved and sessionless jobs with actionable errors', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const running = await manager.start({ prompt: JSON.stringify({ waitMs: 10000 }), cwd: f.home });
    await until(() => manager.store.get(running.jobId).state === 'running');
    const queued = await manager.start({ prompt: 'queued', cwd: f.home });
    for (const job of [running, queued])
      await assert.rejects(
        manager.send(job.jobId, 'follow-up'),
        /codex_agent_follow.*codex_agent_stop/
      );
    manager.store.create(meta(f.home, { id: 'no-session', state: 'completed' }), 'p');
    await assert.rejects(manager.send('no-session', 'follow-up'), /no sessionId/);
    manager.store.create(
      meta(f.home, {
        id: 'reserved',
        state: 'failed',
        reserved: true,
        sessionId: 'still-alive',
      }),
      'p'
    );
    await assert.rejects(manager.send('reserved', 'follow-up'), /process cleanup/);
    assert.equal(manager.store.list().length, 4, 'rejected sends create no job');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('send accepts each stopped state, respects quota pauses and supersedes a paused retry', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    manager.store.writePauses([
      { connector: 'codex', since: Date.now(), resetAt: Date.now() + 60000 },
    ]);
    for (const state of ['completed', 'failed', 'killed', 'paused', 'lost'] as const) {
      const original = meta(f.home, { id: state, state, sessionId: `session-${state}` });
      manager.store.create(original, 'old prompt');
      const followUp = await manager.send(original.id, 'new message');
      const saved = manager.store.get(followUp.jobId);
      assert.equal(saved.resumeSession, original.sessionId);
      await until(() => manager.store.get(saved.id).state === 'paused');
      if (state === 'paused') assert.equal(manager.store.get(original.id).pauseCleared, true);
    }
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('send reuses an existing worktree and falls back to the original cwd when it is missing', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    // Keep the jobs queued so these metadata-only worktree references never run git.
    f.config.maxJobs = 1;
    manager.store.create(meta(f.home, { id: 'slot', state: 'running' }), 'p');
    const path = join(f.home, 'worktree');
    const originalCwd = join(f.home, 'original-subdirectory');
    mkdirSync(path);
    mkdirSync(originalCwd);
    const worktree = { path, root: f.home, gitDir: path, branch: 'fake', baseSha: 'fake' };
    for (const kind of ['exists', 'missing', 'removed', 'legacy'] as const) {
      const original = meta(f.home, {
        id: kind,
        state: 'completed',
        sessionId: 'session',
        cwd: path,
        originalCwd: kind === 'legacy' ? undefined : originalCwd,
        worktree: {
          ...worktree,
          path: kind === 'missing' || kind === 'legacy' ? join(path, 'missing') : path,
          removed: kind === 'removed',
        },
      });
      manager.store.create(original, 'p');
      const next = await manager.send(original.id, 'continue');
      const saved = manager.store.get(next.jobId);
      assert.equal(saved.cwd, kind === 'exists' ? path : kind === 'legacy' ? f.home : originalCwd);
      assert.deepEqual(saved.worktree, kind === 'exists' ? original.worktree : undefined);
    }
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('send preserves a foreign connector and queues for its manager under the shared slot limit', async () => {
  const f = fixture();
  const a = new JobManager(fakeConnector(f.script), f.config);
  const b = new JobManager(fakeConnector(f.script, 'agy'), f.config);
  try {
    await Promise.all([a.initialize(), b.initialize()]);
    const busy = await a.start({ prompt: JSON.stringify({ waitMs: 10000 }), cwd: f.home });
    await until(() => a.store.get(busy.jobId).state === 'running');
    a.store.create(
      meta(f.home, {
        id: 'foreign',
        state: 'completed',
        connector: 'agy',
        sessionId: 'agy-session',
        model: 'fake',
      }),
      'p'
    );
    const followUp = await a.send('foreign', 'continue on agy');
    assert.equal(a.store.get(followUp.jobId).connector, 'agy');
    assert.equal(a.store.get(followUp.jobId).state, 'queued');
    await a.cancel(busy.jobId);
    const result = await b.result(followUp.jobId, 10);
    assert.equal(result.state, 'completed');
    assert.equal(result.final, 'continue on agy');
    assert.equal(b.isOwn(b.store.get(followUp.jobId)), true);
  } finally {
    await Promise.all([a.dispose(), b.dispose()]);
    f.cleanup();
  }
});
