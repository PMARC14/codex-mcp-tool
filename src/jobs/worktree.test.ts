import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './test-helpers.js';
import { runCommand } from './proc.js';
import { createWorktree, collectWorktree, sanitizeLabel } from './worktree.js';

test('worktree labels are safe, bounded and never empty', () => {
  assert.equal(sanitizeLabel('../../Feature / Hello_WORLD!'), 'feature-hello-world');
  assert.equal(sanitizeLabel('!@#$'), 'job');
  assert.equal(sanitizeLabel('A'.repeat(100)).length, 40);
  assert.match(sanitizeLabel('CON & $(echo) \\ foo'), /^[a-z0-9-]+$/);
});

async function repo(home: string) {
  const root = join(home, 'repo');
  mkdirSync(root);
  const git = (...args: string[]) => runCommand('git', args, root);
  await git('init');
  await git('config', 'user.email', 'agent-jobs-test@example.invalid');
  await git('config', 'user.name', 'Agent jobs tests');
  await git('config', 'core.autocrlf', 'false');
  await git('config', 'core.hooksPath', join(home, 'no-hooks'));
  await git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  await git('add', '-A');
  await git('commit', '-m', 'base');
  return { root, git };
}

test('create and collect preserve new files, binary files and worker commits before removal', async () => {
  const f = fixture();
  try {
    const { root, git } = await repo(f.home);
    writeFileSync(join(root, 'dirty.txt'), 'not part of worktree');
    const worktree = await createWorktree(root, 'Feature / New Thing', 'test-id', 'codex');
    assert.match(worktree.warning!, /uncommitted/);
    assert.equal(existsSync(join(worktree.path, 'dirty.txt')), false);
    assert.ok(existsSync(worktree.gitDir));
    writeFileSync(join(worktree.path, 'tracked.txt'), 'worker committed this\n');
    await runCommand('git', ['add', '-A'], worktree.path);
    await runCommand('git', ['commit', '-m', 'worker commit'], worktree.path);
    writeFileSync(join(worktree.path, 'new.txt'), 'untracked new content\n');
    const binary = Buffer.from([0, 255, 0, 128, 40, 50, 60]);
    writeFileSync(join(worktree.path, 'new.bin'), binary);
    const patchPath = join(f.home, 'patch.diff');
    const result = await collectWorktree(worktree, patchPath, 'worktree+branch');
    const patch = readFileSync(patchPath, 'utf8');
    assert.match(patch, /untracked new content/);
    assert.match(patch, /worker committed this/);
    assert.match(patch, /GIT binary patch/);
    assert.match(result.stat, /new.bin/);
    assert.equal(result.removalError, undefined);
    assert.equal(result.removed, true);
    assert.equal(existsSync(worktree.path), false);
    assert.equal((await git('branch', '--list', worktree.branch)).trim(), '');
    await git('apply', '--binary', patchPath);
    assert.deepEqual(readFileSync(join(root, 'new.bin')), binary);
    assert.equal(readFileSync(join(root, 'new.txt'), 'utf8'), 'untracked new content\n');
  } finally {
    f.cleanup();
  }
});

test('worktree creation falls back inside the git dir when the sibling directory cannot be created', async () => {
  const f = fixture();
  try {
    const { root } = await repo(f.home);
    writeFileSync(`${root}.worktrees`, 'blocks mkdir');
    const worktree = await createWorktree(root, undefined, 'fallback-id', 'codex');
    assert.ok(worktree.path.includes('agent-jobs-worktrees'));
    const result = await collectWorktree(worktree, join(f.home, 'patch.diff'), 'worktree+branch');
    assert.equal(result.removalError, undefined);
  } finally {
    f.cleanup();
  }
});

test('a failed patch save leaves the worktree intact', async () => {
  const f = fixture();
  try {
    const { root } = await repo(f.home);
    const worktree = await createWorktree(root, 'safe', 'save-failure', 'codex');
    writeFileSync(join(worktree.path, 'new.txt'), 'keep this');
    await assert.rejects(() =>
      collectWorktree(worktree, join(f.home, 'absent', 'patch.diff'), 'worktree+branch')
    );
    assert.equal(existsSync(worktree.path), true);
    await collectWorktree(worktree, join(f.home, 'patch.diff'), 'worktree+branch');
  } finally {
    f.cleanup();
  }
});

test('collection reports branch removal failure while preserving the saved patch', async () => {
  const f = fixture();
  try {
    const { root } = await repo(f.home);
    const worktree = await createWorktree(root, 'remove-error', 'remove-failure', 'codex');
    writeFileSync(join(worktree.path, 'new.txt'), 'saved before removal');
    worktree.branch = 'branch-that-does-not-exist';
    const patchPath = join(f.home, 'patch.diff');
    const result = await collectWorktree(worktree, patchPath, 'worktree+branch');
    assert.match(result.removalError!, /branch-that-does-not-exist/);
    assert.match(readFileSync(patchPath, 'utf8'), /saved before removal/);
  } finally {
    f.cleanup();
  }
});
