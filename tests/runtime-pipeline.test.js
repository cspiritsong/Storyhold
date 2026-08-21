import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestWindow } from '../projections.js';
import { createRuntimePipeline } from '../runtime-pipeline.js';

function makeWindow(lineage = null) {
  return buildIngestWindow({
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    messages: [
      { mesId: 101, name: 'Badi', is_user: true, mes: 'Mira takes the silver key.' },
      { mesId: 102, name: 'Mira', is_user: false, mes: 'The temple door remains sealed.' },
    ],
    sourceRange: { kind: 'mesId', start: 101, end: 102 },
    lineage,
  });
}

function makePipeline({ failStructuredFirst = false } = {}) {
  const ingestStore = new Map();
  const narrativeStore = new Map();
  const calls = { summarize: [], structured: [] };
  let structuredAttempts = 0;

  const pipeline = createRuntimePipeline({
    loadIngest: (id) => ingestStore.get(id),
    saveIngest: (id, state) => ingestStore.set(id, structuredClone(state)),
    loadNarrative: (window) => narrativeStore.get(window.chat_uid),
    saveNarrative: (window, state) => narrativeStore.set(window.chat_uid, structuredClone(state)),
    summarizeNarrative: async (request) => {
      calls.summarize.push(request);
      return 'Mira takes the silver key while the temple door remains sealed.';
    },
    extractStructured: async (request) => {
      calls.structured.push(request);
      structuredAttempts++;
      if (failStructuredFirst && structuredAttempts === 1) {
        throw new Error('structured extractor unavailable');
      }
      return [{ id: 'state-a', kind: 'state', content: 'Mira carries the silver key.' }];
    },
  });

  return { pipeline, ingestStore, narrativeStore, calls };
}

test('one runtime window reaches narrative and structured projections with one identity', async () => {
  const { pipeline, narrativeStore, calls } = makePipeline();
  const window = makeWindow();

  const result = await pipeline.ingest(window);

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.record_ids.sort(), ['narrative-window:' + window.window_id, 'state-a']);
  assert.equal(calls.summarize.length, 1);
  assert.equal(calls.structured.length, 1);
  assert.equal(calls.summarize[0].sourceWindowId, window.window_id);
  assert.equal(calls.structured[0].window.window_id, window.window_id);
  assert.match(calls.summarize[0].storyText, /silver key/);
  assert.equal(narrativeStore.get('chat-uid-a').layers[0].length, 1);
});

test('replaying a completed runtime window performs no model work', async () => {
  const { pipeline, calls } = makePipeline();
  const window = makeWindow();

  await pipeline.ingest(window);
  const replay = await pipeline.ingest(window);

  assert.equal(replay.replayed, true);
  assert.equal(calls.summarize.length, 1);
  assert.equal(calls.structured.length, 1);
});

test('a structured projection failure retries without rerunning narrative projection', async () => {
  const { pipeline, calls } = makePipeline({ failStructuredFirst: true });
  const window = makeWindow();

  const first = await pipeline.ingest(window);
  const second = await pipeline.ingest(window);

  assert.equal(first.status, 'partial');
  assert.equal(second.status, 'completed');
  assert.equal(calls.summarize.length, 1);
  assert.equal(calls.structured.length, 2);
  assert.deepEqual(second.record_ids.sort(), ['narrative-window:' + window.window_id, 'state-a']);
});

test('quarantined runtime windows do not call any projection or summarizer', async () => {
  const { pipeline, calls, ingestStore, narrativeStore } = makePipeline();
  const window = makeWindow({ status: 'unverified-branch', quarantined: true });

  const result = await pipeline.ingest(window);

  assert.equal(result.status, 'quarantined');
  assert.equal(calls.summarize.length, 0);
  assert.equal(calls.structured.length, 0);
  assert.equal(ingestStore.get(window.window_id).status, 'quarantined');
  assert.equal(narrativeStore.size, 0);
});
