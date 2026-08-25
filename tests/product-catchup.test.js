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

test('product catch-up reports a cancelled terminal phase', async () => {
  const events = [];
  const result = await runProductCatchUp({
    ingestOne: async () => ({ status: 'completed', window_id: 'one' }),
    shouldAbort: (() => {
      let calls = 0;
      return () => ++calls > 1;
    })(),
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.cancelled, true);
  assert.equal(events.at(-1).phase, 'cancelled');
});

test('product catch-up stops when a completed window makes no progress', async () => {
  const events = [];
  const result = await runProductCatchUp({
    ingestOne: async () => ({ status: 'completed', window_id: 'same-window', records: [] }),
    maxWindows: 5,
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.windows, 1);
  assert.equal(result.noProgress, true);
  assert.equal(events.at(-1).phase, 'partial');
});

test('product catch-up reports a capped terminal phase when the window limit is reached', async () => {
  const events = [];
  const result = await runProductCatchUp({
    ingestOne: async () => ({ status: 'completed', window_id: 'one' }),
    maxWindows: 1,
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.exhausted, false);
  assert.equal(events.at(-1).phase, 'capped');
});

test('product catch-up preserves a cancelled window as a cancelled terminal outcome', async () => {
  const events = [];
  const result = await runProductCatchUp({
    ingestOne: async () => ({ status: 'cancelled', window_id: 'cancelled-window' }),
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.cancelled, true);
  assert.equal(events.at(-1).phase, 'cancelled');
});

test('product catch-up reports window and projection progress', async () => {
  const events = [];
  const results = [
    { status: 'completed', window_id: 'one' },
    null,
  ];
  const result = await runProductCatchUp({
    ingestOne: async ({ onProgress }) => {
      const result = results.shift();
      if (result) {
        onProgress?.({ phase: 'projection_start', projection: 'narrative' });
        onProgress?.({ phase: 'projection_complete', projection: 'narrative', recordCount: 1 });
      }
      return result;
    },
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.windows, 1);
  assert.deepEqual(
    events.map((event) => event.phase),
    ['started', 'window_start', 'projection_start', 'projection_complete', 'window_complete', 'window_start', 'finished'],
  );
  assert.equal(events[1].windowNumber, 1);
  assert.equal(events.find((event) => event.phase === 'window_complete').windows, 1);
  assert.equal(events[3].recordCount, 1);
});

test('async progress callback failures are contained', async () => {
  let unhandled = null;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  globalThis.process.on('unhandledRejection', onUnhandled);
  try {
    const result = await runProductCatchUp({
      ingestOne: async () => null,
      onProgress: async () => {
        throw new Error('progress sink unavailable');
      },
    });
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(result.windows, 0);
    assert.equal(unhandled, null);
  } finally {
    globalThis.process.off('unhandledRejection', onUnhandled);
  }
});
