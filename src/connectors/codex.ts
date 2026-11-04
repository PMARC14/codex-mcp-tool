import type { Connector, JobEvent, JobSpec } from '../jobs/connector.js';
import {
  resolveBinary,
  describeUnresolvedBinary,
  CODEX_PATH_ENV,
} from '../utils/binaryResolver.js';
import { MODELS } from '../constants.js';
import { getCodexVersion, checkMinimumCodexVersion } from '../utils/versionDetection.js';
import { runCommand } from '../jobs/proc.js';
import { usageLimit } from '../jobs/usage-reset.js';

export { usageReset } from '../jobs/usage-reset.js';

export class CodexConnector implements Connector {
  readonly id = 'codex';
  readonly reviewModel = 'gpt-6-astra';

  constructor(
    private run = runCommand,
    private resolve = () => resolveBinary('codex', CODEX_PATH_ENV)
  ) {}

  async detect() {
    const resolution = this.resolve();
    if (!resolution.resolved)
      return {
        available: false,
        reason: describeUnresolvedBinary('codex', resolution, CODEX_PATH_ENV),
      };
    const version = await getCodexVersion();
    const minimum = await checkMinimumCodexVersion();
    if (!version.isValid || !minimum.ok)
      return {
        available: false,
        exe: resolution.command,
        version: version.raw,
        reason:
          minimum.message ||
          'Codex CLI could not start. Install a supported CLI, run codex login, and reconnect this MCP server.',
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

  build(job: JobSpec) {
    const args: string[] = [];
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
    return { exe: this.resolve().command, args, stdin: job.prompt };
  }

  parse(line: string, _stream: 'stdout' | 'stderr'): JobEvent | null {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      if (!/usage limit/i.test(line)) return null;
      event = { type: 'error', message: line };
    }
    if (!event || typeof event !== 'object') return null;
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
