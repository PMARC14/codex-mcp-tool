import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { safeSpawn } from './proc.js';
import { readConfig } from './config.js';
import { atomicWrite } from './store.js';
import type { Worktree } from './connector.js';

// One configuration snapshot per operation; even discovery runs with hooks and LFS disabled.
async function gitGroup(cwd: string, home: string) {
  const hooks = join(home, 'empty-hooks');
  mkdirSync(hooks, { recursive: true });
  const base = ['-c', `core.hooksPath=${hooks}`];
  const run = (dir: string, args: string[], allowMissing = false): Promise<Buffer> =>
    new Promise((resolveResult, reject) => {
      const child = safeSpawn('git', args, { cwd: dir, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [], err: Buffer[] = [];
      const timer = setTimeout(() => { child.kill(); reject(new Error('git timed out')); }, 30000);
      child.stdout?.on('data', (data: Buffer) => out.push(data));
      child.stderr?.on('data', (data: Buffer) => err.push(data));
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0 || (allowMissing && code === 1)) resolveResult(Buffer.concat(out));
        else reject(new Error(`git exited ${code}: ${Buffer.concat(err).toString('utf8') || Buffer.concat(out).toString('utf8')}`));
      });
    });
  const config = (await run(cwd, [...base, 'config', '--null', '--get-regexp', '^filter\\.'], true)).toString('utf8');
  const names = new Set<string>();
  for (const entry of config.split('\0')) {
    const key = entry.split('\n', 1)[0];
    const match = /^filter\.(.+)\.[^.]+$/i.exec(key);
    if (match) names.add(match[1]);
  }
  const overrides = [...base];
  for (const name of names) for (const [key, value] of [['smudge', ''], ['clean', ''], ['process', ''], ['required', 'false']])
    overrides.push('-c', `filter.${name}.${key}=${value}`);
  return {
    buffer: (dir: string, ...args: string[]) => run(dir, [...overrides, ...args]),
    text: async (dir: string, ...args: string[]) => (await run(dir, [...overrides, ...args])).toString('utf8').trimEnd(),
  };
}

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
  connector: string,
  home = readConfig().home
): Promise<Worktree> {
  const group = await gitGroup(cwd, home);
  const git = (...args: string[]) => group.text(cwd, ...args);
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
    await group.text(root, 'worktree', 'add', path, '-b', branch, baseSha);
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
    const existing = await group.text(root, 'rev-parse', '--verify', `refs/heads/${branch}`).catch(() => undefined);
    if (existing && existing !== baseSha) throw error;
    await group.text(root, ...(existing
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', path, '-b', branch, baseSha]));
  }
  const gitDir = await group.text(path, 'rev-parse', '--absolute-git-dir');
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
  remove: 'none' | 'worktree' | 'worktree+branch',
  home = readConfig().home
) {
  if (worktree.removed) throw new Error(`Worktree already removed; saved patch: ${patchPath}`);
  const group = await gitGroup(worktree.path, home);
  await group.text(worktree.path, 'add', '-A');
  // The patch is saved as git's raw bytes: no trimming and no text round trip, because the
  // worktree may be removed right after.
  const raw = await group.buffer(worktree.path, 'diff', '--binary', '--cached', worktree.baseSha);
  atomicWrite(patchPath, raw);
  const patch = raw.toString('utf8').trimEnd();
  const stat = await group.text(worktree.path, 'diff', '--stat', '--cached', worktree.baseSha);
  let removalError: string | undefined;
  if (remove !== 'none') {
    try {
      await group.text(worktree.root, 'worktree', 'remove', '--force', worktree.path);
      worktree.removed = true;
      if (remove === 'worktree+branch')
        await group.text(worktree.root, 'branch', '-D', worktree.branch);
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
