import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fixture, meta } from './test-helpers.js';
import { JobStore, atomicWrite } from './store.js';
import { currentOwner, isAlive } from './proc.js';
import { withLock } from './lock.js';
import { readConfig } from './config.js';

test('config defaults, file settings and environment overrides are isolated', () => {
  const f = fixture();
  try {
    const defaults = readConfig({ AGENT_JOBS_HOME: f.home });
    assert.equal(defaults.maxJobs, 8);
    assert.equal(defaults.wakeHold, true);
    writeFileSync(
      join(f.home, 'config.json'),
      JSON.stringify({ maxJobs: 3, wakeHold: false, connectors: { agy: { enabled: false } } })
    );
    assert.equal(readConfig({ AGENT_JOBS_HOME: f.home }).maxJobs, 3);
    const overridden = readConfig({ AGENT_JOBS_HOME: f.home, AGENT_JOBS_MAX: '2' });
    assert.equal(overridden.maxJobs, 2);
    assert.equal(overridden.wakeHold, false);
    assert.equal(overridden.connectors.agy.enabled, false);
    assert.deepEqual(defaults.connectors, {});
    assert.throws(() => readConfig({ AGENT_JOBS_HOME: f.home, AGENT_JOBS_MAX: '0' }));
  } finally {
    f.cleanup();
  }
});

test('store publishes complete JSON atomically to a concurrent reader, without temp files', async () => {
  const f = fixture();
  const store = new JobStore(f.home);
  const owner = { pid: process.pid, startTime: 'atomic-store-test' };
  const job = meta(f.home, { owner });
  store.create(job, 'full prompt');
  const worker = new Worker(
    `
    const {workerData, parentPort} = require('node:worker_threads');
    const fs = require('node:fs');
    parentPort.postMessage('ready');
    try {
      for (let i=0; i<3000; i++) JSON.parse(fs.readFileSync(workerData, 'utf8'));
      parentPort.postMessage('done');
    } catch (error) { throw error; }
  `,
    { eval: true, workerData: join(store.dir(job.id), 'meta.json') }
  );
  const finished = new Promise<void>((resolveResult, reject) => {
    worker.on('error', reject);
    worker.on('exit', code => (code ? reject(new Error(`reader exit ${code}`)) : resolveResult()));
  });
  void finished.catch(() => {});
  try {
    await new Promise(resolveReady => worker.once('message', resolveReady));
    for (let i = 0; i < 100; i++)
      store.save({ ...job, error: 'x'.repeat(30000), exitCode: i }, owner);
    await finished;
    assert.equal(store.get(job.id).exitCode, 99);
    assert.equal(store.read(job.id, 'prompt'), 'full prompt');
    assert.equal(readdirSync(store.dir(job.id)).filter(name => name.endsWith('.tmp')).length, 0);
    assert.throws(() => store.save(job, { ...owner, startTime: 'reused-pid' }), /owner/);
    assert.throws(() => store.dir('../escape'), /Invalid/);
  } finally {
    await worker.terminate();
    await finished.catch(() => {});
    f.cleanup();
  }
});

test('prune removes only finished records older than seven days', () => {
  const f = fixture();
  try {
    const store = new JobStore(f.home);
    const old = Date.now() - 8 * 86400000;
    store.create(meta(f.home, { id: 'old', state: 'completed', finishedAt: old }), 'p');
    store.create(meta(f.home, { id: 'running', state: 'running', updatedAt: old }), 'p');
    store.create(meta(f.home, { id: 'paused', state: 'paused', updatedAt: old }), 'p');
    store.create(meta(f.home, { id: 'new', state: 'failed' }), 'p');
    store.prune();
    assert.equal(existsSync(store.dir('old')), false);
    assert.equal(store.list().length, 3);
  } finally {
    f.cleanup();
  }
});

test('prune removes every task for a pruned job and keeps tasks for retained jobs', () => {
  const f = fixture();
  try {
    const store = new JobStore(f.home);
    const old = Date.now() - 8 * 86400000;
    store.create(meta(f.home, { id: 'old', state: 'completed', finishedAt: old }), 'p');
    store.create(meta(f.home, { id: 'keep', state: 'completed' }), 'p');
    store.create(meta(f.home, { id: 'reserved', state: 'failed', reserved: true, finishedAt: old }), 'p');
    const dir = join(f.home, 'tasks');
    mkdirSync(dir);
    for (const [taskId, jobId] of [['old-launch', 'old'], ['old-follow', 'old'], ['keep-task', 'keep'], ['reserved-task', 'reserved']])
      writeFileSync(join(dir, `${taskId}.json`), JSON.stringify({ taskId, jobId }));
    store.prune();
    assert.deepEqual(readdirSync(dir).sort(), ['keep-task.json', 'reserved-task.json']);
    assert.equal(existsSync(store.dir('reserved')), true);
  } finally { f.cleanup(); }
});

test('paged reads preserve UTF-8 across stream chunks and bound returned characters', async () => {
  const f = fixture();
  try {
    const store = new JobStore(f.home);
    const job = meta(f.home);
    store.create(job, 'prompt');
    const text = 'x'.repeat(65530) + 'こんにちは 🌍\n' + 'y'.repeat(22000);
    atomicWrite(store.path(job.id, 'final'), text);
    const page = await store.page(job.id, 'final', 65528, 20000);
    assert.equal(page.text, text.slice(65528, 85528));
    assert.equal(page.total, text.length);
    assert.equal(page.text.length, 20000);
    assert.equal((await store.page(job.id, 'final', text.length + 1, 20000)).text, '');
  } finally {
    f.cleanup();
  }
});

test('exclusive lock serializes contenders and reclaims a dead or reused PID', async () => {
  const f = fixture();
  try {
    const owner = await currentOwner();
    assert.equal(await isAlive(owner), true);
    assert.equal(await isAlive({ ...owner, startTime: 'wrong-start-time' }), false);
    writeFileSync(
      join(f.home, 'lock'),
      JSON.stringify({ ...owner, startTime: 'wrong-start-time' })
    );
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withLock(f.home, async () => {
          peak = Math.max(peak, ++running);
          await new Promise(resolveResult => setTimeout(resolveResult, 20));
          running--;
        })
      )
    );
    assert.equal(peak, 1);
    assert.equal(existsSync(join(f.home, 'lock')), false);
  } finally {
    f.cleanup();
  }
});
test('explicit failure reasons outrank auth text and auth fallback matches whole words', async () => {
  const { failureReason } = await import('./store.js');
  const cases = { usage_limit: 'quota_exhausted', timeout: 'timeout', cancelled: 'cancelled', stalled: 'stalled', 'kill-failed': 'kill_failed', owner_gone: 'lost', superseded: 'superseded' };
  for (const [reason, expected] of Object.entries(cases))
    assert.equal(failureReason(meta('unused', { state: 'failed', reason, error: 'API key usage limit; logging author designing' })), expected);
  assert.equal(failureReason(meta('unused', { state: 'lost', error: 'auth error' })), 'lost');
  for (const error of ['logging', 'author', 'designing', 'assigning'])
    assert.equal(failureReason(meta('unused', { state: 'failed', error })), 'cli_error');
  for (const error of ['Please sign in', 'login failed', 'authentication failed', 'unauthorized', 'API key missing', 'auth failed'])
    assert.equal(failureReason(meta('unused', { state: 'failed', error })), 'auth');
});
