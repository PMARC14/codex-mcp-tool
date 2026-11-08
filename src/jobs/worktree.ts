import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { safeSpawn } from './proc.js';
import { readConfig } from './config.js';
import { atomicWrite } from './store.js';
import type { Worktree } from './connector.js';

// One configuration snapshot per operation; even discovery runs with hooks and LFS disabled.
async function gitGroup(cwd: string, home: string) {
  const hooks = join(home, 'empty-hooks');
  mkdirSync(hooks, { recursive: true });
  const base = ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false'];
  const run = (dir: string, args: string[], allowMissing = false): Promise<Buffer> =>
    new Promise((resolveResult, reject) => {
      const child = safeSpawn('git', args, { cwd: dir, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [], err: Buffer[] = [];
      const timer = setTimeout(() => { child.kill(); reject(new Error('git timed out')); }, 600000);
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
    if (match) {
      if (match[1].includes('=')) throw new Error(`Unsafe Git filter name containing '=': ${match[1]}; remove this filter configuration before worktree operations`);
      names.add(match[1]);
    }
  }
  const overrides = [...base];
  for (const name of names) for (const [key, value] of [['smudge', ''], ['clean', ''], ['process', ''], ['required', 'false']])
    overrides.push('-c', `filter.${name}.${key}=${value}`);
  return {
    buffer: (dir: string, ...args: string[]) => run(dir, [...overrides, ...args]),
    text: async (dir: string, ...args: string[]) => (await run(dir, [...overrides, ...args])).toString('utf8').trimEnd(),
  };
}

// Walk only ordinary directories. A junction/symlink is unlinked as a single entry;
// never recurse through it or delete its target (which may be outside the worktree).
function unlinkWorktreeLinks(path: string): void {
  let entry;
  try { entry = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink()) {
    rmSync(path, { recursive: false, force: true });
  } else if (entry.isDirectory()) {
    for (const name of readdirSync(path)) unlinkWorktreeLinks(join(path, name));
  }
}

async function removeWorktree(group: Awaited<ReturnType<typeof gitGroup>>, root: string, path: string) {
  unlinkWorktreeLinks(path);
  try {
    await group.text(root, 'worktree', 'remove', '--force', path);
  } catch {
    await group.text(root, '-c', 'core.longpaths=true', 'worktree', 'remove', '--force', path);
  }
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
  const branchExisted = !!(await group.text(root, 'rev-parse', '--verify', `refs/heads/${branch}`).catch(() => undefined));
  const cleanup = async (target: string) => {
    await removeWorktree(group, root, target).catch(() => undefined);
    if (!branchExisted) await group.text(root, 'branch', '-D', branch).catch(() => undefined);
    await group.text(root, 'worktree', 'prune').catch(() => undefined);
  };
  try {
    await group.text(root, 'worktree', 'add', path, '-b', branch, baseSha);
  } catch (error) {
    await cleanup(path);
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
    try {
      await group.text(root, ...(existing
          ? ['worktree', 'add', path, branch]
          : ['worktree', 'add', path, '-b', branch, baseSha]));
    } catch (fallbackError) { await cleanup(path); throw fallbackError; }
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
  const removalMarker = `${patchPath}.removal-attempted`;
  const previousRemoval = existsSync(removalMarker);
  let snapshot: Record<string, string> | undefined;
  let group: Awaited<ReturnType<typeof gitGroup>> | undefined;
  let raw: Buffer;
  let stat: string;
  if (previousRemoval) {
    // A failed Git removal may already have deleted tracked files, or even .git.
    // The durable marker also protects retries after a server restart.
    raw = readFileSync(patchPath);
    const marker = JSON.parse(readFileSync(removalMarker, 'utf8'));
    stat = marker.stat;
    snapshot = marker.snapshot;
  } else {
    group = await gitGroup(worktree.path, home);
    await group.text(worktree.path, 'add', '-A');
    raw = await group.buffer(worktree.path, 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--cached', worktree.baseSha);
    atomicWrite(patchPath, raw);
    stat = await group.text(worktree.path, 'diff', '--no-ext-diff', '--no-textconv', '--stat', '--cached', worktree.baseSha);
  }
  const patch = raw.toString('utf8').trimEnd();
  let removalError: string | undefined;
  if (remove !== 'none') {
    try {
      if (previousRemoval && existsSync(worktree.path)) {
        if (!snapshot) throw new Error('Cannot safely retry removal without a snapshot; preserve newer edits and remove the worktree manually');
        group = await gitGroup(worktree.path, home);
        const current = await collectionSnapshot(group, worktree.path);
        // Partial deletion and later worker edits are indistinguishable; either needs manual inspection.
        if (Object.keys(current).length !== Object.keys(snapshot).length ||
          Object.entries(current).some(([path, hash]) => snapshot![path] !== hash))
          throw new Error('Worktree changed after the saved patch; preserve newer edits before removing it manually');
      }
      if (!previousRemoval) {
        snapshot = await collectionSnapshot(group!, worktree.path);
        atomicWrite(removalMarker, JSON.stringify({ stat, snapshot }));
      }
      group ??= await gitGroup(worktree.root, home);
      await removeWorktree(group, worktree.root, worktree.path);
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

/** Snapshot tracked and untracked source files without traversing ignored dependency trees or links. */
async function collectionSnapshot(group: Awaited<ReturnType<typeof gitGroup>>, path: string): Promise<Record<string, string>> {
  const files = await group.buffer(path, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
  const snapshot: Record<string, string> = Object.create(null);
  for (const name of files.toString('utf8').split('\0').filter(Boolean)) {
    const file = join(path, name);
    try {
      const entry = lstatSync(file);
      const content = entry.isSymbolicLink() ? `link:${readlinkSync(file)}` : entry.isFile() ? readFileSync(file) : 'directory';
      snapshot[name] = createHash('sha256').update(content).digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return snapshot;
}
