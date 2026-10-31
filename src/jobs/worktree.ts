import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runCommand } from './proc.js';
import { atomicWrite } from './store.js';
import type { Worktree } from './connector.js';

export function sanitizeLabel(label = 'job'): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'job'
  );
}

export async function createWorktree(
  cwd: string,
  label: string | undefined,
  id: string,
  connector: string
): Promise<Worktree> {
  const git = (...args: string[]) => runCommand('git', args, cwd);
  const root = await git('rev-parse', '--show-toplevel');
  const baseSha = await git('rev-parse', 'HEAD');
  const dirty = await git('status', '--porcelain');
  const name = `${sanitizeLabel(label)}-${id}`;
  const branch = `${sanitizeLabel(connector)}/${name}`;
  const commonDir = resolve(cwd, await git('rev-parse', '--git-common-dir'));
  let path = join(`${root}.worktrees`, name);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    path = join(commonDir, 'agent-jobs-worktrees', name);
    mkdirSync(dirname(path), { recursive: true });
  }
  try {
    await runCommand('git', ['worktree', 'add', path, '-b', branch, baseSha], root);
  } catch (error) {
    // Only filesystem/access failures should use the alternate location.
    if (
      !/permission|access.*denied|(?:cannot|could not|unable to).*(?:creat|mkdir)|read-only/i.test(
        String(error)
      )
    )
      throw error;
    path = join(commonDir, 'agent-jobs-worktrees', name);
    mkdirSync(dirname(path), { recursive: true });
    const existing = await runCommand(
      'git',
      ['rev-parse', '--verify', `refs/heads/${branch}`],
      root
    ).catch(() => undefined);
    if (existing && existing !== baseSha) throw error;
    await runCommand(
      'git',
      existing
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', path, '-b', branch, baseSha],
      root
    );
  }
  const gitDir = await runCommand('git', ['rev-parse', '--absolute-git-dir'], path);
  return {
    root,
    path,
    gitDir,
    branch,
    baseSha,
    warning: dirty
      ? 'The main checkout has uncommitted changes; they are not included in this worktree.'
      : undefined,
  };
}

export async function collectWorktree(
  worktree: Worktree,
  patchPath: string,
  remove: 'none' | 'worktree' | 'worktree+branch'
) {
  if (worktree.removed) throw new Error(`Worktree already removed; saved patch: ${patchPath}`);
  await runCommand('git', ['add', '-A'], worktree.path);
  const patch = await runCommand(
    'git',
    ['diff', '--binary', '--cached', worktree.baseSha],
    worktree.path
  );
  atomicWrite(patchPath, patch ? `${patch}\n` : '');
  const stat = await runCommand(
    'git',
    ['diff', '--stat', '--cached', worktree.baseSha],
    worktree.path
  );
  let removalError: string | undefined;
  if (remove !== 'none') {
    try {
      await runCommand('git', ['worktree', 'remove', '--force', worktree.path], worktree.root);
      worktree.removed = true;
      if (remove === 'worktree+branch')
        await runCommand('git', ['branch', '-D', worktree.branch], worktree.root);
    } catch (error) {
      removalError = String(error);
    }
  }
  return {
    stat: stat.slice(0, 20000),
    patch: patch.slice(0, 20000),
    truncated: patch.length > 20000,
    patchPath,
    removed: worktree.removed ?? false,
    removalError,
  };
}
