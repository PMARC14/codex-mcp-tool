import { codexBridge } from './codexBridge.js';
import type { Connector, JobEvent, JobSpec } from '../jobs/connector.js';
import {
  resolveBinary,
  describeUnresolvedBinary,
  CODEX_PATH_ENV,
} from '../utils/binaryResolver.js';
import { MODELS } from '../constants.js';
import { getCodexVersion, checkMinimumCodexVersion } from '../utils/versionDetection.js';
import { runCommand } from '../jobs/proc.js';
import { readCodexUsage, readLiveCodexUsage, type CodexUsage } from '../utils/codexUsage.js';
import { usageLimit } from '../jobs/usage-reset.js';
import { buildAppServer, parseAppServer } from './codexAppServer.js';
import { getUsage, type UsageCacheOptions } from '../jobs/usage-cache.js';

export { usageReset } from '../jobs/usage-reset.js';

export const NOT_SIGNED_IN_REASON = 'Codex is not signed in: run codex login';

interface CodexUsageOptions extends UsageCacheOptions {
  live?: typeof readLiveCodexUsage;
  local?: typeof readCodexUsage;
}

export class CodexConnector implements Connector {
  readonly id = 'codex';
  readonly reviewModel = 'gpt-6-astra';
  readonly defaultTransport = 'app-server' as const;

  isNoise(line: string): boolean {
    try {
      const event = JSON.parse(line);
      return event?.id === undefined && ['skills/changed', 'account/rateLimits/updated', 'mcpServer/startupStatus/updated'].includes(event?.method);
    } catch { return false; }
  }

  constructor(
    private run = runCommand,
    private resolve = () => resolveBinary('codex', CODEX_PATH_ENV),
    private now = () => Date.now(),
    private usageOptions: CodexUsageOptions = {}
  ) {}

  private usageSnapshot(command = this.resolve().command, force = false) {
    return getUsage<CodexUsage>(this.id, async () => {
      const usage = await (this.usageOptions.live ?? readLiveCodexUsage)(command);
      return { ok: usage?.available === true, raw: usage ?? null, parsed: usage ?? null };
    }, { ...this.usageOptions, now: this.now, ...(force ? { force: true } : {}) });
  }

  /** Job edge: one probe (at most one per 60 s) that also restarts the interval timer. */
  async refreshUsage(): Promise<void> {
    const resolution = this.resolve();
    if (!resolution.resolved) return;
    await this.usageSnapshot(resolution.command, true);
  }

  /** All live usage consumers, including auth detection, share the disk snapshot. */
  async usage(): Promise<CodexUsage> {
    const snapshot = await this.usageSnapshot();
    if (snapshot?.ok && snapshot.parsed) return snapshot.parsed;
    const local = (this.usageOptions.local ?? readCodexUsage)();
    return local.available ? local : snapshot?.parsed ?? local;
  }

  async usagePercent(_model?: string): Promise<number | undefined> {
    const usage = await this.usage();
    const values = [usage.fiveHour?.usedPercent, usage.weekly?.usedPercent].filter((value): value is number => typeof value === 'number');
    return values.length ? Math.max(...values) : undefined;
  }

  private async checkLogin(command: string): Promise<{ available: boolean; reason?: string }> {
    const snapshot = await this.usageSnapshot(command);
    const raw = snapshot?.raw;
    const reason = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && 'reason' in raw ? String(raw.reason) : '';
    // Usage success implies auth. An unavailable/unknown probe fails open; never
    // launch a separate login-status CLI just to disambiguate it.
    const denied = /\bnot (?:logged|signed) in\b|unauthenticated|authentication required/i.test(reason);
    return { available: !denied, ...(denied ? { reason: NOT_SIGNED_IN_REASON } : {}) };
  }

  protected async versionCheck() {
    return { version: await getCodexVersion(), minimum: await checkMinimumCodexVersion() };
  }

  async detect() {
    const resolution = this.resolve();
    if (!resolution.resolved)
      return {
        available: false,
        reason: describeUnresolvedBinary('codex', resolution, CODEX_PATH_ENV),
      };
    const { version, minimum } = await this.versionCheck();
    if (!version.isValid || !minimum.ok)
      return {
        available: false,
        exe: resolution.command,
        version: version.raw,
        reason:
          minimum.message ||
          'Codex CLI could not start. Install a supported CLI, run codex login, and reconnect this MCP server.',
      };
    const login = await this.checkLogin(resolution.command);
    if (!login.available)
      return {
        available: false,
        exe: resolution.command,
        version: version.raw,
        reason: login.reason,
      };
    return { available: true, exe: resolution.command, version: version.raw };
  }

  async models(): Promise<string[]> {
    try {
      const resolution = this.resolve();
      if (resolution.resolved) {
        const catalog = JSON.parse(
          await this.run(resolution.command, ['debug', 'models'], undefined, 10000)
        );
        const entries = Array.isArray(catalog) ? catalog : catalog.models;
        if (Array.isArray(entries)) {
          const models = entries
            .map(item => (typeof item === 'string' ? item : (item.slug ?? item.id ?? item.model)))
            .filter((id): id is string => typeof id === 'string');
          if (models.length) return models;
        }
      }
    } catch {
      /* Older/offline CLIs still have a useful known-model list. */
    }
    return Object.values(MODELS);
  }

  async health() {
    const detection = await this.detect();
    return {
      ...detection,
      models: await this.models(),
      reviewModel: this.reviewModel,
    };
  }

  sandboxDirs(job: JobSpec): string[] {
    return job.worktree ? [job.worktree.gitDir] : [];
  }

  bridgeConfig(job: JobSpec) { return codexBridge(job); }

  build(job: JobSpec) {
    if (job.transport === 'app-server') return buildAppServer(job, this.resolve().command, this.bridgeConfig(job));
    const bridge = this.bridgeConfig(job);
    const args: string[] = [...bridge.args];
    // Sandbox flags are global; exec resume accepts only a subset of exec flags.
    if (job.mode === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', { read: 'read-only', write: 'workspace-write', trusted: 'danger-full-access' }[job.mode]);
    if (job.model) args.push('-m', job.model);
    if (job.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(job.effort)}`);
    for (const dir of this.sandboxDirs(job)) args.push('--add-dir', dir);
    args.push('exec');
    if (job.resumeSession) args.push('resume', job.resumeSession);
    // Advice and debate jobs run outside any repo; Codex refuses those without this.
    args.push('--skip-git-repo-check', '--json', '-o', job.finalPath, '-');
    return { exe: this.resolve().command, args, stdin: bridge.prompt };
  }

  parse(line: string, _stream: 'stdout' | 'stderr'): JobEvent | null {
    const appEvent = parseAppServer(line, _stream);
    if (appEvent) return appEvent;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      if (!/usage limit/i.test(line)) return null;
      event = { type: 'error', message: line };
    }
    if (!event || typeof event !== 'object') return null;
    if (event.type === 'item.completed' && event.item?.type === 'reasoning' && typeof event.item.text === 'string')
      return { reasoning: event.item.text };
    if (event.type === 'thread.started' && typeof event.thread_id === 'string')
      return { sessionId: event.thread_id };
    if (
      event.type === 'item.completed' &&
      event.item?.type === 'agent_message' &&
      typeof event.item.text === 'string'
    )
      return { final: event.item.text };
    if (event.type === 'error' || event.type === 'turn.failed') {
      const message =
        event.message ??
        event.error?.message ??
        (typeof event.error === 'string' ? event.error : JSON.stringify(event.error ?? event));
      const error = String(message);
      return {
        error,
        usageLimit: /(?:hit your|reached|exceeded|hit the)?\s*usage limit/i.test(error)
          ? usageLimit(error)
          : undefined,
      };
    }
    return null;
  }
}
