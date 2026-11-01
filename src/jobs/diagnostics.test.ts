import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactDiagnostics } from './manager.js';

test('diagnostics stay small: 30 lines, 300 characters per line, 4000 in total', () => {
  const long = 'x'.repeat(5000);
  const out = compactDiagnostics([long, long].join('\n'), Array.from({ length: 100 }, (_, i) => `event ${i} ${long}`).join('\n'));
  assert.ok(out.length <= 4000, `got ${out.length}`);
  for (const line of out.split('\n')) assert.ok(line.length <= 301, `line of ${line.length}`);
  assert.match(out, /event 99/);
  assert.doesNotMatch(out, /event 69 /);
});

test('short diagnostics pass through unchanged apart from trimming', () => {
  assert.equal(compactDiagnostics('denied: command\n', '{"type":"turn.failed"}\n'), 'denied: command\n{"type":"turn.failed"}');
});
