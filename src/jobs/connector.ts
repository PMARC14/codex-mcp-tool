import type { StdinPlan } from './stdin.js';

export interface JobLogger {
  warn(message: string, ...details: unknown[]): void;
}

export interface Owner {
  pid: number;
  startTime: string;
}

export type JobState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'killed' | 'lost';
export interface Worktree {
  root: string;
  path: string;
  gitDir: string;
  branch: string;
  baseSha: string;
  warning?: string;
  removed?: boolean;
}

export interface JobSpec {
  id: string;
  connector: string;
  prompt: string;
  cwd: string;
  // trusted: no sandbox but the CLI's normal approval rules. Windows CLI
  // sandboxes break Git Bash/MSYS2 (CreateFileMapping error 5), so jobs that
  // run bash or npm tests need it. full also bypasses approvals.
  mode: 'read' | 'write' | 'trusted' | 'full';
  model?: string;
  effort?: string;
  label?: string;
  resumeSession?: string;
  transport?: 'exec' | 'app-server';
  approvalTimeoutMin?: number;
  timeoutMin: number;
  stallTimeoutMin?: number;
  onStall?: 'report' | 'kill';
  verifyCommand?: string;
  verifyTimeoutMin?: number;
  finalPath: string;
  worktree?: Worktree;
}

export type FailureReason = 'quota_exhausted' | 'timeout' | 'cancelled' | 'stalled' | 'auth' | 'cli_error' | 'kill_failed' | 'lost' | 'superseded' | 'verify_failed';

export interface JobMeta extends Omit<JobSpec, 'prompt'> {
  steers?: number;
  pendingApproval?: { id: string | number; kind: string; summary: string; requestedAt: number };
  approvalReason?: 'approval_timeout';
  verify?: { command: string; exitCode: number | null; passed: boolean; durationSec: number; timedOut: boolean };
  state: JobState;
  stalled?: boolean;
  stalledSince?: number;
  owner?: Owner;
  managerId?: string;
  reserved?: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  process?: Owner;
  descendants?: Owner[];
  sessionId?: string;
  reason?: string;
  failureReason?: FailureReason;
  partial?: boolean;
  idempotencyKey?: string;
  priority?: 'normal' | 'optional';
  error?: string;
  resetAt?: number;
  pauseModel?: string;
  exitCode?: number | null;
  pauseCleared?: boolean;
  manualRequeue?: boolean;
  requeuedFrom?: string;
  followUpOf?: string;
  supersededBy?: string;
  /** Working directory supplied before creating an isolated worktree. */
  originalCwd?: string;
}

export interface JobEvent {
  pendingApproval?: JobMeta['pendingApproval'] | null;
  approvalReason?: 'approval_timeout';
  reasoning?: string;
  sessionId?: string;
  final?: string;
  error?: string;
  usageLimit?: { resetAt?: number; model?: string };
}

export interface Connector {
  id: string;
  detect(): Promise<{ available: boolean; reason?: string; version?: string; exe?: string }>;
  models(): Promise<string[]>;
  usagePercent?(): Promise<number | undefined>;
  build(job: JobSpec): { exe: string; args: string[]; stdin: string; stdinPlan?: StdinPlan };
  parse(line: string, stream: 'stdout' | 'stderr'): JobEvent | null;
  sandboxDirs(job: JobSpec): string[];
}
