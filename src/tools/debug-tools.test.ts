import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSelftest } from './debug-tools.js';
import { TrafficLog, installRequestErrorReporting } from './traffic-log.js';
import { clientTaskGet, clientInputRequests, clientAgentTaskMeta, clientTaskBase } from './client-schemas.js';
import { readConfig } from '../jobs/config.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';

test('live selftest exercises the real adapter in-process without a CLI', async () => {
  const home = mkdtempSync(join(tmpdir(), 'task-selftest-log-'));
  try {
    const log = new TrafficLog('codex', home);
    const result = await runSelftest(log);
    assert.equal(result.pass, true, JSON.stringify(result.steps));
    assert.equal(result.steps.length, 12);
    assert.equal(result.logPath, log.path);
    const entries = log.tail(200).map(line => JSON.parse(line));
    assert.ok(entries.some(entry => entry.dir === 'in' && entry.method === 'tasks/get'));
    assert.ok(entries.some(entry => entry.dir === 'out' && entry.id));
    assert.ok(!readFileSync(log.path, 'utf8').includes('fake selftest result'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the old terminal envelope fails the exact client discriminator (invalid_union regression)', () => {
  const old = { resultType: 'complete', content: [{ type: 'text', text: 'result' }], isError: false };
  assert.equal(clientTaskGet.safeParse(old).success, false);
  for (const status of ['working', 'input_required', 'completed', 'failed', 'cancelled']) {
    assert.ok(clientTaskGet.safeParse({ taskId: 'job-1', status }).success);
  }
  assert.equal(clientTaskBase.safeParse({ taskId: 'a b', status: 'working' }).success, false);
  assert.equal(clientTaskBase.safeParse({ taskId: 'x'.repeat(129), status: 'working' }).success, false);
  assert.equal(clientAgentTaskMeta.safeParse({ kind: 'codex agent' }).success, false);
  assert.equal(clientAgentTaskMeta.safeParse({ modelImmediateResponse: 'x'.repeat(20001) }).success, false);
  assert.ok(clientInputRequests.safeParse({ q: { method: 'elicitation/create', params: { message: 'question' } } }).success);
});

test('traffic summaries redact content at both levels, bound arguments and bytes, and rotate three files', () => {
  const home = mkdtempSync(join(tmpdir(), 'task-traffic-'));
  try {
    for (const full of [false, true]) {
      const log = new TrafficLog(full ? 'full' : 'summary', home, 6000, full);
      for (let i = 0; i < 30; i++) {
        log.message('in', { id: i, method: 'tools/call', params: { name: 'codex_job_start',
          arguments: { prompt: 'secret prompt', nested: { message: 'secret message' }, label: 'x'.repeat(1000) } } });
        log.message('out', { id: i, result: { status: 'completed', content: [{ text: 'secret output' }], result: { reasoning: 'secret reasoning' }, tools: Array.from({ length: 1000 }, () => ({ name: 'test' })) } });
      }
      const lines = log.tail(200);
      assert.ok(lines.length);
      for (const line of lines) {
        assert.doesNotMatch(line, /secret (prompt|message|output|reasoning)/);
        const entry = JSON.parse(line);
        assert.ok(Buffer.byteLength(entry.summary) <= (full ? 16384 : 2048));
        if (entry.method === 'tools/call') assert.ok(JSON.parse(entry.summary).arguments.length <= 200);
      }
      assert.equal(readdirSync(join(home, 'logs')).filter(name => name.startsWith(full ? 'full-' : 'summary-')).length, 3);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('handler errors retain a structured code, failing step, field, and logged stack', async () => {
  const home = mkdtempSync(join(tmpdir(), 'task-handler-'));
  try {
    let handler: any;
    const server = { setRequestHandler(_schema: unknown, value: unknown) { handler = value; } } as unknown as Server;
    const log = new TrafficLog('codex', home);
    installRequestErrorReporting(server, log);
    server.setRequestHandler(z.object({ method: z.literal('tasks/get') }), async () => { throw new Error('taskId lookup failed'); });
    await assert.rejects(handler({ method: 'tasks/get' }, {}), (error: any) =>
      error.code === -32603 && error.message.includes('tasks/get handler: taskId lookup failed') && error.data.step === 'tasks/get');
    assert.match(log.tail(1)[0], /stack/);
    assert.match(log.tail(1)[0], /taskId lookup failed/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex transport defaults: exec fallback, config, environment override and invalid values', () => {
  const home = mkdtempSync(join(tmpdir(), 'task-config-'));
  try {
    assert.equal(readConfig({ AGENT_JOBS_HOME: home }).connectors.codex?.defaultTransport ?? 'exec', 'exec');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ connectors: { codex: { defaultTransport: 'app-server' } } }));
    assert.equal(readConfig({ AGENT_JOBS_HOME: home }).connectors.codex.defaultTransport, 'app-server');
    assert.equal(readConfig({ AGENT_JOBS_HOME: home, AGENT_JOBS_CODEX_TRANSPORT: 'exec' }).connectors.codex.defaultTransport, 'exec');
    assert.throws(() => readConfig({ AGENT_JOBS_HOME: home, AGENT_JOBS_CODEX_TRANSPORT: 'bad' }), /defaultTransport/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
