import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { JobManager } from './manager.js';
import { currentOwner } from './proc.js';
import { fixture, fakeConnector, meta, until } from './test-helpers.js';
import { fakeChild, flush } from './review-fakes.js';
import { startChannelNotifier } from './channel.js';
import type { JobEvent } from './connector.js';

async function setup(t: any, verify = false) {
  const f = fixture();
  const connector = fakeConnector(f.script);
  let emit!: (event: JobEvent) => void;
  connector.build = () => ({ exe: process.execPath, args: [], stdin: '', stdinPlan: context => {
    emit = context.emit;
    return () => undefined;
  } });
  const manager = new JobManager(connector, f.config, undefined, { verifyShell: async () => process.execPath });
  await manager.initialize();
  t.mock.method(manager as any, 'pump', async () => {});
  const owner = await currentOwner();
  const children = [fakeChild(424250), fakeChild(424251)];
  let spawned = 0;
  const alive = new Set(children.map(c => c.pid));
  const previous = process.env.AGENT_JOBS_NO_JOBOBJECT;
  process.env.AGENT_JOBS_NO_JOBOBJECT = '1';
  const realKill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal: any) => {
    if (!children.some(c => c.pid === pid)) return realKill(pid, signal);
    if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  // Every process here is an EventEmitter. Inspection is answered in memory as well.
  t.mock.method(cp, 'spawn', (exe: string, args: string[]) => {
    if (exe === process.execPath) {
      const child = children[spawned++];
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(args.join(' ').includes('Get-Process -Id') ? '1234' : '[]'));
      child.close();
    });
    return child;
  });
  const job = meta(f.home, { owner, managerId: (manager as any).id, reserved: true, timeoutMin: 120, mode: verify ? 'write' : 'read', verifyCommand: verify ? 'fake verify' : undefined, stallTimeoutMin: 1, onStall: 'kill' });
  manager.store.create(job, 'fake');
  (manager as any).launch(job);
  await flush();
  const active = (manager as any).active.get(job.id);
  return { ...f, manager, children, job, active, alive, emit: (event: JobEvent) => emit(event), async cleanup() {
    children.forEach(child => { alive.delete(child.pid); child.close(); });
    await active.finished;
    await manager.dispose();
    if (previous === undefined) delete process.env.AGENT_JOBS_NO_JOBOBJECT; else process.env.AGENT_JOBS_NO_JOBOBJECT = previous;
    f.cleanup();
  } };
}

test('approval waiting and response restart the stall clock', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    f.emit({ pendingApproval: { id: 'fake', kind: 'command', summary: 'fake', requestedAt: now } });
    now += 11 * 60000;
    f.active.sample();
    now += 11 * 60000;
    f.active.sample();
    assert.equal(f.job.stalled, undefined);
    // The response may arrive a long time after the last pump sample.
    now += 2 * 60000;
    f.emit({ pendingApproval: null });
    f.active.sample();
    assert.equal(f.job.stalled, undefined);
    now += 59000;
    f.active.sample();
    assert.equal(f.job.stalled, undefined);
    f.job.onStall = 'report';
    now += 1001;
    f.active.sample();
    assert.equal(f.job.stalled, true, 'the detector resumes after a full new timeout');
  } finally { await f.cleanup(); }
});

test('orphan recorder owns lost jobs, notifies once, and can retry cleanup', async () => {
  const f = fixture();
  let fail = true;
  let kills = 0;
  const manager = new JobManager(fakeConnector(f.script), f.config, undefined, { async killTree() { kills++; if (fail) throw new Error('fake kill failure'); } });
  const notices: any[] = [];
  const off = startChannelNotifier(manager, { async notification(event) { notices.push(event); } }, 'codex', undefined, { AGENT_JOBS_CHANNEL: '1', CLAUDE_AGENTS: '1' });
  try {
    manager.store.create(meta(f.home, { id: 'orphan', state: 'running', reserved: true, owner: { ...(await currentOwner()), startTime: 'dead owner' }, process: { pid: 424252, startTime: 'fake' } }), 'fake');
    await manager.initialize();
    const lost = manager.store.get('orphan');
    assert.equal(lost.state, 'lost');
    assert.equal(manager.isOwn(lost), true);
    assert.equal(notices.length, 1);
    manager.store.write(lost);
    assert.equal(notices.length, 1);
    fail = false;
    await manager.cancel('orphan');
    assert.equal(manager.store.get('orphan').reserved, false);
    assert.equal(kills, 2);
  } finally { off(); await manager.dispose(); f.cleanup(); }
});

for (const timerFirst of [false, true]) test(`onClosed waits for settlement before releasing a kill-failed worker slot (deadline=${timerFirst})`, { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t);
  try {
    // Complete done with killFailed before invoking onClosed in the same event turn,
    // matching proc.complete(): promise handlers have not executed yet.
    const timers: { fire(): void; ms: number }[] = [];
    t.mock.method(globalThis, 'setTimeout', (fire: () => void, ms: number) => { timers.push({ fire, ms }); return { unref() {} } as any; });
    const stopping = f.active.process.stop();
    await flush();
    // Block the final page read so closing races with settle's reserved=true write.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const page = f.manager.store.page.bind(f.manager.store);
    t.mock.method(f.manager.store, 'page', async (...args: Parameters<typeof page>) => { await gate; return page(...args); });
    f.emit({ final: 'fake final' });
    if (timerFirst) { timers.find(timer => timer.ms === 10000)!.fire(); await stopping; }
    f.alive.delete(f.children[0].pid);
    f.children[0].close();
    await flush();
    release();
    await f.active.finished;
    await flush();
    assert.equal(f.manager.store.get(f.job.id).reserved, false);
    assert.equal((f.manager as any).active.has(f.job.id), false);
  } finally { await f.cleanup(); }
});

test('verification close releases its kill-failed slot after settlement', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t, true);
  try {
    f.alive.delete(f.children[0].pid);
    f.children[0].close();
    await flush();
    assert.equal(f.job.process?.pid, f.children[1].pid);
    const timers: { fire(): void; ms: number }[] = [];
    t.mock.method(globalThis, 'setTimeout', (fire: () => void, ms: number) => { timers.push({ fire, ms }); return { unref() {} } as any; });
    // Emulate a successful bounded-output replacement even while the fake child owns
    // the verify descriptor; this case isolates the missing verify onClosed callback.
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source: fs.PathLike, target: fs.PathLike) => {
      if (String(target) === f.manager.store.path(f.job.id, 'verify')) { fs.rmSync(source); return; }
      rename(source, target);
    });
    syncBuiltinESMExports();
    const stopping = (f.manager as any).active.get(f.job.id).process.stop('timeout');
    await flush();
    timers.find(timer => timer.ms === 10000)!.fire();
    await stopping;
    await f.active.finished;
    assert.equal(f.manager.store.get(f.job.id).reserved, true);
    f.alive.delete(f.children[1].pid);
    f.children[1].close();
    await flush();
    assert.equal(f.manager.store.get(f.job.id).reserved, false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.cleanup(); }
});

test('verification persistence failure retains the slot when cleanup failed', { skip: process.platform !== 'win32' }, async t => {
  const f = await setup(t, true);
  try {
    f.alive.delete(f.children[0].pid);
    f.children[0].close();
    await flush();
    const timers: { fire(): void; ms: number }[] = [];
    t.mock.method(globalThis, 'setTimeout', (fire: () => void, ms: number) => { timers.push({ fire, ms }); return { unref() {} } as any; });
    const stopping = (f.manager as any).active.get(f.job.id).process.stop();
    await flush();
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (path: any, ...args: any[]) => {
      if (String(path).startsWith(f.manager.store.path(f.job.id, 'verify') + '.') && String(path).endsWith('.tmp')) throw new Error('fake verify persistence failure');
      return (write as any)(path, ...args);
    });
    syncBuiltinESMExports();
    timers.find(timer => timer.ms === 10000)!.fire();
    await stopping;
    await f.active.finished;
    assert.equal(f.manager.store.get(f.job.id).reason, 'store_error');
    assert.equal(f.manager.store.get(f.job.id).reserved, true);
    assert.equal((f.manager as any).active.has(f.job.id), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.cleanup(); }
});

test('startup lost notifications replay once across notifier instances', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config, undefined, { async killTree() {} });
  const notices: any[] = [];
  const stops: (() => void)[] = [];
  try {
    manager.store.create(meta(f.home, { id: 'startup-orphan', state: 'running', owner: { ...(await currentOwner()), startTime: 'dead owner' } }), 'fake');
    await manager.initialize();
    for (let i = 0; i < 2; i++) stops.push(startChannelNotifier(manager, { async notification(event) { notices.push(event); } }, 'codex', undefined, { AGENT_JOBS_CHANNEL: '1', CLAUDE_AGENTS: '1' }));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].params.meta.state, 'lost');
  } finally { stops.forEach(stop => stop()); await manager.dispose(); f.cleanup(); }
});
