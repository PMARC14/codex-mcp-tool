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
  timeoutMin: number;
  finalPath: string;
  worktree?: Worktree;
}

export interface JobMeta extends Omit<JobSpec, 'prompt'> {
  state: JobState;
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
  error?: string;
  resetAt?: number;
  pauseModel?: string;
  exitCode?: number | null;
  pauseCleared?: boolean;
  manualRequeue?: boolean;
  requeuedFrom?: string;
}

export interface JobEvent {
  sessionId?: string;
  final?: string;
  error?: string;
  usageLimit?: { resetAt?: number; model?: string };
}

export interface Connector {
  id: string;
  detect(): Promise<{ available: boolean; reason?: string; version?: string; exe?: string }>;
  models(): Promise<string[]>;
  build(job: JobSpec): { exe: string; args: string[]; stdin: string };
  parse(line: string, stream: 'stdout' | 'stderr'): JobEvent | null;
  sandboxDirs(job: JobSpec): string[];
}
