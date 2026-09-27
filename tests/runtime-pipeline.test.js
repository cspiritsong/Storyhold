import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestWindow } from '../projections.js';
import { createRuntimePipeline } from '../runtime-pipeline.js';
import { advanceProductCursor, createProductPipeline } from '../product-runtime.js';
import { buildSectionsFromTypedState, buildMemoryEnvelopeSync } from '../memory-broker.js';

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

test('abort after narrative state load prevents model work and narrative saves', async () => {
  let releaseLoad;
  let loadStarted;
  const loadGate = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const started = new Promise((resolve) => {
    loadStarted = resolve;
  });
  let aborted = false;
  let summarizeCalls = 0;
  let narrativeSaves = 0;
  const pipeline = createRuntimePipeline({
    loadIngest: () => null,
    saveIngest: () => {},
    loadNarrative: async () => {
      loadStarted();
      await loadGate;
      return null;
    },
    saveNarrative: () => {
      narrativeSaves++;
    },
    summarizeNarrative: async () => {
      summarizeCalls++;
      return 'should not run';
    },
    extractStructured: async () => [],
  });

  const pending = pipeline.ingest(makeWindow(), { shouldAbort: () => aborted });
  await started;
  aborted = true;
  releaseLoad();

  await assert.rejects(pending, /aborted/);
  assert.equal(summarizeCalls, 0);
  assert.equal(narrativeSaves, 0);
});

test('exact 5-step partial retry reload sequence with unified slot inspection', async () => {
  const metadata = {};
  const calls = { summarize: 0, structured: 0 };
  let structuredShouldFail = true;

  const window = {
    window_id: 'win-exact-seq',
    chat_uid: 'chat-exact-seq',
    branch_uid: 'branch-exact-seq',
    messages: [
      { mesId: 101, name: 'Badi', is_user: true, mes: 'Mira reaches the bridge.' },
      { mesId: 102, name: 'Mira', is_user: false, mes: 'Rowan broke his promise.' },
    ],
    source_range: { kind: 'mesId', start: 101, end: 102 },
    fingerprint: 'fp-exact-seq',
    story_text: 'Mira reaches the bridge. Rowan broke his promise.',
  };

  const createTestPipeline = (meta) => createProductPipeline({
    metadata: meta,
    settings: {
      single_extension_mode: true,
      chatUid: 'chat-exact-seq',
      branchUid: 'branch-exact-seq',
    },
    summarizeNarrative: async () => {
      calls.summarize++;
      return 'CAUSE: Rowan broke his promise to protect Kael.';
    },
    extractStructured: async () => {
      calls.structured++;
      if (structuredShouldFail) {
        throw new Error('structured extraction failed');
      }
      return {
        facts: [],
        state: [{ id: 'state-seq', content: 'Mira is at the bridge.', validity: { status: 'active' } }],
      };
    },
  });

  // Step 1: Ingest window W; narrative succeeds once, structured extractor fails
  const pipeline1 = createTestPipeline(metadata);
  const res1 = await pipeline1.ingest(window);
  if (res1.status === 'completed') await advanceProductCursor(metadata, window);

  // Step 2: Result/status is partial; unified slot contains N; no structured record fabricated; cursor held
  assert.equal(res1.status, 'partial');
  assert.equal(calls.summarize, 1);
  assert.equal(calls.structured, 1);

  assert.equal(metadata.smartMemory?.product_cursor ?? null, null);

  const sections1 = buildSectionsFromTypedState({
    chatUid: 'chat-exact-seq',
    branchUid: 'branch-exact-seq',
    narrativeState: metadata.smartMemory.narrative,
  });
  const env1 = buildMemoryEnvelopeSync({
    chatUid: 'chat-exact-seq',
    branchUid: 'branch-exact-seq',
    allocationPolicy: 'product-continuity',
    sections: sections1,
    records: metadata.smartMemory.structured_records ?? [],
    totalBudget: 2000,
  });
  assert.ok(env1.text.includes('CAUSE: Rowan broke his promise'));
  assert.equal(env1.text.includes('CURRENT STATE:'), false);

  // Step 3 & 4: Retry the same W; narrative is skipped (not called again), structured succeeds
  structuredShouldFail = false;
  const res2 = await pipeline1.ingest(window);
  if (res2.status === 'completed') await advanceProductCursor(metadata, window);
  assert.equal(res2.status, 'completed');
  assert.equal(calls.summarize, 1, 'summarizeNarrative must not be called again on retry');
  assert.equal(calls.structured, 2, 'extractStructured retried and succeeded');

  assert.ok(metadata.smartMemory?.product_cursor != null);
  assert.equal(metadata.smartMemory.product_cursor.last_mes_id, 102);

  const sections2 = buildSectionsFromTypedState({
    chatUid: 'chat-exact-seq',
    branchUid: 'branch-exact-seq',
    narrativeState: metadata.smartMemory.narrative,
  });
  const env2 = buildMemoryEnvelopeSync({
    chatUid: 'chat-exact-seq',
    branchUid: 'branch-exact-seq',
    allocationPolicy: 'product-continuity',
    sections: sections2,
    records: metadata.smartMemory.structured_records ?? [],
    totalBudget: 2000,
  });
  assert.ok(env2.text.includes('CAUSE: Rowan broke his promise'));
  assert.ok(env2.text.includes('CURRENT STATE:'));
  assert.ok(env2.text.includes('Mira is at the bridge.'));
  assert.equal(metadata.smartMemory.narrative.layers[0].length, 1, 'layer 0 has exactly one N');

  // Step 5: Serialize/clone metadata and construct a fresh runtime/injection context
  const clonedMetadata = JSON.parse(JSON.stringify(metadata));
  const pipelineFresh = createTestPipeline(clonedMetadata);
  const resReplay = await pipelineFresh.ingest(window);

  assert.equal(resReplay.replayed, true);
  assert.equal(calls.summarize, 1, 'no model work on reload/replay');
  assert.equal(calls.structured, 2, 'no model work on reload/replay');

  const sectionsReplay = buildSectionsFromTypedState({
    chatUid: 'chat-exact-seq',
    branchUid: 'branch-exact-seq',
    narrativeState: clonedMetadata.smartMemory.narrative,
  });
  const envReplay = buildMemoryEnvelopeSync({
    chatUid: 'chat-exact-seq',
    branchUid: 'branch-exact-seq',
    allocationPolicy: 'product-continuity',
    sections: sectionsReplay,
    records: clonedMetadata.smartMemory.structured_records ?? [],
    totalBudget: 2000,
  });
  assert.ok(envReplay.text.includes('CAUSE: Rowan broke his promise'));
  assert.equal(clonedMetadata.smartMemory.narrative.layers[0].length, 1, 'persisted narrative layer 0 has exactly one N');
});
