import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerJobTools, type JobTool } from './tools.js';
import { JobManager } from './manager.js';
import { fixture, fakeConnector } from './test-helpers.js';

test('portable registration exposes prefixed tools with bounded schemas and explicit full mode', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const tools: JobTool[] = [];
    registerJobTools(tools, 'codex', manager);
    assert.deepEqual(
      tools.map(tool => tool.name),
      [
        'codex_agent',
        'codex_agent_status',
        'codex_agent_result',
        'codex_agent_follow',
        'codex_agent_message',
        'codex_agent_answer',
        'codex_agent_stop',
        'codex_agent_list',
        'codex_agent_read',
        'codex_agent_retry',
        'codex_agent_collect',
      ]
    );
    assert.equal(tools[0].title, 'Codex agent');
    assert.match(tools[0].description, /^Launch a background Codex agent/);
    for (const tool of tools)
      assert.ok(JSON.stringify(zodToJsonSchema(tool.zodSchema)).includes('object'));
    for (const tool of tools.slice(1)) assert.equal(tool.title, `Codex agent: ${tool.name.slice('codex_agent_'.length)}`);
    const agy: JobTool[] = [];
    registerJobTools(agy, 'agy', manager);
    assert.deepEqual(agy.map(t => t.name), tools.map(t => t.name.replace('codex_', 'agy_')));
    assert.match(agy[0].description, /^Launch a background agy agent/);
    assert.ok(agy.every(t => !t.description.includes('codex_')));
    const start = tools[0];
    assert.equal(start.zodSchema.parse({ prompt: 'p', cwd: f.home }).mode, 'read');
    assert.equal(start.zodSchema.parse({ prompt: 'p', cwd: f.home, mode: 'full' }).mode, 'full');
    assert.throws(() => tools[2].zodSchema.parse({ jobId: 'a', waitSec: 11 }));
    const watch = tools.find(tool => tool.name === 'codex_agent_follow')!;
    assert.equal(watch.zodSchema.parse({ jobId: 'a' }).maxWaitSec, 1800);
    assert.throws(() => watch.zodSchema.parse({ jobId: 'a', maxWaitSec: 7201 }));
    const read = tools.find(tool => tool.name === 'codex_agent_read')!;
    assert.throws(() => read.zodSchema.parse({ jobId: 'a', name: 'stdout', limit: 20001 }));
    await assert.rejects(() => start.execute({ cwd: f.home }), /exactly one/);
    await assert.rejects(
      () => start.execute({ cwd: f.home, prompt: 'a', promptFile: 'b' }),
      /exactly one/
    );
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});

test('registered tools execute the manager and return JSON results', async () => {
  const f = fixture();
  const manager = new JobManager(fakeConnector(f.script), f.config);
  try {
    const tools: JobTool[] = [];
    registerJobTools(tools, 'codex', manager);
    const start = tools[0];
    const job = JSON.parse(await start.execute({ prompt: 'tool prompt', cwd: f.home }));
    const result = JSON.parse(await tools[2].execute({ jobId: job.jobId, waitSec: 10 }));
    assert.equal(result.final, 'tool prompt');
  } finally {
    await manager.dispose();
    f.cleanup();
  }
});
