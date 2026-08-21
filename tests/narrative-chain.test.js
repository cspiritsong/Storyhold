import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleNarrative,
  createNarrativeState,
  inheritNarrativePrefix,
  ingestNarrativeBatch,
  promoteNarrativeLayers,
  pruneNarrativeAtBranch,
  rebuildNarrativeChain,
  retagNarrativeChatUid,
} from '../narrative-chain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/narrative-layers.json'), 'utf8'),
);

const sourceRange = fixture.windows[0].source_range;
const baseWindow = {
  window_id: fixture.windows[0].window_id,
  source_range: sourceRange,
  fingerprint: fixture.windows[0].fingerprint,
  story_text: fixture.windows[0].story_text,
};

function newState(overrides = {}) {
  return createNarrativeState({
    snippetsPerLayer: fixture.settings.snippets_per_layer,
    snippetsPerPromotion: fixture.settings.snippets_per_promotion,
    maxLayers: fixture.settings.max_layers,
    ...overrides,
  });
}

test('one narrative window creates a layer-0 delta with provenance and watermark', async () => {
  const calls = [];
  const result = await ingestNarrativeBatch(newState(), {
    ...baseWindow,
    summarize: async (request) => {
      calls.push(request);
      return 'Mira takes the silver key and promises to help.';
    },
    now: () => 1000,
  });

  assert.equal(result.changed, true);
  assert.equal(result.failed, false);
  assert.equal(calls.length, 1);
  assert.equal(result.state.layers[0].length, 1);
  assert.deepEqual(result.state.layers[0][0].source_range, sourceRange);
  assert.equal(result.state.layers[0][0].window_id, baseWindow.window_id);
  assert.deepEqual(result.state.watermark, {
    window_id: baseWindow.window_id,
    source_range: sourceRange,
    fingerprint: baseWindow.fingerprint,
  });
  assert.equal(result.state.processed_windows.length, 1);
});

test('replaying the same narrative window is idempotent and does not call the summarizer', async () => {
  let calls = 0;
  const first = await ingestNarrativeBatch(newState(), {
    ...baseWindow,
    summarize: async () => {
      calls++;
      return 'First summary.';
    },
  });
  const second = await ingestNarrativeBatch(first.state, {
    ...baseWindow,
    summarize: async () => {
      calls++;
      return 'Should not be used.';
    },
  });

  assert.equal(calls, 1);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already-processed');
  assert.deepEqual(second.state, first.state);
});

test('a failed summarizer leaves the narrative state unchanged', async () => {
  const state = newState();
  const result = await ingestNarrativeBatch(state, {
    ...baseWindow,
    summarize: async () => '',
  });

  assert.equal(result.failed, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.state, state);
});

test('first overflow promotion seeds the next layer without an LLM call', async () => {
  const state = newState();
  state.layers[0] = [
    { id: 'oldest', text: 'oldest', source_range: sourceRange },
    { id: 'middle', text: 'middle', source_range: sourceRange },
    { id: 'newest', text: 'newest', source_range: sourceRange },
  ];
  let calls = 0;

  const result = await promoteNarrativeLayers(state, {
    summarize: async () => {
      calls++;
      return 'not needed';
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.failed, false);
  assert.equal(calls, 0);
  assert.equal(result.state.layers[0].length, 2);
  assert.equal(result.state.layers[1][0].text, 'oldest');
  assert.equal(result.state.layers[1][0].seed_from_layer, 0);
});

test('subsequent overflow promotion merges snippets once against destination context', async () => {
  const state = newState();
  state.layers[0] = [
    { id: 'a', text: 'a', source_range: sourceRange },
    { id: 'b', text: 'b', source_range: sourceRange },
    { id: 'c', text: 'c', source_range: sourceRange },
    { id: 'd', text: 'd', source_range: sourceRange },
  ];
  state.layers[1] = [{ id: 'existing', text: 'existing', source_range: sourceRange }];
  const calls = [];

  const result = await promoteNarrativeLayers(state, {
    summarize: async (request) => {
      calls.push(request);
      return 'a and b compressed';
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.failed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].layer, 1);
  assert.equal(calls[0].storyText, 'a b');
  assert.match(calls[0].contextText, /existing/);
  assert.equal(result.state.layers[0].length, 2);
  assert.equal(result.state.layers[1][1].text, 'a and b compressed');
  assert.equal(result.state.layers[1][1].from_layer, 0);
  assert.equal(result.state.layers[1][1].merged_count, 2);
});

test('failed merge promotion restores all snippets and does not mutate the input', async () => {
  const state = newState();
  state.layers[0] = [
    { id: 'a', text: 'a', source_range: sourceRange },
    { id: 'b', text: 'b', source_range: sourceRange },
    { id: 'c', text: 'c', source_range: sourceRange },
  ];
  state.layers[1] = [{ id: 'existing', text: 'existing', source_range: sourceRange }];
  const before = structuredClone(state);

  const result = await promoteNarrativeLayers(state, {
    summarize: async () => {
      throw new Error('summarizer unavailable');
    },
  });

  assert.equal(result.failed, true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.state, before);
  assert.deepEqual(state, before);
});

test('assembled narrative places deeper layers before layer zero', () => {
  const state = newState();
  state.layers = [
    [{ text: 'near history' }],
    [{ text: 'older history' }],
    [{ text: 'deep history' }],
  ];

  assert.equal(assembleNarrative(state), 'deep history older history near history');
});

test('verified narrative prefix inheritance excludes divergent and provenance-less snippets', () => {
  const parent = createNarrativeState({ chatUid: 'parent-chat', branchUid: 'parent-branch' });
  parent.layers = [
    [{
      id: 'prefix',
      text: 'prefix event',
      source_range: { kind: 'mesId', start: 1, end: 3 },
      scope: { chat_uid: 'parent-chat', branch_uid: 'parent-branch' },
    }, {
      id: 'tail',
      text: 'divergent event',
      source_range: { kind: 'mesId', start: 4, end: 5 },
      scope: { chat_uid: 'parent-chat', branch_uid: 'parent-branch' },
    }, { id: 'unknown', text: 'legacy without provenance' }],
    [{
      id: 'promoted-prefix',
      text: 'older prefix',
      source_ranges: [{ kind: 'mesId', start: 1, end: 3 }],
      scope: { chat_uid: 'parent-chat', branch_uid: 'parent-branch' },
    }],
  ];

  const child = inheritNarrativePrefix(parent, {
    parentChatUid: 'parent-chat',
    branchChatUid: 'child-chat',
    branchUid: 'child-branch',
    parentPrefixEnd: 3,
  });

  const ids = child.layers.flat().map((snippet) => snippet.id);
  assert.deepEqual(ids.sort(), ['prefix', 'promoted-prefix']);
  assert.ok(child.layers.flat().every((snippet) => snippet.scope.chat_uid === 'child-chat'));
  assert.ok(child.layers.flat().every((snippet) => snippet.scope.branch_uid === 'child-branch'));
  assert.deepEqual(parent.layers[0].map((snippet) => snippet.id), ['prefix', 'tail', 'unknown']);
});

test('narrative branch pruning removes tail layers and rolls watermark back', () => {
  const state = createNarrativeState({ chatUid: 'chat-a', branchUid: 'branch-a' });
  state.layers = [[
    { id: 'prefix', text: 'prefix', source_range: { kind: 'mesId', start: 1, end: 3 } },
    { id: 'tail', text: 'tail', source_range: { kind: 'mesId', start: 4, end: 5 } },
  ]];
  state.watermark = {
    window_id: 'tail-window',
    source_range: { kind: 'mesId', start: 4, end: 5 },
    fingerprint: 'tail',
  };

  const result = pruneNarrativeAtBranch(state, { branchPointMesId: 3 });

  assert.deepEqual(result.state.layers[0].map((snippet) => snippet.id), ['prefix']);
  assert.equal(result.state.watermark, null);
  assert.equal(result.removed, 1);
  assert.deepEqual(state.layers[0].map((snippet) => snippet.id), ['prefix', 'tail']);
});

test('renaming a narrative store preserves its layers while updating stable scope', () => {
  const state = createNarrativeState({ chatUid: 'old-chat', branchUid: 'old-branch' });
  state.layers = [[{
    id: 'one',
    text: 'event',
    scope: { chat_uid: 'old-chat', branch_uid: 'old-branch' },
    source_range: { kind: 'mesId', start: 1, end: 1 },
  }]];

  const renamed = retagNarrativeChatUid(state, {
    chatUid: 'renamed-chat',
    branchUid: 'renamed-branch',
  });

  assert.equal(renamed.chat_uid, 'renamed-chat');
  assert.equal(renamed.branch_uid, 'renamed-branch');
  assert.deepEqual(renamed.layers[0][0].scope, {
    chat_uid: 'renamed-chat',
    branch_uid: 'renamed-branch',
  });
});

test('mesId-less or missing provenance is not inherited automatically', () => {
  const parent = createNarrativeState({ chatUid: 'parent-chat' });
  parent.layers = [[
    { id: 'mesidless', text: 'unknown', source_range: { kind: 'index', start: 1, end: 2 } },
    { id: 'missing', text: 'missing' },
  ]];

  const child = inheritNarrativePrefix(parent, {
    parentChatUid: 'parent-chat',
    branchChatUid: 'child-chat',
    parentPrefixEnd: 2,
    requireMesIds: true,
  });

  assert.deepEqual(child.layers.flat(), []);
});

test('rebuild processes raw windows into a fresh narrative chain', async () => {
  const windows = [
    { ...baseWindow, window_id: 'rebuild-1', fingerprint: 'one', story_text: 'first event' },
    { ...baseWindow, window_id: 'rebuild-2', fingerprint: 'two', source_range: { kind: 'mesId', start: 12, end: 13 }, story_text: 'second event' },
  ];
  const result = await rebuildNarrativeChain(windows, {
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    summarize: async ({ storyText }) => `summary:${storyText}`,
  });

  assert.equal(result.failed, false);
  assert.equal(result.state.layers[0].length, 2);
  assert.equal(result.state.watermark.window_id, 'rebuild-2');
});
