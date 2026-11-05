import { test } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './test-helpers.js';
import { fakeChild } from './review-fakes.js';
import { collectWorktree, createWorktree } from './worktree.js';
import type { Worktree } from './connector.js';

function setup(t: any, respond: (args: string[], cwd: string) => { out?: string; error?: string }) {
  const f = fixture();
  const path = join(f.home, 'worktree');
  mkdirSync(path);
  const worktree: Worktree = { path, root: f.home, gitDir: join(f.home, 'git'), baseSha: 'base', branch: 'fake' };
  const calls: string[][] = [];
  t.mock.method(cp, 'spawn', (_exe: string, args: string[], options: any) => {
    const child = fakeChild();
    calls.push(args);
    queueMicrotask(() => {
      try {
        const result = respond(args, options.cwd);
        if (result.out) child.stdout.emit('data', Buffer.from(result.out));
        if (result.error) child.stderr.emit('data', Buffer.from(result.error));
        child.close(result.error ? 128 : 0);
      } catch (error) { child.emit('error', error); child.close(128); }
    });
    return child;
  });
  return { ...f, worktree, calls, patch: join(f.home, 'patch.diff') };
}

test('all worktree Git calls disable fsmonitor and both diffs disable external drivers', async t => {
  const f = setup(t, args => {
    if (args.includes('worktree') && args.includes('add')) mkdirSync(args[args.indexOf('add') + 1], { recursive: true });
    return { out: args.includes('--get-regexp') ? '' : args.includes('--show-toplevel') ? join(f.home, 'repo') : args.includes('diff') ? 'safe patch\n' : 'base' };
  });
  try {
    mkdirSync(join(f.home, 'repo'));
    await createWorktree(f.home, 'fake', 'id', 'codex', f.home);
    await collectWorktree(f.worktree, f.patch, 'none', f.home);
    // Discovery must carry the same guard, before any config-dependent command runs.
    assert.ok(f.calls.length >= 4);
    assert.ok(f.calls.every(args => args.includes('core.fsmonitor=false')));
    for (const args of f.calls.filter(args => args.includes('diff'))) {
      assert.ok(args.includes('--no-ext-diff'));
      assert.ok(args.includes('--no-textconv'));
    }
  } finally { f.cleanup(); }
});

test('removal also unlinks dangling directory links', async t => {
  const f = setup(t, () => ({}));
  const link = join(f.worktree.path, 'missing-deps');
  symlinkSync(join(f.home, 'missing-target'), link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    await collectWorktree(f.worktree, f.patch, 'worktree', f.home);
    assert.throws(() => lstatSync(link), { code: 'ENOENT' });
  } finally { rmSync(link, { recursive: false, force: true }); f.cleanup(); }
});

test('filter names containing equals are refused before staging or checkout', async t => {
  const f = setup(t, args => ({ out: args.includes('--get-regexp') ? 'filter.a=b.clean\nunsafe\0' : '' }));
  try {
    await assert.rejects(collectWorktree(f.worktree, f.patch, 'none', f.home), /filter.*=.*unsafe|unsafe.*filter.*=/i);
    await assert.rejects(createWorktree(f.home, 'fake', 'id', 'codex', f.home), /filter.*=.*unsafe|unsafe.*filter.*=/i);
    assert.ok(f.calls.every(args => args.includes('config')));
  } finally { f.cleanup(); }
});

test('failed removal retries preserve the original patch after partial deletion', async t => {
  let partial = false;
  const f = setup(t, args => {
    if (args.includes('remove')) { partial = true; return { error: 'locked file after partial removal' }; }
    return { out: args.includes('diff') ? (partial ? 'CORRUPTED deleted files\n' : 'GOOD worker changes\n') : '' };
  });
  try {
    const first = await collectWorktree(f.worktree, f.patch, 'worktree', f.home);
    assert.match(first.removalError!, /locked file/);
    const saved = readFileSync(f.patch);
    const restored = JSON.parse(JSON.stringify(f.worktree));
    const second = await collectWorktree(restored, f.patch, 'none', f.home);
    assert.deepEqual(readFileSync(f.patch), saved);
    assert.equal(second.patch, first.patch);
    assert.equal(second.stat, first.stat);
    assert.equal(f.calls.filter(args => args.includes('add')).length, 1);
  } finally { f.cleanup(); }
});

test('removal unlinks junctions without touching outside targets and retries with longpaths', async t => {
  let attempts = 0;
  let linksPresent = false;
  const f = setup(t, args => {
    if (args.includes('remove')) {
      attempts++;
      linksPresent ||= existsSync(join(f.worktree.path, 'node_modules'));
      if (!args.includes('core.longpaths=true')) return { error: 'Filename too long' };
    }
    return { out: args.includes('diff') ? 'saved patch\n' : '' };
  });
  const outside = join(f.home, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'untouched');
  symlinkSync(outside, join(f.worktree.path, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // A nested link also needs unlinking, without descending into either target.
  mkdirSync(join(f.worktree.path, 'nested'));
  symlinkSync(outside, join(f.worktree.path, 'nested', 'deps'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const result = await collectWorktree(f.worktree, f.patch, 'worktree', f.home);
    assert.equal(linksPresent, false, 'links are removed before Git removal');
    assert.equal(existsSync(join(f.worktree.path, 'nested', 'deps')), false);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'untouched');
    assert.equal(result.removalError, undefined);
    assert.equal(result.removed, true);
    assert.equal(attempts, 2);
  } finally {
    // Fixture cleanup is confined to its temporary root, including the outside target.
    rmSync(join(f.worktree.path, 'node_modules'), { force: true, recursive: false });
    rmSync(join(f.worktree.path, 'nested', 'deps'), { force: true, recursive: false });
    f.cleanup();
  }
});
