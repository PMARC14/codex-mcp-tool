import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { updateStdin } from './stdin.js';

test('stdin actions write once, close, and ignore later actions', () => {
  const pipe = new PassThrough();
  updateStdin(pipe, { write: 'first' });
  assert.equal(pipe.writableEnded, false);
  updateStdin(pipe, { write: 'second', close: true });
  updateStdin(pipe, { write: 'ignored', close: true });
  assert.equal(pipe.read().toString(), 'firstsecond');
  assert.equal(pipe.writableEnded, true);
});

test('stdin actions ignore synchronous pipe errors on write and close', () => {
  for (const code of ['EPIPE', 'EOF', 'ECONNRESET']) {
    const pipe = new PassThrough();
    let closed = false;
    pipe.write = () => { throw Object.assign(new Error(code), { code }); };
    pipe.end = (() => { closed = true; throw Object.assign(new Error(code), { code }); }) as typeof pipe.end;
    assert.doesNotThrow(() => updateStdin(pipe, { write: 'second', close: true }));
    assert.equal(closed, true);
  }
});
