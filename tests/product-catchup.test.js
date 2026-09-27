import test from 'node:test';
import assert from 'node:assert/strict';
import { runProductCatchUp } from '../product-catchup.js';
import { buildSectionsFromTypedState, buildMemoryEnvelopeSync } from '../memory-broker.js';
import { advanceProductCursor } from '../product-runtime.js';

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

test('product catch-up annotates events with the provided totals', async () => {
  const events = [];
  await runProductCatchUp({
    ingestOne: async ({ onProgress }) => {
      onProgress?.({ phase: 'projection_start', projection: 'narrative', sourceRange: { start: 0, end: 39 } });
      return { status: 'completed', window_id: 'one' };
    },
    totalWindows: 8,
    totalMessages: 300,
    onProgress: (event) => events.push(event),
  });

  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.totalWindows, 8);
    assert.equal(event.totalMessages, 300);
  }
});

test('product catch-up omits totals when they are not provided or invalid', async () => {
  const events = [];
  await runProductCatchUp({
    ingestOne: async () => null,
    totalWindows: 0,
    totalMessages: -4,
    onProgress: (event) => events.push(event),
  });

  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.totalWindows, undefined);
    assert.equal(event.totalMessages, undefined);
  }
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

test('product catch-up preserves valid envelope and cursor on repeated-window no-progress', async () => {
  const initialCursor = Object.freeze({
    chat_uid: 'chat-np',
    branch_uid: 'branch-np',
    last_mes_id: 105,
    last_index: 4,
    source_fingerprint: 'fp-105',
  });
  const metadata = {
    smartMemory: {
      chat_uid: 'chat-np',
      branch_uid: 'branch-np',
      product_cursor: { ...initialCursor },
      narrative: {
        chat_uid: 'chat-np',
        branch_uid: 'branch-np',
        layers: [[{
          id: 'snip-existing',
          text: 'Mira discovered the hidden passage under the chapel.',
          scope: { chat_uid: 'chat-np', branch_uid: 'branch-np' },
          source_range: { kind: 'mesId', start: 101, end: 105 },
          narrative_layer: 0,
          narrative_order: 0,
        }]],
      },
      structured_records: [
        { id: 'rec-state-np', kind: 'state', content: 'Chapel passage open.', scope: { chat_uid: 'chat-np', branch_uid: 'branch-np' }, validity: { status: 'active' } },
      ],
    },
  };

  // Compute pre-catchup envelope E from real metadata
  const initialSections = buildSectionsFromTypedState({
    chatUid: 'chat-np',
    branchUid: 'branch-np',
    narrativeState: metadata.smartMemory.narrative,
  });
  const initialEnvelope = buildMemoryEnvelopeSync({
    chatUid: 'chat-np',
    branchUid: 'branch-np',
    allocationPolicy: 'product-continuity',
    sections: initialSections,
    records: metadata.smartMemory.structured_records,
    totalBudget: 2000,
  });
  assert.ok(initialEnvelope.text.includes('Mira discovered the hidden passage'));
  assert.ok(initialEnvelope.text.includes('CURRENT STATE:'));

  let modelCalls = 0;
  const events = [];
  const result = await runProductCatchUp({
    ingestOne: async () => {
      // Production repeated-window scenario: window already ingested / replayed
      const replayedResult = {
        status: 'completed',
        window_id: 'stuck-window-42',
        replayed: true,
        records: [],
      };
      // In production (index.js:847-855), replayed windows do NOT advance cursor and make no model calls
      if (!replayedResult.replayed && replayedResult.status === 'completed') {
        modelCalls++;
        await advanceProductCursor(metadata, {
          window_id: 'stuck-window-42',
          source_range: { kind: 'mesId', start: 106, end: 110 },
          fingerprint: 'fp-110',
          chat_uid: 'chat-np',
          branch_uid: 'branch-np',
        });
      }
      return replayedResult;
    },
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.noProgress, true);
  assert.equal(result.windows, 1);
  assert.equal(events.at(-1).phase, 'partial');
  assert.equal(modelCalls, 0, 'zero model calls during no-progress');
  assert.equal(metadata.smartMemory.narrative.layers[0].length, 1, 'no new narrative snippet added');

  // Real cursor is unchanged
  assert.deepEqual(metadata.smartMemory.product_cursor, initialCursor);

  // Production re-injects unified envelope from metadata after catch-up (index.js:1105)
  const finalSections = buildSectionsFromTypedState({
    chatUid: 'chat-np',
    branchUid: 'branch-np',
    narrativeState: metadata.smartMemory.narrative,
  });
  const finalEnvelope = buildMemoryEnvelopeSync({
    chatUid: 'chat-np',
    branchUid: 'branch-np',
    allocationPolicy: 'product-continuity',
    sections: finalSections,
    records: metadata.smartMemory.structured_records,
    totalBudget: 2000,
  });

  assert.strictEqual(finalEnvelope.text, initialEnvelope.text, 'envelope E must be preserved and reproduced identically');
});
