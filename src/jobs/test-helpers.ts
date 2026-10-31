import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector, JobMeta, JobSpec } from './connector.js';
import { readConfig } from './config.js';

export function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-jobs-test-'));
  const script = join(home, 'fake-worker.cjs');
  writeFileSync(
    script,
    `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let opts;
  try { opts = JSON.parse(input); } catch { opts = { final: input }; }
  if (opts.log) fs.appendFileSync(opts.log, 'start\\n');
  console.log(JSON.stringify({type:'thread.started', thread_id:'fake-session'}));
  if (opts.stderr) process.stderr.write(opts.stderr);
  if (opts.limit) {
    let first = true;
    if (opts.once) { first = !fs.existsSync(opts.once); fs.writeFileSync(opts.once, '1'); }
    if (first) {
      console.log(JSON.stringify({type:'error', message:'You have hit your usage limit'}));
      process.exitCode = 1;
      return;
    }
  }
  setTimeout(() => {
    const text = opts.final || 'pong';
    if (opts.file) fs.writeFileSync(process.argv[2], text);
    else console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
    if (opts.log) fs.appendFileSync(opts.log, 'end\\n');
    process.exitCode = opts.code || 0;
  }, opts.waitMs || 10);
});
`
  );
  const config = readConfig({ AGENT_JOBS_HOME: home, AGENT_JOBS_MAX: '1' });
  config.wakeHold = false;
  return { home, script, config, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function fakeConnector(script: string, id = 'codex', resetAt?: number): Connector {
  return {
    id,
    async detect() {
      return { available: true, exe: process.execPath };
    },
    async models() {
      return ['fake'];
    },
    sandboxDirs() {
      return [];
    },
    build(job: JobSpec) {
      return { exe: process.execPath, args: [script, job.finalPath], stdin: job.prompt };
    },
    parse(line, stream) {
      if (stream !== 'stdout') return null;
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started') return { sessionId: event.thread_id };
        if (event.type === 'item.completed') return { final: event.item.text };
        if (event.type === 'error') return { error: event.message, usageLimit: { resetAt } };
      } catch {
        /* Fake workers only emit NDJSON. */
      }
      return null;
    },
  };
}

export function meta(home: string, overrides: Partial<JobMeta> = {}): JobMeta {
  const id = overrides.id ?? 'test-job';
  return {
    id,
    connector: 'codex',
    cwd: home,
    mode: 'read',
    timeoutMin: 120,
    finalPath: join(home, 'jobs', id, 'final.txt'),
    state: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

export async function until(
  predicate: () => boolean | Promise<boolean>,
  message = 'condition',
  timeoutMs = 30000
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolveResult => setTimeout(resolveResult, 50));
  }
}
