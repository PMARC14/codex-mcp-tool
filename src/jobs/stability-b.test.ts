import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, fakeConnector, meta, until } from './test-helpers.js';
import { JobManager } from './manager.js';
import { spawnStats } from './spawn-stats.js';
import { finalSpawnOptions, spawnOptions } from './proc.js';
import { COMPILER_SPAWN_OPTIONS, CREATE_NO_WINDOW, CREATE_SUSPENDED, JOB_WRAPPER_SOURCE, LAUNCHER_CREATE_FLAGS } from './jobobject.js';
import { getUsage, POWER_TTL_MS } from './usage-cache.js';
import { TrafficLog, describeError, redactPaths } from '../tools/traffic-log.js';
import { registerStandaloneTools, legacyTools } from '../tools/index.js';
import type { UnifiedTool } from '../tools/registry.js';
type ToolRegistry = UnifiedTool[];

// ---- Argon #3: idle servers spawn nothing ----
test('30 seconds of idle pump ticks call detect() and spawn zero times', async () => {
  const f = fixture();
  let detects = 0;
  const base = fakeConnector(f.script);
  // Fake timers: capture the pump's interval callbacks and fire them by hand (60 x 500 ms = 30 s).
  const ticks: Array<() => void> = [];
  mock.method(globalThis, 'setInterval', ((fn: () => void) => { ticks.push(fn); return { unref() {}, ref() {} }; }) as unknown as typeof setInterval);
  const manager = new JobManager({ ...base, async detect() { detects++; return base.detect(); } }, f.config);
  try {
    await manager.initialize(); // the owner lookup may spawn once; the baseline is taken after it
    const spawnsBefore = spawnStats.count;
    detects = 0;
    for (let i = 0; i < 60; i++) { // 60 ticks of 500 ms
      for (const tick of ticks) tick();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.ok(ticks.length > 0, 'the pump registered its interval');
    assert.equal(detects, 0, 'detect() must not run while there are no jobs');
    assert.equal(spawnStats.count, spawnsBefore, 'no process may be spawned while idle');
  } finally { await manager.dispose(); mock.restoreAll(); f.cleanup(); }
});

test('detect() is asked only when a job is about to start', async () => {
  const f = fixture();
  let detects = 0;
  const base = fakeConnector(f.script);
  const manager = new JobManager({ ...base, async detect() { detects++; return base.detect(); } }, f.config);
  try {
    await manager.initialize();
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(detects, 0);
    const { jobId } = await manager.start({ cwd: f.home, prompt: '{}' });
    await until(() => manager.store.get(jobId).state === 'completed');
    assert.ok(detects >= 1);
  } finally { await manager.dispose(); f.cleanup(); }
});

test('power status is read at most every ten minutes', async () => {
  const f = fixture(); let time = 1_000_000, reads = 0;
  const opts = { home: f.home, now: () => time, ttlMs: 2 * 60_000, batteryTtlMs: 30 * 60_000, onBattery: () => { reads++; return false; } };
  const probe = async () => ({ ok: true, raw: 1, parsed: 1 });
  try {
    assert.ok(POWER_TTL_MS >= 10 * 60_000);
    await getUsage('p', probe, opts);
    time += 3 * 60_000; await getUsage('p', probe, opts); // a TTL decision: power is read once
    assert.equal(reads, 1);
    time += 3 * 60_000; await getUsage('p', probe, opts); // another TTL decision, but the reading is only 3 minutes old
    assert.equal(reads, 1, 'power state is cached for ten minutes');
  } finally { f.cleanup(); }
});

// ---- Never open a console window ----
test('spawn options never detach on Windows and always hide the window', () => {
  assert.equal(spawnOptions('win32').detached, undefined);
  for (const options of [{}, { detached: true }, { windowsHide: false, shell: true }, { stdio: 'pipe' as const }]) {
    const win = finalSpawnOptions(options, 'win32');
    assert.equal(win.windowsHide, true);
    assert.equal(win.shell, false);
    assert.equal('detached' in win, false);
    const posix = finalSpawnOptions(options, 'linux');
    assert.equal(posix.windowsHide, true);
  }
  assert.equal(COMPILER_SPAWN_OPTIONS.windowsHide, true);
});

test('every child process in src goes through hidden-window spawn paths', () => {
  const root = fileURLToPath(new URL('../../src/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p); } };
  walk(root);
  const allowed = new Set(['proc.ts', 'jobobject.ts']);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const name = file.split(/[\\/]/).pop()!;
    const direct = /node:child_process|from 'cross-spawn'|\bexecSync\(|\bspawnSync\(|\bexecFile\(/.test(text.replace(/import type[^\n]*\n/g, ''));
    if (direct) assert.ok(allowed.has(name), `${name} starts processes outside the audited spawn paths`);
    if (name !== 'proc.ts') assert.doesNotMatch(text, /detached:\s*true/, `${name} must not detach`); // proc.ts detaches only off Windows
  }
  assert.match(readFileSync(join(root, 'jobs', 'proc.ts'), 'utf8'), /windowsHide: true/);
  assert.match(readFileSync(join(root, 'jobs', 'jobobject.ts'), 'utf8'), /windowsHide: true/);
});

test('the Job Object launcher creates processes suspended with no console window', () => {
  assert.equal(CREATE_SUSPENDED, 0x4);
  assert.equal(CREATE_NO_WINDOW, 0x08000000);
  assert.equal(LAUNCHER_CREATE_FLAGS, 0x08000004);
  const flagLiteral = `0x${LAUNCHER_CREATE_FLAGS.toString(16).padStart(8, '0')}`;
  assert.ok(JOB_WRAPPER_SOURCE.includes(`true, ${flagLiteral}, IntPtr.Zero`), 'CreateProcess must receive the flags constant');
});

// ---- Argon #1 / #11: follow keeps following an auto-retrying pause ----
test('follow keeps waiting through a pause that will retry, and returns for one that will not', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    await manager.initialize();
    manager.store.create(meta(f.home, { id: 'retrying', state: 'paused', resetAt: Date.now() + 3_600_000, owner: { pid: process.pid, startTime: 'x' } }), 'p');
    manager.store.create(meta(f.home, { id: 'stuck', state: 'paused', owner: { pid: process.pid, startTime: 'x' } }), 'p');
    const started = Date.now();
    const retrying = await manager.watch('retrying', 1, { heartbeatMs: 100 });
    assert.equal(retrying.timedOut, true);
    assert.ok(Date.now() - started >= 900, 'must not return at the pause');
    const stuck = await manager.watch('stuck', 5, { heartbeatMs: 100 });
    assert.equal(stuck.timedOut, false);
    assert.equal(stuck.state, 'paused');
  } finally { await manager.dispose(); f.cleanup(); }
});

// ---- Argon #8: traffic log redaction ----
test('error logs redact home paths, cap stacks at 2 KB and never include argument values', () => {
  const home = mkdtempSync(join(tmpdir(), 'traffic-redact-'));
  try {
    const log = new TrafficLog('codex', home);
    const error = new Error(`failed in ${homedir()}${'\\'}secret${'\\'}file.txt and C:/Users/someone/else/x`);
    error.stack = `Error: boom\n${('    at ' + homedir() + '/proj/file.js:1:1\n').repeat(500)}`;
    log.error('tools/call', error);
    const zod: any = Object.assign(new Error('Invalid input: received "TOP SECRET PROMPT"'), { issues: [{ path: ['prompt'], code: 'invalid_type' }] });
    log.error('tools/call', zod);
    const lines = log.tail(5);
    const text = lines.join('\n');
    assert.ok(!text.includes(homedir()), 'home directory must be redacted');
    assert.ok(!text.includes('someone'), 'other profile paths must be redacted');
    assert.ok(!text.includes('TOP SECRET'), 'argument values must not be logged');
    assert.match(text, /prompt:invalid_type/);
    const described = describeError(error);
    assert.ok(Buffer.byteLength(described.stack!) <= 2048 + 4);
    assert.equal(redactPaths(`${homedir()}/x`), '~/x');
    // A JSON-RPC error body is redacted too.
    log.message('out', { id: 1, error: { code: -1, message: `bad ${homedir()}/y` } });
    assert.ok(!log.tail(1).join('').includes(homedir()));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- Simplification 14: legacy tools hidden by default ----
test('legacy non-agent tools register only with CODEX_MCP_LEGACY_TOOLS=1', () => {
  const kept = ['health', 'codex_usage', 'codex_selftest', 'codex_debug_log'];
  const hidden: ToolRegistry = [];
  registerStandaloneTools(hidden, {});
  assert.deepEqual(hidden.map(tool => tool.name).sort(), [...kept].sort());
  const shown: ToolRegistry = [];
  registerStandaloneTools(shown, { CODEX_MCP_LEGACY_TOOLS: '1' });
  const names = shown.map(tool => tool.name);
  for (const name of [...kept, ...legacyTools.map(tool => tool.name)]) assert.ok(names.includes(name), name);
  for (const name of ['ask-codex', 'batch-codex', 'review-changes', 'do-act', 'brainstorm', 'fetch-chunk', 'timeout-test', 'image-gen', 'list-skills', 'list-sessions', 'help', 'ping', 'version'])
    assert.ok(names.includes(name) && !hidden.some(tool => tool.name === name), name);
});

// ---- Simplification 13: default transport ----
test('a job without an explicit transport uses the connector default, exec stays selectable', async () => {
  const f = fixture();
  const base = fakeConnector(f.script);
  const manager = new JobManager({ ...base, defaultTransport: 'app-server' }, f.config);
  try {
    await manager.initialize();
    const a = await manager.start({ cwd: f.home, prompt: '{}' });
    const b = await manager.start({ cwd: f.home, prompt: '{}', transport: 'exec' });
    assert.equal(manager.store.get(a.jobId).transport, 'app-server');
    assert.equal(manager.store.get(b.jobId).transport, 'exec');
  } finally { await manager.dispose(); f.cleanup(); }
});

// ---- Usage cadence (15 min AC / 30 min battery), anchored to job edges ----
import { usageIntervals } from './config.js';
import { runCommand } from './proc.js';

const MIN = 60_000;

test('usage intervals default to 15/30 minutes; config.json then env override them', () => {
  const f = fixture();
  try {
    const env = { AGENT_JOBS_HOME: f.home };
    assert.deepEqual(usageIntervals(env), { intervalMs: 15 * MIN, batteryIntervalMs: 30 * MIN });
    writeFileSync(join(f.home, 'config.json'), JSON.stringify({ usage: { intervalMin: 20, batteryIntervalMin: 45 } }));
    assert.deepEqual(usageIntervals(env), { intervalMs: 20 * MIN, batteryIntervalMs: 45 * MIN });
    assert.deepEqual(usageIntervals({ ...env, AGENT_JOBS_USAGE_INTERVAL_MIN: '5', AGENT_JOBS_USAGE_BATTERY_INTERVAL_MIN: '7' }), { intervalMs: 5 * MIN, batteryIntervalMs: 7 * MIN });
    assert.deepEqual(usageIntervals({ ...env, AGENT_JOBS_USAGE_INTERVAL_MIN: 'junk' }), { intervalMs: 20 * MIN, batteryIntervalMs: 45 * MIN });
  } finally { f.cleanup(); }
});

test('usage probes: job edges probe, 14 idle minutes do not, a reader at 16 minutes probes once, battery waits 30', async () => {
  const f = fixture(); let time = 10_000_000, probes = 0, battery = false;
  const probe = async () => { probes++; return { ok: true, raw: probes, parsed: probes }; };
  const opts = () => ({ home: f.home, now: () => time, onBattery: battery });
  try {
    await getUsage('c', probe, { ...opts(), force: true }); // job about to start
    assert.equal(probes, 1);
    time += 10_000; await getUsage('c', probe, { ...opts(), force: true }); // second job starting right after: covered
    assert.equal(probes, 1, 'at most one probe per connector per 60 s');
    time += 2 * MIN; await getUsage('c', probe, { ...opts(), force: true }); // job stopped
    assert.equal(probes, 2);
    time += 14 * MIN; await getUsage('c', probe, opts()); // idle readers
    assert.equal(probes, 2, 'no probe within the 15 minute interval, which the last refresh restarted');
    time += 2 * MIN; await getUsage('c', probe, opts()); // 16 minutes after the last refresh
    assert.equal(probes, 3);
    await getUsage('c', probe, opts());
    assert.equal(probes, 3, 'a single probe serves every later reader');
    battery = true;
    time += 20 * MIN; await getUsage('c', probe, opts());
    assert.equal(probes, 3, 'on battery 20 minutes is still fresh');
    time += 11 * MIN; await getUsage('c', probe, opts());
    assert.equal(probes, 4, 'on battery the interval is 30 minutes');
  } finally { f.cleanup(); }
});

test('usage intervals follow config and environment overrides in the cache', async () => {
  const f = fixture(); let time = 10_000_000, probes = 0;
  const probe = async () => { probes++; return { ok: true, raw: 1, parsed: 1 }; };
  const saved = process.env.AGENT_JOBS_HOME, savedInterval = process.env.AGENT_JOBS_USAGE_INTERVAL_MIN;
  try {
    process.env.AGENT_JOBS_HOME = f.home;
    process.env.AGENT_JOBS_USAGE_INTERVAL_MIN = '2';
    const opts = { now: () => time, onBattery: false };
    await getUsage('e', probe, opts);
    time += MIN; await getUsage('e', probe, opts); assert.equal(probes, 1);
    time += 2 * MIN; await getUsage('e', probe, opts); assert.equal(probes, 2);
  } finally {
    if (saved === undefined) delete process.env.AGENT_JOBS_HOME; else process.env.AGENT_JOBS_HOME = saved;
    if (savedInterval === undefined) delete process.env.AGENT_JOBS_USAGE_INTERVAL_MIN; else process.env.AGENT_JOBS_USAGE_INTERVAL_MIN = savedInterval;
    f.cleanup();
  }
});

test('a failed probe waits the longer of the interval and the backoff', async () => {
  const f = fixture(); let time = 10_000_000, probes = 0;
  const probe = async () => { probes++; return { ok: false, raw: 'down', parsed: null }; };
  const opts = { home: f.home, now: () => time, onBattery: false, ttlMs: 5 * MIN };
  try {
    await getUsage('b', probe, opts);
    time += 14 * MIN; await getUsage('b', probe, opts); assert.equal(probes, 1);
    time += 2 * MIN; await getUsage('b', probe, opts); assert.equal(probes, 2);
  } finally { f.cleanup(); }
});

test('the manager refreshes usage before dispatch and after a job stops, never while idle', async () => {
  const f = fixture(); const times: number[] = [];
  const manager = new JobManager({ ...fakeConnector(f.script), async refreshUsage() { times.push(Date.now()); } }, f.config);
  try {
    await manager.initialize();
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(times.length, 0, 'the idle pump never probes');
    const { jobId } = await manager.start({ cwd: f.home, prompt: '{}' });
    assert.ok(times.length >= 1, 'pre-dispatch refresh');
    await until(() => manager.store.get(jobId).state === 'completed');
    await until(() => times.some(t => t >= manager.store.get(jobId).finishedAt!), 'post-stop refresh', 3000);
  } finally { await manager.dispose(); f.cleanup(); }
});

test('short CLI checks go through the no-console launcher on Windows', async () => {
  if (process.platform !== 'win32') return;
  const before = spawnStats.viaLauncher;
  assert.equal(await runCommand(process.execPath, ['-e', 'console.log("ok")']), 'ok');
  assert.equal(spawnStats.viaLauncher, before + 1, 'runCommand must use the CREATE_NO_WINDOW launcher');
});
