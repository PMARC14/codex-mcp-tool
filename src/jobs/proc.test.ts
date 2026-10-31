import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { fixture } from './test-helpers.js';
import {
  startProcess,
  resolveCommand,
  spawnOptions,
  runCommand,
  isAlive,
  safeSpawn,
  processStartTime,
  killTree,
} from './proc.js';
import type { Owner } from './connector.js';

test('spawn options hide Windows consoles without detaching, and create POSIX process groups', () => {
  const windows = spawnOptions('win32');
  assert.equal(windows.windowsHide, true);
  assert.equal(windows.shell, false);
  assert.equal(windows.detached, undefined);
  assert.equal(spawnOptions('linux').detached, true);
});

test(
  'Windows missing commands are rejected before cross-spawn can fall back to cmd.exe',
  { skip: process.platform !== 'win32' },
  () => {
    const f = fixture();
    try {
      assert.throws(() => safeSpawn(join(f.home, 'absent.exe'), [], { stdio: 'ignore' }), {
        code: 'ENOENT',
      });
      assert.throws(
        () =>
          safeSpawn('agent-jobs-impossible-command', [], {
            stdio: 'ignore',
            env: { PATH: f.home },
          }),
        /not found/
      );
    } finally {
      f.cleanup();
    }
  }
);

test('npm cmd shim resolves to JavaScript via Node without cmd.exe or shell interpolation', async () => {
  const f = fixture();
  try {
    const shim = join(f.home, 'fake.cmd');
    const target = join(f.home, 'fake.cjs');
    writeFileSync(target, 'console.log(process.argv[2]);');
    writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\fake.cjs" %*\r\n');
    const input = '" & $(echo nope) | %PATH%';
    assert.deepEqual(resolveCommand(shim, [input]), {
      exe: process.execPath,
      args: [target, input],
    });
    assert.equal(await runCommand(shim, [input]), input);
    writeFileSync(shim, 'echo unsupported');
    assert.throws(() => resolveCommand(shim, []), /Cannot resolve/);
  } finally {
    f.cleanup();
  }
});

test('tree kill verifies start time and never kills a process with a reused PID', async () => {
  const child = safeSpawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn);
    child.once('error', reject);
  });
  const identity = { pid: child.pid!, startTime: (await processStartTime(child.pid!))! };
  try {
    assert.ok(identity.startTime);
    await killTree({ ...identity, startTime: 'a-previous-process' });
    assert.equal(await isAlive(identity), true);
    await killTree(identity);
    assert.equal(await isAlive(identity), false);
  } finally {
    if (await isAlive(identity)) await killTree(identity);
    // Covers failed identity inspection too, while this ChildProcess still owns the PID.
    if (child.exitCode === null) child.kill();
  }
});

test('cancel before spawn and simultaneous timeout settle once, after the child ends', async () => {
  const f = fixture();
  let identity: Owner | undefined;
  try {
    const proc = startProcess({
      exe: process.execPath,
      args: ['-e', 'setTimeout(()=>{},10000)'],
      cwd: f.home,
      stdout: join(f.home, 'out'),
      stderr: join(f.home, 'err'),
      async onSpawn(owner) {
        identity = owner;
      },
      onSnapshot() {},
      onLine() {},
    });
    const cancel = proc.stop('cancel');
    const timeout = proc.stop('timeout');
    const results = await Promise.all([cancel, timeout, proc.done]);
    assert.equal(results[0].kind, 'cancel');
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
    assert.equal(results[0].killFailed, undefined);
    assert.equal(await isAlive(identity!), false);
  } finally {
    f.cleanup();
  }
});

test('exit wins over a later cancel and stdin/stdout/stderr are handled independently', async () => {
  const f = fixture();
  try {
    const lines: string[] = [];
    const proc = startProcess({
      exe: process.execPath,
      args: [
        '-e',
        'process.stdin.resume(); process.stdin.on("end",()=>{console.log("out"); console.error("err")})',
      ],
      stdin: 'a prompt',
      cwd: f.home,
      stdout: join(f.home, 'out'),
      stderr: join(f.home, 'err'),
      async onSpawn() {},
      onSnapshot() {},
      onLine(line, stream) {
        lines.push(`${stream}:${line}`);
      },
    });
    const outcome = await proc.done;
    assert.equal(outcome.kind, 'exit');
    assert.equal(outcome.code, 0);
    assert.deepEqual(await proc.stop(), outcome);
    assert.equal(readFileSync(join(f.home, 'out'), 'utf8').trim(), 'out');
    assert.equal(readFileSync(join(f.home, 'err'), 'utf8').trim(), 'err');
    assert.deepEqual(lines.sort(), ['stderr:err', 'stdout:out']);
  } finally {
    f.cleanup();
  }
});

test('child exiting without consuming a large stdin cannot crash the server with EPIPE', async () => {
  const f = fixture();
  try {
    const proc = startProcess({
      exe: process.execPath,
      args: ['-e', 'process.exit(0)'],
      stdin: 'x'.repeat(2 * 1024 * 1024),
      cwd: f.home,
      stdout: join(f.home, 'out'),
      stderr: join(f.home, 'err'),
      async onSpawn() {},
      onSnapshot() {},
      onLine() {},
    });
    assert.equal((await proc.done).code, 0);
  } finally {
    f.cleanup();
  }
});
