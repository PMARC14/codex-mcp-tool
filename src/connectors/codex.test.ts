import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexConnector, usageReset } from './codex.js';
import type { JobSpec } from '../jobs/connector.js';

const binary = () => ({
  resolved: true,
  command: '/fake/codex.exe',
  source: 'explicit-path' as const,
  searchedPaths: [],
});
const connector = new CodexConnector(undefined, binary);
const spec: JobSpec = {
  id: 'job',
  connector: 'codex',
  prompt: 'hello\n$() & "quote"',
  cwd: '/repo',
  mode: 'read',
  timeoutMin: 120,
  finalPath: '/jobs/job/final.txt',
};

for (const [mode, expected] of [
  ['read', 'read-only'],
  ['write', 'workspace-write'],
  ['full', '--dangerously-bypass-approvals-and-sandbox'],
] as const) {
  test(`Codex build ${mode} mode keeps prompt off argv and supports resume`, () => {
    for (const resumeSession of [undefined, 'session-id']) {
      const command = connector.build({
        ...spec,
        mode,
        resumeSession,
        model: 'gpt-6-astra',
        effort: 'high',
        worktree: {
          root: '/repo',
          path: '/worktree',
          gitDir: '/repo/.git/worktrees/job',
          branch: 'codex/job',
          baseSha: 'abc',
        },
      });
      assert.equal(command.stdin, spec.prompt);
      assert.equal(command.args.includes(spec.prompt), false);
      assert.ok(command.args.includes(expected));
      assert.equal(
        command.args.includes('--dangerously-bypass-approvals-and-sandbox'),
        mode === 'full'
      );
      assert.deepEqual(command.args.slice(-3), ['-o', spec.finalPath, '-']);
      assert.ok(command.args.includes('model_reasoning_effort="high"'));
      assert.ok(command.args.includes('/repo/.git/worktrees/job'));
      assert.equal(command.args.includes('resume'), !!resumeSession);
      assert.equal(command.args.includes('-C'), false);
    }
  });
}

test('Codex parses real thread, agent message and limit events from this machine', () => {
  assert.deepEqual(
    connector.parse(
      '{"type":"thread.started","thread_id":"01a18a1c-a984-77a2-8d05-c5f300bcac2a"}',
      'stdout'
    ),
    { sessionId: '01a18a1c-a984-77a2-8d05-c5f300bcac2a' }
  );
  assert.deepEqual(
    connector.parse(
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}',
      'stdout'
    ),
    { final: 'pong' }
  );
  const line = `{"type":"error","message":"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 8:37 PM."}`;
  const event = connector.parse(line, 'stdout');
  assert.ok(event?.usageLimit?.resetAt);
  assert.match(event!.error!, /hit your usage limit/);
  const date = new Date(event!.usageLimit!.resetAt!);
  assert.equal(date.getHours(), 20);
  assert.equal(date.getMinutes(), 37);
  assert.equal(connector.parse('not an event', 'stderr'), null);
  assert.equal(connector.parse('null', 'stdout'), null);
  assert.equal(
    connector.parse('{"type":"turn.failed","error":{"message":"bad flags"}}', 'stdout')?.error,
    'bad flags'
  );
});

test('Codex lists the live model catalog and falls back without running a real CLI', async () => {
  const live = new CodexConnector(async (_exe, args) => {
    assert.deepEqual(args, ['debug', 'models']);
    return JSON.stringify({ models: [{ slug: 'gpt-6-astra' }, { slug: 'new-model' }] });
  }, binary);
  assert.deepEqual(await live.models(), ['gpt-6-astra', 'new-model']);
  const offline = new CodexConnector(async () => {
    throw new Error('offline');
  }, binary);
  assert.ok((await offline.models()).includes('gpt-6-astra'));
  const missing = new CodexConnector(
    async () => {
      throw new Error('must not execute');
    },
    () => ({ ...binary(), resolved: false, source: 'unresolved' })
  );
  assert.match((await missing.detect()).reason!, /Install/);
});

test('usage reset uses local time and rolls over midnight', () => {
  const now = new Date(2026, 9, 29, 23, 0);
  assert.equal(usageReset('try again at 8:37 PM', now), new Date(2026, 9, 30, 20, 37).getTime());
  assert.equal(usageReset('try again at 12:01 AM', now), new Date(2026, 9, 30, 0, 1).getTime());
  assert.equal(usageReset('try again at 25:99 PM', now), undefined);
  assert.equal(usageReset('no reset'), undefined);
});
