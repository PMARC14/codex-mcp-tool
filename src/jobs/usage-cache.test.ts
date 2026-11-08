import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { fixture, until } from './test-helpers.js';

import { getUsage } from './usage-cache.js';

test('concurrent usage calls keep the last good disk snapshot when the active probe fails', async () => {
  const f = fixture();
  const opts = { home: f.home, onBattery: false, now: () => 1_000_000 };
  const cache = join(f.home, 'cache', 'fake-usage.json');
  const good = { takenAt: 1, ok: true, raw: { available: true }, parsed: { percent: 42 } };
  mkdirSync(join(f.home, 'cache'));
  writeFileSync(cache, JSON.stringify(good));
  let entered!: () => void;
  const probing = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let duplicates = 0;
  const first = getUsage('fake', async () => {
    entered();
    await gate;
    return { ok: false, raw: null, parsed: null };
  }, opts);
  try {
    await probing;
    const second = await getUsage('fake', async () => {
      duplicates++;
      return { ok: true, raw: 'duplicate', parsed: { percent: 99 } };
    }, opts);
    assert.deepEqual(second, good, 'a contending reader receives the last good result');
    release();
    const failed = await first;
    assert.equal(failed?.ok, false, 'the probing caller can still observe failure');
    assert.deepEqual(failed?.parsed, good.parsed);
    assert.deepEqual(JSON.parse(readFileSync(cache, 'utf8')), good, 'a failed overlapping probe never replaces the last good disk snapshot');
    const cached = await getUsage('fake', async () => { duplicates++; throw new Error('must back off'); }, opts);
    assert.equal(cached?.ok, false);
    assert.equal(duplicates, 0);
  } finally { release(); await first; f.cleanup(); }
});

test('usage cache shares five-minute results and backs off fifteen minutes on battery or failure', async () => {
  const f = fixture(); let time = 1000000, calls = 0, battery = false, fail = false;
  const opts = { home: f.home, now: () => time, onBattery: () => battery, ttlMs: 300000, batteryTtlMs: 900000 };
  const probe = async () => {
    calls++;
    if (fail) throw new Error('offline');
    return { ok: true, raw: 'quota:42', parsed: { percent: 42 } };
  };
  try {
    assert.equal((await getUsage('fake', probe, opts))?.parsed?.percent, 42);
    time += 299999; await getUsage('fake', probe, opts); assert.equal(calls, 1);
    time++; await getUsage('fake', probe, opts); assert.equal(calls, 2);
    battery = true; time += 600000; // power status is cached for ten minutes
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
    assert.equal(saved.ok, true);
    assert.equal(saved.raw, 'quota:42');
    assert.equal(saved.takenAt, 2500000, 'failed probes preserve the successful snapshot timestamp');
    const failurePath = join(f.home, 'cache', 'fake-usage.failure.json');
    assert.equal(JSON.parse(readFileSync(failurePath, 'utf8')).takenAt, time);
    fail = false;
    time += 900000;
    assert.equal((await getUsage('fake', probe, opts))?.ok, true);
    assert.equal(existsSync(failurePath), false, 'successful probes clear the failure backoff');
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


test('battery readers reuse timestamped power state without taking the usage lock', async () => {
  const f = fixture(); let time = 1000000, powerReads = 0, probes = 0, locks = 0;
  const original = fs.linkSync;
  const probe = async () => { probes++; return { ok: true, raw: 42, parsed: 42 }; };
  const opts = { home: f.home, now: () => time, ttlMs: 300000, batteryTtlMs: 1800000, onBattery: () => { powerReads++; return true; } };
  try {
    await getUsage('fake', probe, opts);
    time += 300000;
    await getUsage('fake', probe, opts); // Detect battery and remember when it was checked.
    const reads = powerReads;
    assert.ok(reads > 0);
    fs.linkSync = ((existing: fs.PathLike, path: fs.PathLike) => {
      if (String(path).endsWith('fake-usage.lock')) locks++;
      return original(existing, path);
    }) as typeof fs.linkSync;
    syncBuiltinESMExports();
    for (let i = 0; i < 5; i++) {
      time += 1000;
      assert.equal((await getUsage('fake', probe, opts))?.parsed, 42);
    }
    assert.equal(powerReads, reads, 'power queries must also be cached');
    assert.equal(locks, 0, 'fresh battery snapshots return before acquiring the usage lock');
    assert.equal(probes, 1);
    assert.equal(JSON.parse(readFileSync(join(f.home, 'cache', 'fake-usage.json'), 'utf8')).takenAt, 1000000);
    time += 600000;
    await getUsage('fake', probe, opts);
    assert.ok(powerReads > reads, 'power state has its own expiry');
    time = 3000000;
    await getUsage('fake', probe, opts);
    assert.equal(probes, 2, 'battery does not extend quota freshness past the battery interval');
  } finally { fs.linkSync = original; syncBuiltinESMExports(); f.cleanup(); }
});
