import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestWindow } from '../projections.js';
import { createIngestQueue, pruneIngestWindowsAtBranch } from '../ingest-queue.js';

const makeWindow = (overrides = {}) =>
  buildIngestWindow({
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    messages: [
      { mesId: 101, name: 'Badi', is_user: true, mes: 'Mira takes the silver key.' },
      { mesId: 102, name: 'Mira', is_user: false, mes: 'I will help you open the door.' },
    ],
    sourceRange: { kind: 'mesId', start: 101, end: 102 },
    ...overrides,
  });

test('the same transcript window has a stable identity', () => {
  const first = makeWindow();
  const second = makeWindow();

  assert.equal(first.window_id, second.window_id);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.source_range, { kind: 'mesId', start: 101, end: 102 });
});

test('ingest windows prune sparse index-range tails', () => {
  const result = pruneIngestWindowsAtBranch({
    prefix: { source_range: { kind: 'index', start: 0, end: 1 } },
    tail: { source_range: { kind: 'index', start: 2, end: 4 } },
  }, { branchPointMesId: 20, branchPointIndex: 1 });

  assert.deepEqual(Object.keys(result.windows), ['prefix']);
  assert.deepEqual(result.removed.map((entry) => entry.window_id), ['tail']);
});

test('ingest windows prune mesId ranges when no numeric prefix survives', () => {
  const result = pruneIngestWindowsAtBranch({
    stale: { source_range: { kind: 'mesId', start: 10, end: 20 } },
  }, { branchPointMesId: null, branchPointIndex: -1 });

  assert.deepEqual(result.windows, {});
  assert.deepEqual(result.removed.map((entry) => entry.window_id), ['stale']);
});

test('replaying a committed window does not run projections twice', async () => {
  const stored = new Map();
  const calls = { structured: 0, narrative: 0 };
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: {
      structured: async (window) => {
        calls.structured++;
        return [{ id: 'state-a', kind: 'state', content: `state for ${window.chat_uid}` }];
      },
      narrative: async () => {
        calls.narrative++;
        return [{ id: 'narrative-a', kind: 'narrative_delta', content: 'Mira takes the key.' }];
      },
    },
  });
  const window = makeWindow();

  const first = await queue.ingest(window);
  const second = await queue.ingest(window);

  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(second.replayed, true);
  assert.deepEqual(calls, { structured: 1, narrative: 1 });
  assert.deepEqual(second.record_ids.sort(), ['narrative-a', 'state-a']);
});

test('explicit force reprocess reruns a completed window instead of replaying it', async () => {
  const stored = new Map();
  let calls = 0;
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: {
      structured: async () => {
        calls++;
        return [{ id: `fact-${calls}`, kind: 'fact', content: `Fact ${calls}.` }];
      },
    },
  });

  await queue.ingest(makeWindow());
  const result = await queue.ingest(makeWindow(), { forceReprocess: true });

  assert.equal(result.replayed, false);
  assert.equal(calls, 2);
  assert.deepEqual(result.record_ids, ['fact-2']);
});
test('persisted window state carries the actual array endpoints', async () => {
  const stored = new Map();
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: {
      structured: async () => [{ id: 'fact-a', kind: 'fact', content: 'The key is silver.' }],
    },
  });
  const window = {
    ...makeWindow(),
    start_index: 3,
    end_index: 7,
  };

  const result = await queue.ingest(window);

  assert.equal(result.status, 'completed');
  assert.equal(stored.get(window.window_id).start_index, 3);
  assert.equal(stored.get(window.window_id).end_index, 7);
});

test('queue reports each projector lifecycle without changing stored results', async () => {
  const stored = new Map();
  const events = [];
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: {
      narrative: async () => [{ id: 'narrative-a', kind: 'narrative_delta', content: 'The party enters.' }],
      structured: async () => [
        { id: 'fact-a', kind: 'fact', content: 'The key is silver.' },
        { id: 'state-a', kind: 'state', content: 'Mira carries the key.' },
      ],
    },
  });

  const result = await queue.ingest(makeWindow(), {
    onProgress: (event) => events.push(event),
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(
    events.map((event) => `${event.phase}:${event.projection ?? 'window'}`),
    [
      'projection_start:narrative',
      'projection_complete:narrative',
      'projection_start:structured',
      'projection_complete:structured',
      'window_complete:window',
    ],
  );
  assert.equal(events[1].recordCount, 1);
  assert.equal(events[3].recordCount, 2);
  assert.equal(events[4].recordCount, 3);
});

test('aborted ingest does not persist a running window', async () => {
  const stored = new Map();
  let saves = 0;
  let projectorCalled = false;
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => {
      saves++;
      stored.set(id, structuredClone(state));
    },
    projectors: {
      structured: async () => {
        projectorCalled = true;
        return [{ id: 'state-a', kind: 'state', content: 'unsafe after abort' }];
      },
    },
  });

  await assert.rejects(
    () => queue.ingest(makeWindow(), { shouldAbort: () => true }),
    /ingest aborted/,
  );
  assert.equal(projectorCalled, false);
  assert.equal(saves, 0);
  assert.equal(stored.size, 0);
});

test('abort after loading prior state prevents initial running save', async () => {
  const stored = new Map([['window-1', { status: 'partial', projections: {} }]]);
  let saveCalls = 0;
  let aborted = false;
  const queue = createIngestQueue({
    load: async () => {
      await Promise.resolve();
      aborted = true;
      return stored.get('window-1');
    },
    save: async () => {
      saveCalls++;
    },
    projectors: { narrative: async () => [] },
  });

  await assert.rejects(
    queue.ingest({
      window_id: 'window-1',
      chat_uid: 'chat-1',
      source_range: { kind: 'index', start: 0, end: 0 },
      fingerprint: 'fp-1',
    }, {
      shouldAbort: () => aborted,
      onProgress: (event) => {
        if (event.phase === 'window_start') aborted = true;
      },
    }),
    /ingest aborted/,
  );
  assert.equal(saveCalls, 0);
});

test('queue contains asynchronous progress callback failures', async () => {
  const stored = new Map();
  let unhandled = null;
  const onUnhandled = (reason) => {
    unhandled = reason;
  };
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: {
      structured: async () => [{ id: 'state-a', kind: 'state', content: 'Mira is healed.' }],
    },
  });
  globalThis.process.on('unhandledRejection', onUnhandled);
  try {
    const result = await queue.ingest(makeWindow(), {
      onProgress: async () => {
        throw new Error('progress sink unavailable');
      },
    });
    await new Promise((resolve) => globalThis.setImmediate(resolve));
    assert.equal(result.status, 'completed');
    assert.equal(unhandled, null);
  } finally {
    globalThis.process.off('unhandledRejection', onUnhandled);
  }
});

test('concurrent callers share one in-flight projection for the same window', async () => {
  const stored = new Map();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = { structured: 0 };
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: {
      structured: async () => {
        calls.structured++;
        await gate;
        return [{ id: 'state-a', kind: 'state', content: 'Mira is healed.' }];
      },
    },
  });
  const window = makeWindow();

  const firstPromise = queue.ingest(window);
  const secondPromise = queue.ingest(window);
  release();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(calls.structured, 1);
});


test('a failed projection retries alone while completed projections are skipped', async () => {
  const stored = new Map();
  const calls = { structured: 0, narrative: 0 };
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: {
      structured: async () => {
        calls.structured++;
        if (calls.structured === 1) throw new Error('structured endpoint unavailable');
        return [{ id: 'state-a', kind: 'state', content: 'Mira is healed.' }];
      },
      narrative: async () => {
        calls.narrative++;
        return [{ id: 'narrative-a', kind: 'narrative_delta', content: 'The party enters the temple.' }];
      },
    },
  });
  const window = makeWindow();

  const first = await queue.ingest(window);
  const second = await queue.ingest(window);

  assert.equal(first.status, 'partial');
  assert.equal(first.projections.structured.status, 'failed');
  assert.equal(first.projections.narrative.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.deepEqual(calls, { structured: 2, narrative: 1 });
  assert.deepEqual(second.record_ids.sort(), ['narrative-a', 'state-a']);
});

test('queue windows sourced from a discarded branch tail are pruned', () => {
  const windows = {
    prefix: { source_range: { kind: 'mesId', start: 1, end: 2 }, status: 'completed' },
    tail: { source_range: { kind: 'mesId', start: 3, end: 4 }, status: 'completed' },
    legacy: { status: 'completed' },
  };
  const result = pruneIngestWindowsAtBranch(windows, { branchPointMesId: 2 });

  assert.deepEqual(Object.keys(result.windows), ['prefix', 'legacy']);
  assert.deepEqual(result.removed.map((entry) => entry.window_id), ['tail']);
  assert.deepEqual(Object.keys(windows), ['prefix', 'tail', 'legacy']);
});

test('quarantined lineage produces no records and does not call projectors', async () => {
  let called = false;
  const queue = createIngestQueue({
    load: () => undefined,
    save: () => {},
    projectors: {
      structured: async () => {
        called = true;
        return [{ id: 'should-not-exist', kind: 'state', content: 'unsafe' }];
      },
    },
  });
  const window = makeWindow({ lineage: { status: 'unverified-branch', quarantined: true } });

  const result = await queue.ingest(window);

  assert.equal(result.status, 'quarantined');
  assert.deepEqual(result.record_ids, []);
  assert.equal(called, false);
});

test('cancellation during a projector persists a retryable cancelled window', async () => {
  const stored = new Map();
  let cancelled = false;
  let cancelledState = null;
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: {
      structured: async () => {
        cancelled = true;
        throw new Error('cancelled during model work');
      },
    },
  });
  const window = makeWindow();

  const result = await queue.ingest(window, {
    isCancelled: () => cancelled,
    shouldAbort: () => cancelled,
    saveCancelled: async (id, state) => {
      cancelledState = structuredClone(state);
      stored.set(id, structuredClone(state));
    },
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancelled, true);
  assert.equal(result.projections.structured.status, 'cancelled');
  assert.equal(cancelledState.status, 'cancelled');
  assert.equal(stored.get(window.window_id).status, 'cancelled');
});
