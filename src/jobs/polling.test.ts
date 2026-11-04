import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeConnector } from './test-helpers.js';
import { JobManager } from './manager.js';
import { spawn } from 'node:child_process';
import { ownerAlive, startTimeCacheSize } from './proc.js';

// On Windows every uncached start-time lookup starts a powershell.exe; the job pump asked
// for the same owners every 500 ms in every server, which drained the battery (2026-11-03).

test('ownerAlive caches another process start time, so repeated checks start no new process', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise(resolve => child.once('spawn', resolve));
    const other = { pid: child.pid!, startTime: 'not-its-start-time' };
    const before = startTimeCacheSize();
    assert.equal(await ownerAlive(other), false); // alive, but a different identity
    assert.equal(startTimeCacheSize(), before + 1);
    const started = Date.now();
    for (let i = 0; i < 20; i++) assert.equal(await ownerAlive(other), false);
    // 20 cached checks take milliseconds; 20 PowerShell lookups would take seconds.
    assert.ok(Date.now() - started < 1000, `20 checks took ${Date.now() - started} ms`);
    assert.equal(startTimeCacheSize(), before + 1);
  } finally {
    child.kill();
  }
});

test('the job pump reuses detect() instead of calling it every 500 ms', async () => {
  const f = fixture();
  const base = fakeConnector(f.script);
  let detects = 0;
  const connector = {
    ...base,
    async detect() {
      detects++;
      return base.detect();
    },
  };
  const manager = new JobManager(connector, f.config);
  try {
    await manager.initialize();
    await new Promise(resolve => setTimeout(resolve, 2600)); // about five pump ticks
    assert.ok(detects <= 1, `detect() ran ${detects} times`);
  } finally {
    await manager.dispose?.();
    f.cleanup();
  }
});
