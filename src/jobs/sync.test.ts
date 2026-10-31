import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const source =
  basename(resolve('.')) === 'antigravity-mcp-server'
    ? resolve('../codex-mcp-tool/src/jobs')
    : resolve('src/jobs');
const sibling = resolve(process.env.AGENT_JOBS_MIRROR ?? '../antigravity-mcp-server/src/jobs');
test(
  'sibling jobs module is byte-identical when installed',
  {
    skip:
      !existsSync(sibling) && !process.env.AGENT_JOBS_MIRROR
        ? 'Sibling jobs module has not been installed yet; run scripts/sync-jobs.sh when integrating that fork'
        : false,
  },
  () => {
    const names = readdirSync(source)
      .filter(name => name.endsWith('.ts'))
      .sort();
    assert.deepEqual(
      readdirSync(sibling)
        .filter(name => name.endsWith('.ts'))
        .sort(),
      names
    );
    for (const name of names)
      assert.deepEqual(
        readFileSync(join(sibling, name)),
        readFileSync(join(source, name)),
        `${name} differs; sync from the Codex fork`
      );
  }
);
