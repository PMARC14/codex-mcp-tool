import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  Connector,
  JobEvent,
  JobLogger,
  JobMeta,
  JobSpec,
  JobState,
  Owner,
} from './connector.js';
import { readConfig, type JobsConfig } from './config.js';
import {
  JobStore,
  atomicWrite,
  sameOwner,
  terminal,
  type JobFile,
  type QuotaPause,
} from './store.js';
import { withLock } from './lock.js';
import {
  currentOwner,
  ownerAlive,
  killTree,
  startProcess,
  type ProcessOutcome,
  type RunningProcess,
  runCommand,
} from './proc.js';
import { createWorktree, collectWorktree } from './worktree.js';
import { WakeHold } from './wakehold.js';
import { watchJob, type WatchOptions } from './watch.js';
import type { ApprovalDecision } from './stdin.js';

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
  transport?: JobSpec['transport'];
  approvalTimeoutMin?: number;
  timeoutMin?: number;
  stallTimeoutMin?: number;
  onStall?: 'report' | 'kill';
  verify?: string;
  verifyTimeoutMin?: number;
  idempotencyKey?: string;
  priority?: 'normal' | 'optional';
}

const sleep = (ms: number) => new Promise(resolveResult => setTimeout(resolveResult, ms));
let gitBash: Promise<string | undefined> | undefined;
async function verifyShell(): Promise<string> {
  if (process.platform !== 'win32') return 'bash';
  const override = process.env.AGENT_JOBS_BASH || process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override) {
    if (!win32.isAbsolute(override)) throw new Error('Git Bash override must be an absolute path');
    if (/(?:^|[\\/])system32[\\/]bash(?:\.exe)?$/i.test(override)) throw new Error('System32 bash is not supported');
    return override;
  }
  gitBash ??= runCommand('git', ['--exec-path'], undefined, 10000).then(path => {
    const candidate = join(dirname(dirname(dirname(path.trim()))), 'bin', 'bash.exe');
    return existsSync(candidate) ? candidate : undefined;
  }).catch(() => undefined);
  const found = await gitBash;
  if (found) return found;
  const fallback = join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  if (existsSync(fallback)) return fallback;
  throw new Error('Git Bash not found; set AGENT_JOBS_BASH');
}
const quiet: JobLogger = { warn() {} };
const DETECT_TTL_MS = 60_000;
/** How often the pump checks whether other servers' job owners are still alive. */
export const FOREIGN_SWEEP_MS = 15_000;

/** The last 30 lines of stderr then stdout, each cut to 300 characters, at most 4000 in total. */
export function compactDiagnostics(stderr: string, stdout: string): string {
  const lines = `${stderr.trim()}\n${stdout.trim()}`
    .split(/\r?\n/)
    .filter(line => line.trim())
    .slice(-30)
    .map(line => (line.length > 300 ? `${line.slice(0, 300)}…` : line));
  // Drop the oldest lines first, so the newest (most telling) ones survive.
  while (lines.length > 1 && lines.join('\n').length > 4000) lines.shift();
  return lines.join('\n').slice(-4000);
}

export class JobManager {
  readonly store: JobStore;
  readonly config: JobsConfig;
  private owner!: Owner;
  private readonly id = randomUUID();
  private initialized?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  private active = new Map<string, { job: JobMeta; process: RunningProcess; finished: Promise<void>; sample?: () => void; cancelled: boolean }>();
  private hold: WakeHold;
  private disposed = false;
  private readonly kill: typeof killTree;
  private readonly resolveVerifyShell: typeof verifyShell;
  private cleanupTried = new Map<string, number>();
  private usageCache?: { at: number; value: number | undefined };
  private readonly watchShutdown = new AbortController();

  constructor(
    readonly connector: Connector,
    config = readConfig(),
    private logger = quiet,
    deps: { killTree?: typeof killTree; verifyShell?: typeof verifyShell } = {}
  ) {
    this.kill = deps.killTree ?? killTree;
    this.resolveVerifyShell = deps.verifyShell ?? verifyShell;
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
            await this.recoverOrphan(job, Date.now());
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

  // Must run under the shared lock. The slot and the identities needed to retry the cleanup are
  // only dropped once the tree is confirmed dead; a later recovery pass retries the same record.
  private async recoverOrphan(job: JobMeta, now: number): Promise<void> {
    if (job.state === 'lost' && now - (this.cleanupTried.get(job.id) ?? 0) < 2000) return;
    this.cleanupTried.set(job.id, now);
    let confirmed = true;
    await this.kill(job.process, job.descendants).catch(error => {
      confirmed = false;
      this.logger.warn(`Lost job ${job.id} cleanup failed; keeping its slot`, error);
    });
    this.store.write({
      ...job,
      state: 'lost',
      reserved: !confirmed,
      reason: 'owner_gone',
      finishedAt: job.finishedAt ?? now,
    });
    if (confirmed) this.cleanupTried.delete(job.id);
  }

  /**
   * Subscribes to job state changes written by this process. The listener runs synchronously after
   * the record is persisted, with a copy of the job and its previous state; it receives records
   * for every owner, so use isOwn() to filter. Returns an unsubscribe function.
   */
  onTransition(listener: (job: JobMeta, previous: JobState | undefined) => void): () => void {
    return this.store.onWrite(listener);
  }

  /** True when this manager (not another server or an earlier run) owns the job. */
  isOwn(job: JobMeta): boolean {
    return this.owns(job);
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

  private selectModel(requested?: string, connector = this.connector.id): string | undefined {
    const settings = this.config.connectors[connector];
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

  async start(options: StartOptions, followUpOf?: string) {
    await this.initialize();
    if (this.disposed) throw new Error('Job manager is shutting down');
    const connector = followUpOf ? this.store.get(followUpOf).connector : this.connector.id;
    if (options.idempotencyKey && !followUpOf) {
      const existing = await withLock(this.config.home, () => this.store.list().find(job =>
        job.connector === connector && job.idempotencyKey === options.idempotencyKey && Date.now() - job.createdAt < 86400000));
      if (existing) return { jobId: existing.id, state: existing.state, warning: undefined };
    }
    if (connector === this.connector.id) await this.available();
    else if (this.config.connectors[connector]?.enabled === false)
      throw new Error(`${connector} is disabled in agent-jobs config`);
    if ((options.prompt === undefined) === (options.promptFile === undefined))
      throw new Error('Provide exactly one of prompt or promptFile');
    const prompt = options.prompt ?? readFileSync(options.promptFile!, 'utf8');
    const timeoutMin = options.timeoutMin ?? 120;
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0)
      throw new Error('timeoutMin must be positive');
    if (options.verify !== undefined && (!options.verify.trim() || (options.mode ?? 'read') === 'read'))
      throw new Error('verify requires a non-empty command and a non-read mode');
    if (options.verifyTimeoutMin !== undefined && (!Number.isFinite(options.verifyTimeoutMin) || options.verifyTimeoutMin <= 0))
      throw new Error('verifyTimeoutMin must be positive');
    if (!Number.isFinite(options.stallTimeoutMin ?? 10) || (options.stallTimeoutMin ?? 10) < 0) throw new Error('stallTimeoutMin must be non-negative');
    if (options.transport !== undefined && !['exec', 'app-server'].includes(options.transport)) throw new Error('Unknown job transport');
    if (!Number.isFinite(options.approvalTimeoutMin ?? 30) || (options.approvalTimeoutMin ?? 30) <= 0) throw new Error('approvalTimeoutMin must be positive');
    return withLock(this.config.home, async () => {
      if (options.idempotencyKey && !followUpOf) {
        const existing = this.store.list().find(job => job.connector === connector && job.idempotencyKey === options.idempotencyKey && Date.now() - job.createdAt < 86400000);
        if (existing) return { jobId: existing.id, state: existing.state, warning: undefined };
      }
      if (options.priority === 'optional' && connector === this.connector.id) {
        if (!this.usageCache || Date.now() - this.usageCache.at >= 300000) {
          let value: number | undefined;
          try { value = await this.connector.usagePercent?.(); } catch { /* fail open */ }
          this.usageCache = { at: Date.now(), value };
        }
        if (this.usageCache.value !== undefined && this.usageCache.value >= (this.config.usageCeiling ?? 90))
          throw new Error(`Optional job refused: 5-hour or weekly usage window is at ${this.usageCache.value}% (ceiling ${this.config.usageCeiling ?? 90}%)`);
      }
      const id = randomUUID();
      const model = followUpOf ? undefined : this.selectModel(options.model);
      const worktree = options.worktree
        ? await createWorktree(options.cwd, options.label, id, this.connector.id, this.config.home)
        : undefined;
      if (worktree?.warning) this.logger.warn(worktree.warning);
      let meta: JobMeta = {
        id,
        connector: this.connector.id,
        cwd: worktree?.path ?? resolve(options.cwd),
        mode: options.mode ?? 'read',
        model,
        effort: options.effort,
        label: options.label,
        resumeSession: options.resumeSession,
        transport: options.transport ?? 'exec',
        approvalTimeoutMin: options.approvalTimeoutMin ?? 30,
        steers: 0,
        timeoutMin,
        stallTimeoutMin: options.stallTimeoutMin ?? 10,
        onStall: options.onStall ?? 'report',
        idempotencyKey: options.idempotencyKey,
        priority: options.priority ?? 'normal',
        verifyCommand: options.verify,
        verifyTimeoutMin: options.verifyTimeoutMin ?? 10,
        worktree,
        originalCwd: resolve(options.cwd),
        finalPath: this.store.path(id, 'final'),
        state: 'queued',
        owner: this.owner,
        managerId: this.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const create = () => {
        if (followUpOf) {
          // Re-read under the queue lock: a paused source may have resumed during detect().
          const original = this.store.get(followUpOf);
          this.assertSendable(original);
          const reusable =
            original.worktree &&
            !original.worktree.removed &&
            this.isDirectory(original.worktree.path)
              ? original.worktree
              : undefined;
          if ((options.mode ?? original.mode) === 'read' && original.verifyCommand)
            throw new Error('verify requires a non-read mode');
          meta = {
            ...meta,
            connector: original.connector,
            owner: original.connector === this.connector.id ? this.owner : undefined,
            managerId: original.connector === this.connector.id ? this.id : undefined,
            cwd: reusable?.path ?? original.originalCwd ?? original.worktree?.root ?? original.cwd,
            originalCwd: original.originalCwd ?? original.worktree?.root ?? original.cwd,
            worktree: reusable,
            mode: options.mode ?? original.mode,
            model: this.selectModel(options.model ?? original.model, original.connector),
            effort: options.effort ?? original.effort,
            timeoutMin: options.timeoutMin ?? original.timeoutMin,
            stallTimeoutMin: options.stallTimeoutMin ?? original.stallTimeoutMin ?? 10,
            onStall: options.onStall ?? original.onStall ?? 'report',
            verifyCommand: original.verifyCommand,
            verifyTimeoutMin: original.verifyTimeoutMin,
            resumeSession: original.sessionId,
            transport: original.transport ?? 'exec',
            approvalTimeoutMin: original.approvalTimeoutMin ?? 30,
            followUpOf,
          };
          this.store.create(meta, prompt);
          // A follow-up supersedes a paused job's automatic retry, like requeue does.
          if (original.state === 'paused') this.supersede(original, id);
        } else this.store.create(meta, prompt);
      };
      create();
      // Promotion is asynchronous; returning queued also covers spawn-in-progress.
      void this.pump().catch(error => this.logger.warn('Job queue error', error));
      return { jobId: id, state: meta.state, warning: worktree?.warning };
    });
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  private assertSendable(job: JobMeta): void {
    if (job.state === 'queued' || job.state === 'running' || job.reserved)
      throw new Error(
        `Job is still running or queued; use ${job.connector}_job_watch and send once it stops, or ${job.connector}_job_cancel first (wait for process cleanup if reserved)`
      );
    if (!job.sessionId) throw new Error('Job has no sessionId; cannot send a follow-up');
  }

  async send(
    jobId: string,
    message: string,
    overrides: Pick<StartOptions, 'mode' | 'model' | 'effort' | 'timeoutMin'> = {}
  ) {
    await this.initialize();
    const original = this.store.get(jobId);
    this.assertSendable(original);
    if (!message.trim()) throw new Error('Follow-up message must not be empty');
    const result = await this.start({ ...overrides, prompt: message, cwd: original.cwd }, jobId);
    return { jobId: result.jobId, state: result.state, followUpOf: jobId };
  }

  watch(jobId: string, maxWaitSec = 1800, options: WatchOptions = {}) {
    return watchJob(this, jobId, maxWaitSec, options, this.watchShutdown.signal);
  }

  async steer(jobId: string, message: string) {
    await this.initialize();
    const job = this.store.get(jobId);
    if (!this.owns(job)) throw new Error('Only the owning server can steer this job');
    if (job.state !== 'running') throw new Error('Only a running job can be steered');
    if (!message.trim()) throw new Error('Steer message must not be blank');
    const active = this.active.get(jobId);
    if (!active?.process.steer) throw new Error(`this job can't take mid-turn messages; use ${this.connector.id}_job_send after it stops, or start it with transport: app-server`);
    if (active.cancelled) throw new Error('Job is stopping');
    const { delivered } = await active.process.steer(message);
    appendFileSync(join(this.store.dir(jobId), 'steer.log'), JSON.stringify({ timestamp: new Date().toISOString(), message }) + '\n');
    active.job.steers = (active.job.steers ?? 0) + 1;
    this.store.save(active.job, this.owner);
    return { delivered };
  }

  async respond(jobId: string, decision: ApprovalDecision) {
    await this.initialize();
    const job = this.store.get(jobId);
    if (!this.owns(job)) throw new Error('Only the owning server can respond to this job');
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) throw new Error('Invalid approval decision');
    const active = this.active.get(jobId);
    if (job.state !== 'running' || !job.pendingApproval || !active?.process.respond || active.cancelled)
      throw new Error('No pending approval for this running job');
    active.process.respond(decision);
    return { responded: true };
  }

  // Must run under the shared lock after the replacement exists. Quota pauses are independent.
  private supersede(job: JobMeta, replacementId: string): void {
    Object.assign(job, {
      state: 'killed',
      reason: 'superseded',
      supersededBy: replacementId,
      pauseCleared: true,
      finishedAt: Date.now(),
    });
    this.store.write(job);
  }

  private pump(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    for (const active of this.active.values()) active.sample?.();
    return (this.pumping ??= this.promote().finally(() => {
      this.pumping = undefined;
    }));
  }

  // detect() can spawn the CLI (agy runs `agy --version`), and the pump ticks every 500 ms in
  // every server instance, so the queue reuses the answer for DETECT_TTL_MS.
  private detected?: { available: boolean; at: number };
  private lastForeignSweep = 0;
  private async pumpAvailable(): Promise<boolean> {
    const now = Date.now();
    if (!this.detected || now - this.detected.at >= DETECT_TTL_MS)
      this.detected = { available: (await this.connector.detect()).available, at: now };
    return this.detected.available;
  }

  private async promote(): Promise<void> {
    if (
      this.config.connectors[this.connector.id]?.enabled === false ||
      !(await this.pumpAvailable())
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
        // Other servers' jobs only need an occasional liveness check; doing it every 500 ms in
        // every server instance was the main CPU/battery cost on Windows.
        const sweepForeign = now - this.lastForeignSweep >= FOREIGN_SWEEP_MS;
        if (sweepForeign) this.lastForeignSweep = now;
        const liveOwners = new Map<string, boolean>();
        for (const job of sweepForeign ? jobs : []) {
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
            await this.recoverOrphan(job, now);
          }
        }
        // Pauses live in their own per-connector (and per-model) state, so handing a paused job
        // to another connector cannot lift them. Expired ones are dropped here.
        const replacements = new Map<string, string>();
        // list() is newest first; prefer the latest replacement when recovering old records.
        for (const job of jobs) {
          for (const originalId of [job.requeuedFrom, job.followUpOf]) {
            if (originalId && !replacements.has(originalId))
              replacements.set(originalId, job.id);
          }
        }
        const saved = this.store.pauses();
        const pauses = saved.filter(pause => !pause.resetAt || pause.resetAt > now);
        if (pauses.length !== saved.length) this.store.writePauses(pauses);
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
          const replacementId = replacements.get(job.id);
          if (job.state === 'paused' && replacementId) {
            this.supersede(job, replacementId);
            continue;
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
                p.connector === job.connector && (!p.model || !job.model || p.model === job.model)
            );
          if (pause) {
            Object.assign(job, {
              state: 'paused',
              reason: 'usage_limit',
              resetAt: pause.resetAt,
              pauseModel: pause.model,
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
    let stalledKill = false;
    let workerDone = false;
    let sizes = [0, 0];
    let lastGrowth = Date.now();
    try {
      const prompt = this.store.read(job.id, 'prompt');
      atomicWrite(job.finalPath, '');
      job.finishedAt = undefined;
      job.error = undefined;
      job.pendingApproval = undefined;
      job.approvalReason = undefined;
      job.exitCode = undefined;
      const command = this.connector.build({
        ...job,
        prompt: job.worktree
          ? `${prompt}\n\nDo not commit changes; the orchestrator will collect the patch.`
          : prompt,
      });
      const receive = (parsed: JobEvent | null) => {
        if (!parsed) return;
        if (parsed.reasoning) {
          const path = this.store.path(job.id, 'reasoning');
          const previous = readFileSync(path);
          const combined = Buffer.concat([previous, Buffer.from(parsed.reasoning + '\n')]);
          let tail = combined.subarray(Math.max(0, combined.length - 256 * 1024));
          while (tail.length && (tail[0] & 0xc0) === 0x80) tail = tail.subarray(1);
          atomicWrite(path, tail);
        }
        event = { ...event, ...parsed, usageLimit: parsed.usageLimit ?? event.usageLimit };
        if (parsed.final && !parsed.error) event.error = undefined;
        let changed = false;
        if (parsed.sessionId) { job.sessionId = parsed.sessionId; changed = true; }
        if ('pendingApproval' in parsed) { job.pendingApproval = parsed.pendingApproval ?? undefined; changed = true; }
        if (parsed.approvalReason) { job.approvalReason = parsed.approvalReason; job.reason = parsed.approvalReason; changed = true; }
        if (changed) this.store.save(job, this.owner);
      };
      const process = startProcess({
        ...command,
        cwd: job.cwd,
        stdout: this.store.path(job.id, 'stdout'),
        stderr: this.store.path(job.id, 'stderr'),
        onSpawn: async identity => {
          job.state = 'running';
          job.process = identity;
          job.startedAt = Date.now();
          lastGrowth = job.startedAt;
          sizes = [statSync(this.store.path(job.id, 'stdout')).size, statSync(this.store.path(job.id, 'stderr')).size];
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
        onEvent: receive,
        onLine: (line, stream) => receive(this.connector.parse(line, stream)),
      });
      const finished = process.done
        .then(async outcome => {
          workerDone = true;
          job.pendingApproval = undefined;
          killFailed = outcome.killFailed ?? false;
          clearTimeout(timer);
          if (event.final && !(await this.store.page(job.id, 'final', 0, 20000)).text.trim())
            atomicWrite(job.finalPath, event.final);
          if (outcome.kind === 'exit' && outcome.code === 0 && !event.error && !event.usageLimit && job.verifyCommand) {
            let shell: string;
            try { shell = await this.resolveVerifyShell(); } catch (error) {
              if (this.active.get(job.id)?.cancelled) { await this.settle(job, { kind: 'cancel', code: null }, event); return; }
              throw error;
            }
            if (this.active.get(job.id)?.cancelled) { await this.settle(job, { kind: 'cancel', code: null }, event); return; }
            const started = Date.now();
            let output = '';
            const verifyProcess = startProcess({
              exe: shell, args: ['-c', job.verifyCommand], cwd: job.cwd,
              stdout: this.store.path(job.id, 'verify'), stderr: this.store.path(job.id, 'verify'),
              onSpawn: async identity => { job.process = identity; job.descendants = []; this.store.save(job, this.owner); },
              onSnapshot: identities => { job.descendants = identities; this.store.save(job, this.owner); },
              onLine: () => {}, onData: data => { output = (output + data).slice(-65536); },
            });
            const active = this.active.get(job.id);
            if (active) active.process = verifyProcess;
            const verifyTimer = setTimeout(() => void verifyProcess.stop('timeout'), (job.verifyTimeoutMin ?? 10) * 60000);
            const checked = await verifyProcess.done;
            clearTimeout(verifyTimer);
            // Keep a bounded output tail in the public verification file.
            atomicWrite(this.store.path(job.id, 'verify'), output + (checked.error ? `\n${checked.error}` : ''));
            job.verify = { command: job.verifyCommand, exitCode: checked.code, passed: checked.kind === 'exit' && checked.code === 0, durationSec: (Date.now() - started) / 1000, timedOut: checked.kind === 'timeout' };
            if (checked.kind === 'cancel') { await this.settle(job, checked, event); return; }
            if (checked.killFailed) { killFailed = true; await this.settle(job, checked, event); return; }
          }
          await this.settle(job, outcome, event, stalledKill);
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
      this.active.set(job.id, { job, process, finished, cancelled: false, sample: () => {
        if (workerDone || job.pendingApproval || job.state !== 'running' || !(job.stallTimeoutMin ?? 10) || stalledKill) return;
        const current = [statSync(this.store.path(job.id, 'stdout')).size, statSync(this.store.path(job.id, 'stderr')).size];
        const now = Date.now();
        if (current[0] > sizes[0] || current[1] > sizes[1]) {
          lastGrowth = now;
          if (job.stalled) { job.stalled = false; job.stalledSince = undefined; this.store.save(job, this.owner); }
        }
        sizes = current;
        if (!job.stalled && now - lastGrowth >= (job.stallTimeoutMin ?? 10) * 60000) {
          job.stalled = true; job.stalledSince = lastGrowth; this.store.save(job, this.owner);
          if (job.onStall === 'kill') { stalledKill = true; void process.stop(); }
        }
      } });
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

  private async settle(job: JobMeta, outcome: ProcessOutcome, event: JobEvent, stalledKill = false): Promise<void> {
    job.reserved = outcome.killFailed ?? false;
    job.exitCode = outcome.code;
    job.finishedAt = Date.now();
    job.error = (outcome.error ?? event.error)?.slice(0, 20000);
    if (outcome.killFailed) {
      job.state = 'failed';
      job.reason = 'kill-failed';
    } else if (outcome.kind === 'cancel') {
      job.state = 'killed';
      job.reason = stalledKill ? 'stalled' : 'cancelled';
    } else if (outcome.kind === 'timeout') {
      job.state = 'failed';
      job.reason = 'timeout';
    } else if (event.usageLimit) {
      job.state = 'paused';
      job.reason = 'usage_limit';
      job.resetAt = event.usageLimit.resetAt;
      job.pauseModel = event.usageLimit.model;
      await this.recordQuota(job, event.usageLimit);
    } else if (outcome.kind === 'error' || outcome.code !== 0 || event.error) {
      job.state = 'failed';
      job.reason = job.approvalReason ?? (outcome.kind === 'error' ? 'spawn_error' : 'cli_error');
    } else {
      job.state = 'completed';
      job.reason = job.approvalReason;
      await this.recordQuota(job);
    }
    this.store.save(job, this.owner);
  }

  // A usage limit adds or extends the connector's pause (no reset time means until lifted). A
  // job that started after the pause and completed proves the quota is back, which lifts it.
  private recordQuota(job: JobMeta, limit?: { resetAt?: number; model?: string }): Promise<void> {
    return withLock(this.config.home, () => {
      const matches = (pause: QuotaPause, model?: string) =>
        pause.connector === job.connector && pause.model === model;
      let pauses = this.store.pauses();
      if (limit) {
        const existing = pauses.find(pause => matches(pause, limit.model));
        const resetAt =
          existing && (!existing.resetAt || !limit.resetAt)
            ? undefined
            : Math.max(existing?.resetAt ?? 0, limit.resetAt ?? 0) || undefined;
        pauses = pauses.filter(pause => pause !== existing);
        pauses.push({ connector: job.connector, model: limit.model, resetAt, since: Date.now() });
      } else {
        pauses = pauses.filter(
          pause =>
            pause.connector !== job.connector ||
            (pause.model !== undefined && pause.model !== job.model) ||
            pause.since > (job.startedAt ?? 0)
        );
      }
      this.store.writePauses(pauses);
    });
  }

  async list(limit = 50) {
    await this.initialize();
    return this.store.list().slice(0, Math.min(100, Math.max(1, limit)));
  }

  private tail(id: string, name: 'stdout' | 'stderr', count = 20): string {
    return this.store.tail(id, name, count).slice(-10000);
  }

  private publicEvents(id: string, count = 20): string {
    return this.tail(id, 'stdout', count).split('\n').map(line => {
      try { const event = JSON.parse(line); return event.item?.type === 'reasoning' ? JSON.stringify({ type: event.type, item: { type: 'reasoning' } }) : line; }
      catch { return line.endsWith('"}}') ? '' : line; }
    }).join('\n');
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
      steers: job.steers ?? 0,
      elapsedSec: ((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000,
      stderr: this.tail(jobId, 'stderr'),
      events: this.publicEvents(jobId),
    };
  }

  async result(jobId: string, waitSec = 0, includeReasoning = false) {
    await this.initialize();
    const deadline = Date.now() + Math.min(10, Math.max(0, waitSec)) * 1000;
    let job = this.store.get(jobId);
    while (['queued', 'running'].includes(job.state) && Date.now() < deadline) {
      await sleep(Math.min(100, deadline - Date.now()));
      job = this.store.get(jobId);
    }
    const final = await this.store.page(jobId, 'final', 0, 20000);
    if (!['queued', 'running'].includes(job.state)) writeFileSync(resolve(this.store.dir(jobId), 'collected'), '');
    let reasoningTail: string | undefined;
    if (includeReasoning) {
      try { reasoningTail = readFileSync(this.store.path(jobId, 'reasoning'), 'utf8').slice(-4000); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return {
      ...(includeReasoning && reasoningTail ? { reasoningTail } : {}),
      stalled: job.stalled ?? false,
      stalledSince: job.stalledSince,
      jobId,
      state: job.state,
      verify: job.verify,
      reason: job.reason,
      failureReason: job.failureReason,
      partial: job.partial,
      supersededBy: job.supersededBy,
      error: job.error?.slice(0, 20000),
      sessionId: job.sessionId,
      resetAt: job.resetAt,
      final: final.text,
      truncated: final.total > 20000,
      finalPath: job.finalPath,
      // Only once a job has stopped with no final text: while it runs, the
      // stdout tail is raw event JSON that would flood the caller's context.
      diagnostics:
        final.text.trim() || ['queued', 'running'].includes(job.state)
          ? undefined
          : compactDiagnostics(this.tail(jobId, 'stderr', 30), this.publicEvents(jobId, 30)),
    };
  }

  async read(jobId: string, name: JobFile, offset = 0, limit = 20000) {
    await this.initialize();
    this.store.get(jobId);
    const start = Math.max(0, Math.floor(offset));
    if (name === 'reasoning') {
      try { statSync(this.store.path(jobId, name)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return { text: '', offset: start, nextOffset: 0, total: 0, path: this.store.path(jobId, name) };
      }
    }
    return this.store.page(jobId, name, start, Math.min(20000, Math.max(1, Math.floor(limit))));
  }

  async cancel(jobId: string) {
    await this.initialize();
    let active: { process: RunningProcess; finished: Promise<void>; cancelled: boolean } | undefined;
    let retry: JobMeta | undefined;
    await withLock(this.config.home, () => {
      const job = this.store.get(jobId);
      if (!this.owns(job)) throw new Error('Only the owning server can cancel this job');
      if (job.reason === 'kill-failed' && job.reserved) retry = job;
      else { active = this.active.get(jobId); if (active) active.cancelled = true; }
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
    // The slow availability check stays outside the lock; the record is read again inside it.
    if (agent === this.connector.id) await this.available();
    const result = await withLock(this.config.home, () => {
      const original = this.store.get(jobId);
      if (!['paused', 'lost', 'failed'].includes(original.state) && !(original.state === 'killed' && original.reason === 'stalled') && !(original.state === 'completed' && original.verify?.passed === false))
        throw new Error('Only paused, lost, failed or stalled jobs can be requeued');
      if (original.reserved)
        throw new Error(
          'The process is still alive after kill-failed or owner loss; wait until cleanup is confirmed before requeueing'
        );
      if (original.worktree?.removed)
        throw new Error('The worktree was removed; start a new job with the saved prompt');
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
        pendingApproval: undefined,
        approvalReason: undefined,
        steers: 0,
        reason: undefined,
        failureReason: undefined,
        partial: undefined,
        idempotencyKey: undefined,
        error: undefined,
        resetAt: undefined,
        pauseModel: undefined,
        exitCode: undefined,
        verify: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: undefined,
        stalled: false,
        stalledSince: undefined,
        finishedAt: undefined,
        finalPath: this.store.path(id, 'final'),
      };
      meta.pauseCleared = false;
      meta.manualRequeue = true;
      meta.requeuedFrom = original.id;
      this.store.create(meta, this.store.read(jobId, 'prompt'));
      // Publishing the replacement and suppressing the original's retry are one critical section.
      if (original.state === 'paused') this.supersede(original, id);
      return { jobId: id, state: meta.state };
    });
    void this.pump().catch(error => this.logger.warn('Job queue error', error));
    return result;
  }

  // The whole collect runs under the shared lock. That is the reservation: promotion, requeue and
  // other collects cannot start a job in this worktree while it is saved and possibly removed.
  // Trade-off: the git calls (10 minute timeout each) stall both forks' queues while they run.
  async collect(jobId: string, remove: 'none' | 'worktree' | 'worktree+branch' = 'none') {
    await this.initialize();
    return withLock(this.config.home, async () => {
      const job = this.store.get(jobId);
      if (!job.worktree) throw new Error('This job has no worktree');
      if (job.state === 'running' || job.reserved || job.state === 'queued')
        throw new Error('Wait for the job to stop before collecting its worktree');
      if (!this.owns(job))
        throw new Error('Only the owning server can collect this job; requeue a lost job first');
      // Requeue copies the worktree reference, so every job that points at it must be idle.
      // A paused job that was requeued will never resume and does not count.
      const sharing = this.store
        .list()
        .filter(other => other.id !== job.id && other.worktree?.path === job.worktree!.path);
      const busy = sharing.find(
        other =>
          other.reserved || (!terminal(other) && !(other.state === 'paused' && other.pauseCleared))
      );
      if (busy)
        throw new Error(`Job ${busy.id} still uses this worktree; wait for it to stop first`);
      const result = await collectWorktree(job.worktree, this.store.path(jobId, 'patch'), remove, this.config.home);
      if (job.worktree.removed && job.state === 'paused') job.pauseCleared = true;
      this.store.save(job, this.owner);
      if (job.worktree.removed)
        for (const other of sharing) {
          if (!other.worktree) continue;
          other.worktree.removed = true;
          this.store.write(other);
        }
      return result;
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.watchShutdown.abort();
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
