import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressReporter } from './progress.js';

test('progress token zero is valid, completion stays monotonic past 100, and absent tokens send nothing', async () => {
  const notifications: { progressToken: string | number; progress: number }[] = [];
  const notify = async (params: { progressToken: string | number; progress: number }) => {
    notifications.push(params);
  };
  const reporter = new ProgressReporter(0, notify);
  for (let i = 0; i < 120; i++) await reporter.send('working');
  await reporter.send('completed');
  assert.equal(notifications.length, 121);
  assert.equal(notifications[0].progressToken, 0);
  assert.deepEqual(
    notifications.map(item => item.progress),
    Array.from({ length: 121 }, (_, i) => i)
  );
  const absent = new ProgressReporter(undefined, notify);
  await absent.send('starting');
  await absent.send('completed');
  assert.equal(notifications.length, 121);
});
