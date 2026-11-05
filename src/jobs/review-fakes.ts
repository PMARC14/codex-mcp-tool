import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/** In-memory child for process and Git regression tests; never starts a CLI. */
export function fakeChild(pid = 424242) {
  const child = Object.assign(new EventEmitter(), {
    pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killCalls: [] as (NodeJS.Signals | number | undefined)[],
    kill(signal?: NodeJS.Signals | number) { this.killCalls.push(signal); return true; },
    close(code = 0) { child.exitCode = code; child.emit('exit', code, null); child.emit('close', code, null); },
  });
  return child as typeof child & ChildProcess;
}

export const flush = () => new Promise<void>(resolve => setImmediate(resolve));
