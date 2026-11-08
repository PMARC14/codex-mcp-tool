import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import spawn from 'cross-spawn';
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fixture } from './test-helpers.js';
import { fakeChild, flush } from './review-fakes.js';
import { ownerAlive, startProcess } from './proc.js';
import { jobWrapper } from './jobobject.js';

function setup(t: any, starts: (string | undefined)[]) {
  const f = fixture();
  const child = fakeChild();
  let alive = true;
  let lookups = 0;
  let treeKills = 0;
  let snapshots = 0;
  const noJob = process.env.AGENT_JOBS_NO_JOBOBJECT;
  process.env.AGENT_JOBS_NO_JOBOBJECT = '1';
  const realKill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid: number, signal: any) => {
    if (pid !== child.pid) return realKill(pid, signal);
    if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  t.mock.method(cp, 'spawn', (exe: string, args: string[]) => {
    if (exe === process.execPath) { queueMicrotask(() => child.emit('spawn')); return child; }
    const command = fakeChild(424243);
    queueMicrotask(() => {
      if (/taskkill/i.test(exe)) {
        treeKills++;
        assert.deepEqual(args, ['/PID', String(child.pid), '/T', '/F']);
        alive = false;
        child.close();
      } else if (args.join(' ').includes('Get-Process -Id')) {
        const value = starts[Math.min(lookups++, starts.length - 1)];
        if (value) command.stdout.emit('data', Buffer.from(value));
        command.close(value ? 0 : 1);
        return;
      } else {
        snapshots++;
        command.stdout.emit('data', Buffer.from('[]'));
      }
      command.close();
    });
    return command;
  });
  const options = { exe: process.execPath, args: [], cwd: f.home, stdout: join(f.home, 'out'), stderr: join(f.home, 'err'), async onSpawn() {}, onSnapshot() {}, onLine() {} };
  return { ...f, child, options, get lookups() { return lookups; }, get treeKills() { return treeKills; }, get snapshots() { return snapshots; }, close() { alive = false; child.close(); }, cleanup() {
    if (noJob === undefined) delete process.env.AGENT_JOBS_NO_JOBOBJECT; else process.env.AGENT_JOBS_NO_JOBOBJECT = noJob;
    f.cleanup();
  } };
}

test('unknown child start time retries once and cancellation uses handle plus taskkill', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(t, [undefined]);
  let identity: any;
  const proc = startProcess({ ...f.options, async onSpawn(owner) { identity = owner; } });
  try {
    await flush();
    assert.equal(f.lookups, 2);
    assert.equal(identity.startTime, '');
    assert.equal(await ownerAlive(identity), true);
    const result = await proc.stop();
    assert.equal(f.treeKills, 1);
    assert.ok(f.child.killCalls.length > 0);
    assert.equal(result.killFailed, undefined);
  } finally { f.close(); await proc.done; f.cleanup(); }
});

test('transient start-time failure recovers on its one retry', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(t, [undefined, '1234']);
  let identity: any;
  const proc = startProcess({ ...f.options, async onSpawn(owner) { identity = owner; } });
  try {
    await flush();
    assert.equal(identity.startTime, '1234');
    assert.equal(f.lookups, 2);
  } finally { f.close(); await proc.done; f.cleanup(); }
});

test('termination shares its descendant snapshot with killTree', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(t, ['1234']);
  const proc = startProcess(f.options);
  try {
    await flush();
    const before = f.snapshots;
    await proc.stop();
    assert.equal(f.snapshots - before, 2, 'one pre-kill snapshot and one survivor check');
  } finally { f.close(); await proc.done; f.cleanup(); }
});

test('empty-start owner stays alive even when inspection returns a known start time', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(t, ['1234']);
  try { assert.equal(await ownerAlive({ pid: f.child.pid!, startTime: '' }), true); }
  finally { f.cleanup(); }
});

test('interrupt completion never launches termination after close', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(t, ['1234']);
  const proc = startProcess({ ...f.options, stdin: '', stdinPlan: () => Object.assign(() => undefined, { onInterrupt() { queueMicrotask(() => f.close()); return {}; } }) });
  try {
    await flush();
    const before = f.snapshots;
    await proc.stop();
    await flush();
    assert.equal(f.snapshots, before);
    assert.equal(f.treeKills, 0);
  } finally { f.close(); await proc.done; f.cleanup(); }
});

test('hard-kill deadline starts after the interrupt grace', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(t, ['1234']);
  const proc = startProcess({ ...f.options, stdin: '', stdinPlan: () => Object.assign(() => undefined, { onInterrupt() { return {}; } }) });
  const timers: { ms: number; fire(): void }[] = [];
  try {
    await flush();
    t.mock.method(globalThis, 'setTimeout', (fire: () => void, ms: number) => { timers.push({ ms, fire }); return { unref() {} } as any; });
    const stopping = proc.stop();
    assert.deepEqual(timers.map(timer => timer.ms), [3000]);
    timers[0].fire();
    await stopping;
    assert.ok(timers.some(timer => timer.ms === 10000));
  } finally { f.close(); await proc.done; f.cleanup(); }
});

test('cached wrapper is recompiled after its executable disappears', { skip: process.platform !== 'win32' }, t => {
  const f = fixture();
  const previous = process.env.AGENT_JOBS_NO_JOBOBJECT;
  delete process.env.AGENT_JOBS_NO_JOBOBJECT;
  let compilations = 0;
  t.mock.method(os, 'homedir', () => f.home);
  syncBuiltinESMExports();
  t.mock.method(spawn, 'sync', (_exe: string, args: string[]) => {
    compilations++;
    fs.writeFileSync(args.find(arg => arg.startsWith('/out:'))!.slice(5), 'fake executable');
    return { status: 0 };
  });
  try {
    const first = jobWrapper()!;
    assert.ok(first.startsWith(f.home));
    fs.rmSync(first);
    const second = jobWrapper();
    assert.ok(second && fs.existsSync(second));
    assert.equal(compilations, 2);
  } finally {
    if (previous === undefined) delete process.env.AGENT_JOBS_NO_JOBOBJECT; else process.env.AGENT_JOBS_NO_JOBOBJECT = previous;
    t.mock.restoreAll(); syncBuiltinESMExports(); f.cleanup();
  }
});
