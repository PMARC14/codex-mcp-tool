import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connector, JobEvent, JobLogger, JobMeta, JobSpec, Owner } from './connector.js';
import { readConfig, type JobsConfig } from './config.js';
import { JobStore, atomicWrite, sameOwner, terminal, type JobFile } from './store.js';
import { withLock } from './lock.js';
import {
  currentOwner,
  ownerAlive,
  killTree,
  startProcess,
  type ProcessOutcome,
  type RunningProcess,
} from './proc.js';
import { createWorktree, collectWorktree } from './worktree.js';
import { WakeHold } from './wakehold.js';

export interface StartOptions {
  prompt?: string;
  promptFile?: string;
  cwd: string;
  mode?: JobSpec['mode'];
  model?: string;
  effort?: string;
  label?: string;
  worktree?: boolean;
  resumeSession?: string;
  timeoutMin?: number;
}

const sleep = (ms: number) => new Promise(resolveResult => setTimeout(resolveResult, ms));
const quiet: JobLogger = { warn() {} };

export class JobManager {
  readonly store: JobStore;
  readonly config: JobsConfig;
  private owner!: Owner;
  private readonly id = randomUUID();
  private initialized?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  private active = new Map<string, { process: RunningProcess; finished: Promise<void> }>();
  private hold: WakeHold;
  private disposed = false;

  constructor(
    readonly connector: Connector,
    config = readConfig(),
    private logger = quiet
  ) {
    this.config = config;
    this.store = new JobStore(config.home);
    this.hold = new WakeHold(config.home, logger);
  }

  initialize(): Promise<void> {
    return (this.initialized ??= (async () => {
      this.owner = await currentOwner();
      await withLock(this.config.home, async () => {
        const alive = new Map<string, boolean>();
        for (const job of this.store.list()) {
          if (!job.owner || (terminal(job) && !job.reserved)) continue;
          const key = JSON.stringify(job.owner);
          if (!alive.has(key)) alive.set(key, await ownerAlive(job.owner));
          if (alive.get(key)) continue;
          if (job.state === 'paused') {
            if (job.connector === this.connector.id) {
              job.owner = this.owner;
              job.managerId = this.id;
              this.store.write(job);
            }
          } else {
            await killTree(job.process, job.descendants).catch(error =>
              this.logger.warn(`Lost job ${job.id} cleanup failed`, error)
            );
            this.store.write({
              ...job,
              state: 'lost',
              reserved: false,
              reason: 'owner_gone',
              finishedAt: Date.now(),
            });
          }
        }
        this.store.prune();
      });
      this.timer = setInterval(
        () => void this.pump().catch(error => this.logger.warn('Job queue error', error)),
        500
      );
      this.timer.unref();
    })());
  }

  private owns(job: JobMeta): boolean {
    return sameOwner(job.owner, this.owner) && job.managerId === this.id;
  }

  private async available(): Promise<void> {
    if (this.config.connectors[this.connector.id]?.enabled === false)
      throw new Error(
        `${this.connector.id} is disabled in agent-jobs config; enable it and restart this MCP server`
      );
    const detected = await this.connector.detect();
    if (!detected.available)
      throw new Error(
        detected.reason || `Install ${this.connector.id} CLI and sign in before starting jobs`
      );
  }

  private selectModel(requested?: string): string | undefined {
    const settings = this.config.connectors[this.connector.id];
    const model = requested ?? settings?.defaultModel ?? undefined;
    if (
      !requested &&
      model &&
      settings?.requestOnlyModels?.some(pattern => {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`).test(model);
      })
    )
      throw new Error(
        'Configured default model is request-only; provide model explicitly or change defaultModel'
      );
    return model;
  }

  async start(options: StartOptions) {
    await this.initialize();
    if (this.disposed) throw new Error('Job manager is shutting down');
    await this.available();
    if ((options.prompt === undefined) === (options.promptFile === undefined))
      throw new Error('Provide exactly one of prompt or promptFile');
    const prompt = options.prompt ?? readFileSync(options.promptFile!, 'utf8');
    const timeoutMin = options.timeoutMin ?? 120;
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0)
      throw new Error('timeoutMin must be positive');
    const id = randomUUID();
    const model = this.selectModel(options.model);
    const worktree = options.worktree
      ? await createWorktree(options.cwd, options.label, id, this.connector.id)
      : undefined;
    if (worktree?.warning) this.logger.warn(worktree.warning);
    const meta: JobMeta = {
      id,
      connector: this.connector.id,
      cwd: worktree?.path ?? resolve(options.cwd),
      mode: options.mode ?? 'read',
      model,
      effort: options.effort,
      label: options.label,
      resumeSession: options.resumeSession,
      timeoutMin,
      worktree,
      finalPath: this.store.path(id, 'final'),
      state: 'queued',
      owner: this.owner,
      managerId: this.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.create(meta, prompt);
    // Promotion is asynchronous; returning queued also covers spawn-in-progress.
    void this.pump().catch(error => this.logger.warn('Job queue error', error));
    return { jobId: id, state: meta.state, warning: worktree?.warning };
  }

  private pump(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return (this.pumping ??= this.promote().finally(() => {
      this.pumping = undefined;
    }));
  }

  private async promote(): Promise<void> {
    if (
      this.config.connectors[this.connector.id]?.enabled === false ||
      !(await this.connector.detect()).available
    )
      return;
    const ready: JobMeta[] = [];
    try {
      await withLock(this.config.home, async () => {
        const jobs = this.store.list();
        const now = Date.now();
        for (const job of jobs) {
          if (
            this.owns(job) &&
            job.state === 'queued' &&
            job.reserved &&
            !this.active.has(job.id)
          ) {
            Object.assign(job, {
              state: 'failed',
              reserved: false,
              reason: 'spawn_error',
              error: 'Start interrupted before the process was registered',
              finishedAt: now,
            });
            this.store.save(job, this.owner);
          }
          if (!this.owns(job) || !terminal(job) || !job.reserved) continue;
          const identities = [...(job.process ? [job.process] : []), ...(job.descendants ?? [])];
          if (!(await Promise.all(identities.map(ownerAlive))).some(Boolean)) {
            job.reserved = false;
            this.store.save(job, this.owner);
            this.active.delete(job.id);
            if (!this.active.size) this.hold.stop();
          }
        }
        const liveOwners = new Map<string, boolean>();
        for (const job of jobs) {
          if (!job.owner || sameOwner(job.owner, this.owner) || (terminal(job) && !job.reserved))
            continue;
          const key = JSON.stringify(job.owner);
          if (!liveOwners.has(key)) liveOwners.set(key, await ownerAlive(job.owner));
          if (!liveOwners.get(key)) {
            if (job.state === 'paused') {
              if (job.connector === this.connector.id) {
                job.owner = this.owner;
                job.managerId = this.id;
                this.store.write(job);
              }
              continue;
            }
            await killTree(job.process, job.descendants).catch(error =>
              this.logger.warn(`Lost job ${job.id} cleanup failed`, error)
            );
            Object.assign(job, {
              state: 'lost',
              reserved: false,
              reason: 'owner_gone',
              finishedAt: now,
            });
            this.store.write(job);
          }
        }
        // Pauses are records in the common store, including after a restart.
        const requeued = new Set(jobs.map(job => job.requeuedFrom).filter(Boolean));
        const pauses = jobs.filter(
          job =>
            job.state === 'paused' &&
            !job.pauseCleared &&
            !requeued.has(job.id) &&
            (!job.resetAt || job.resetAt > now)
        );
        let slots = jobs.filter(job => job.state === 'running' || job.reserved).length;
        for (const job of jobs.reverse()) {
          if (job.connector !== this.connector.id || terminal(job)) continue;
          if (!job.owner && job.state === 'queued') {
            job.owner = this.owner;
            job.managerId = this.id;
            try {
              job.model = this.selectModel(job.model);
            } catch (error) {
              Object.assign(job, {
                state: 'failed',
                reason: 'config_error',
                error: String(error),
                finishedAt: now,
              });
            }
            this.store.write(job);
          }
          if (terminal(job)) continue;
          if (!this.owns(job) || job.state === 'running' || job.reserved) continue;
          if (job.state === 'paused' && requeued.has(job.id)) {
            job.pauseCleared = true;
            this.store.save(job, this.owner);
          }
          if (job.state === 'paused' && job.pauseCleared) continue;
          if (job.state === 'paused' && job.resetAt && job.resetAt <= now) {
            job.state = 'queued';
            job.reason = undefined;
            job.resetAt = undefined;
            this.store.save(job, this.owner);
          }
          if (job.state !== 'queued') continue;
          const pause =
            !job.manualRequeue &&
            pauses.find(
              p =>
                p.connector === job.connector &&
                (!p.pauseModel || !job.model || p.pauseModel === job.model)
            );
          if (pause) {
            Object.assign(job, {
              state: 'paused',
              reason: 'usage_limit',
              resetAt: pause.resetAt,
              pauseModel: pause.pauseModel,
            });
            this.store.save(job, this.owner);
            continue;
          }
          if (slots >= this.config.maxJobs) continue;
          // Reserve before spawning, under the same lock used by both forks.
          job.reserved = true;
          job.manualRequeue = false;
          this.store.save(job, this.owner);
          slots++;
          ready.push(job);
        }
      });
    } finally {
      // A later reservation failure must not strand slots already reserved.
      for (const job of ready) this.launch(job);
    }
  }

  private launch(job: JobMeta): void {
    let event: JobEvent = {};
    let timer: NodeJS.Timeout | undefined;
    let killFailed = false;
    try {
      const prompt = this.store.read(job.id, 'prompt');
      atomicWrite(job.finalPath, '');
      job.finishedAt = undefined;
      job.error = undefined;
      job.exitCode = undefined;
      const command = this.connector.build({
        ...job,
        prompt: job.worktree
          ? `${prompt}\n\nDo not commit changes; the orchestrator will collect the patch.`
          : prompt,
      });
      const process = startProcess({
        ...command,
        cwd: job.cwd,
        stdout: this.store.path(job.id, 'stdout'),
        stderr: this.store.path(job.id, 'stderr'),
        onSpawn: async identity => {
          job.state = 'running';
          job.process = identity;
          job.startedAt = Date.now();
          this.store.save(job, this.owner);
          if (this.config.wakeHold) void this.hold.start();
          timer = setTimeout(() => void process.stop('timeout'), job.timeoutMin * 60000);
        },
        onSnapshot: identities => {
          if (!terminal(job)) {
            job.descendants = identities;
            this.store.save(job, this.owner);
          }
        },
        onClosed: () => {
          void (async () => {
            if (killFailed) {
              if (
                (
                  await Promise.all(
                    [...(job.process ? [job.process] : []), ...(job.descendants ?? [])].map(
                      ownerAlive
                    )
                  )
                ).some(Boolean)
              )
                return;
              job.reserved = false;
              try {
                this.store.save(job, this.owner);
              } catch (error) {
                this.logger.warn('Failed releasing ended job slot', error);
              }
              this.active.delete(job.id);
              if (!this.active.size) this.hold.stop();
            }
          })().catch(error => this.logger.warn('Failed checking process cleanup', error));
        },
        onLine: (line, stream) => {
          const parsed = this.connector.parse(line, stream);
          if (!parsed) return;
          event = { ...event, ...parsed, usageLimit: parsed.usageLimit ?? event.usageLimit };
          if (parsed.sessionId) {
            job.sessionId = parsed.sessionId;
            this.store.save(job, this.owner);
          }
        },
      });
      const finished = process.done
        .then(async outcome => {
          killFailed = outcome.killFailed ?? false;
          clearTimeout(timer);
          if (event.final && !(await this.store.page(job.id, 'final', 0, 20000)).text.trim())
            atomicWrite(job.finalPath, event.final);
          await this.settle(job, outcome, event);
        })
        .catch(error => {
          this.logger.warn(`Failed saving job ${job.id}`, error);
          // Retain a failed record when a transient store error permits it.
          try {
            this.store.save(
              {
                ...job,
                state: 'failed',
                reserved: killFailed,
                reason: 'store_error',
                error: String(error),
                finishedAt: Date.now(),
              },
              this.owner
            );
          } catch (saveError) {
            this.logger.warn('Unable to persist failed job', saveError);
          }
        })
        .finally(() => {
          if (!killFailed) this.active.delete(job.id);
          if (!this.active.size) this.hold.stop();
          void this.pump().catch(error => this.logger.warn('Job queue error', error));
        });
      this.active.set(job.id, { process, finished });
    } catch (error) {
      this.store.save(
        {
          ...job,
          state: 'failed',
          reserved: false,
          reason: 'spawn_error',
          error: String(error),
          finishedAt: Date.now(),
        },
        this.owner
      );
    }
  }

  private async settle(job: JobMeta, outcome: ProcessOutcome, event: JobEvent): Promise<void> {
    job.reserved = outcome.killFailed ?? false;
    job.exitCode = outcome.code;
    job.finishedAt = Date.now();
    job.error = (outcome.error ?? event.error)?.slice(0, 20000);
    if (outcome.killFailed) {
      job.state = 'failed';
      job.reason = 'kill-failed';
    } else if (outcome.kind === 'cancel') {
      job.state = 'killed';
      job.reason = 'cancelled';
    } else if (outcome.kind === 'timeout') {
      job.state = 'failed';
      job.reason = 'timeout';
    } else if (event.usageLimit) {
      job.state = 'paused';
      job.reason = 'usage_limit';
      job.resetAt = event.usageLimit.resetAt;
      job.pauseModel = event.usageLimit.model;
    } else if (outcome.kind === 'error' || outcome.code !== 0 || event.error) {
      job.state = 'failed';
      job.reason = outcome.kind === 'error' ? 'spawn_error' : 'cli_error';
    } else {
      job.state = 'completed';
      job.reason = undefined;
    }
    this.store.save(job, this.owner);
  }

  async list(limit = 50) {
    await this.initialize();
    return this.store.list().slice(0, Math.min(100, Math.max(1, limit)));
  }

  private tail(id: string, name: 'stdout' | 'stderr', count = 20): string {
    return this.store.tail(id, name, count).slice(-10000);
  }

  async status(jobId?: string): Promise<unknown> {
    await this.initialize();
    if (!jobId)
      return Promise.all(
        this.store
          .list()
          .filter(job => !terminal(job) || job.reserved)
          .slice(0, 100)
          .map(job => this.status(job.id))
      );
    const job = this.store.get(jobId);
    return {
      ...job,
      elapsedSec: ((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000,
      stderr: this.tail(jobId, 'stderr'),
      events: this.tail(jobId, 'stdout'),
    };
  }

  async result(jobId: string, waitSec = 0) {
    await this.initialize();
    const deadline = Date.now() + Math.min(10, Math.max(0, waitSec)) * 1000;
    let job = this.store.get(jobId);
    while (['queued', 'running'].includes(job.state) && Date.now() < deadline) {
      await sleep(Math.min(100, deadline - Date.now()));
      job = this.store.get(jobId);
    }
    const final = await this.store.page(jobId, 'final', 0, 20000);
    return {
      jobId,
      state: job.state,
      reason: job.reason,
      error: job.error?.slice(0, 20000),
      sessionId: job.sessionId,
      resetAt: job.resetAt,
      final: final.text,
      truncated: final.total > 20000,
      finalPath: job.finalPath,
      diagnostics: final.text.trim()
        ? undefined
        : `${this.tail(jobId, 'stderr', 30)}\n${this.tail(jobId, 'stdout', 30)}`.slice(-20000),
    };
  }

  async read(jobId: string, name: JobFile, offset = 0, limit = 20000) {
    await this.initialize();
    this.store.get(jobId);
    const start = Math.max(0, Math.floor(offset));
    return this.store.page(jobId, name, start, Math.min(20000, Math.max(1, Math.floor(limit))));
  }

  async cancel(jobId: string) {
    await this.initialize();
    let active: { process: RunningProcess; finished: Promise<void> } | undefined;
    let retry: JobMeta | undefined;
    await withLock(this.config.home, () => {
      const job = this.store.get(jobId);
      if (!this.owns(job)) throw new Error('Only the owning server can cancel this job');
      if (job.reason === 'kill-failed' && job.reserved) retry = job;
      else active = this.active.get(jobId);
      if (!active && !retry && !terminal(job)) {
        this.store.save(
          { ...job, state: 'killed', reserved: false, reason: 'cancelled', finishedAt: Date.now() },
          this.owner
        );
      }
    });
    if (retry) {
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          killTree(retry.process, retry.descendants),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(new Error('kill-failed: termination did not complete within 10 seconds')),
              10000
            );
          }),
        ]);
        this.store.save(
          {
            ...retry,
            state: 'killed',
            reserved: false,
            reason: 'cancelled',
            finishedAt: Date.now(),
          },
          this.owner
        );
        this.active.delete(jobId);
        if (!this.active.size) this.hold.stop();
      } finally {
        clearTimeout(deadline);
      }
    } else if (active) {
      await active.process.stop();
      await active.finished;
    }
    return this.status(jobId);
  }

  async requeue(jobId: string, model?: string, agent = this.connector.id) {
    await this.initialize();
    const original = this.store.get(jobId);
    if (!['paused', 'lost', 'failed'].includes(original.state))
      throw new Error('Only paused, lost or failed jobs can be requeued');
    if (original.reserved)
      throw new Error(
        'The process is still alive after kill-failed; cancel it from its owner before requeueing'
      );
    if (agent === this.connector.id) await this.available();
    const id = randomUUID();
    const meta: JobMeta = {
      ...original,
      id,
      connector: agent,
      model:
        agent === this.connector.id
          ? this.selectModel(model ?? (agent === original.connector ? original.model : undefined))
          : (model ?? (agent === original.connector ? original.model : undefined)),
      state: 'queued',
      owner: agent === this.connector.id ? this.owner : undefined,
      managerId: agent === this.connector.id ? this.id : undefined,
      process: undefined,
      descendants: undefined,
      reserved: false,
      sessionId: undefined,
      reason: undefined,
      error: undefined,
      resetAt: undefined,
      pauseModel: undefined,
      exitCode: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      finalPath: this.store.path(id, 'final'),
    };
    meta.pauseCleared = false;
    meta.manualRequeue = true;
    meta.requeuedFrom = original.id;
    if (meta.worktree?.removed)
      throw new Error('The worktree was removed; start a new job with the saved prompt');
    this.store.create(meta, this.store.read(jobId, 'prompt'));
    if (this.owns(original) && original.state === 'paused') {
      await withLock(this.config.home, () => {
        original.pauseCleared = true;
        this.store.save(original, this.owner);
      });
    }
    void this.pump().catch(error => this.logger.warn('Job queue error', error));
    return { jobId: id, state: meta.state };
  }

  async collect(jobId: string, remove: 'none' | 'worktree' | 'worktree+branch' = 'none') {
    await this.initialize();
    const job = this.store.get(jobId);
    if (!job.worktree) throw new Error('This job has no worktree');
    if (job.state === 'running' || job.reserved || job.state === 'queued')
      throw new Error('Wait for the job to stop before collecting its worktree');
    if (!this.owns(job))
      throw new Error('Only the owning server can collect this job; requeue a lost job first');
    const result = await collectWorktree(job.worktree, this.store.path(jobId, 'patch'), remove);
    this.store.save(job, this.owner);
    return result;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.timer);
    await this.pumping;
    await Promise.all(
      [...this.active.values()].map(async active => {
        await active.process.stop();
        await active.finished;
      })
    );
    this.hold.stop();
  }
}
