import test from 'node:test';
import assert from 'node:assert/strict';
import { runProductCatchUp } from '../product-catchup.js';

test('product catch-up processes completed windows until exhaustion', async () => {
  const calls = [];
  const results = [
    { status: 'completed', window_id: 'one' },
    { status: 'completed', window_id: 'two' },
    null,
  ];
  const result = await runProductCatchUp({
    ingestOne: async ({ rescan }) => {
      calls.push({ rescan });
      return results.shift();
    },
    rescan: true,
  });

  assert.equal(result.windows, 2);
  assert.equal(result.last.window_id, 'two');
  assert.deepEqual(calls, [{ rescan: true }, { rescan: false }, { rescan: false }]);
});

test('product catch-up stops on partial failure and honors cancellation', async () => {
  let calls = 0;
  const partial = await runProductCatchUp({
    ingestOne: async () => {
      calls++;
      return { status: 'partial', window_id: 'failed-window' };
    },
  });
  assert.equal(partial.windows, 1);
  assert.equal(calls, 1);

  let cancelledCalls = 0;
  const cancelled = await runProductCatchUp({
    ingestOne: async () => {
      cancelledCalls++;
      return { status: 'completed', window_id: 'never' };
    },
    shouldAbort: () => true,
  });
  assert.equal(cancelled.windows, 0);
  assert.equal(cancelledCalls, 0);
});
