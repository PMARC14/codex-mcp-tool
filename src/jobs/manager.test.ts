import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, fakeConnector, meta, until } from './test-helpers.js';
import { JobManager } from './manager.js';
import { JobStore } from './store.js';
import { currentOwner, isAlive, runCommand } from './proc.js';
import { createWorktree } from './worktree.js';

test('two managers own their jobs exclusively and share the machine limit across connectors', async () => {
  const f = fixture();
  const a = new JobManager(fakeConnector(f.script), f.config);
  const b = new JobManager(fakeConnector(f.script, 'agy'), f.config);
  const observer = new JobManager(fakeConnector(f.script), f.config);
  try {
    await Promise.all([a.initialize(), b.initialize(), observer.initialize()]);
    const log = join(f.home, 'runs');
    const one = await a.start({
      prompt: JSON.stringify({ log, waitMs: 1400 }),
      cwd: f.home,
      mode: 'write',
    });
    await until(() => a.store.get(one.jobId).state === 'running', 'first running');
    const two = await b.start({ prompt: JSON.stringify({ log, waitMs: 500 }), cwd: f.home });
    const three = await a.start({ prompt: JSON.stringify({ log, waitMs: 500 }), cwd: f.home });
    assert.equal(two.state, 'queued');
    await assert.rejects(() => observer.cancel(one.jobId), /owning server/);
    assert.equal((await observer.result(one.jobId)).state, 'running');
    let peak = 0;
    await until(() => {
      const jobs = a.store.list();
      const slots = jobs.filter(job => job.reserved || job.state === 'running').length;
      peak = Math.max(peak, slots);
      assert.ok(slots <= 1, 'global limit is never exceeded');
      return [one, two, three].every(job => a.store.get(job.jobId).state === 'completed');
    }, 'three completions');
    assert.equal(peak, 1);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      'start',
      'end',
      'start',
      'end',
      'start',
      'end',
    ]);
    assert.equal((await a.result(one.jobId)).sessionId, 'fake-session');
  } finally {
    await Promise.all([a.dispose(), b.dispose(), observer.dispose()]);
    f.cleanup();
  }
});

test('cancel waits for exit, is idempotent, and timeout wins over a successful exit', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const job = await manager.start({ prompt: JSON.stringify({ waitMs: 10000 }), cwd: f.home });
    await until(() => manager.store.get(job.jobId).state === 'running');
    const identity = manager.store.get(job.jobId).process!;
    await manager.cancel(job.jobId);
    assert.equal((await manager.result(job.jobId)).state, 'killed');
    assert.equal(await isAlive(identity), false);
    await manager.cancel(job.jobId);
    assert.equal((await manager.result(job.jobId)).reason, 'cancelled');
    const timed = await manager.start({
      prompt: JSON.stringify({ waitMs: 10000 }),
      cwd: f.home,
      timeoutMin: 0.003,
    });
    const result = await manager.result(timed.jobId, 10);
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'timeout');
    assert.equal(await isAlive(manager.store.get(timed.jobId).process!), false);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('missing executable and invalid cwd fail asynchronously and free the reserved slot', async () => {
  const f = fixture();
  const connector = fakeConnector(f.script);
  const original = connector.build;
  connector.build = job =>
    job.label === 'missing'
      ? { exe: join(f.home, 'missing.exe'), args: [], stdin: job.prompt }
      : original(job);
  const manager = new JobManager(connector, f.config);
  try {
    const bad = await manager.start({ prompt: 'p', cwd: f.home, label: 'missing' });
    const cwd = await manager.start({ prompt: 'p', cwd: join(f.home, 'absent') });
    const good = await manager.start({ prompt: 'p', cwd: f.home });
    for (const job of [bad, cwd]) {
      const result = await manager.result(job.jobId, 10);
      assert.equal(result.state, 'failed');
      assert.equal(result.reason, 'spawn_error');
      assert.equal(manager.store.get(job.jobId).startedAt, undefined);
      assert.equal(manager.store.get(job.jobId).reserved, false);
    }
    assert.equal((await manager.result(good.jobId, 10)).state, 'completed');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('startup marks dead running and queued owners lost, preserves live owners and prunes', async () => {
  const f = fixture();
  const store = new JobStore(f.home);
  const owner = await currentOwner();
  const dead = { ...owner, startTime: 'reused-pid' };
  for (const state of ['queued', 'running'] as const)
    store.create(meta(f.home, { id: state, state, owner: dead }), 'original');
  store.create(meta(f.home, { id: 'live', owner }), 'original');
  store.create(
    meta(f.home, { id: 'expired', state: 'completed', finishedAt: Date.now() - 8 * 86400000 }),
    'p'
  );
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    assert.equal(store.get('queued').state, 'lost');
    assert.equal(store.get('running').state, 'lost');
    assert.equal(store.get('live').state, 'queued');
    assert.equal((await manager.list()).length, 3);
    const requeued = await manager.requeue('queued');
    assert.equal(store.read(requeued.jobId, 'prompt'), 'original');
    assert.equal((await manager.result(requeued.jobId, 10)).state, 'completed');
    assert.equal(store.get('queued').state, 'lost');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('usage limits pause the connector queue and automatically retry after reset', async () => {
  const f = fixture();
  const resetAt = Date.now() + 2800;
  const manager = new JobManager(fakeConnector(f.script, 'codex', resetAt), f.config);
  try {
    const one = await manager.start({
      prompt: JSON.stringify({ limit: true, once: join(f.home, 'limited') }),
      cwd: f.home,
    });
    const two = await manager.start({ prompt: 'second job', cwd: f.home });
    await until(() => manager.store.get(one.jobId).state === 'paused', 'usage pause');
    assert.equal(manager.store.get(one.jobId).resetAt, resetAt);
    await until(() => manager.store.get(two.jobId).state === 'paused', 'queued pause');
    await until(
      () => [one, two].every(job => manager.store.get(job.jobId).state === 'completed'),
      'reset retries'
    );
    assert.equal((await manager.result(two.jobId)).final, 'second job');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('saved pauses survive restart and can be handed to the sibling connector unowned', async () => {
  const f = fixture();
  const store = new JobStore(f.home);
  store.create(
    meta(f.home, {
      id: 'paused',
      owner: { pid: process.pid, startTime: 'old-owner' },
      state: 'paused',
      reason: 'usage_limit',
    }),
    'saved full prompt'
  );
  const a = new JobManager(fakeConnector(f.script), f.config);
  const b = new JobManager(fakeConnector(f.script, 'agy'), f.config);
  try {
    await a.initialize();
    assert.equal(store.get('paused').state, 'paused');
    const queued = await a.requeue('paused', 'another-model', 'agy');
    assert.equal(store.get(queued.jobId).owner, undefined);
    await b.initialize();
    const result = await b.result(queued.jobId, 10);
    assert.equal(result.state, 'completed');
    assert.equal(result.final, 'saved full prompt');
    assert.equal(store.get(queued.jobId).connector, 'agy');
  } finally {
    await Promise.all([a.dispose(), b.dispose()]);
    f.cleanup();
  }
});

test('result prefers -o output, caps text, and read pages recover the remainder', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const text = 'x'.repeat(25000) + 'tail';
    const job = await manager.start({
      prompt: JSON.stringify({ final: text, file: true }),
      cwd: f.home,
    });
    const result = await manager.result(job.jobId, 10);
    assert.equal(result.state, 'completed');
    assert.equal(result.final.length, 20000);
    assert.equal(result.truncated, true);
    assert.equal(result.finalPath, manager.store.path(job.jobId, 'final'));
    const rest = await manager.read(job.jobId, 'final', 20000, 20000);
    assert.equal(result.final + rest.text, text);
    assert.equal(rest.total, text.length);
    assert.equal((await manager.read(job.jobId, 'prompt', 0, 50000)).text.length, 20000);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('store failure after spawn kills the worker, keeps a failed record and frees the queue', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  const save = manager.store.save.bind(manager.store);
  let failed = false;
  manager.store.save = (job, owner) => {
    if (job.state === 'running' && !failed) {
      failed = true;
      throw new Error('simulated disk error');
    }
    save(job, owner);
  };
  try {
    const bad = await manager.start({ prompt: JSON.stringify({ waitMs: 10000 }), cwd: f.home });
    const good = await manager.start({ prompt: 'good', cwd: f.home });
    assert.equal((await manager.result(bad.jobId, 10)).state, 'failed');
    assert.equal(manager.store.get(bad.jobId).reserved, false);
    assert.equal((await manager.result(good.jobId, 10)).state, 'completed');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('unavailable or disabled CLI fails start immediately with an install hint', async () => {
  const f = fixture();
  const connector = fakeConnector(f.script);
  connector.detect = async () => ({ available: false, reason: 'Install fake CLI and sign in' });
  const manager = new JobManager(connector, f.config);
  try {
    await assert.rejects(() => manager.start({ prompt: 'p', cwd: f.home }), /Install/);
    assert.equal(manager.store.list().length, 0);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('failed orphan cleanup keeps the slot and cleanup identities until termination is confirmed', async () => {
  const f = fixture();
  const store = new JobStore(f.home);
  const dead = { ...(await currentOwner()), startTime: 'reused-pid' };
  const root = { pid: 424242, startTime: '1' };
  const child = { pid: 424243, startTime: '2' };
  store.create(
    meta(f.home, {
      id: 'orphan',
      state: 'running',
      reserved: true,
      owner: dead,
      process: root,
      descendants: [child],
    }),
    'p'
  );
  let terminated = false;
  const attempts: unknown[] = [];
  const manager = new JobManager(fakeConnector(f.script), f.config, undefined, {
    async killTree(rootIdentity, children) {
      attempts.push([rootIdentity, children]);
      if (!terminated) throw new Error('kill-failed: processes in the tree are still alive');
    },
  });
  try {
    await manager.initialize();
    const orphan = store.get('orphan');
    assert.equal(orphan.state, 'lost');
    assert.equal(orphan.reserved, true);
    assert.deepEqual(orphan.process, root);
    assert.deepEqual(orphan.descendants, [child]);
    await assert.rejects(() => manager.requeue('orphan'), /still alive/);
    const next = await manager.start({ prompt: 'next', cwd: f.home });
    await new Promise(resolveWait => setTimeout(resolveWait, 1500));
    assert.equal(
      store.get(next.jobId).state,
      'queued',
      'the orphan still counts against the limit'
    );
    terminated = true;
    await until(() => store.get('orphan').reserved === false, 'cleanup retried');
    assert.deepEqual(attempts.at(-1), [root, [child]]);
    assert.equal((await manager.result(next.jobId, 10)).state, 'completed');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('requeue revalidates the original under the lock and cannot clobber a job promoted meanwhile', async () => {
  const f = fixture();
  const connector = fakeConnector(f.script, 'codex', Date.now() + 60000);
  const manager = new JobManager(connector, f.config);
  try {
    const one = await manager.start({ prompt: JSON.stringify({ limit: true }), cwd: f.home });
    await until(() => manager.store.get(one.jobId).state === 'paused', 'usage pause');
    const before = manager.store.list().length;
    const detect = connector.detect.bind(connector);
    connector.detect = async () => {
      // Reset-time promotion wins the race while requeue awaits availability.
      connector.detect = detect;
      manager.store.write({ ...manager.store.get(one.jobId), state: 'running', reserved: true });
      return detect();
    };
    await assert.rejects(() => manager.requeue(one.jobId), /Only paused/);
    assert.equal(manager.store.list().length, before, 'no replacement job is created');
    const original = manager.store.get(one.jobId);
    assert.equal(original.state, 'running');
    assert.equal(original.reserved, true);
    assert.notEqual(original.pauseCleared, true);
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('handing the only paused job to another connector does not lift the quota pause', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script, 'codex', Date.now() + 60000), f.config);
  try {
    const one = await manager.start({ prompt: JSON.stringify({ limit: true }), cwd: f.home });
    await until(() => manager.store.get(one.jobId).state === 'paused', 'usage pause');
    const handed = await manager.requeue(one.jobId, undefined, 'agy');
    assert.equal(manager.store.get(handed.jobId).connector, 'agy');
    const two = await manager.start({ prompt: 'second', cwd: f.home });
    await until(() => manager.store.get(two.jobId).state === 'paused', 'new job pauses', 8000);
    assert.equal(manager.store.get(two.jobId).reason, 'usage_limit');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('a manual requeue on the same connector bypasses the pause, and its success lifts it', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script, 'codex', Date.now() + 60000), f.config);
  try {
    const one = await manager.start({
      prompt: JSON.stringify({ limit: true, once: join(f.home, 'limited') }),
      cwd: f.home,
    });
    await until(() => manager.store.get(one.jobId).state === 'paused', 'usage pause');
    const again = await manager.requeue(one.jobId);
    assert.equal((await manager.result(again.jobId, 10)).state, 'completed');
    await until(() => manager.store.pauses().length === 0, 'pause lifted by the success');
    const next = await manager.start({ prompt: 'after', cwd: f.home });
    assert.equal((await manager.result(next.jobId, 10)).state, 'completed');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('collect refuses to remove a worktree that a requeued replacement still uses', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    const root = join(f.home, 'repo');
    mkdirSync(root);
    const git = (...args: string[]) => runCommand('git', args, root);
    await git('init');
    await git('config', 'user.email', 'agent-jobs-test@example.invalid');
    await git('config', 'user.name', 'Agent jobs tests');
    await git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'tracked.txt'), 'base\n');
    await git('add', '-A');
    await git('commit', '-m', 'base');
    const worktree = await createWorktree(root, 'shared', 'shared-wt', 'codex');
    const mine = {
      owner: await currentOwner(),
      managerId: (manager as unknown as { id: string }).id,
    };
    const store = manager.store;
    store.create(meta(f.home, { id: 'orig', state: 'failed', worktree, ...mine }), 'p');
    store.create(
      meta(f.home, {
        id: 'repl',
        state: 'running',
        reserved: true,
        requeuedFrom: 'orig',
        worktree,
        ...mine,
      }),
      'p'
    );
    await assert.rejects(() => manager.collect('orig', 'worktree'), /still uses this worktree/);
    assert.equal(existsSync(worktree.path), true);
    assert.notEqual(store.get('orig').worktree?.removed, true);
    store.write({ ...store.get('repl'), state: 'completed', reserved: false });
    const result = await manager.collect('orig', 'worktree');
    assert.equal(result.removed, true);
    assert.equal(existsSync(worktree.path), false);
    assert.equal(store.get('repl').worktree?.removed, true, 'every job sharing it is updated');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('a final answer after an intermediate error completes the job (agy read mode answers on turn 2)', async () => {
  const f = fixture();
  const base = fakeConnector(f.script);
  // The fake worker writes opts.stderr first, then the final answer on stdout.
  const connector = {
    ...base,
    parse(line: string, stream: 'stdout' | 'stderr') {
      if (stream === 'stderr' && line.includes('empty turn')) return { error: 'agy produced no response' };
      return base.parse(line, stream);
    },
  };
  const manager = new JobManager(connector, f.config);
  try {
    const { jobId } = await manager.start({
      prompt: JSON.stringify({ stderr: 'empty turn\n', final: 'the review', waitMs: 50 }),
      cwd: f.home,
    });
    await until(async () => !['queued', 'running'].includes((await manager.result(jobId)).state), 'job end');
    const result = await manager.result(jobId);
    assert.equal(result.state, 'completed');
    assert.equal(result.final, 'the review');
  } finally {
    await manager.dispose?.();
    f.cleanup();
  }
});
