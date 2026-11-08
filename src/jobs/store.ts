import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  existsSync,
  createReadStream,
  openSync,
  closeSync,
  readSync,
  fstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FailureReason, JobMeta, JobState, Owner } from './connector.js';

export type TransitionListener = (job: JobMeta, previous: JobState | undefined) => void;

export const files = {
  prompt: 'prompt.txt',
  stdout: 'stdout',
  stderr: 'stderr',
  final: 'final.txt',
  patch: 'patch.diff',
  verify: 'verify',
  reasoning: 'reasoning',
  notes: 'notes.ndjson',
} as const;
export type JobFile = keyof typeof files;
export const terminal = (job: JobMeta) =>
  ['completed', 'failed', 'killed', 'lost'].includes(job.state);
export const sameOwner = (a: Owner | undefined, b: Owner) =>
  a?.pid === b.pid && a.startTime === b.startTime;

/** A connector (and optionally one model) that hit a usage limit, independent of any job record. */
export interface QuotaPause {
  connector: string;
  model?: string;
  resetAt?: number;
  since: number;
}

export function atomicWrite(path: string, data: string | Buffer): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, data, { flag: 'wx' });
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        renameSync(temp, path);
        break;
      } catch (error) {
        // Windows readers/antivirus can briefly hold a handle without delete sharing.
        if (
          process.platform !== 'win32' ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
          Date.now() >= deadline
        )
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

export function failureReason(job: JobMeta): FailureReason | undefined {
  if (job.state === 'queued' || job.state === 'running') return undefined;
  if (job.verify && !job.verify.passed && job.state === 'completed') return 'verify_failed';
  if (job.state === 'completed') return undefined;
  const reasons: Record<string, FailureReason> = { usage_limit: 'quota_exhausted', timeout: 'timeout', cancelled: 'cancelled', stalled: 'stalled', 'kill-failed': 'kill_failed', owner_gone: 'lost', superseded: 'superseded' };
  const known = reasons[job.reason ?? ''] ?? (job.state === 'lost' ? 'lost' : undefined);
  if (known) return known;
  if (/\b(?:sign[-_ ]?in|log[-_ ]?in|auth|auth(?:enticat|oriz)\w*|unauthori[sz]ed|credentials|api[-_ ]?key)\b/i.test(job.error ?? '')) return 'auth';
  return 'cli_error';
}

function fstatSize(path: string): number { const fd = openSync(path, 'r'); try { return fstatSync(fd).size; } finally { closeSync(fd); } }

export class JobStore {
  private readonly listeners = new Set<TransitionListener>();

  constructor(readonly home: string) {
    mkdirSync(join(home, 'jobs'), { recursive: true });
  }

  dir(id: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid job id');
    return join(this.home, 'jobs', id);
  }

  path(id: string, name: JobFile): string {
    return join(this.dir(id), files[name]);
  }

  create(meta: JobMeta, prompt: string): void {
    mkdirSync(this.dir(meta.id));
    try {
      for (const name of Object.keys(files) as JobFile[])
        atomicWrite(this.path(meta.id, name), name === 'prompt' ? prompt : '');
      atomicWrite(join(this.dir(meta.id), 'meta.json'), JSON.stringify(meta));
    } catch (error) {
      rmSync(this.dir(meta.id), { recursive: true, force: true });
      throw error;
    }
  }

  get(id: string): JobMeta {
    return JSON.parse(readFileSync(join(this.dir(id), 'meta.json'), 'utf8'));
  }

  list(): JobMeta[] {
    return readdirSync(join(this.home, 'jobs'))
      .flatMap(id => {
        if (!/^[a-zA-Z0-9-]+$/.test(id)) return [];
        if (!existsSync(join(this.dir(id), 'meta.json'))) return [];
        return [this.get(id)];
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  save(meta: JobMeta, owner: Owner): void {
    const current = this.get(meta.id);
    if (!sameOwner(current.owner, owner) || !sameOwner(meta.owner, owner))
      throw new Error('Only the job owner may update this job');
    this.write(meta);
  }

  // Recovery and claiming unowned records must be performed under the machine lock.
  write(meta: JobMeta): void {
    let previous: JobState | undefined;
    {
      try {
        previous = this.get(meta.id).state;
      } catch {
        /* No readable previous record. */
      }
    }
    if ((meta.state === 'queued' || meta.state === 'running') && previous !== meta.state) {
      for (const marker of ['woken', 'collected']) rmSync(join(this.dir(meta.id), marker), { force: true });
    }
    meta.failureReason = failureReason(meta);
    if (meta.state === 'queued' || meta.state === 'running') meta.partial = undefined;
    else {
      const final = readFileSync(this.path(meta.id, 'final'), 'utf8').trim();
      const output = ['stdout', 'stderr'].some(name => { try { return fstatSize(this.path(meta.id, name as 'stdout' | 'stderr')) > 0; } catch { return false; } });
      meta.partial = ((!final && output) || meta.reason === 'timeout' || (meta.state === 'killed' && !!meta.startedAt && meta.reason !== 'superseded')) ? true : undefined;
    }
    meta.updatedAt = Date.now();
    atomicWrite(join(this.dir(meta.id), 'meta.json'), JSON.stringify(meta));
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...meta }, previous);
      } catch {
        /* A listener must never break persistence. */
      }
    }
  }

  /** Subscribes to every persisted record write; returns an unsubscribe function. */
  onWrite(listener: TransitionListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  // Quota pauses are shared state: read and change them only under the machine lock.
  pauses(): QuotaPause[] {
    try {
      return JSON.parse(readFileSync(join(this.home, 'pauses.json'), 'utf8')) as QuotaPause[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  writePauses(pauses: QuotaPause[]): void {
    atomicWrite(join(this.home, 'pauses.json'), JSON.stringify(pauses));
  }

  read(id: string, name: JobFile): string {
    return readFileSync(this.path(id, name), 'utf8');
  }

  async page(id: string, name: JobFile, offset: number, limit: number) {
    let total = 0;
    let text = '';
    const path = this.path(id, name);
    for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
      const part = String(chunk);
      if (total < offset + limit && total + part.length > offset) {
        text += part.slice(Math.max(0, offset - total), Math.max(0, offset + limit - total));
      }
      total += part.length;
    }
    return { text, offset, nextOffset: Math.min(offset + text.length, total), total, path };
  }

  tail(id: string, name: 'stdout' | 'stderr' | 'reasoning' | 'notes', count: number): string {
    const fd = openSync(this.path(id, name), 'r');
    try {
      const size = fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(size, 65536));
      const length = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return buffer.subarray(0, length).toString('utf8').split(/\r?\n/).slice(-count).join('\n');
    } finally {
      closeSync(fd);
    }
  }

  prune(now = Date.now()): void {
    const pruned = new Set<string>();
    for (const job of this.list()) {
      if (
        terminal(job) &&
        !job.reserved &&
        now - (job.finishedAt ?? job.updatedAt) > 7 * 86400000
      ) {
        rmSync(this.dir(job.id), { recursive: true, force: true });
        pruned.add(job.id);
      }
    }
    const tasks = join(this.home, 'tasks');
    if (!pruned.size || !existsSync(tasks)) return;
    for (const file of readdirSync(tasks).filter(file => file.endsWith('.json'))) {
      let jobId: string;
      try { jobId = JSON.parse(readFileSync(join(tasks, file), 'utf8')).jobId; }
      catch { continue; }
      if (pruned.has(jobId)) rmSync(join(tasks, file), { force: true });
    }
  }
}
