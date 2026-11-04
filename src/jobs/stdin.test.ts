import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { updateStdin } from './stdin.js';
import { writeFileSync } from 'node:fs';
import { JobManager } from './manager.js';
import { fakeConnector, fixture, until } from './test-helpers.js';
import type { StdinHandler } from './stdin.js';

test('stdin actions write once, close, and ignore later actions', () => {
  const pipe = new PassThrough();
  updateStdin(pipe, { write: 'first' });
  assert.equal(pipe.writableEnded, false);
  updateStdin(pipe, { write: 'second', close: true });
  updateStdin(pipe, { write: 'ignored', close: true });
  assert.equal(pipe.read().toString(), 'firstsecond');
  assert.equal(pipe.writableEnded, true);
});

test('stdin actions ignore synchronous pipe errors on write and close', () => {
  for (const code of ['EPIPE', 'EOF', 'ECONNRESET']) {
    const pipe = new PassThrough();
    let closed = false;
    pipe.write = () => { throw Object.assign(new Error(code), { code }); };
    pipe.end = (() => { closed = true; throw Object.assign(new Error(code), { code }); }) as typeof pipe.end;
    assert.doesNotThrow(() => updateStdin(pipe, { write: 'second', close: true }));
    assert.equal(closed, true);
  }
});

test('a non-Codex connector can queue a steer through its per-process stdin capability', async () => {
  const f = fixture();
  writeFileSync(f.script, `
    const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', line => {
      console.log(JSON.stringify({type: 'thread.started', thread_id: 'fake'}));
      if (line !== 'initial') console.log(JSON.stringify({type: 'item.completed', item: {text: line}}));
    });
  `);
  const connector = fakeConnector(f.script, 'other');
  const build = connector.build;
  connector.build = job => ({ ...build(job), stdin: 'initial\n', stdinPlan: () => {
    const handler: StdinHandler = line => line.includes('item.completed') ? { close: true } : undefined;
    handler.onSteer = message => ({ write: message + '\n', delivered: 'queued' });
    return handler;
  } });
  const manager = new JobManager(connector, f.config);
  try {
    const { jobId } = await manager.start({ prompt: 'initial', cwd: f.home });
    await until(() => manager.store.get(jobId).state === 'running');
    assert.deepEqual(await manager.steer(jobId, 'queued message'), { delivered: 'queued' });
    assert.equal((await manager.watch(jobId, 20)).final, 'queued message');
    assert.equal(manager.store.get(jobId).steers, 1);
  } finally { await manager.dispose(); f.cleanup(); }
});
