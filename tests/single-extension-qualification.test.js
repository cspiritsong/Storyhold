import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMemoryEnvelopeSync,
  buildSectionsFromTypedState,
} from '../memory-broker.js';
import {
  advanceProductCursor,
  buildProductWindow,
  createProductPipeline,
} from '../product-runtime.js';
import {
  createNarrativeState,
  ingestNarrativeBatch,
  inheritNarrativePrefix,
  retagNarrativeChatUid,
} from '../narrative-chain.js';
import { rebuildTimeline } from '../timeline.js';
import { retrieveWithLadder } from '../retrieval.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/single-extension-qualification.json'), 'utf8'),
);

function ids(records) {
  return records.map((record) => record.id).sort();
}

test('single-extension qualification ingests one window into narrative plus typed state', async () => {
  const metadata = { unrelated_metadata: { survives: true } };
  const timeline = rebuildTimeline(fixture.messages, {
    chatId: fixture.chat_uid,
    epochId: fixture.branch_uid,
  });
  const calls = { narrative: 0, structured: 0 };
  const pipeline = createProductPipeline({
    metadata,
    settings: {
      respondingCharacter: 'Mira',
      timeline,
      narrativeSettings: { snippetsPerLayer: 3, snippetsPerPromotion: 1, maxLayers: 4 },
    },
    narrativeSettings: { snippetsPerLayer: 3, snippetsPerPromotion: 1, maxLayers: 4 },
    summarizeNarrative: async ({ storyText, contextText }) => {
      calls.narrative++;
      assert.match(storyText, /silver key/i);
      assert.equal(typeof contextText, 'string');
      return `Narrative delta: ${storyText.replace(/\s+/g, ' ').trim()}`;
    },
    extractStructured: async ({ prompt }) => {
      calls.structured++;
      assert.match(prompt, /Current story clock/i);
      assert.match(prompt, /Day 15/i);
      assert.match(prompt, /Temporal conflict|Backstory/i);
      return fixture.structured_response;
    },
  });
  const window = buildProductWindow({
    chat: fixture.messages,
    chatUid: fixture.chat_uid,
    branchUid: fixture.branch_uid,
  });

  const result = await pipeline.ingest(window);

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, { narrative: 1, structured: 1 });
  assert.deepEqual(metadata.unrelated_metadata, { survives: true });
  assert.equal(metadata.smartMemory.narrative.chat_uid, fixture.chat_uid);
  assert.equal(metadata.smartMemory.narrative.branch_uid, fixture.branch_uid);
  assert.equal(metadata.smartMemory.narrative.layers[0].length, 1);

  const records = metadata.smartMemory.structured_records;
  assert.deepEqual(ids(records), [
    'backstory-day12',
    'door-thread',
    'key-fact',
    'mira-current-state',
    'mira-secret',
    'trust-badi-mira',
  ]);
  assert.equal(records.some((record) => record.id === 'stale-clock'), false);
  assert.deepEqual(records.find((record) => record.id === 'mira-secret').witnessed_by, ['Mira']);

  const envelope = buildMemoryEnvelopeSync({
    chatUid: fixture.chat_uid,
    branchUid: fixture.branch_uid,
    query: 'silver key',
    records,
    sections: buildSectionsFromTypedState({
      narrativeState: metadata.smartMemory.narrative,
    }),
    totalBudget: fixture.expectations.max_tokens,
  });
  assert.ok(envelope.tokens <= fixture.expectations.max_tokens);
  assert.deepEqual(envelope.injected_slots, ['smart_memory_unified']);
  for (const text of fixture.expectations.must_include_text) assert.match(envelope.text, new RegExp(text, 'i'));
  for (const text of fixture.expectations.must_not_include_text) {
    assert.doesNotMatch(envelope.text, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.deepEqual(calls, { narrative: 1, structured: 1 });

  const replay = await pipeline.ingest(window);
  assert.equal(replay.replayed, true);
  assert.deepEqual(calls, { narrative: 1, structured: 1 });

  await advanceProductCursor(metadata, window);
  assert.equal(metadata.smartMemory.product_cursor.last_mes_id, 104);
});

test('qualification branch and rename operations fail closed or retag without changing narrative text', () => {
  const parent = createNarrativeState({ chatUid: 'parent-chat', branchUid: 'parent-branch' });
  parent.layers = [[
    {
      id: 'prefix',
      text: 'prefix remains',
      source_range: { kind: 'mesId', start: 1, end: 2 },
      scope: { chat_uid: 'parent-chat', branch_uid: 'parent-branch' },
    },
    {
      id: 'tail',
      text: 'discarded tail',
      source_range: { kind: 'mesId', start: 3, end: 4 },
      scope: { chat_uid: 'parent-chat', branch_uid: 'parent-branch' },
    },
  ]];
  const branch = inheritNarrativePrefix(parent, {
    parentChatUid: 'parent-chat',
    branchChatUid: 'child-chat',
    branchUid: 'child-branch',
    parentPrefixEnd: 2,
    requireMesIds: true,
  });
  assert.deepEqual(branch.layers.flat().map((snippet) => snippet.id), ['prefix']);
  assert.equal(branch.layers[0][0].text, 'prefix remains');
  assert.deepEqual(parent.layers[0].map((snippet) => snippet.id), ['prefix', 'tail']);

  const renamed = retagNarrativeChatUid(branch, {
    chatUid: 'renamed-child-chat',
    branchUid: 'child-branch-renamed',
  });
  assert.equal(renamed.layers[0][0].text, 'prefix remains');
  assert.deepEqual(renamed.layers[0][0].scope, {
    chat_uid: 'renamed-child-chat',
    branch_uid: 'child-branch-renamed',
  });
});

test('bounded narrative promotion uses a fake summarizer and ordinary retrieval uses no model', async () => {
  let summarizeCalls = 0;
  let state = createNarrativeState({
    chatUid: 'promotion-chat',
    branchUid: 'promotion-branch',
    snippetsPerLayer: 2,
    snippetsPerPromotion: 1,
    maxLayers: 3,
  });
  for (let index = 1; index <= 6; index++) {
    const result = await ingestNarrativeBatch(state, {
      window_id: `promotion-${index}`,
      source_range: { kind: 'mesId', start: index, end: index },
      fingerprint: `promotion-fingerprint-${index}`,
      chat_uid: 'promotion-chat',
      branch_uid: 'promotion-branch',
      story_text: `event ${index}`,
      summarize: async ({ storyText, promotion }) => {
        if (promotion) summarizeCalls++;
        return `summary:${storyText}`;
      },
    });
    state = result.state;
  }
  assert.ok(state.layers.length >= 2);
  assert.ok(summarizeCalls >= 1);
  assert.ok(summarizeCalls <= 6);

  let vectorCalls = 0;
  const retrieval = await retrieveWithLadder({
    records: [{
      id: 'known',
      kind: 'fact',
      content: 'The silver key opens the temple door.',
      scope: { chat_uid: 'promotion-chat', branch_uid: 'promotion-branch' },
      validity: { status: 'active' },
    }],
    chatUid: 'promotion-chat',
    branchUid: 'promotion-branch',
    query: 'silver key',
    vectorSearch: async () => {
      vectorCalls++;
      return [];
    },
  });
  assert.equal(retrieval.stage, 'exact');
  assert.equal(vectorCalls, 0);

  const fallback = await retrieveWithLadder({
    records: [],
    chatUid: 'promotion-chat',
    branchUid: 'promotion-branch',
    query: 'unknown sigil',
    vectorSearch: async () => {
      vectorCalls++;
      return [];
    },
  });
  assert.equal(fallback.stage, null);
  assert.equal(vectorCalls, 1);
});
