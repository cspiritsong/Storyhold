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
