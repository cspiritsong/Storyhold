import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestWindow } from '../projections.js';
import {
  buildProductWindow,
  createProductPipeline,
  resetProductMemory,
} from '../product-runtime.js';

const chat = [
  { mesId: 10, name: 'Badi', is_user: true, mes: 'We enter the temple.' },
  { mesId: 11, name: 'Mira', is_user: false, mes: 'The silver key is warm.' },
  { mesId: 12, name: 'Badi', is_user: true, mes: 'Open the sealed door.' },
  { mesId: 13, name: 'Mira', is_user: false, mes: 'Not yet.' },
];

test('product window selects only unprocessed messages and prefers mesId provenance', () => {
  const first = buildProductWindow({
    chat,
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    cursor: null,
  });
  const second = buildProductWindow({
    chat,
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    cursor: { last_mes_id: 11 },
  });

  assert.deepEqual(first.source_range, { kind: 'mesId', start: 10, end: 12 });
  assert.deepEqual(second.source_range, { kind: 'mesId', start: 12, end: 12 });
  assert.equal(first.messages.length, 3);
  assert.equal(second.messages.length, 1);
});

test('product window caps the first catch-up slice instead of loading the whole chat', () => {
  const longChat = Array.from({ length: 100 }, (_, index) => ({
    mesId: index + 1,
    name: index % 2 === 0 ? 'Badi' : 'Mira',
    is_user: index % 2 === 0,
    mes: `message-${index + 1}`,
  }));
  const window = buildProductWindow({
    chat: longChat,
    chatUid: 'chat-uid-long',
    branchUid: 'branch-long',
    maxMessages: 12,
  });

  assert.equal(window.messages.length, 12);
  assert.deepEqual(window.source_range, { kind: 'mesId', start: 1, end: 12 });
});

test('product window returns null when the cursor is already at the stable chat tip', () => {
  const window = buildProductWindow({
    chat,
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    cursor: { last_mes_id: 12 },
  });

  assert.equal(window, null);
});

test('single-extension product pipeline stores narrative and one combined structured projection', async () => {
  const metadata = {};
  let saves = 0;
  const calls = { narrative: 0, structured: 0 };
  const pipeline = createProductPipeline({
    metadata,
    saveMetadata: async () => {
      saves++;
    },
    settings: { narrativeSettings: { snippetsPerLayer: 3 } },
    summarizeNarrative: async ({ storyText }) => {
      calls.narrative++;
      assert.match(storyText, /silver key/);
      return 'The party enters the temple and Mira carries the silver key.';
    },
    extractStructured: async ({ window }) => {
      calls.structured++;
      assert.match(window.messages[0].mes, /temple/);
      return [{
        id: 'state-a',
        kind: 'state',
        content: 'Mira carries the silver key.',
      }];
    },
  });
  const window = buildIngestWindow({
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    messages: chat.slice(0, 2),
    sourceRange: { kind: 'mesId', start: 10, end: 11 },
  });

  const result = await pipeline.ingest(window);

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, { narrative: 1, structured: 1 });
  assert.equal(metadata.smartMemory.narrative.layers[0].length, 1);
  assert.equal(metadata.smartMemory.narrative.chat_uid, 'chat-uid-a');
  assert.equal(metadata.smartMemory.narrative.branch_uid, 'branch-uid-a');
  assert.equal(metadata.smartMemory.structured_records.length, 1);
  assert.equal(metadata.smartMemory.structured_records[0].id, 'state-a');
  assert.ok(saves >= 3);
});

test('rescan reset clears only product stores and preserves unrelated metadata', async () => {
  const metadata = {
    unrelated: { keep: true },
    smartMemory: {
      lineage: { status: 'standalone' },
      timeline: { current_anchor: { day: 15 } },
      product_cursor: { last_mes_id: 10 },
      narrative: { layers: [[{ text: 'old' }]] },
      structured_records: [{ id: 'old-record' }],
      ingest_windows: { old: { status: 'completed' } },
    },
  };
  let saves = 0;
  await resetProductMemory(metadata, async () => {
    saves++;
  });

  assert.deepEqual(metadata.unrelated, { keep: true });
  assert.deepEqual(metadata.smartMemory.lineage, { status: 'standalone' });
  assert.deepEqual(metadata.smartMemory.timeline, { current_anchor: { day: 15 } });
  assert.equal(metadata.smartMemory.product_cursor, null);
  assert.equal(metadata.smartMemory.narrative, null);
  assert.deepEqual(metadata.smartMemory.structured_records, []);
  assert.deepEqual(metadata.smartMemory.ingest_windows, {});
  assert.equal(saves, 1);
});
