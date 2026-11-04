import type { Writable } from 'node:stream';
import type { JobEvent } from './connector.js';

export interface StdinAction {
  write?: string;
  close?: boolean;
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type SteerResult = StdinAction & { delivered: 'mid-turn' | 'queued' };
export interface StdinContext {
  apply(action: StdinAction): void;
  emit(event: JobEvent): void;
}
export interface StdinHandler {
  (line: string, stream: 'stdout' | 'stderr'): StdinAction | void;
  onSteer?(message: string): SteerResult | Promise<SteerResult>;
  onRespond?(decision: ApprovalDecision): StdinAction;
  onInterrupt?(): StdinAction | void;
  dispose?(): void;
}

/** A fresh handler per process, including retries. Absence preserves write-and-close input. */
export type StdinPlan = (context: StdinContext) => StdinHandler;

export function closedPipe(error: unknown): boolean {
  return ['EPIPE', 'EOF', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']
    .includes((error as NodeJS.ErrnoException)?.code ?? '');
}

/** Child exit can race either operation, on Windows as well as POSIX. */
export function updateStdin(pipe: Writable | null | undefined, action: StdinAction): void {
  if (!pipe || pipe.destroyed || pipe.writableEnded) return;
  try {
    if (action.write !== undefined) pipe.write(action.write, 'utf8');
  } catch (error) {
    if (!closedPipe(error)) throw error;
  } finally {
    if (action.close) {
      try { pipe.end(); } catch (error) { if (!closedPipe(error)) throw error; }
    }
  }
}
