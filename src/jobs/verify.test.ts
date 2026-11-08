import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from './manager.js';
import { fixture, fakeConnector } from './test-helpers.js';

for (const [label, command, passed, timedOut] of [
  ['passing', 'echo verified', true, false],
  ['failing', 'echo failed; exit 7', false, false],
  ['timeout', 'sleep 10', false, true],
] as const) {
  test(`verification ${label} keeps completed state and exposes result`, async () => {
    const f = fixture();
    const manager = new JobManager(fakeConnector(f.script), f.config);
    try {
      const job = await manager.start({ prompt: 'test', cwd: f.home, mode: 'write', verify: command, verifyTimeoutMin: timedOut ? 0.003 : 1 });
      const result = await manager.watch(job.jobId, 20);
      assert.equal(result.state, 'completed');
      assert.equal(result.verify?.passed, passed);
      assert.equal(result.verify?.timedOut, timedOut);
      if (!timedOut) assert.match((await manager.read(job.jobId, 'verify')).text, passed ? /verified/ : /failed/);
      if (passed) {
        const next = await manager.send(job.jobId, 'follow-up');
        const nextResult = await manager.result(next.jobId, 10);
        assert.equal(nextResult.verify?.command, command);
        assert.equal(manager.store.get(next.jobId).verifyTimeoutMin, 1);
      }
    } finally { await manager.dispose(); f.cleanup(); }
  });
}

test('read mode rejects verification', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try { await assert.rejects(manager.start({ prompt: 'test', cwd: f.home, verify: 'echo no' }), /non-read/); }
  finally { await manager.dispose(); f.cleanup(); }
});
