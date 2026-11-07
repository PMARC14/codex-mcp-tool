import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobSpec } from '../jobs/connector.js';

export const BRIDGE_PREAMBLE = 'If you need a decision or information from the orchestrator, call `ask_orchestrator`; use `report_progress` for milestone notes.';

/** Per-run dotted TOML overrides. Never change the user's Codex configuration. */
export function codexBridge(job: JobSpec, path = fileURLToPath(new URL('../bridge/agent-bridge.js', import.meta.url))): { config: Record<string, unknown>; args: string[]; prompt: string } {
  if (!existsSync(path)) return { config: {}, args: [] as string[], prompt: job.prompt };
  const base = 'mcp_servers.agent_bridge';
  const overrides: Record<string, unknown> = {
    [`${base}.command`]: process.execPath,
    [`${base}.args`]: [path],
    [`${base}.env.AGENT_JOBS_HOME`]: dirname(dirname(dirname(job.finalPath))),
    [`${base}.env.AGENT_JOB_ID`]: job.id,
    [`${base}.enabled`]: true,
    [`${base}.enabled_tools`]: ['ask_orchestrator', 'report_progress'],
    // Covers the bridge's maximum timeout, including process/transport overhead.
    [`${base}.tool_timeout_sec`]: 86500,
    [`${base}.tools.ask_orchestrator.approval_mode`]: 'approve',
    [`${base}.tools.report_progress.approval_mode`]: 'approve',
  };
  const config = { mcp_servers: { agent_bridge: {
    command: process.execPath, args: [path],
    env: { AGENT_JOBS_HOME: dirname(dirname(dirname(job.finalPath))), AGENT_JOB_ID: job.id },
    enabled: true, enabled_tools: ['ask_orchestrator', 'report_progress'], tool_timeout_sec: 86500,
    tools: { ask_orchestrator: { approval_mode: 'approve' }, report_progress: { approval_mode: 'approve' } },
  } } };
  return { config, args: Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    prompt: `${BRIDGE_PREAMBLE}\n\n${job.prompt}` };
}
