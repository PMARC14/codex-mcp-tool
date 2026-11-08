import { test } from 'node:test';
import assert from 'node:assert/strict';
import spawn from 'cross-spawn';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, fakeConnector, meta, until } from './test-helpers.js';
import { JobManager } from './manager.js';
import { bridgeSampler, publishAnswer } from './bridge.js';
import { lockTestHooks, reclaimStale, releaseOwned, tryAcquire } from './lock.js';
import { claimQuestion, readAnswerFile, releaseQuestion } from './question-claim.js';
import { getUsage } from './usage-cache.js';
import { currentOwner, processStartTime } from './proc.js';

const bridgePath = fileURLToPath(new URL('../bridge/agent-bridge.js', import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), 'agent-jobs-lock-'));

// ---- Astra #1: a foreign responder never writes job metadata ----
test('a foreign responder publishes only the answer file and leaves meta.json untouched', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    const jobId = 'foreign-respond', qid = 'q-foreign';
    manager.store.create(meta(f.home, { id: jobId, state: 'running', owner: await currentOwner(), managerId: 'someone-else',
      awaitingInput: { qid, question: 'q?', askedAt: Date.now() } }), 'fake');
    writeFileSync(join(manager.store.dir(jobId), 'question.json'), JSON.stringify({ id: qid, question: 'q?', askedAt: Date.now() }));
    const metaPath = join(manager.store.dir(jobId), 'meta.json');
    const before = readFileSync(metaPath, 'utf8');
    await manager.respond(jobId, { answer: 'yes', qid });
    assert.equal(readFileSync(metaPath, 'utf8'), before, 'foreign respond must not rewrite meta.json');
    assert.equal(JSON.parse(readFileSync(join(manager.store.dir(jobId), `answer-${qid}.json`), 'utf8')).answer, 'yes');
  } finally { await manager.dispose(); f.cleanup(); }
});

// ---- Astra #2: lock reclamation and release stay exclusive ----
test('a second reclaimer holding the same stale judgement leaves the fresh lock alone', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'lock');
    const stale = JSON.stringify({ token: 'dead' }), fresh = JSON.stringify({ token: 'fresh' });
    writeFileSync(path, stale);
    assert.equal(reclaimStale(path, stale), 'reclaimed');
    assert.equal(tryAcquire(path, fresh), true); // A acquires
    assert.equal(reclaimStale(path, stale), 'changed'); // B, judged earlier, must not touch A's lock
    assert.equal(readFileSync(path, 'utf8'), fresh);
    assert.equal(tryAcquire(path, JSON.stringify({ token: 'C' })), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the lock is replaced between judgement and reclaim: the replacement survives', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'lock');
    const stale = JSON.stringify({ token: 'dead' }), fresh = JSON.stringify({ token: 'fresh' });
    writeFileSync(path, stale);
    lockTestHooks.beforeReread = () => { rmSync(path); writeFileSync(path, fresh); };
    assert.equal(reclaimStale(path, stale), 'changed');
    assert.equal(readFileSync(path, 'utf8'), fresh);
    assert.deepEqual(readdirSync(dir).sort(), ['lock']);
  } finally { lockTestHooks.beforeReread = undefined; rmSync(dir, { recursive: true, force: true }); }
});

test('reclaiming is serialized: while another reclaimer is working the lock counts as held', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'lock');
    const stale = JSON.stringify({ token: 'dead' });
    writeFileSync(path, stale);
    writeFileSync(`${path}.reaper`, '1');
    assert.equal(reclaimStale(path, stale), 'busy');
    assert.equal(readFileSync(path, 'utf8'), stale);
    // A crashed reaper (old file) is cleared so the next attempt can proceed.
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.reaper`, old, old);
    assert.equal(reclaimStale(path, stale), 'busy');
    assert.equal(reclaimStale(path, stale), 'reclaimed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release removes only our own lock, even when another process replaced it just before', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'lock');
    writeFileSync(path, 'A');
    // Between A deciding to release and the removal, A's lock was reclaimed and B took the name.
    lockTestHooks.beforeRelease = () => { rmSync(path); writeFileSync(path, 'B'); };
    assert.equal(releaseOwned(path, raw => raw === 'A'), false);
    lockTestHooks.beforeRelease = undefined;
    assert.equal(readFileSync(path, 'utf8'), 'B');
    assert.equal(releaseOwned(path, raw => raw === 'B'), true);
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(dir), []);
  } finally { lockTestHooks.beforeRelease = undefined; rmSync(dir, { recursive: true, force: true }); }
});

test('an expired question claim is replaced once; the old asker cannot release the new claim', () => {
  const dir = scratch();
  try {
    const old = { owner: 'bridge', id: 'old', ts: Date.now() - 10_000, timeoutMs: 1000 };
    assert.equal(claimQuestion(dir, old), true);
    assert.equal(claimQuestion(dir, { owner: 'bridge', id: 'new', ts: Date.now(), timeoutMs: 60_000 }), true);
    assert.equal(claimQuestion(dir, { owner: 'bridge', id: 'third', ts: Date.now(), timeoutMs: 60_000 }), false);
    assert.equal(releaseQuestion(dir, 'old'), false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'question.lock'), 'utf8')).id, 'new');
    assert.equal(releaseQuestion(dir, 'new'), true);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('usage cache: an expired probe lock is reclaimed once and removed only by its owner', async () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'cache'));
    writeFileSync(join(dir, 'cache', 'x-usage.lock'), JSON.stringify({ token: 'dead', ts: Date.now() - 600_000 }));
    let probes = 0;
    const probe = async () => { probes++; return { ok: true, raw: 1, parsed: 1 }; };
    const [a, b] = await Promise.all([getUsage('x', probe, { home: dir, onBattery: false }), getUsage('x', probe, { home: dir, onBattery: false })]);
    assert.equal(probes, 1);
    assert.ok(a || b);
    assert.deepEqual(readdirSync(join(dir, 'cache')).sort(), ['x-usage.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Astra #3: answering an orphan must not make recovery kill it ----
test('an answered orphan stays supervised until its process exits', async () => {
  const f = fixture();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  const managers: JobManager[] = [];
  try {
    await new Promise(resolve => child.once('spawn', resolve));
    const jobId = 'orphan', qid = 'q-orphan';
    const first = new JobManager(fakeConnector(f.script), f.config);
    managers.push(first);
    const identity = { pid: child.pid!, startTime: (await processStartTime(child.pid!))! };
    first.store.create(meta(f.home, { id: jobId, state: 'running', owner: { pid: 2147483647, startTime: 'dead' }, process: identity,
      awaitingInput: { qid, question: 'q?', askedAt: Date.now() } }), 'fake');
    writeFileSync(join(first.store.dir(jobId), 'question.json'), JSON.stringify({ id: qid, question: 'q?', askedAt: Date.now() }));
    await first.initialize();
    assert.equal(first.store.get(jobId).state, 'running');
    // The answer arrives; a later recovery pass (here: another server starting) must not kill.
    await first.respond(jobId, { answer: 'go', qid });
    const second = new JobManager(fakeConnector(f.script), f.config);
    managers.push(second);
    await second.initialize();
    const after = second.store.get(jobId);
    assert.equal(after.state, 'running');
    assert.equal(after.awaitingInput, undefined);
    assert.equal(child.exitCode, null);
    // Once the worker is gone, recovery marks the job lost.
    child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null);
    const third = new JobManager(fakeConnector(f.script), f.config);
    managers.push(third);
    await third.initialize();
    assert.equal(third.store.get(jobId).state, 'lost');
  } finally { child.kill(); for (const m of managers) await m.dispose(); f.cleanup(); }
});

test('an orphan answered before recovery stays supervised until its process exits', async () => {
  const f = fixture();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  const managers: JobManager[] = [];
  try {
    await new Promise(resolve => child.once('spawn', resolve));
    const jobId = 'orphan-pre-answered', qid = 'q-pre';
    const store = new JobManager(fakeConnector(f.script), f.config).store;
    const identity = { pid: child.pid!, startTime: (await processStartTime(child.pid!))! };
    store.create(meta(f.home, {
      id: jobId,
      state: 'running',
      owner: { pid: 2147483647, startTime: 'dead' },
      process: identity,
      awaitingInput: { qid, question: 'q?', askedAt: Date.now() },
    }), 'fake');
    const dir = store.dir(jobId);
    writeFileSync(join(dir, 'question.json'), JSON.stringify({ id: qid, question: 'q?', askedAt: Date.now() }));
    // A replacement server publishes the answer before recovery ever sees or preserves the orphan
    publishAnswer(dir, qid, 'delivered answer');
    const replacement = new JobManager(fakeConnector(f.script), f.config);
    managers.push(replacement);
    await replacement.initialize();
    const after = replacement.store.get(jobId);
    assert.equal(after.state, 'running', 'orphan must not be marked lost just because the answer exists');
    assert.equal(child.exitCode, null, 'orphan process must not be killed just because the answer exists');
    child.kill();
    await until(() => child.exitCode !== null || child.signalCode !== null);
    const third = new JobManager(fakeConnector(f.script), f.config);
    managers.push(third);
    await third.initialize();
    assert.equal(third.store.get(jobId).state, 'lost');
  } finally {
    child.kill();
    for (const m of managers) await m.dispose();
    f.cleanup();
  }
});

// ---- Astra #4: first writer wins ----
test('concurrent answers: the first wins, an identical retry succeeds, a conflicting one fails', () => {
  const dir = scratch();
  try {
    publishAnswer(dir, 'q1', 'first');
    publishAnswer(dir, 'q1', 'first'); // idempotent
    assert.throws(() => publishAnswer(dir, 'q1', 'second'), /different answer/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'answer-q1.json'), 'utf8')).answer, 'first');
    assert.deepEqual(readdirSync(dir), ['answer-q1.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Astra #5: the deadline does not discard an answer that already arrived ----
test('bridge deadline returns an answer that arrived after the last poll', async () => {
  const f = fixture();
  const jobId = 'bridge-deadline';
  const dir = join(f.home, 'jobs', jobId);
  mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, AGENT_JOBS_HOME: f.home, AGENT_JOB_ID: jobId }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let out = '';
    child.stdout!.on('data', d => out += d);
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_orchestrator', arguments: { question: 'Q?', timeoutSec: 1 } } }) + '\n');
    await until(() => existsSync(join(dir, 'question.json')), 'question', 5000);
    const qid = JSON.parse(readFileSync(join(dir, 'question.json'), 'utf8')).id;
    publishAnswer(dir, qid, 'late but delivered'); // before the 1 s deadline, after the t=0 check, before the 2 s poll
    await until(() => out.includes('"id":1'), 'reply', 5000);
    assert.match(out, /late but delivered/);
    assert.doesNotMatch(out, /no answer within/);
  } finally { child.kill(); f.cleanup(); }
});

// ---- Astra #6/#7 ----
test('a claim that cannot be removed never throws out of release', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'question.lock', 'nested'), { recursive: true }); // not a file: cannot be read or unlinked
    assert.doesNotThrow(() => releaseQuestion(dir, 'x'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an abandoned mailbox stops advertising a pending question once its claim expired', () => {
  const f = fixture();
  try {
    const store = new JobManager(fakeConnector(f.script), f.config).store;
    const job = meta(f.home, { id: 'abandoned', state: 'running' });
    store.create(job, 'fake');
    const dir = store.dir('abandoned');
    writeFileSync(join(dir, 'question.json'), JSON.stringify({ id: 'qa', question: 'q?', askedAt: Date.now() - 100_000 }));
    writeFileSync(join(dir, 'question.lock'), JSON.stringify({ owner: 'bridge', id: 'qa', ts: Date.now() - 100_000, timeoutMs: 1000 }));
    job.stalled = true;
    assert.equal(bridgeSampler(store, job)(), true);
    assert.equal(job.awaitingInput, undefined);
    // A live claim is still advertised.
    writeFileSync(join(dir, 'question.json'), JSON.stringify({ id: 'qb', question: 'q?', askedAt: Date.now() }));
    writeFileSync(join(dir, 'question.lock'), JSON.stringify({ owner: 'bridge', id: 'qb', ts: Date.now(), timeoutMs: 600_000 }));
    bridgeSampler(store, job)();
    assert.equal((job as { awaitingInput?: { qid: string } }).awaitingInput?.qid, 'qb');
  } finally { f.cleanup(); }
});

// ---- Argon #9 ----
test('answer polling treats busy/denied files as "not yet" and retries on the next tick', () => {
  const busy = (code: string) => ({ stat: () => ({ isFile: () => true }), read: () => { throw Object.assign(new Error(code), { code }); } });
  for (const code of ['EBUSY', 'EPERM', 'ENOENT']) assert.equal(readAnswerFile('x', busy(code)), undefined);
  assert.throws(() => readAnswerFile('x', busy('EIO')), /EIO/);
  assert.equal(readAnswerFile('x', { stat: () => ({ isFile: () => true }), read: () => '{"answer":"ok"}' }), 'ok');
  assert.throws(() => readAnswerFile('x', { stat: () => ({ isFile: () => true }), read: () => '{"answer":5}' }), /must be a string/);
});

// ---- Coordinator findings ----
import { mkdirSync as mkdir2 } from 'node:fs';

test('a second continuation of a worktree job is rejected while the first is still active', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    const tree = join(f.home, 'tree');
    mkdir2(tree);
    const worktree = { root: f.home, path: tree, gitDir: join(tree, '.git'), branch: 'b', baseSha: 'x' };
    manager.store.create(meta(f.home, { id: 'wt-src', state: 'failed', sessionId: 's1', worktree, cwd: tree, originalCwd: f.home, finishedAt: Date.now() }), 'p');
    const gate = join(f.home, 'gate');
    const first = await manager.send('wt-src', JSON.stringify({ gate }));
    await assert.rejects(manager.send('wt-src', 'second'), /already continues in this worktree/);
    await assert.rejects(manager.requeue('wt-src'), /already continues in this worktree/);
    writeFileSync(gate, '1');
    await until(() => manager.store.get(first.jobId).state === 'completed');
  } finally { await manager.dispose(); f.cleanup(); }
});

test('a cross-connector retry starts a fresh native session', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    manager.store.create(meta(f.home, { id: 'xc-src', state: 'failed', sessionId: 's1', resumeSession: 'old-session', transport: 'app-server', finishedAt: Date.now() }), 'p');
    const { jobId } = await manager.requeue('xc-src', undefined, 'agy');
    const copy = manager.store.get(jobId);
    assert.equal(copy.connector, 'agy');
    assert.equal(copy.resumeSession, undefined);
    assert.equal(copy.sessionId, undefined);
    const same = manager.store.get((await manager.requeue('xc-src')).jobId);
    assert.equal(same.resumeSession, 'old-session');
  } finally { await manager.dispose(); f.cleanup(); }
});


test('a structurally invalid claim expires by file age instead of never', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'question.lock'), '{}');
    assert.equal(claimQuestion(dir, { owner: 'bridge', id: 'a', ts: Date.now(), timeoutMs: 1000 }), false); // fresh garbage still holds
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(join(dir, 'question.lock'), old, old);
    assert.equal(claimQuestion(dir, { owner: 'bridge', id: 'a', ts: Date.now(), timeoutMs: 1000 }), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
