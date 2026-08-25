import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestWindow, fingerprintMessages } from '../projections.js';
import {
  buildProductWindow,
  createProductPipeline,
  advanceProductCursor,
  persistProductStatus,
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
    cursor: {
      chat_uid: 'chat-uid-a',
      branch_uid: 'branch-uid-a',
      last_mes_id: 11,
      last_index: 1,
      end_index: 1,
      source_range: { kind: 'mesId', start: 10, end: 11 },
      fingerprint: fingerprintMessages(chat.slice(0, 2)),
    },
  });

  assert.deepEqual(first.source_range, { kind: 'mesId', start: 10, end: 12 });
  assert.deepEqual(second.source_range, { kind: 'mesId', start: 12, end: 12 });
  assert.equal(first.messages.length, 3);
  assert.equal(second.messages.length, 1);
});

test('product window replays an identity-less cursor instead of trusting its numeric watermark', () => {
  const result = buildProductWindow({
    chat,
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    cursor: { last_mes_id: 11 },
  });

  assert.deepEqual(result.source_range, { kind: 'mesId', start: 10, end: 12 });
});

test('product window rejects a cursor without a source fingerprint even with matching identity', () => {
  const result = buildProductWindow({
    chat,
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    cursor: {
      chat_uid: 'chat-uid-a',
      branch_uid: 'branch-uid-a',
      last_mes_id: 11,
    },
  });

  assert.deepEqual(result.source_range, { kind: 'mesId', start: 10, end: 12 });
});

test('product window resumes after a numeric watermark through mesId-less messages', () => {
  const sparseChat = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'The clue.' },
    { name: 'Badi', is_user: true, mes: 'Continue without a mesId.' },
  ];

  const window = buildProductWindow({
    chat: sparseChat,
    chatUid: 'chat-uid-sparse',
    branchUid: 'branch-sparse',
    cursor: {
      chat_uid: 'chat-uid-sparse',
      branch_uid: 'branch-sparse',
      last_mes_id: 20,
      last_index: 1,
      end_index: 1,
      source_range: { kind: 'mesId', start: 10, end: 20 },
      fingerprint: fingerprintMessages(sparseChat.slice(0, 2)),
    },
  });

  assert.equal(window.messages.length, 1);
  assert.equal(window.messages[0].mes, 'Continue without a mesId.');
  assert.deepEqual(window.source_range, { kind: 'index', start: 2, end: 2 });
});

test('product window conservatively replays when a persisted index is stale', () => {
  const sparseChat = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'The clue.' },
    { name: 'Badi', is_user: true, mes: 'Reindexed message.' },
  ];

  const window = buildProductWindow({
    chat: sparseChat,
    chatUid: 'chat-uid-reindexed',
    branchUid: 'branch-reindexed',
    cursor: {
      chat_uid: 'chat-uid-reindexed',
      branch_uid: 'branch-reindexed',
      last_mes_id: 20,
      last_index: 99,
      source_range: { kind: 'mesId', start: 10, end: 20 },
      fingerprint: fingerprintMessages(sparseChat.slice(0, 2)),
    },
  });

  assert.equal(window.messages[0].mes, 'Start.');
  assert.equal(window.messages.some((message) => message.mes === 'Reindexed message.'), true);
  assert.deepEqual(window.source_range, { kind: 'index', start: 0, end: 2 });
});

test('mixed product windows preserve both mesId and index cursor boundaries', async () => {
  const metadata = {
    smartMemory: {
      product_cursor: { last_mes_id: 20, last_index: null },
    },
  };
  const cursor = await advanceProductCursor(
    metadata,
    {
      window_id: 'window-mixed',
      fingerprint: 'mixed',
      messages: [{ mesId: 30 }, { mes: 'missing mesId' }],
      source_range: { kind: 'index', start: 2, end: 3 },
    },
  );

  assert.deepEqual(cursor, {
    window_id: 'window-mixed',
    fingerprint: 'mixed',
    source_range: { kind: 'index', start: 2, end: 3 },
    last_mes_id: 30,
    last_index: 3,
    end_index: 3,
  });
});

test('product window replays when a numeric watermark has no source proof', () => {
  const sparseChat = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'The clue.' },
    { name: 'Badi', is_user: true, mes: 'Unprocessed sparse message.' },
    { mesId: 30, name: 'Mira', is_user: false, mes: 'The next reply.' },
    { name: 'Badi', is_user: true, mes: 'A later committed turn.' },
  ];
  const window = buildProductWindow({
    chat: sparseChat,
    chatUid: 'chat-uid-unvalidated-index',
    branchUid: 'branch-unvalidated-index',
    cursor: {
      chat_uid: 'chat-uid-unvalidated-index',
      branch_uid: 'branch-unvalidated-index',
      last_mes_id: 20,
      last_index: 3,
    },
  });

  assert.equal(window.messages[0].mes, 'Start.');
  assert.equal(window.messages.some((message) => message.mes === 'Unprocessed sparse message.'), true);
});

test('product window rejects an in-range index cursor whose range crosses its numeric watermark', () => {
  const sparseChat = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'The clue.' },
    { name: 'Badi', is_user: true, mes: 'Unprocessed sparse message.' },
    { mesId: 30, name: 'Mira', is_user: false, mes: 'A later reply.' },
    { name: 'Badi', is_user: true, mes: 'Later unprocessed message.' },
  ];
  const window = buildProductWindow({
    chat: sparseChat,
    chatUid: 'chat-uid-stale-in-range',
    branchUid: 'branch-stale-in-range',
    cursor: {
      chat_uid: 'chat-uid-stale-in-range',
      branch_uid: 'branch-stale-in-range',
      last_mes_id: 20,
      last_index: 3,
      source_range: { kind: 'index', start: 0, end: 3 },
      fingerprint: fingerprintMessages(sparseChat.slice(0, 4)),
    },
  });

  assert.equal(window.messages[0].mes, 'Unprocessed sparse message.');
  assert.equal(window.source_range.start, 2);
});

test('product window rejects a mesId cursor whose persisted endpoint disagrees with the range end', () => {
  const malformedChat = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 11, name: 'Mira', is_user: false, mes: 'The clue.' },
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Duplicated endpoint.' },
    { mesId: 12, name: 'Mira', is_user: false, mes: 'The next reply.' },
  ];
  const window = buildProductWindow({
    chat: malformedChat,
    chatUid: 'chat-uid-malformed-endpoint',
    branchUid: 'branch-malformed-endpoint',
    cursor: {
      chat_uid: 'chat-uid-malformed-endpoint',
      branch_uid: 'branch-malformed-endpoint',
      last_mes_id: 11,
      last_index: 2,
      end_index: 2,
      source_range: { kind: 'mesId', start: 10, end: 11 },
      fingerprint: fingerprintMessages(malformedChat.slice(0, 3)),
    },
  });

  assert.equal(window.messages[0].mes, 'Start.');
  assert.equal(window.source_range.start, 10);
});


test('product window replays when a mesId cursor source fingerprint is stale', () => {
  const changedChat = [...chat];
  changedChat[1] = { ...changedChat[1], mes: 'The edited silver key is cold.' };
  const window = buildProductWindow({
    chat: changedChat,
    chatUid: 'chat-uid-stale-range',
    branchUid: 'branch-stale-range',
    cursor: {
      last_mes_id: 11,
      last_index: 2,
      source_range: { kind: 'mesId', start: 10, end: 12 },
      fingerprint: fingerprintMessages(chat.slice(0, 3)),
    },
  });

  assert.equal(window.messages[0].mes, 'We enter the temple.');
  assert.equal(window.messages[1].mes, 'The edited silver key is cold.');
  assert.equal(window.source_range.start, 10);
});

test('product window replays when a mesId cursor has no source fingerprint', () => {
  const window = buildProductWindow({
    chat,
    chatUid: 'chat-uid-missing-fingerprint',
    branchUid: 'branch-missing-fingerprint',
    cursor: {
      last_mes_id: 11,
      last_index: 2,
      source_range: { kind: 'mesId', start: 10, end: 12 },
      fingerprint: null,
    },
  });

  assert.equal(window.messages[0].mes, 'We enter the temple.');
  assert.equal(window.messages[1].mes, 'The silver key is warm.');
});

test('product window detects a mesId-less insertion inside a processed mesId range', () => {
  const processed = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 11, name: 'Mira', is_user: false, mes: 'The clue.' },
    { mesId: 12, name: 'Badi', is_user: true, mes: 'Continue.' },
  ];
  const live = [
    processed[0],
    processed[1],
    { name: 'Badi', is_user: true, mes: 'Imported message between numeric IDs.' },
    processed[2],
  ];
  const window = buildProductWindow({
    chat: live,
    chatUid: 'chat-uid-mesid-less-insert',
    branchUid: 'branch-mesid-less-insert',
    cursor: {
      last_mes_id: 12,
      last_index: 2,
      source_range: { kind: 'mesId', start: 10, end: 12 },
      fingerprint: fingerprintMessages(processed),
    },
  });

  assert.equal(window.messages[0].mes, 'Start.');
  assert.equal(window.messages.some((message) => message.mes.includes('Imported message')), true);
});

test('mesId product windows persist their actual array endpoint in the cursor', async () => {
  const window = buildProductWindow({
    chat,
    chatUid: 'chat-uid-index-endpoint',
    branchUid: 'branch-index-endpoint',
    cursor: null,
  });
  const metadata = {};
  const cursor = await advanceProductCursor(metadata, window);

  assert.equal(window.end_index, 2);
  assert.equal(cursor.last_index, 2);
});

test('product cursor preserves explicit chat and branch identity', async () => {
  const cursor = await advanceProductCursor({}, {
    window_id: 'identity-window',
    chat_uid: 'chat-a',
    branch_uid: 'branch-a',
    fingerprint: 'identity-fingerprint',
    messages: [{ mesId: 1 }],
    source_range: { kind: 'mesId', start: 1, end: 1 },
  });

  assert.equal(cursor.chat_uid, 'chat-a');
  assert.equal(cursor.branch_uid, 'branch-a');
});

test('product window replays when a cursor belongs to another chat or branch', () => {
  const window = buildProductWindow({
    chat,
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    cursor: {
      chat_uid: 'chat-b',
      branch_uid: 'branch-a',
      last_mes_id: 11,
    },
  });

  assert.equal(window.messages[0].mes, 'We enter the temple.');
  assert.equal(window.source_range.start, 10);

  const foreignBranch = buildProductWindow({
    chat,
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    cursor: {
      chat_uid: 'chat-a',
      branch_uid: 'branch-b',
      last_mes_id: 11,
    },
  });

  assert.equal(foreignBranch.messages[0].mes, 'We enter the temple.');
  assert.equal(foreignBranch.source_range.start, 10);
});

test('product window does not repeat an already processed sparse suffix', () => {
  const sparseChat = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'Clue.' },
    { mesId: 30, name: 'Badi', is_user: true, mes: 'Continue.' },
    { name: 'Mira', is_user: false, mes: 'Sparse reply.' },
    { name: 'Badi', is_user: true, mes: 'Sparse follow-up.' },
  ];

  const window = buildProductWindow({
    chat: sparseChat,
    chatUid: 'chat-uid-no-repeat',
    branchUid: 'branch-no-repeat',
    cursor: {
      chat_uid: 'chat-uid-no-repeat',
      branch_uid: 'branch-no-repeat',
      last_mes_id: 30,
      last_index: 4,
      source_range: { kind: 'index', start: 3, end: 4 },
      fingerprint: fingerprintMessages(sparseChat.slice(3, 5)),
    },
  });

  assert.equal(window, null);
});

test('product window conservatively replays when the numeric watermark disappeared', () => {
  const chatWithDeletedWatermark = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { name: 'Badi', is_user: true, mes: 'Sparse surviving reply.' },
  ];
  const window = buildProductWindow({
    chat: chatWithDeletedWatermark,
    chatUid: 'chat-uid-missing-watermark',
    branchUid: 'branch-missing-watermark',
    cursor: { last_mes_id: 20 },
  });

  assert.equal(window.messages[0].mes, 'Start.');
  assert.equal(window.messages[1].mes, 'Sparse surviving reply.');
  assert.deepEqual(window.source_range, { kind: 'index', start: 0, end: 1 });
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
    cursor: {
      chat_uid: 'chat-uid-a',
      branch_uid: 'branch-uid-a',
      last_mes_id: 12,
      last_index: 2,
      end_index: 2,
      source_range: { kind: 'mesId', start: 10, end: 12 },
      fingerprint: fingerprintMessages(chat.slice(0, 3)),
    },
  });

  assert.equal(window, null);
});

test('product window ignores a chat-stamped cursor with no branch proof', () => {
  const sparseChat = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'Clue.' },
    { mesId: 30, name: 'Badi', is_user: true, mes: 'Continue.' },
  ];
  const window = buildProductWindow({
    chat: sparseChat,
    chatUid: 'chat-x',
    branchUid: 'branch-x',
    cursor: { chat_uid: 'chat-x', last_mes_id: 20 },
  });

  assert.equal(window.messages[0].mes, 'Start.');
});

test('product window resumes from persisted end_index when last_index is absent', () => {
  const sparseChat = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'Clue.' },
    { mesId: 30, name: 'Badi', is_user: true, mes: 'After.' },
  ];
  const window = buildProductWindow({
    chat: sparseChat,
    chatUid: 'chat-c',
    branchUid: 'branch-b',
    cursor: {
      chat_uid: 'chat-c',
      branch_uid: 'branch-b',
      last_mes_id: null,
      end_index: 1,
      source_range: { kind: 'index', start: 0, end: 1 },
      fingerprint: fingerprintMessages(sparseChat.slice(0, 2)),
    },
  });

  assert.equal(window.messages[0].mes, 'After.');
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

test('product model prompts receive only current chat and branch history', async () => {
  const metadata = {
    smartMemory: {
      narrative: {
        chat_uid: 'chat-a',
        branch_uid: 'branch-a',
        layers: [[
          {
            id: 'narrative-current',
            text: 'Current narrative.',
            scope: { chat_uid: 'chat-a', branch_uid: 'branch-a' },
          },
          {
            id: 'narrative-foreign',
            text: 'Foreign narrative must not reach the model.',
            scope: { chat_uid: 'chat-b', branch_uid: 'branch-b' },
          },
        ]],
      },
      structured_records: [
        {
          id: 'record-current',
          kind: 'fact',
          content: 'Current structured fact.',
          scope: { chat_uid: 'chat-a', branch_uid: 'branch-a' },
          validity: { status: 'active' },
        },
        {
          id: 'record-foreign',
          kind: 'fact',
          content: 'Foreign structured fact must not reach the model.',
          scope: { chat_uid: 'chat-b', branch_uid: 'branch-b' },
          validity: { status: 'active' },
        },
      ],
    },
  };
  const observed = { narrativeContext: '', priorRecordIds: [] };
  const pipeline = createProductPipeline({
    metadata,
    settings: { chatUid: 'chat-a', branchUid: 'branch-a' },
    summarizeNarrative: async ({ contextText }) => {
      observed.narrativeContext = contextText;
      return 'Current narrative continues.';
    },
    extractStructured: async ({ priorRecords }) => {
      observed.priorRecordIds = priorRecords.map((record) => record.id);
      return [];
    },
  });
  const window = buildIngestWindow({
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    messages: chat.slice(0, 2),
    sourceRange: { kind: 'mesId', start: 10, end: 11 },
  });

  await pipeline.ingest(window);

  assert.match(observed.narrativeContext, /Current narrative/);
  assert.doesNotMatch(observed.narrativeContext, /Foreign narrative/);
  assert.deepEqual(observed.priorRecordIds, ['record-current']);
});

test('product pipeline persists cancellation without completing or advancing the window', async () => {
  const metadata = {};
  let cancelled = false;
  let cancellationSaves = 0;
  const pipeline = createProductPipeline({
    metadata,
    saveMetadata: async () => {},
    saveCancelledMetadata: async () => {
      cancellationSaves++;
    },
    summarizeNarrative: async () => {
      cancelled = true;
      return 'cancelled narrative';
    },
    extractStructured: async () => [],
  });
  const window = buildIngestWindow({
    chatUid: 'chat-uid-cancelled',
    branchUid: 'branch-cancelled',
    messages: chat.slice(0, 2),
    sourceRange: { kind: 'mesId', start: 10, end: 11 },
  });

  const result = await pipeline.ingest(window, {
    shouldAbort: () => cancelled,
    isCancelled: () => cancelled,
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancelled, true);
  assert.equal(cancellationSaves, 1);
  assert.equal(metadata.smartMemory.ingest_windows[window.window_id].status, 'cancelled');
  assert.equal(metadata.smartMemory.product_cursor, undefined);
});

test('array-form structured extraction preserves session evidence records', async () => {
  const metadata = {};
  const pipeline = createProductPipeline({
    metadata,
    summarizeNarrative: async () => 'The scene continues.',
    extractStructured: async () => [
      { id: 'session-a', kind: 'session', type: 'revelation', content: 'Mira reveals the hidden door.' },
    ],
  });
  const window = buildIngestWindow({
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    messages: chat.slice(0, 2),
    sourceRange: { kind: 'mesId', start: 10, end: 11 },
  });

  const result = await pipeline.ingest(window);

  assert.equal(result.status, 'completed');
  assert.deepEqual(metadata.smartMemory.structured_records.map((record) => record.kind), ['session']);
});

test('product status is persisted in the canonical chat metadata', async () => {
  const metadata = {};
  let saves = 0;
  const status = await persistProductStatus(
    metadata,
    { phase: 'finished', windows: 3, recordCount: 12 },
    async () => {
      saves++;
    },
    'smartMemory',
    () => 1234,
  );

  assert.deepEqual(status, {
    phase: 'finished',
    windows: 3,
    recordCount: 12,
    updated_at: 1234,
  });
  assert.deepEqual(metadata.smartMemory.product_status, status);
  assert.equal(saves, 1);
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
      product_status: { phase: 'finished' },
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
  assert.equal(metadata.smartMemory.product_status, null);
  assert.equal(saves, 1);
});

test('rescan reset aborts before mutation when cancellation is already active', async () => {
  const metadata = {
    smartMemory: {
      product_cursor: { last_mes_id: 10 },
      narrative: { layers: [[{ text: 'old' }]] },
      structured_records: [{ id: 'old-record' }],
      ingest_windows: { old: { status: 'completed' } },
      product_status: { phase: 'finished' },
    },
  };
  const before = structuredClone(metadata);
  let saves = 0;

  await assert.rejects(
    resetProductMemory(metadata, async () => {
      saves++;
    }, 'smartMemory', () => true),
    /product reset aborted/,
  );
  assert.deepEqual(metadata, before);
  assert.equal(saves, 0);
});
