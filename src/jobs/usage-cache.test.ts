import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { fixture, until } from './test-helpers.js';

import { getUsage } from './usage-cache.js';

test('usage cache shares five-minute results and backs off fifteen minutes on battery or failure', async () => {
  const f = fixture(); let time = 1000000, calls = 0, battery = false, fail = false;
  const opts = { home: f.home, now: () => time, onBattery: () => battery };
  const probe = async () => {
    calls++;
    if (fail) throw new Error('offline');
    return { ok: true, raw: 'quota:42', parsed: { percent: 42 } };
  };
  try {
    assert.equal((await getUsage('fake', probe, opts))?.parsed?.percent, 42);
    time += 299999; await getUsage('fake', probe, opts); assert.equal(calls, 1);
    time++; await getUsage('fake', probe, opts); assert.equal(calls, 2);
    battery = true; time += 300000;
    await getUsage('fake', probe, opts); assert.equal(calls, 2);
    time += 600000; await getUsage('fake', probe, opts); assert.equal(calls, 3);
    battery = false; fail = true; time += 300000;
    const failed = await getUsage('fake', probe, opts);
    assert.ok(failed);
    assert.equal(failed.ok, false); assert.deepEqual(failed.parsed, { percent: 42 });
    time += 899999; await getUsage('fake', probe, opts); assert.equal(calls, 4);
    time++; await getUsage('fake', probe, opts); assert.equal(calls, 5);
    const saved = JSON.parse(readFileSync(join(f.home, 'cache', 'fake-usage.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['ok', 'parsed', 'raw', 'takenAt']);
    assert.equal(saved.takenAt, time);
  } finally { f.cleanup(); }
});

test('usage cache returns stale or missing data immediately while another process probes', async () => {
  const f = fixture(); mkdirSync(join(f.home, 'cache'), { recursive: true });
  const cache = join(f.home, 'cache', 'fake-usage.json');
  const gate = join(f.home, 'gate'), entered = join(f.home, 'entered');
  const script = join(f.home, 'probe.mjs');
  writeFileSync(cache, JSON.stringify({ takenAt: 1, ok: true, raw: 'old', parsed: { percent: 5 } }));
  writeFileSync(script, `import { getUsage } from ${JSON.stringify(new URL('./usage-cache.js', import.meta.url).href)};
import { appendFileSync, existsSync } from 'node:fs';
await getUsage('fake', async () => {
  appendFileSync(process.argv[3], 'probe\\n');
  while (!existsSync(process.argv[4])) await new Promise(r => setTimeout(r, 20));
  return { ok: true, raw: 'new', parsed: { percent: 8 } };
}, { home: process.argv[2], onBattery: false });`);
  const child = spawn(process.execPath, [script, f.home, entered, gate], { windowsHide: true, stdio: 'ignore' });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  let duplicates = 0;
  try {
    await until(() => existsSync(entered), 'fake probe entered');
    const value = await getUsage<{ percent: number }>('fake', async () => { duplicates++; throw new Error('duplicate probe'); }, { home: f.home, onBattery: false });
    assert.equal(value?.parsed?.percent, 5); assert.equal(duplicates, 0);
    // A first-ever reader with no snapshot also returns without waiting.
    writeFileSync(join(f.home, 'cache', 'empty-usage.lock'), '{}');
    assert.equal(await getUsage('empty', async () => { duplicates++; throw new Error('duplicate probe'); }, { home: f.home, onBattery: false }), undefined);
    writeFileSync(gate, ''); assert.equal(await closed, 0);
    assert.equal((await getUsage<{ percent: number }>('fake', async () => { duplicates++; throw new Error('duplicate probe'); }, { home: f.home, onBattery: false }))?.parsed?.percent, 8);
    assert.equal(duplicates, 0);
    assert.equal(readFileSync(entered, 'utf8').trim(), 'probe');
    assert.equal(existsSync(join(f.home, 'cache', 'fake-usage.lock')), false);
  } finally { if (child.exitCode === null) { child.kill(); await closed; } f.cleanup(); }
});

test('usage cache reclaims expired locks and caches unsuccessful probe results', async () => {
  const f = fixture(); mkdirSync(join(f.home, 'cache'), { recursive: true }); let calls = 0;
  try {
    writeFileSync(join(f.home, 'cache', 'fake-usage.lock'), JSON.stringify({ token: 'dead', ts: 1 }));
    const opts = { home: f.home, now: () => Date.now(), onBattery: false, staleLockMs: 1 };
    const probe = async () => { calls++; return { ok: false, raw: 'not signed in', parsed: null }; };
    assert.equal((await getUsage('fake', probe, opts))?.ok, false);
    await getUsage('fake', probe, opts); assert.equal(calls, 1);
    assert.equal(existsSync(join(f.home, 'cache', 'fake-usage.lock')), false);
    await assert.rejects(getUsage('../escape', probe, opts), /connector/i);
  } finally { f.cleanup(); }
});
