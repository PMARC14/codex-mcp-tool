import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fixture, fakeConnector, meta, until } from '../jobs/test-helpers.js';
import { JobManager } from '../jobs/manager.js';
import { registerJobTools } from '../jobs/tools.js';
import { toolRegistry } from './registry.js';
import { executeJobWatch } from './job-watch-progress.js';
import type { ToolArguments } from '../constants.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function setup() {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  await manager.initialize();
  registerJobTools(toolRegistry, 'test', manager, { watchHeartbeatMs: 10 });
  const job = meta(f.home, { state: 'running' });
  manager.store.create(job, 'p');
  const server = new Server({ name: 'watch-test', version: '1' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'watch-test-client', version: '1' });
  let ended = false;
  let signal: AbortSignal | undefined;
  let listeners = 0;
  let notifications = 0;
  const subscribe = manager.onTransition.bind(manager);
  manager.onTransition = listener => {
    listeners++;
    const off = subscribe(listener);
    let active = true;
    return () => {
      if (active) listeners--;
      active = false;
      off();
    };
  };
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    signal = extra.signal;
    try {
      const result = await executeJobWatch(
        request.params.name,
        (request.params.arguments ?? {}) as ToolArguments,
        {
          progressToken: request.params._meta?.progressToken,
          signal: extra.signal,
          notify: async params => {
            notifications++;
            await extra.sendNotification({ method: 'notifications/progress', params });
          },
        }
      );
      return { content: [{ type: 'text', text: String(result) }] };
    } finally {
      ended = true;
    }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    manager,
    job,
    client,
    get signal() {
      return signal;
    },
    get ended() {
      return ended;
    },
    get listeners() {
      return listeners;
    },
    get notifications() {
      return notifications;
    },
    async cleanup() {
      await client.close();
      await server.close();
      await manager.dispose();
      toolRegistry.splice(0);
      f.cleanup();
    },
  };
}

test('MCP watch progress is immediate, monotonic, bounded and stops when the call settles', async () => {
  const s = await setup();
  try {
    const progress: { progress: number; message?: string }[] = [];
    const pending = s.client.callTool(
      { name: 'test_job_watch', arguments: { jobId: s.job.id } },
      undefined,
      {
        onprogress: params => progress.push(params),
      }
    );
    await until(() => progress.length >= 2, 'initial progress and heartbeat');
    s.manager.store.write({ ...s.job, state: 'completed' });
    const response = await pending;
    assert.equal(response.isError, undefined);
    assert.match(progress.at(-1)!.message!, /^codex [^|]+ \| completed \| /);
    assert.ok(progress.every(item => item.message!.length <= 120));
    assert.deepEqual(
      progress.map(item => item.progress),
      progress.map((_, i) => i)
    );
    const count = s.notifications;
    await delay(40);
    assert.equal(s.notifications, count);
    assert.equal(s.listeners, 0);
  } finally {
    await s.cleanup();
  }
});

test('MCP watch with no progress token sends no notifications', async () => {
  const s = await setup();
  try {
    const result = await s.client.callTool({
      name: 'test_job_watch',
      arguments: { jobId: s.job.id, maxWaitSec: 0.04 },
    });
    const content = result.content as { type: string; text: string }[];
    assert.equal(JSON.parse(content[0].text).timedOut, true);
    assert.equal(s.notifications, 0);
  } finally {
    await s.cleanup();
  }
});

for (const action of ['cancel', 'disconnect'] as const) {
  test(`MCP ${action} aborts watch and releases its listener without stopping the job`, async () => {
    const s = await setup();
    const controller = new AbortController();
    try {
      const pending = s.client.callTool(
        { name: 'test_job_watch', arguments: { jobId: s.job.id } },
        undefined,
        {
          signal: controller.signal,
          onprogress: () => {},
        }
      );
      const rejected = assert.rejects(pending);
      await until(() => s.listeners === 1);
      if (action === 'cancel') controller.abort();
      else await s.client.close();
      await rejected;
      await until(() => s.ended, 'server watch cleaned up');
      assert.equal(s.signal!.aborted, true);
      assert.equal(s.listeners, 0);
      assert.equal(s.manager.store.get(s.job.id).state, 'running');
      const count = s.notifications;
      await delay(40);
      assert.equal(s.notifications, count);
    } finally {
      controller.abort();
      await s.cleanup();
    }
  });
}
