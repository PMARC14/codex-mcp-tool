import type { Writable } from 'node:stream';

export interface StdinAction {
  write?: string;
  close?: boolean;
}

/** A fresh handler per process, including retries. Absence preserves write-and-close input. */
export type StdinPlan = () => (line: string, stream: 'stdout' | 'stderr') => StdinAction | void;

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
