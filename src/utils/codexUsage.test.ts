import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexUsage } from './codexUsage.js';

const NOW = Date.parse('2026-10-31T18:00:00Z');
const snapshot = (timestamp: string, primary: number, secondary: number) =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary: { used_percent: primary, window_minutes: 300, resets_at: 1793338687 },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1793886361 },
        credits: { has_credits: false },
        plan_type: 'plus',
        rate_limit_reached_type: null,
      },
    },
  });

test('reads the newest snapshot, walking back past files without one', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-usage-'));
  try {
    const day = join(home, 'sessions', '2026', '10', '31');
    mkdirSync(day, { recursive: true });
    const write = (name: string, body: string, mtimeSec: number) => {
      writeFileSync(join(day, name), body);
      utimesSync(join(day, name), mtimeSec, mtimeSec);
    };
    const old = NOW / 1000 - 7200;
    write('old.jsonl', snapshot('2026-10-31T10:00:00Z', 5, 6) + '\n', old - 100);
    write(
      'mid.jsonl',
      snapshot('2026-10-31T15:00:00Z', 10, 11) +
        '\n' +
        snapshot('2026-10-31T16:00:00Z', 15, 18) +
        '\n{"partial":',
      old
    );
    write('new.jsonl', '{"type":"session_meta"}\n', NOW / 1000 - 60);
    const usage = readCodexUsage({ CODEX_HOME: home }, NOW);
    assert.equal(usage.available, true);
    assert.equal(usage.plan, 'plus');
    assert.equal(usage.fiveHour?.usedPercent, 15);
    assert.equal(usage.weekly?.usedPercent, 18);
    assert.equal(usage.fiveHour?.windowMinutes, 300);
    assert.equal(usage.fiveHour?.resetAtIso, new Date(1793338687 * 1000).toISOString());
    assert.equal(usage.snapshotAt, '2026-10-31T16:00:00.000Z');
    assert.equal(usage.snapshotAgeSec, 7200);
    assert.match(usage.meter ?? '', /^codex 5h 15% · wk 18%\n/);
    assert.equal(usage.rateLimitReached, null);
    assert.match(usage.fiveHour?.resetIn ?? '', /^(in \d+h \d+m|reset)$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reports unavailable when no snapshot or no sessions directory exists', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-usage-'));
  try {
    assert.equal(readCodexUsage({ CODEX_HOME: home }, NOW).available, false);
    mkdirSync(join(home, 'sessions'));
    writeFileSync(join(home, 'sessions', 'a.jsonl'), '{"type":"x"}\n');
    const usage = readCodexUsage({ CODEX_HOME: home }, NOW);
    assert.equal(usage.available, false);
    assert.match(usage.reason ?? '', /no Codex usage snapshot/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
