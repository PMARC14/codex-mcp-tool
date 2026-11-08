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
  closeGrace,
  liveIn,
  type GroupKillDeps,
} from './proc.js';
import type { Owner } from './connector.js';
import { jobWrapper } from './jobobject.js';

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

test('Windows Job Object launcher forwards arguments, streams and exit code', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  try {
    assert.ok(jobWrapper(), 'the Job Object launcher is available');
    const args = ['', 'space here', 'a"b', 'ends with slash\\', 'slashes\\\\"quote', 'λ'];
    const script = 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{console.log(JSON.stringify([s,process.argv.slice(1)]));console.error("stderr passed");process.exitCode=23})';
    const proc = startProcess({ exe: process.execPath, args: ['-e', script, ...args], stdin: 'input λ', cwd: f.home,
      stdout: join(f.home, 'out'), stderr: join(f.home, 'err'), async onSpawn() {}, onSnapshot() {}, onLine() {} });
    const outcome = await proc.done;
    assert.equal(outcome.code, 23);
    assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'out'), 'utf8')), ['input λ', args]);
    assert.equal(readFileSync(join(f.home, 'err'), 'utf8').trim(), 'stderr passed');
  } finally { f.cleanup(); }
});

test('Windows Job Object launcher falls back when the compiler is unavailable', { skip: process.platform !== 'win32' }, () => {
  const f = fixture();
  try {
    const warnings: string[] = [];
    assert.equal(jobWrapper({ compiler: join(f.home, 'missing-csc.exe'), cacheDir: f.home, warn: message => warnings.push(message) }), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /using process-tree cleanup/);
  } finally { f.cleanup(); }
});

test('Windows cancellation kills detached and orphaned Node descendants', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const f = fixture();
  const pidFile = join(f.home, 'pids');
  const worker = join(f.home, 'worker.cjs');
  const childScript = join(f.home, 'child.cjs');
  const sleeper = join(f.home, 'sleeper.cjs');
  writeFileSync(sleeper, 'setTimeout(() => {}, 60000);');
  writeFileSync(childScript, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const p=spawn(process.execPath,[process.argv[2]],{detached:true,stdio:'ignore',windowsHide:true});
    fs.appendFileSync(process.argv[3],p.pid+'\\n'); p.unref();`);
  writeFileSync(worker, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const p=spawn(process.execPath,[process.argv[2]],{detached:true,stdio:'ignore',windowsHide:true});
    fs.appendFileSync(process.argv[4],p.pid+'\\n'); p.unref();
    const c=spawn(process.execPath,[process.argv[3],process.argv[2],process.argv[4]],{stdio:'ignore',windowsHide:true});
    fs.appendFileSync(process.argv[4],c.pid+'\\n'); setInterval(()=>{},1000);`);
  const identities: Owner[] = [];
  let proc: ReturnType<typeof startProcess> | undefined;
  try {
    proc = startProcess({ exe: process.execPath, args: [worker, sleeper, childScript, pidFile], cwd: process.cwd(),
      stdout: join(f.home, 'out'), stderr: join(f.home, 'err'), async onSpawn() {}, onSnapshot() {}, onLine() {} });
    let pids: number[] = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { pids = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number); } catch { /* worker starting */ }
      if (pids.length === 3) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(pids.length, 3, 'worker started all descendants');
    while (Date.now() < deadline && await processStartTime(pids[1]))
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await processStartTime(pids[1]), undefined, 'intermediate child exited');
    for (const pid of [pids[0], pids[2]]) {
      const startTime = await processStartTime(pid);
      assert.ok(startTime);
      identities.push({ pid, startTime });
    }
    const started = Date.now();
    const result = await proc.stop();
    assert.ok(Date.now() - started <= 10000, 'cancellation completes within 10 seconds');
    assert.equal(result.killFailed, undefined);
    for (const identity of identities) assert.equal(await isAlive(identity), false, `descendant ${identity.pid} survived`);
  } finally {
    if (proc) await proc.stop();
    for (const identity of identities) if (await isAlive(identity)) { process.kill(identity.pid); }
    await new Promise(resolve => setTimeout(resolve, 500));
    f.cleanup();
  }
});

test('snapshot follows a dead known parent but rejects a reused parent PID', () => {
  const root = { pid: 10, startTime: '1000' };
  const known = [{ pid: 20, startTime: '1100' }];
  const rows = [{ ProcessId: 30, ParentProcessId: 20, Start: '1200' }];
  // Dead known entries still act as parents but are dropped from the result.
  assert.deepEqual(snapshotDescendants(rows, root, known).map(p => p.pid), [30]);
  assert.deepEqual(snapshotDescendants([...rows, { ProcessId: 20, ParentProcessId: 1, Start: '1300' }], root, known).map(p => p.pid), []);
  assert.deepEqual(snapshotDescendants([{ ...rows[0], Start: '900' }], root, known).map(p => p.pid), []);
  assert.deepEqual(snapshotDescendants([...rows, { ProcessId: 20, ParentProcessId: 10, Start: '1100' }], root, known).map(p => p.pid), [20, 30]);
});

test('liveIn matches PID and start time from one snapshot', () => {
  const rows = [{ ProcessId: 1, ParentProcessId: 0, Start: '5' }, { ProcessId: 2, ParentProcessId: 1, Start: '6' }];
  assert.deepEqual(liveIn(rows, [{ pid: 1, startTime: '5' }, { pid: 2, startTime: '7' }, { pid: 3, startTime: '8' }, { pid: 1, startTime: '' }]), [{ pid: 1, startTime: '5' }]);
});

for (const [name, script] of [
  ['a child that keeps running after its stdin closes', 'process.stdin.resume(); process.stdin.on("data", d => { if (String(d).includes("done")) console.log("turn-completed"); }); setInterval(() => {}, 1000);'],
  ['a child whose grandchild holds its pipes after it exits', 'process.stdin.resume(); process.stdin.on("data", d => { if (String(d).includes("done")) { require("child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "inherit" }); console.log("turn-completed"); setTimeout(() => process.exit(0), 200); } });'],
] as const) test(`close grace finishes ${name} as a clean exit`, async () => {
  const f = fixture();
  const saved = closeGrace.ms;
  closeGrace.ms = 500;
  try {
    const started = Date.now();
    const proc = startProcess({
      exe: process.execPath,
      args: ['-e', script],
      stdin: 'done\n',
      stdinPlan: () => (line: string) => (line === 'turn-completed' ? { close: true } : undefined),
      cwd: f.home,
      stdout: join(f.home, 'out'),
      stderr: join(f.home, 'err'),
      async onSpawn() {},
      onSnapshot() {},
      onLine() {},
    });
    const outcome = await proc.done;
    assert.equal(outcome.kind, 'exit');
    assert.equal(outcome.code, 0);
    assert.ok(Date.now() - started < 20_000, 'finishes well before any job timeout');
  } finally {
    closeGrace.ms = saved;
    f.cleanup();
  }
});
