import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexConnector as RealCodexConnector, usageReset } from './codex.js';
import type { JobSpec } from '../jobs/connector.js';
import { fixture } from '../jobs/test-helpers.js';
import { createCodexUsageTool } from '../tools/codex-usage.tool.js';
import { usageWindow } from '../jobs/usage.js';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Keep version discovery fake too; injecting only login probes previously leaked --version.
class CodexConnector extends RealCodexConnector {
  protected async versionCheck() {
    const version = { major: 0, minor: 166, patch: 0, raw: 'fake-0.166.0', isValid: true };
    return { version, minimum: { ok: true, version } };
  }
}

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

test('Codex detection, usage guard and usage tool share one disk probe across connector instances', async () => {
  const f = fixture();
  let probes = 0, commands = 0;
  const deps = {
    home: f.home, onBattery: false,
    live: async () => { probes++; return { available: true, source: 'live' as const, fiveHour: usageWindow(42, 2000000000, 1000000) }; },
    local: () => ({ available: false }),
  };
  const make = () => new CodexConnector(async () => { commands++; throw new Error('No independent auth probe'); }, binary, Date.now, deps);
  try {
    const a = make(), b = make();
    assert.equal((await a.detect()).available, true);
    assert.equal(commands, 0);
    assert.equal(await b.usagePercent(), 42);
    const tool = createCodexUsageTool(() => b.usage());
    assert.equal(JSON.parse(await tool.execute({}) as string).fiveHour.usedPercent, 42);
    assert.equal(probes, 1);
  } finally { f.cleanup(); }
});

test('explicit exec transport is identical to the default and app-server is opt-in', () => {
  assert.deepEqual(connector.build({ ...spec, transport: 'exec' }), connector.build(spec));
  const app = connector.build({ ...spec, transport: 'app-server' });
  assert.deepEqual(app.args, ['app-server']);
  assert.ok('stdinPlan' in app && typeof app.stdinPlan === 'function');
  assert.equal(JSON.parse(app.stdin).method, 'initialize');
});

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
      assert.ok(command.stdin.endsWith(spec.prompt));
      assert.ok(command.stdin.startsWith('If you need a decision or information'));
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

test('Codex detection derives authentication from cached usage without a login command', async () => {
  const f = fixture(); let probes = 0, commands = 0;
  const cache = join(f.home, 'cache', 'codex-usage.json');
  mkdirSync(join(f.home, 'cache'), { recursive: true });
  try {
    for (const available of [true, false]) {
      writeFileSync(cache, JSON.stringify({ takenAt: Date.now(), ok: available,
        raw: { available, reason: available ? undefined : 'Not logged in' }, parsed: { available } }));
      const connector = new CodexConnector(async () => { commands++; throw new Error('No login command'); }, binary, Date.now,
        { home: f.home, onBattery: false, live: async () => { probes++; return undefined; } });
      const result = await connector.detect();
      assert.equal(result.available, available);
      if (!available) assert.equal(result.reason, 'Codex is not signed in: run codex login');
    }
    assert.equal(commands, 0); assert.equal(probes, 0);
  } finally { f.cleanup(); }
});

test('Codex detection fails open on unknown usage and backs off failed probes for fifteen minutes', async () => {
  for (const failure of ['timeout', 'unknown']) {
    const f = fixture(); let calls = 0, time = 1000000;
    const connector = new CodexConnector(async () => { throw new Error('No CLI command'); }, binary, () => time,
      { home: f.home, onBattery: false, live: async () => { calls++; if (failure === 'timeout') throw new Error('timeout'); return undefined; } });
    try {
      assert.equal((await connector.detect()).available, true);
      time += 14 * 60000; assert.equal((await connector.detect()).available, true); assert.equal(calls, 1);
      time += 60000; await connector.detect(); assert.equal(calls, 2);
      assert.equal(JSON.parse(readFileSync(join(f.home, 'cache', 'codex-usage.json'), 'utf8')).ok, false);
    } finally { f.cleanup(); }
  }
});

test('Codex detection refreshes shared successful usage after the configured interval (five minutes here)', async () => {
  const f = fixture(); let calls = 0, time = 1000000;
  const live = async () => { calls++; return { available: true }; };
  const a = new CodexConnector(undefined, binary, () => time, { home: f.home, onBattery: false, live, ttlMs: 300000 });
  const b = new CodexConnector(undefined, binary, () => time, { home: f.home, onBattery: false, live, ttlMs: 300000 });
  try {
    await a.detect(); await b.detect(); assert.equal(calls, 1);
    time += 299999; await b.detect(); assert.equal(calls, 1);
    time++; await b.detect(); assert.equal(calls, 2);
  } finally { f.cleanup(); }
});

test('parses completed reasoning items', () => {
  assert.deepEqual(connector.parse(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'Inspecting the files.' } }), 'stdout'), { reasoning: 'Inspecting the files.' });
});
