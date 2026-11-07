import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobManager } from './manager.js';
import { startChannelNotifier } from './channel.js';
import { fixture, fakeConnector, meta, until } from './test-helpers.js';
import { registerJobTools, type JobTool } from './tools.js';
import { currentOwner } from './proc.js';

for (const action of ['requeue', 'send'] as const) {
  test(`${action} finishes a paused original, exposes its replacement and notifies once`, async () => {
    const f = fixture();
    const manager = new JobManager(fakeConnector(f.script, 'codex', Date.now() + 60000), f.config);
    const notifications: Record<string, string>[] = [];
    let stop = () => {};
    try {
      const original = await manager.start({
        prompt: JSON.stringify({ limit: true }),
        cwd: f.home,
      });
      await until(() => manager.store.get(original.jobId).state === 'paused');
      const pauseFile = join(f.home, 'pauses.json');
      const pauseBefore = readFileSync(pauseFile, 'utf8');
      stop = startChannelNotifier(
        manager,
        {
          async notification({ params }) {
            notifications.push(params.meta!);
          },
        },
        'codex',
        undefined,
        { AGENT_JOBS_CHANNEL: '1', CLAUDE_AGENTS: '1' }
      );
      const before = Date.now();
      const replacement =
        action === 'requeue'
          ? await manager.requeue(original.jobId, undefined, 'agy')
          : await manager.send(original.jobId, 'continue');
      const saved = manager.store.get(original.jobId);
      assert.equal(saved.state, 'killed');
      assert.equal(saved.reason, 'superseded');
      assert.equal(saved.supersededBy, replacement.jobId);
      assert.ok(saved.finishedAt! >= before);
      assert.equal(readFileSync(pauseFile, 'utf8'), pauseBefore);

      const tools: JobTool[] = [];
      registerJobTools(tools, 'codex', manager);
      for (const name of ['status', 'result', 'follow']) {
        const tool = tools.find(tool => tool.name === `codex_agent_${name}`)!;
        // A long heartbeat and deadline make an accidental wait fail this test promptly.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
          const result = JSON.parse(
            await tool.execute({ jobId: original.jobId }, undefined, controller.signal)
          );
          assert.equal(result.state, 'killed');
          assert.equal(result.reason, 'superseded');
          assert.equal(result.supersededBy, replacement.jobId);
          if (name === 'follow') assert.equal(result.timedOut, false);
        } finally {
          clearTimeout(timeout);
        }
      }

      // A metadata rewrite must not emit a second terminal notification.
      manager.store.write(saved);
      const events = notifications.filter(event => event.job_id === original.jobId);
      assert.equal(events.length, 1);
      assert.equal(events[0].state, 'killed');
      assert.equal(events[0].reason, 'superseded');
      assert.equal(events[0].superseded_by, replacement.jobId);
      const next = await manager.start({ prompt: 'new job', cwd: f.home });
      await until(() => manager.store.get(next.jobId).state === 'paused');
      assert.equal(manager.store.get(next.jobId).reason, 'usage_limit');
      assert.equal(readFileSync(pauseFile, 'utf8'), pauseBefore);
    } finally {
      stop();
      await manager.dispose();
      f.cleanup();
    }
  });
}

for (const link of ['requeuedFrom', 'followUpOf'] as const) {
  test(`pump migrates legacy paused originals via ${link}, only for its own jobs`, async () => {
    const f = fixture();
    const manager = new JobManager(fakeConnector(f.script), f.config);
    const transitions: string[] = [];
    try {
      await manager.initialize();
      const owner = await currentOwner();
      const managerId = (manager as unknown as { id: string }).id;
      const since = Date.now();
      manager.store.writePauses([{ connector: 'codex', model: 'fake', since }]);
      const pauseBefore = readFileSync(join(f.home, 'pauses.json'), 'utf8');
      for (const id of ['own', 'foreign', 'unlinked']) {
        manager.store.create(
          meta(f.home, {
            id,
            state: 'paused',
            reason: 'usage_limit',
            pauseCleared: true,
            finishedAt: since - 60000,
            owner,
            managerId: id === 'foreign' ? 'another-live-manager' : managerId,
          }),
          'old prompt'
        );
        if (id !== 'unlinked')
          manager.store.create(
            meta(f.home, {
              id: `${id}-replacement`,
              state: 'completed',
              [link]: id,
            }),
            'replacement'
          );
      }
      manager.onTransition((job, previous) => {
        if (job.state === 'killed' && previous === 'paused') transitions.push(job.id);
      });
      // Drive exactly one owner's pump; another manager's record must remain untouched.
      await (manager as unknown as { pump(): Promise<void> }).pump();
      const saved = manager.store.get('own');
      assert.equal(saved.state, 'killed');
      assert.equal(saved.reason, 'superseded');
      assert.equal(saved.supersededBy, 'own-replacement');
      assert.ok(saved.finishedAt! >= since);
      assert.equal(manager.store.get('foreign').state, 'paused');
      assert.equal(manager.store.get('unlinked').state, 'paused');
      assert.deepEqual(transitions, ['own']);
      await (manager as unknown as { pump(): Promise<void> }).pump();
      assert.deepEqual(transitions, ['own'], 'migration only transitions once');
      assert.equal(readFileSync(join(f.home, 'pauses.json'), 'utf8'), pauseBefore);
    } finally {
      await manager.dispose();
      f.cleanup();
    }
  });
}
