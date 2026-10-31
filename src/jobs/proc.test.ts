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
  snapshotDescendants,
  runCommandBuffer,
  killProcessGroup,
  type GroupKillDeps,
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

test('snapshot rejects PID-reuse edges so an old orphan is never adopted as a descendant', () => {
  const root = { pid: 100, startTime: '5000' };
  const rows = [
    { ProcessId: 100, ParentProcessId: 1, Start: '5000' },
    // Legitimate child and grandchild, started after their parents.
    { ProcessId: 101, ParentProcessId: 100, Start: '5100' },
    { ProcessId: 102, ParentProcessId: 101, Start: '5100' },
    // Orphan left by an earlier process that had PID 100; it predates the current root.
    { ProcessId: 200, ParentProcessId: 100, Start: '1000' },
    { ProcessId: 201, ParentProcessId: 200, Start: '1500' },
  ];
  assert.deepEqual(
    snapshotDescendants(rows, root)
      .map(p => p.pid)
      .sort(),
    [101, 102]
  );
});

test('runCommand decodes UTF-8 once, so a character split across chunks survives', async () => {
  const script =
    'const b=Buffer.from("é€x  \\n");process.stdout.write(b.subarray(0,3));setTimeout(()=>process.stdout.write(b.subarray(3)),150)';
  assert.equal(await runCommand(process.execPath, ['-e', script]), 'é€x');
  // The raw form keeps every byte, including trailing whitespace.
  assert.deepEqual(
    await runCommandBuffer(process.execPath, ['-e', script]),
    Buffer.from('é€x  \n')
  );
});

function groupDeps(deadAfterKill: number | undefined): GroupKillDeps & { signals: string[] } {
  const signals: string[] = [];
  let killed = false;
  let polls = 0;
  return {
    signals,
    graceMs: 20,
    killWaitMs: 300,
    pollMs: 5,
    startTime: async () => '42',
    kill(pid, signal) {
      assert.equal(pid, -77);
      if (signal === 0) {
        // The group outlives its root: a descendant keeps it alive until deadAfterKill polls.
        if (killed && deadAfterKill !== undefined && ++polls > deadAfterKill)
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return;
      }
      signals.push(String(signal));
      if (signal === 'SIGKILL') killed = true;
    },
  };
}

test('POSIX group kill waits for the group to disappear after SIGKILL', async () => {
  const deps = groupDeps(4);
  await killProcessGroup({ pid: 77, startTime: '42' }, deps);
  assert.deepEqual(deps.signals, ['SIGTERM', 'SIGKILL']);
});

test('POSIX group kill reports kill-failed when a descendant keeps the group alive', async () => {
  const deps = groupDeps(undefined);
  await assert.rejects(
    () => killProcessGroup({ pid: 77, startTime: '42' }, deps),
    /^Error: kill-failed/
  );
});
