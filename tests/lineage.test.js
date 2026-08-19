import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINEAGE_STATUS,
  classifyChatLineage,
  filterDerivedRecordsForChat,
} from '../lineage.js';
import { filterCurrentStateLedger, setCurrentLineage } from '../lineage-runtime.js';

const message = (mesId, text = `message-${mesId}`) => ({ mesId, mes: text });

test('standalone chat is trusted without a parent lineage', () => {
  const result = classifyChatLineage({
    chatId: 'chat-30',
    parentChatId: null,
    chat: [message(1)],
  });

  assert.deepEqual(result, {
    status: LINEAGE_STATUS.STANDALONE,
    quarantined: false,
    chatId: 'chat-30',
    parentChatId: null,
    hasRealMesIds: true,
  });
});

test('mesId-less cross-file branch is quarantined', () => {
  const result = classifyChatLineage({
    chatId: 'branch-31',
    parentChatId: 'chat-30',
    chat: [message(null), message(null)],
  });

  assert.equal(result.status, LINEAGE_STATUS.MESID_LESS_BRANCH);
  assert.equal(result.quarantined, true);
  assert.equal(result.parentChatId, 'chat-30');
  assert.equal(result.hasRealMesIds, false);
});

test('cross-file branch with mesIds is still quarantined until prefix verification', () => {
  const result = classifyChatLineage({
    chatId: 'branch-31',
    parentChatId: 'chat-30',
    chat: [message(1), message(2)],
  });

  assert.equal(result.status, LINEAGE_STATUS.UNVERIFIED_BRANCH);
  assert.equal(result.quarantined, true);
  assert.equal(result.hasRealMesIds, true);
});

test('verified prefix lineage releases a branch from quarantine', () => {
  const result = classifyChatLineage({
    chatId: 'branch-31',
    parentChatId: 'chat-30',
    chat: [message(1), message(2)],
    lineage: {
      status: LINEAGE_STATUS.VERIFIED_PREFIX,
      chat_id: 'branch-31',
      parent_chat_id: 'chat-30',
      prefix_end: 2,
    },
  });

  assert.equal(result.status, LINEAGE_STATUS.VERIFIED_PREFIX);
  assert.equal(result.quarantined, false);
});

test('same parent identifier is not treated as a cross-file branch', () => {
  const result = classifyChatLineage({
    chatId: 'chat-30',
    parentChatId: 'chat-30',
    chat: [],
  });

  assert.equal(result.status, LINEAGE_STATUS.STANDALONE);
  assert.equal(result.quarantined, false);
});

test('quarantine removes all derived records from the injection candidate set', () => {
  const records = [
    { id: 'legacy', source_chat_id: null },
    { id: 'parent', source_chat_id: 'chat-30' },
    { id: 'current', source_chat_id: 'branch-31' },
  ];

  const result = filterDerivedRecordsForChat(records, 'branch-31', {
    status: LINEAGE_STATUS.MESID_LESS_BRANCH,
    quarantined: true,
  });

  assert.deepEqual(result, []);
});

test('trusted chat keeps legacy records but rejects foreign provenance', () => {
  const records = [
    { id: 'legacy', source_chat_id: null },
    { id: 'parent', source_chat_id: 'chat-30' },
    { id: 'current', source_chat_id: 'branch-31' },
  ];

  const result = filterDerivedRecordsForChat(records, 'branch-31', {
    status: LINEAGE_STATUS.STANDALONE,
    quarantined: false,
  });

  assert.deepEqual(result.map((record) => record.id), ['legacy', 'current']);
});

test('trusted state ledger keeps legacy/current cards and rejects foreign cards', () => {
  setCurrentLineage({
    status: LINEAGE_STATUS.STANDALONE,
    quarantined: false,
    chatId: 'branch-31',
  });
  try {
    const result = filterCurrentStateLedger({
      legacy: { mood: 'unknown' },
      parent: { mood: 'parent', _source_chat_id: 'chat-30' },
      current: { mood: 'current', _source_chat_id: 'branch-31' },
    });

    assert.deepEqual(Object.keys(result), ['legacy', 'current']);
  } finally {
    setCurrentLineage(null);
  }
});
