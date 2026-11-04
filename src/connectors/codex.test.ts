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
  ['trusted', 'danger-full-access'],
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
      assert.equal('stdinPlan' in command, false, 'Codex still writes the prompt and closes stdin');
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
  assert.ok(Math.abs(event!.usageLimit!.resetAt! - usageReset(line)!) < 1000);
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

test('usage reset retries recently passed clock times in 60 seconds', () => {
  const now = new Date(2026, 9, 29, 17, 37, 20);
  const originalNow = now.getTime();
  for (const time of ['5:37 PM', '4:00 PM', '3:38 PM']) {
    assert.equal(usageReset(`try again at ${time}`, now), originalNow + 60000, time);
  }
  assert.equal(now.getTime(), originalNow, 'the supplied clock is not mutated');
  assert.equal(
    usageReset('try again at 5:37 PM', new Date(2026, 9, 29, 17, 37)),
    new Date(2026, 9, 29, 17, 38).getTime()
  );
});

test('usage reset rolls older clock times to tomorrow and keeps future times today', () => {
  const now = new Date(2026, 9, 29, 17, 37, 20);
  for (const [message, expected] of [
    ['try again at 9:00 AM', new Date(2026, 9, 30, 9)],
    ['try again at 3:00 PM', new Date(2026, 9, 30, 15)],
    ['try again at 6:00 PM', new Date(2026, 9, 29, 18)],
  ] as const) {
    assert.equal(usageReset(message, now), expected.getTime(), message);
  }
  assert.equal(
    usageReset('try again at 3:37 PM', new Date(2026, 9, 29, 17, 37)),
    new Date(2026, 9, 30, 15, 37).getTime(),
    'exactly two hours uses tomorrow'
  );
});

test('Codex jobs run outside git repos too (advice and debate need no repo)', () => {
  for (const resumeSession of [undefined, 'session-id']) {
    const { args } = connector.build({ ...spec, mode: 'read', resumeSession });
    assert.ok(args.includes('--skip-git-repo-check'), `missing for resume=${resumeSession}`);
    assert.ok(args.indexOf('--skip-git-repo-check') > args.indexOf('exec'));
  }
});

test('Codex detect succeeds when logged in', async () => {
  let executedExe: string | undefined;
  let executedArgs: string[] | undefined;
  let executedTimeout: number | undefined;

  const loggedIn = new CodexConnector(async (exe, args, _cwd, timeoutMs) => {
    executedExe = exe;
    executedArgs = args;
    executedTimeout = timeoutMs;
    return 'Logged in using ChatGPT';
  }, binary);

  const result = await loggedIn.detect();
  assert.equal(result.available, true);
  assert.equal(executedExe, '/fake/codex.exe');
  assert.deepEqual(executedArgs, ['login', 'status']);
  assert.equal(executedTimeout, 10000);
});

test('Codex detect reports unavailable when not logged in', async () => {
  const notLoggedIn = new CodexConnector(async (_exe, args) => {
    assert.deepEqual(args, ['login', 'status']);
    return 'Not logged in';
  }, binary);

  const result = await notLoggedIn.detect();
  assert.equal(result.available, false);
  assert.equal(result.reason, 'Codex is not signed in: run codex login');
});

test('Codex detect probe failure fails open on timeout or error', async () => {
  const failing = new CodexConnector(async () => {
    throw new Error('timed out after 10000ms');
  }, binary);

  const result = await failing.detect();
  assert.equal(result.available, true);
});

test('Codex detect probe failure fails open on unknown output', async () => {
  const unknown = new CodexConnector(async () => {
    return 'unknown status format from new CLI version';
  }, binary);

  const result = await unknown.detect();
  assert.equal(result.available, true);
});

test('Codex detect caches login status for 10 minutes and refreshes after expiration', async () => {
  let probeCalls = 0;
  let now = 1000000;
  const connector = new CodexConnector(
    async () => {
      probeCalls++;
      return 'Logged in using ChatGPT';
    },
    binary,
    () => now
  );

  const first = await connector.detect();
  assert.equal(first.available, true);
  assert.equal(probeCalls, 1);

  // Immediate subsequent call uses cache
  const second = await connector.detect();
  assert.equal(second.available, true);
  assert.equal(probeCalls, 1);

  // Still within 10 minutes (9 minutes elapsed)
  now += 9 * 60 * 1000;
  const third = await connector.detect();
  assert.equal(third.available, true);
  assert.equal(probeCalls, 1);

  // Past 10 minutes TTL (10 minutes + 1 ms elapsed)
  now += 1 * 60 * 1000 + 1;
  const fourth = await connector.detect();
  assert.equal(fourth.available, true);
  assert.equal(probeCalls, 2);
});

test('Codex detect caches not-logged-in status', async () => {
  let probeCalls = 0;
  const connector = new CodexConnector(async () => {
    probeCalls++;
    return 'Not logged in';
  }, binary);

  const first = await connector.detect();
  assert.equal(first.available, false);
  assert.equal(first.reason, 'Codex is not signed in: run codex login');
  assert.equal(probeCalls, 1);

  const second = await connector.detect();
  assert.equal(second.available, false);
  assert.equal(second.reason, 'Codex is not signed in: run codex login');
  assert.equal(probeCalls, 1);
});

