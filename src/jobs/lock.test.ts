import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './test-helpers.js';
import { currentOwner } from './proc.js';
import { reclaimStale, withLock } from './lock.js';

const deadLock = JSON.stringify({ pid: 999999, startTime: 'gone', token: 'dead' });

test(
  'a live legacy .reap sentinel neither blocks nor is touched when reclaiming a stale lock',
  {
    timeout: 8000,
  },
  async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.home, 'lock'), deadLock);
      const live = JSON.stringify(await currentOwner());
      writeFileSync(join(f.home, 'lock.reap'), live);
      assert.equal(await withLock(f.home, () => 'acquired'), 'acquired');
      assert.equal(readFileSync(join(f.home, 'lock.reap'), 'utf8'), live);
    } finally {
      f.cleanup();
    }
  }
);

test('reclaiming never removes a lock that is not the stale one that was judged', () => {
  const f = fixture();
  try {
    const path = join(f.home, 'lock');
    const live = JSON.stringify({ ...{ pid: process.pid, startTime: 'x' }, token: 'live' });
    writeFileSync(path, live);
    // Another waiter already reclaimed the dead lock and a live holder replaced it.
    reclaimStale(path, deadLock);
    assert.equal(readFileSync(path, 'utf8'), live);
    assert.deepEqual(
      readdirSync(f.home).filter(name => name.startsWith('lock.')),
      []
    );
    writeFileSync(path, deadLock);
    reclaimStale(path, deadLock);
    assert.equal(existsSync(path), false);
    reclaimStale(path, deadLock);
  } finally {
    f.cleanup();
  }
});

test(
  'concurrent waiters over a dead owner lock keep mutual exclusion',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.home, 'lock'), deadLock);
      let inside = 0;
      let max = 0;
      await Promise.all(
        Array.from({ length: 6 }, () =>
          withLock(f.home, async () => {
            max = Math.max(max, ++inside);
            await new Promise(resolve => setTimeout(resolve, 20));
            inside--;
          })
        )
      );
      assert.equal(max, 1);
      assert.deepEqual(
        readdirSync(f.home).filter(name => name.startsWith('lock')),
        []
      );
    } finally {
      f.cleanup();
    }
  }
);
