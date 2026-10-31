import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface JobsConfig {
  home: string;
  maxJobs: number;
  wakeHold: boolean;
  connectors: Record<
    string,
    {
      enabled?: boolean;
      defaultModel?: string | null;
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
  return { home, maxJobs, wakeHold: config.wakeHold ?? true, connectors: config.connectors ?? {} };
}
