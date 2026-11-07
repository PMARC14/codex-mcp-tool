import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fixture, until } from '../jobs/test-helpers.js';
import { createBridge } from './agent-bridge.js';
import { buildAppServer } from '../connectors/codexAppServer.js';
import type { JobSpec } from '../jobs/connector.js';

async function peer(home: string, id: string) {
  const server = createBridge(home, id);
  const client = new Client({ name: 'fake', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('bridge retries a busy mailbox unlink and replaces stale mailbox on next ask', async () => {
  const f = fixture(); const dir = join(f.home, 'jobs', 'mailbox'); mkdirSync(dir, { recursive: true });
  const p = await peer(f.home, 'mailbox');
  const original = fs.unlinkSync; let failures = 0;
  try {
    fs.unlinkSync = ((path: fs.PathLike) => {
      if (String(path) === join(dir, 'question.json') && !failures++) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return original(path);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    await p.client.callTool({ name: 'ask_orchestrator', arguments: { question: 'first', timeoutSec: 0.1 } });
    await until(() => !existsSync(join(dir, 'question.json')), 'retry unlink', 1500);
    assert.ok(failures >= 2);
    writeFileSync(join(dir, 'question.json'), JSON.stringify({ id: 'stale', question: 'old', askedAt: 1 }));
    const ask = p.client.callTool({ name: 'ask_orchestrator', arguments: { question: 'second', timeoutSec: 0.2 } });
    await until(() => JSON.parse(readFileSync(join(dir, 'question.json'), 'utf8')).id !== 'stale', 'replace stale', 1500);
    await ask;
  } finally { fs.unlinkSync = original; syncBuiltinESMExports(); await p.close(); f.cleanup(); }
});

test('native and bridge question claims exclude another asker before mailbox publication', async () => {
  const f = fixture(); const dir = join(f.home, 'jobs', 'claims'); mkdirSync(dir, { recursive: true });
  const p = await peer(f.home, 'claims'); const writes: any[] = [];
  const job = { finalPath: join(dir, 'final.txt'), cwd: f.home, mode: 'write', prompt: 'fake' } as JobSpec;
  const handler = buildAppServer(job, 'fake', { config: {}, prompt: 'fake' } as any).stdinPlan({ apply(a) { if (a.write) writes.push(JSON.parse(a.write)); }, emit() {} });
  try {
    writeFileSync(join(dir, 'question.lock'), JSON.stringify({ owner: 'native', id: 'first', ts: Date.now(), timeoutMs: 10000 }));
    await assert.rejects(p.client.callTool({ name: 'ask_orchestrator', arguments: { question: 'bridge', timeoutSec: 0.1 } }), /already awaiting/i);
    handler(JSON.stringify({ id: 'native-second', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'a', question: 'native' }] } }), 'stdout');
    assert.match(writes.find(m => m.id === 'native-second')?.error?.message ?? '', /already awaiting/i);
    assert.equal(existsSync(join(dir, 'question.json')), false);
  } finally { handler.dispose?.(); await p.close(); f.cleanup(); }
});


test('live native and bridge questions exclude each other and expired claims can be replaced', async () => {
  const f = fixture(); const dir = join(f.home, 'jobs', 'both'); mkdirSync(dir, { recursive: true });
  const p = await peer(f.home, 'both'); const writes: any[] = [];
  const job = { finalPath: join(dir, 'final.txt'), cwd: f.home, mode: 'write', prompt: 'fake' } as JobSpec;
  const handler = buildAppServer(job, 'fake', { config: {}, prompt: 'fake' } as any).stdinPlan({ apply(a) { if (a.write) writes.push(JSON.parse(a.write)); }, emit() {} });
  const native = (id: string) => handler(JSON.stringify({ id, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'a', question: 'native' }] } }), 'stdout');
  try {
    writeFileSync(join(dir, 'question.lock'), JSON.stringify({ owner: 'old', id: 'old', ts: 1, timeoutMs: 1 }));
    native('first');
    assert.notEqual(JSON.parse(readFileSync(join(dir, 'question.lock'), 'utf8')).id, 'old');
    await assert.rejects(p.client.callTool({ name: 'ask_orchestrator', arguments: { question: 'bridge', timeoutSec: 1 } }), /already awaiting/i);
    handler(JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: 'first' } }), 'stdout');
    // Dispose clears a native request even when the fake server has no initialized thread.
    handler.dispose?.();
    const ask = p.client.callTool({ name: 'ask_orchestrator', arguments: { question: 'bridge', timeoutSec: 3600 } });
    await until(() => existsSync(join(dir, 'question.json')), 'bridge question', 1500);
    const second = buildAppServer(job, 'fake', { config: {}, prompt: 'fake' } as any).stdinPlan({ apply(a) { if (a.write) writes.push(JSON.parse(a.write)); }, emit() {} });
    try {
      second(JSON.stringify({ id: 'second', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'a', question: 'native' }] } }), 'stdout');
      assert.match(writes.find(m => m.id === 'second')?.error?.message ?? '', /already awaiting/i);
    } finally { second.dispose?.(); }
    const qid = JSON.parse(readFileSync(join(dir, 'question.json'), 'utf8')).id;
    writeFileSync(join(dir, `answer-${qid}.json`), JSON.stringify({ answer: 'release claim' }));
    const reply: any = await ask;
    assert.equal(reply.content[0].type === 'text' && reply.content[0].text, 'release claim');
    assert.equal(existsSync(join(dir, 'question.lock')), false);
  } finally { handler.dispose?.(); await p.close(); f.cleanup(); }
});
