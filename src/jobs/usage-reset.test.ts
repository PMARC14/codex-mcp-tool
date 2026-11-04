import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageReset, usageLimit } from './usage-reset.js';

test('shared quota reset parser accepts absolute and relative vendor formats', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  for (const [message, expected] of [
    ['quota resets at 2026-10-31T20:39:33Z', Date.parse('2026-10-31T20:39:33Z')],
    ['quota resets at 2026-10-31T15:00:00-0400', Date.parse('2026-10-31T19:00:00Z')],
    ['try again in 2h 30m', now.getTime() + 9000000],
    ['retry after 90 seconds', now.getTime() + 90000],
    ['try again after 2 hours 30 minutes 15 seconds', now.getTime() + 9015000],
    ['"retryDelay":"3600s"', now.getTime() + 3600000],
    ['"retry_delay": "1.5s"', now.getTime() + 1500],
    ['quota exhausted', undefined],
    ['try again at 25:99 PM', undefined],
  ] as const) assert.equal(usageReset(message, now), expected, message);
});

test('clock resets just passed retry in a minute, old ones roll to tomorrow', () => {
  for (const now of [new Date(2026, 9, 31, 17, 37, 30), new Date(2026, 9, 31, 18, 37)])
    assert.equal(usageReset('try again at 5:37 PM', now), now.getTime() + 60000);
  assert.equal(usageReset('try again at 5:37 PM', new Date(2026, 9, 31, 19, 37)),
    new Date(2026, 10, 1, 17, 37).getTime());
  assert.equal(usageReset('try again at 5:37 PM', new Date(2026, 9, 31, 16)),
    new Date(2026, 9, 31, 17, 37).getTime());
});

test('quota pause model scoping is shared by connectors', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  assert.deepEqual(usageLimit('quota for model "fake-model" exhausted, retry after 90 seconds', now),
    { model: 'fake-model', resetAt: now.getTime() + 90000 });
  assert.deepEqual(usageLimit('quota exhausted', now), { model: undefined, resetAt: undefined });
});
