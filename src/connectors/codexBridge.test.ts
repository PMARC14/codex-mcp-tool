import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, meta } from '../jobs/test-helpers.js';
import { codexBridge, BRIDGE_PREAMBLE } from './codexBridge.js';
import { CodexConnector } from './codex.js';
import { buildAppServer } from './codexAppServer.js';

test('bridge overrides are shell-free TOML argv for exec and nested per-thread settings for app-server', async () => {
  const f = fixture();
  try {
    const job = { ...meta(f.home), prompt: 'worker prompt' };
    const bridge = codexBridge(job);
    const overrides = Object.fromEntries(Array.from({ length: bridge.args.length / 2 }, (_, i) => {
      assert.equal(bridge.args[i * 2], '-c');
      const entry = bridge.args[i * 2 + 1];
      const split = entry.indexOf('=');
      return [entry.slice(0, split), JSON.parse(entry.slice(split + 1))];
    }));
    assert.equal(overrides['mcp_servers.agent_bridge.command'], process.execPath);
    assert.equal(overrides['mcp_servers.agent_bridge.env.AGENT_JOBS_HOME'], f.home);
    assert.equal(overrides['mcp_servers.agent_bridge.env.AGENT_JOB_ID'], job.id);
    assert.equal(overrides['mcp_servers.agent_bridge.tool_timeout_sec'], 86500);
    for (const tool of ['ask_orchestrator', 'report_progress'])
      assert.equal(overrides[`mcp_servers.agent_bridge.tools.${tool}.approval_mode`], 'approve');
    assert.match(overrides['mcp_servers.agent_bridge.args'][0], /[\\/]dist[\\/]bridge[\\/]agent-bridge\.js$/);
    assert.equal(bridge.prompt, `${BRIDGE_PREAMBLE}\n\nworker prompt`);
    const connector = new CodexConnector(undefined, () => ({ command: '/fake/codex', resolved: true, source: 'explicit-path', searchedPaths: [] }));
    const exec = connector.build(job);
    assert.deepEqual(exec.args.slice(0, bridge.args.length), bridge.args);
    assert.equal(exec.stdin, bridge.prompt);
    const writes: any[] = [];
    const app = buildAppServer(job, '/fake/codex');
    const handler = app.stdinPlan({ apply(action) { if (action.write) writes.push(JSON.parse(action.write)); }, emit() {} });
    try {
      handler(JSON.stringify({ id: 1, result: {} }), 'stdout');
      const start = writes.find(message => message.method === 'thread/start');
      assert.deepEqual(start.params.config.mcp_servers, bridge.config.mcp_servers);
      handler(JSON.stringify({ id: start.id, result: { thread: { id: 'thread' } } }), 'stdout');
      await new Promise<void>(resolve => setImmediate(resolve));
      const turn = writes.find(message => message.method === 'turn/start');
      assert.equal(turn.params.input[0].text, bridge.prompt);
      handler(JSON.stringify({ id: turn.id, result: { turn: { id: 'turn' } } }), 'stdout');
    } finally { handler.dispose!(); }
    const inactive = codexBridge(job, join(f.home, 'missing-bridge.js'));
    assert.deepEqual(inactive.args, []);
    assert.equal(inactive.prompt, 'worker prompt');
  } finally { f.cleanup(); }
});
