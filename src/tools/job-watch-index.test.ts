import { test } from 'node:test';
import assert from 'node:assert/strict';
import spawn from 'cross-spawn';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { fixture, until } from '../jobs/test-helpers.js';
import { JobStore } from '../jobs/store.js';

async function setup() {
  const f = fixture();
  const listenersPath = join(f.home, 'watch-listeners');
  // Load the actual entrypoint with its production registry and request handler. Only the
  // connector and generic keepalive interval are replaced; no real CLI is ever started.
  const bootstrap = `
    const { codexJobManager: manager, toolRegistry } = await import(${JSON.stringify(new URL('./index.js', import.meta.url).href)});
    const { fakeConnector } = await import(${JSON.stringify(new URL('../jobs/test-helpers.js', import.meta.url).href)});
    const { PROTOCOL } = await import(${JSON.stringify(new URL('../constants.js', import.meta.url).href)});
    const { writeFileSync } = await import('node:fs');
    const { z } = await import('zod');
    Object.assign(manager, { connector: fakeConnector(${JSON.stringify(f.script)}) });
    manager.config.wakeHold = false;
    PROTOCOL.KEEPALIVE_INTERVAL = 20;
    let listeners = 0;
    const record = () => writeFileSync(${JSON.stringify(listenersPath)}, String(listeners));
    record();
    const subscribe = manager.onTransition.bind(manager);
    manager.onTransition = listener => {
      listeners++; record();
      const off = subscribe(listener);
      let active = true;
      return () => { if (active) { listeners--; record(); } active = false; off(); };
    };
    toolRegistry.push({
      name: 'test_keepalive', description: 'Fake slow tool', zodSchema: z.object({}),
      execute: async (_args, onProgress) => {
        onProgress?.('fixture output');
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'pong';
      },
    });
    await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    env: { ...process.env, AGENT_JOBS_HOME: f.home, AGENT_JOBS_MAX: '1', AGENT_JOBS_CHANNEL: '0' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const buffer = new ReadBuffer();
  let stderr = '';
  child.stderr!.on('data', chunk => {
    stderr += String(chunk);
  });
  const transport: Transport = {
    start: () => started,
    send: async (message: JSONRPCMessage) => {
      await new Promise<void>((resolve, reject) => {
        child.stdin!.write(serializeMessage(message), error => (error ? reject(error) : resolve()));
      });
    },
    // Simulate losing the MCP pipe, without sending an OS termination signal to the server.
    close: async () => {
      child.stdin!.end();
      transport.onclose?.();
    },
  };
  child.stdout!.on('data', chunk => {
    buffer.append(chunk);
    let message: JSONRPCMessage | null;
    while ((message = buffer.readMessage()) !== null) transport.onmessage?.(message);
  });
  child.stdin!.on('error', error => transport.onerror?.(error));
  const exited = new Promise<void>(resolve =>
    child.once('close', () => {
      transport.onclose?.();
      resolve();
    })
  );
  const client = new Client({ name: 'entrypoint-test', version: '1' });
  const store = new JobStore(f.home);
  const cleanup = async () => {
    await client.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    f.cleanup();
  };
  try {
    await client.connect(transport);
  } catch (error) {
    await cleanup();
    throw new Error(`Entrypoint failed: ${String(error)}\n${stderr}`);
  }
  return {
    client,
    store,
    child,
    exited,
    cleanup,
    listeners: () => Number(readFileSync(listenersPath, 'utf8')),
    async startJob(waitMs = 1200) {
      const response = await client.callTool({
        name: 'codex_job_start',
        arguments: {
          prompt: JSON.stringify({ waitMs, final: 'survived' }),
          cwd: f.home,
        },
      });
      const content = response.content as { text: string }[];
      assert.equal(response.isError, false, content[0].text);
      const { jobId } = JSON.parse(content[0].text);
      await until(() => store.get(jobId).state === 'running' && !!store.get(jobId).sessionId);
      return jobId as string;
    },
  };
}

test('index dispatch sends watch state changes immediately and keeps other tools generic keepalives', async () => {
  const s = await setup();
  try {
    const jobId = await s.startJob();
    const progress: { progress: number; message?: string }[] = [];
    const pending = s.client.callTool(
      { name: 'codex_job_watch', arguments: { jobId } },
      undefined,
      {
        onprogress: event => progress.push(event),
      }
    );
    await until(() => progress.length > 0);
    assert.equal(s.store.get(jobId).state, 'running', 'progress arrives before the job stops');
    const response = await pending;
    assert.equal(response.isError, false);
    assert.match(progress.at(-1)!.message!, /^codex [^|]+ \| completed \| /);
    assert.ok(progress.every(event => /^codex [^|]+ \| (running|completed) \| /.test(event.message!)));
    assert.deepEqual(
      progress.map(event => event.progress),
      progress.map((_, i) => i)
    );
    assert.equal(s.listeners(), 0);
    const generic: string[] = [];
    await s.client.callTool({ name: 'test_keepalive', arguments: {} }, undefined, {
      onprogress: event => generic.push(event.message ?? ''),
    });
    assert.equal(generic[0], 'Starting test_keepalive');
    assert.ok(generic.some(message => message.includes('fixture output')));
    assert.equal(generic.at(-1), 'test_keepalive completed successfully');
  } finally {
    await s.cleanup();
  }
});

test('index dispatch forwards request cancellation and sends no watch progress without a token', async () => {
  const s = await setup();
  const controller = new AbortController();
  try {
    const jobId = await s.startJob();
    const pending = s.client.callTool(
      { name: 'codex_job_watch', arguments: { jobId } },
      undefined,
      {
        signal: controller.signal,
        onprogress: () => {},
      }
    );
    const rejected = assert.rejects(pending);
    await until(() => s.listeners() === 1);
    controller.abort();
    await rejected;
    await until(() => s.listeners() === 0, 'cancelled watch listener removed');
    assert.equal(s.store.get(jobId).state, 'running');
    let notifications = 0;
    const onmessage = (s.client.transport as Transport).onmessage!;
    (s.client.transport as Transport).onmessage = (message, extra) => {
      if ('method' in message && message.method === 'notifications/progress') notifications++;
      onmessage(message, extra);
    };
    const response = await s.client.callTool({
      name: 'codex_job_watch',
      arguments: { jobId, maxWaitSec: 0.05 },
    });
    assert.equal(response.isError, false);
    assert.equal(notifications, 0);
    await until(() => s.store.get(jobId).state === 'completed');
  } finally {
    controller.abort();
    await s.cleanup();
  }
});

test('stdio EOF aborts the index watch while its real fake worker runs to completion', async () => {
  const s = await setup();
  try {
    const jobId = await s.startJob();
    const pending = s.client.callTool(
      { name: 'codex_job_watch', arguments: { jobId } },
      undefined,
      {
        onprogress: () => {},
      }
    );
    const rejected = assert.rejects(pending);
    await until(() => s.listeners() === 1);
    await s.client.close();
    await rejected;
    await until(() => s.listeners() === 0, 'EOF removes the watch listener');
    assert.equal(s.store.get(jobId).state, 'running');
    await until(
      () => s.store.get(jobId).state === 'completed',
      'worker completes after disconnect'
    );
    assert.equal(s.store.read(jobId, 'final'), 'survived');
    await s.exited;
    assert.equal(s.child.exitCode, 0, 'server exits naturally once the job is saved');
  } finally {
    await s.cleanup();
  }
});
