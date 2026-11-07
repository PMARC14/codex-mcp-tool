import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface JobsConfig {
  home: string;
  maxJobs: number;
  wakeHold: boolean;
  usageCeiling?: number;
  connectors: Record<
    string,
    {
      enabled?: boolean;
      defaultModel?: string | null;
      defaultTransport?: 'exec' | 'app-server';
      reviewModel?: string;
      requestOnlyModels?: string[];
    }
  >;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  const home = resolve(env.AGENT_JOBS_HOME || join(homedir(), '.agent-jobs'));
  let config: Partial<JobsConfig> = {};
  try {
    config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const maxJobs = Number(env.AGENT_JOBS_MAX ?? config.maxJobs ?? 8);
  if (!Number.isInteger(maxJobs) || maxJobs < 1)
    throw new Error('AGENT_JOBS_MAX / maxJobs must be a positive integer');
  const connectors = config.connectors ?? {};
  const transport = env.AGENT_JOBS_CODEX_TRANSPORT ?? connectors.codex?.defaultTransport ?? 'exec';
  if (transport !== 'exec' && transport !== 'app-server')
    throw new Error('AGENT_JOBS_CODEX_TRANSPORT / connectors.codex.defaultTransport must be exec or app-server');
  if (env.AGENT_JOBS_CODEX_TRANSPORT !== undefined || connectors.codex?.defaultTransport !== undefined)
    connectors.codex = { ...connectors.codex, defaultTransport: transport };
  return { home, maxJobs, usageCeiling: config.usageCeiling ?? 90, wakeHold: config.wakeHold ?? true, connectors };
}
