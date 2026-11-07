import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface JobsConfig {
  home: string;
  maxJobs: number;
  wakeHold: boolean;
  usageCeiling?: number;
  /** Minutes between CLI version/sign-in checks and usage probes (AC / battery). */
  usage?: { intervalMin?: number; batteryIntervalMin?: number };
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
  const transport = env.AGENT_JOBS_CODEX_TRANSPORT ?? connectors.codex?.defaultTransport ?? 'app-server';
  if (transport !== 'exec' && transport !== 'app-server')
    throw new Error('AGENT_JOBS_CODEX_TRANSPORT / connectors.codex.defaultTransport must be exec or app-server');
  // Resolution order: environment, then config.json, then the connector's own default
  // (Connector.defaultTransport: app-server for Codex). exec stays selectable.
  if (env.AGENT_JOBS_CODEX_TRANSPORT !== undefined || connectors.codex?.defaultTransport !== undefined)
    connectors.codex = { ...connectors.codex, defaultTransport: transport };
  return { home, maxJobs, usageCeiling: config.usageCeiling ?? 90, wakeHold: config.wakeHold ?? true, connectors, usage: config.usage };
}

export const DEFAULT_USAGE_INTERVAL_MIN = 15;
export const DEFAULT_USAGE_BATTERY_INTERVAL_MIN = 30;

/**
 * Cadence of version/sign-in checks and usage probes, in milliseconds. Order: environment
 * (AGENT_JOBS_USAGE_INTERVAL_MIN, AGENT_JOBS_USAGE_BATTERY_INTERVAL_MIN), then
 * config.json usage.{intervalMin,batteryIntervalMin}, then 15 and 30 minutes. Tolerant: a bad
 * value falls back to the next source, and the battery interval is never shorter than the AC one.
 */
export function usageIntervals(env: NodeJS.ProcessEnv = process.env): { intervalMs: number; batteryIntervalMs: number } {
  let file: JobsConfig['usage'];
  try {
    file = JSON.parse(readFileSync(join(resolve(env.AGENT_JOBS_HOME || join(homedir(), '.agent-jobs')), 'config.json'), 'utf8')).usage;
  } catch { /* No or unreadable config: defaults. */ }
  const pick = (...values: unknown[]) => {
    for (const value of values) {
      const n = typeof value === 'string' && value.trim() ? Number(value) : value;
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  };
  const interval = pick(env.AGENT_JOBS_USAGE_INTERVAL_MIN, file?.intervalMin) ?? DEFAULT_USAGE_INTERVAL_MIN;
  const battery = pick(env.AGENT_JOBS_USAGE_BATTERY_INTERVAL_MIN, file?.batteryIntervalMin) ?? DEFAULT_USAGE_BATTERY_INTERVAL_MIN;
  return { intervalMs: interval * 60_000, batteryIntervalMs: Math.max(battery, interval) * 60_000 };
}
