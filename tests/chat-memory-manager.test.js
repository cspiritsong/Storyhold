import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyRollbackArchive,
  listChatMemoryNamespaces,
  listRollbackArchives,
  nukeAllChatNamespaces,
  nukeChatNamespaces,
} from '../chat-memory-manager.js';

const store = () => ({
  'uid-linked': {
    chat_uid: 'uid-linked',
    chat_id: 'Maeve Main',
    memories: [{ id: 'm1' }],
    sessionMemories: [{ id: 's1' }],
  },
  orphaned: {
    memories: [{ id: 'm2' }],
  },
  'uid-empty': {
    chat_uid: 'uid-empty',
    chat_id: 'Empty Chat',
  },
  archived_chats: {
    'old-name': {
      archived_at: 123,
      reason: 'manual-orphan-archive',
      container: { memories: [{ id: 'old' }] },
    },
  },
});

test('lists active namespaces with linked target and excludes rollback archive', () => {
  const rows = listChatMemoryNamespaces(store(), { currentChatUid: 'uid-linked' });

  assert.deepEqual(rows.map((row) => row.key), ['uid-linked', 'orphaned', 'uid-empty']);
  assert.equal(rows[0].status, 'linked');
  assert.equal(rows[0].linked_to, 'Maeve Main');
  assert.equal(rows[0].current, true);
  assert.equal(rows[1].status, 'orphaned');
  assert.equal(rows[1].linked_to, null);
  assert.equal(rows[0].memory_count, 1);
  assert.equal('memories' in rows[0], false);
});

test('lists rollback entries separately', () => {
  const rows = listRollbackArchives(store());

  assert.deepEqual(rows, [
    {
      key: 'old-name',
      archived_at: 123,
      reason: 'manual-orphan-archive',
      memory_count: 1,
    },
  ]);
});

test('selective nuke removes only chosen active namespaces and preserves archive', () => {
  const data = store();
  const result = nukeChatNamespaces(data, ['orphaned']);

  assert.deepEqual(result.deleted, ['orphaned']);
  assert.equal(data.orphaned, undefined);
  assert.ok(data['uid-linked']);
  assert.ok(data.archived_chats['old-name']);
});

test('nuke all removes active namespaces but leaves rollback archive intact', () => {
  const data = store();
  const result = nukeAllChatNamespaces(data);

  assert.deepEqual(result.deleted, ['uid-linked', 'orphaned', 'uid-empty']);
  assert.deepEqual(Object.keys(data), ['archived_chats']);
  assert.ok(data.archived_chats['old-name']);
});

test('empty rollback archive removes only archived derived data', () => {
  const data = store();
  const result = emptyRollbackArchive(data);

  assert.deepEqual(result.deleted, ['old-name']);
  assert.equal(data.archived_chats, undefined);
  assert.ok(data['uid-linked']);
  assert.ok(data.orphaned);
});

test('nuke operations reject protected archive key as an active namespace', () => {
  const data = store();
  const result = nukeChatNamespaces(data, ['archived_chats']);

  assert.deepEqual(result.deleted, []);
  assert.ok(data.archived_chats);
});
