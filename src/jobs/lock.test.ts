import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture, until } from './test-helpers.js';
import { currentOwner } from './proc.js';
import { lockTestHooks, mutexAddress, reclaimStale, tryAcquire, withLock } from './lock.js';

const deadLock = JSON.stringify({ pid: 999999, startTime: 'gone', token: 'dead' });

test('withLock excludes a live legacy file-lock holder without overwriting it', async () => {
  const f = fixture();
  const path = join(f.home, 'lock');
  const legacy = JSON.stringify({ ...await currentOwner(), token: 'legacy' });
  try {
    assert.equal(tryAcquire(path, legacy), true);
    await assert.rejects(withLock(f.home, () => assert.fail('overlapped legacy holder'), 100), /Timed out/);
    assert.equal(readFileSync(path, 'utf8'), legacy);
  } finally { f.cleanup(); }
});

test('withLock publishes a legacy-compatible owner and releases both locks after errors', async () => {
  const f = fixture();
  try {
    const owner = await currentOwner();
    await assert.rejects(withLock(f.home, () => {
      const held = JSON.parse(readFileSync(join(f.home, 'lock'), 'utf8'));
      assert.equal(held.pid, owner.pid);
      assert.equal(held.startTime, owner.startTime);
      assert.equal(tryAcquire(join(f.home, 'lock'), 'old server'), false);
      throw new Error('action failed');
    }), /action failed/);
    assert.equal(existsSync(join(f.home, 'lock')), false);
    assert.equal(await withLock(f.home, () => 'released', 100), 'released');
  } finally { f.cleanup(); }
});

test('withLock release preserves a replacement file owned by another holder', async () => {
  const f = fixture();
  try {
    await withLock(f.home, () => writeFileSync(join(f.home, 'lock'), '{replacement'));
    assert.equal(readFileSync(join(f.home, 'lock'), 'utf8'), '{replacement');
  } finally { f.cleanup(); }
});

test('mutex address resolves relative keys before hashing', () => {
  assert.equal(mutexAddress('relative-lock'), mutexAddress(join(process.cwd(), 'relative-lock')));
});

test('mutex address canonicalizes Windows case and separator variants', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    for (const key of [f.home, join(f.home, 'not-created-yet')])
      assert.equal(mutexAddress(key), mutexAddress(key.toUpperCase().replace(/\\/g, '/')));
  } finally { f.cleanup(); }
});

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

test('withLock sweeps stale lock temp files left by an interrupted acquisition', async () => {
  const home = mkdtempSync(join(tmpdir(), 'lock-tmp-'));
  try {
    const stale = join(home, 'lock.00000000-0000-0000-0000-000000000000.tmp');
    const fresh = join(home, 'lock.11111111-1111-1111-1111-111111111111.tmp');
    writeFileSync(stale, '{}');
    writeFileSync(fresh, '{}');
    const old = (Date.now() - 20 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);
    await withLock(home, () => undefined);
    assert.equal(existsSync(stale), false, 'stale temp file was not removed');
    assert.equal(existsSync(fresh), true, 'a fresh temp file (maybe in use) must stay');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('multi-process contention keeps mutual exclusion with zero overlap', { timeout: 30000 }, async () => {
  const f = fixture();
  const logFile = join(f.home, 'contention.log');
  const lockModule = new URL('./lock.js', import.meta.url).href;
  const workerCode = `
    import { withLock } from ${JSON.stringify(lockModule)};
    import { appendFileSync } from 'node:fs';
    const [home, logFile] = process.argv.slice(1);
    for (let i = 0; i < 4; i++) {
      await withLock(home, async () => {
        const enter = Date.now();
        await new Promise(r => setTimeout(r, 15));
        const exit = Date.now();
        appendFileSync(logFile, JSON.stringify({ pid: process.pid, enter, exit }) + '\\n');
      });
      await new Promise(r => setTimeout(r, 5));
    }
  `;
  try {
    const children = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode, f.home, logFile], {
        stdio: 'inherit',
        windowsHide: true,
      });
      return new Promise<void>((resolve, reject) => {
        child.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`Worker exited with code ${code}`));
        });
      });
    });
    await Promise.all(children);

    const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 16, 'all 16 critical sections must be recorded');
    const records = lines.map(l => JSON.parse(l) as { pid: number; enter: number; exit: number });
    records.sort((a, b) => a.enter - b.enter);
    for (let i = 1; i < records.length; i++) {
      assert.ok(
        records[i].enter >= records[i - 1].exit,
        `Lock overlap: PID ${records[i - 1].pid} exited at ${records[i - 1].exit}, but PID ${records[i].pid} entered at ${records[i].enter}`
      );
    }
  } finally {
    f.cleanup();
  }
});

test('when a lock holder is killed mid-critical-section, the next waiter gets the lock promptly', { timeout: 15000 }, async () => {
  const f = fixture();
  const lockModule = new URL('./lock.js', import.meta.url).href;
  const holderEntered = join(f.home, 'holder.entered');
  const waiterAcquired = join(f.home, 'waiter.acquired');
  const waiterReady = join(f.home, 'waiter.ready');
  const procModule = new URL('./proc.js', import.meta.url).href;

  const holderCode = `
    import { withLock } from ${JSON.stringify(lockModule)};
    import { writeFileSync } from 'node:fs';
    const [home, signal] = process.argv.slice(1);
    await withLock(home, async () => {
      writeFileSync(signal, 'entered');
      await new Promise(r => setTimeout(r, 60000));
    });
  `;

  const waiterCode = `
    import { withLock } from ${JSON.stringify(lockModule)};
    import { currentOwner } from ${JSON.stringify(procModule)};
    import { writeFileSync } from 'node:fs';
    const [home, signal, ready] = process.argv.slice(1);
    // Windows process identity initialization launches PowerShell; exclude startup from lock handoff timing.
    await currentOwner();
    writeFileSync(ready, 'ready');
    await withLock(home, async () => {
      writeFileSync(signal, String(Date.now()));
    });
  `;

  try {
    const holder = spawn(process.execPath, ['--input-type=module', '-e', holderCode, f.home, holderEntered], {
      stdio: 'inherit',
      windowsHide: true,
    });
    await until(() => existsSync(holderEntered), 'holder entered critical section', 5000);

    const waiter = spawn(process.execPath, ['--input-type=module', '-e', waiterCode, f.home, waiterAcquired, waiterReady], {
      stdio: 'inherit',
      windowsHide: true,
    });
    const waiterDone = new Promise<void>((resolve, reject) => {
      waiter.on('close', code => (code === 0 ? resolve() : reject(new Error(`Waiter exited ${code}`))));
    });

    await until(() => existsSync(waiterReady), 'waiter initialized', 5000);
    const killTime = Date.now();
    holder.kill();

    await until(() => existsSync(waiterAcquired), 'waiter acquired after holder killed', 5000);
    const acquiredTime = Number(readFileSync(waiterAcquired, 'utf8'));
    const waitDuration = acquiredTime - killTime;

    // Full Windows runs contend for disk and process scheduling; still reject any stale-lock grace period.
    const maxHandoffMs = process.platform === 'win32' ? 1000 : 100;
    assert.ok(waitDuration < maxHandoffMs, `Waiter took too long to acquire: ${waitDuration}ms`);

    await waiterDone;
  } finally {
    f.cleanup();
  }
});
