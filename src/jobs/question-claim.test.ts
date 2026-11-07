import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './test-helpers.js';
import { claimQuestion, releaseQuestion } from './question-claim.js';

test('malformed question claims expire after thirty minutes, while fresh claims remain exclusive', () => {
  const f = fixture(); const path = join(f.home, 'question.lock');
  try {
    const claim = { owner: 'bridge', id: 'replacement', ts: Date.now(), timeoutMs: 3600000 };
    writeFileSync(path, '{partial');
    assert.equal(claimQuestion(f.home, claim), false);
    const old = new Date(Date.now() - 31 * 60 * 1000);
    utimesSync(path, old, old);
    assert.equal(claimQuestion(f.home, claim), true);
    assert.equal(claimQuestion(f.home, { ...claim, id: 'other' }), false);
    releaseQuestion(f.home, claim.id);
    assert.equal(claimQuestion(f.home, { ...claim, id: 'other' }), true);
  } finally { f.cleanup(); }
});
