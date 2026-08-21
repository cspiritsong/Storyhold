import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowFromChat, createMetadataIngestStore, createRuntimeIngestQueue } from '../runtime-ingest.js';

const chat = [
  { mesId: 10, name: 'Badi', is_user: true, mes: 'We enter the temple.' },
  { mesId: 11, name: 'Mira', is_user: false, mes: 'The sealed door waits.' },
];

test('runtime window uses mesId range when the source messages have real mesIds', () => {
  const window = buildWindowFromChat({
    chat,
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    startIndex: 0,
    endIndex: 1,
  });

  assert.deepEqual(window.source_range, { kind: 'mesId', start: 10, end: 11 });
  assert.equal(window.chat_uid, 'chat-uid-a');
  assert.equal(window.branch_uid, 'branch-uid-a');
  assert.equal(window.messages.length, 2);
});

test('runtime window falls back to array index for imported messages', () => {
  const window = buildWindowFromChat({
    chat: [{ name: 'Mira', mes: 'A clue.' }, { name: 'Badi', mes: 'A key.' }],
    chatUid: 'chat-uid-a',
    startIndex: 4,
    endIndex: 5,
  });

  assert.deepEqual(window.source_range, { kind: 'index', start: 4, end: 5 });
});

test('metadata store snapshots queue state and preserves other chat metadata', async () => {
  const metadata = { existing: 'untouched', smartMemory: { chat_uid: 'chat-uid-a' } };
  let saves = 0;
  const store = createMetadataIngestStore({
    metadata,
    saveMetadata: async () => {
      saves++;
    },
  });
  const state = { window_id: 'window-a', records: [{ id: 'record-a' }] };

  await store.save('window-a', state);
  state.records.push({ id: 'mutated-after-save' });
  const loaded = await store.load('window-a');

  assert.equal(metadata.existing, 'untouched');
  assert.equal(metadata.smartMemory.chat_uid, 'chat-uid-a');
  assert.deepEqual(loaded, { window_id: 'window-a', records: [{ id: 'record-a' }] });
  assert.equal(saves, 1);
});

test('runtime queue persists completed projection state in chat metadata', async () => {
  const metadata = {};
  const queue = createRuntimeIngestQueue({
    metadata,
    projectors: {
      structured: async () => [{ id: 'state-a', kind: 'state', content: 'Mira is here.' }],
    },
  });
  const window = buildWindowFromChat({ chat, chatUid: 'chat-uid-a', startIndex: 0, endIndex: 1 });

  const result = await queue.ingest(window);

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.record_ids, ['state-a']);
  assert.equal(Object.keys(metadata.smartMemory.ingest_windows).length, 1);
});
