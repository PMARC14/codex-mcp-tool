import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobManager } from './manager.js';
import { fixture, fakeConnector, meta } from './test-helpers.js';
import { processStartTime, safeSpawn } from './proc.js';

test('optional quota guard resolves models and caches each model independently', async t => {
  const f = fixture();
  const reads: Array<string | undefined> = [];
  f.config.connectors.codex = { defaultModel: 'gemini' };
  const connector = { ...fakeConnector(f.script), async usagePercent(model?: string) {
    reads.push(model);
    return model === 'argon' ? 95 : 10;
  } };
  const manager = new JobManager(connector, f.config);
  t.mock.method(manager as any, 'pump', async () => {});
  const optional = { cwd: f.home, prompt: 'p', priority: 'optional' as const };
  try {
    await manager.start(optional);
    await assert.rejects(manager.start({ ...optional, model: 'argon' }), /95%/);
    await manager.start(optional);
    await assert.rejects(manager.start({ ...optional, model: 'argon' }), /95%/);
    assert.deepEqual(reads, ['gemini', 'argon']);
    manager.store.create(meta(f.home, { id: 'original', state: 'completed', model: 'argon', sessionId: 'native' }), 'first');
    await assert.rejects(manager.start(optional, 'original'), /95%/);
    assert.deepEqual(reads, ['gemini', 'argon'], 'follow-ups use the inherited model pool');
  } finally { await manager.dispose(); f.cleanup(); }
});

test('resume and requeue inherit the original job label', async t => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  t.mock.method(manager as any, 'pump', async () => {});
  try {
    await manager.initialize();
    manager.store.create(meta(f.home, { id: 'original', state: 'completed', label: 'fix-core-bugs', sessionId: 'native' }), 'first');
    const resumed = await manager.send('original', 'next');
    assert.equal(manager.store.get(resumed.jobId).label, 'fix-core-bugs');
    manager.store.write({ ...manager.store.get(resumed.jobId), state: 'failed' });
    const requeued = await manager.requeue(resumed.jobId);
    assert.equal(manager.store.get(requeued.jobId).label, 'fix-core-bugs');
  } finally { await manager.dispose(); f.cleanup(); }
});

test('an answered orphan exiting zero recovers its final answer instead of becoming lost', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const job = meta(f.home, {
      id: 'answered-orphan', state: 'running', reserved: true, orphanPreserved: true,
      owner: { pid: 2147483647, startTime: 'dead' },
      process: { pid: 2147483646, startTime: 'dead worker' },
    });
    manager.store.create(job, 'first');
    // A surviving worker publishes its final output and exits successfully without its server.
    const gate = join(f.home, 'finish-worker');
    const worker = safeSpawn(process.execPath, ['-e', "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); fs.writeFileSync(process.argv[1], 'finished after answer'); } }, 10);", job.finalPath, gate], { stdio: 'ignore' });
    const closed = new Promise<number | null>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('close', resolve);
    });
    try {
      const startTime = await processStartTime(worker.pid!);
      assert.ok(startTime);
      manager.store.write({ ...job, process: { pid: worker.pid!, startTime } });
    } finally { writeFileSync(gate, 'finish'); }
    const code = await closed;
    assert.equal(code, 0);
    await manager.initialize();
    const recovered = manager.store.get(job.id);
    assert.equal(recovered.state, 'completed');
    assert.equal(recovered.reserved, false);
    assert.equal(recovered.reason, undefined);
    assert.equal((await manager.result(job.id)).final, 'finished after answer');
    assert.equal(manager.isOwn(recovered), true);
  } finally { await manager.dispose(); f.cleanup(); }
});
