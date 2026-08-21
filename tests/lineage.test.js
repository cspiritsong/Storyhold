import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINEAGE_STATUS,
  buildVerifiedPrefixLineage,
  canInheritRecord,
  classifyChatLineage,
  filterDerivedRecordsForChat,
  findCommonChatPrefix,
  inheritDerivedRecords,
  inheritSmartMemoryMetadata,
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

test('rebuilt branch lineage is trusted without inheriting parent records', () => {
  const result = classifyChatLineage({
    chatId: 'branch-31',
    parentChatId: 'chat-30',
    chat: [message(null, 'rebuilt')],
    lineage: {
      status: LINEAGE_STATUS.REBUILT,
      chat_id: 'branch-31',
      parent_chat_id: 'chat-30',
    },
  });

  assert.equal(result.status, LINEAGE_STATUS.REBUILT);
  assert.equal(result.quarantined, false);
});

test('verified branch lineage survives a later chat rename through stable uid', () => {
  const result = classifyChatLineage({
    chatId: 'renamed-branch',
    chatUid: 'uid-branch',
    parentChatId: 'parent-chat',
    chat: [message(1)],
    lineage: {
      status: LINEAGE_STATUS.REBUILT,
      chat_id: 'old-branch-name',
      chat_uid: 'uid-branch',
      parent_chat_id: 'parent-chat',
    },
  });

  assert.equal(result.status, LINEAGE_STATUS.REBUILT);
  assert.equal(result.quarantined, false);
});

test('explicit manual link trusts the selected full namespace as an override', () => {
  const result = classifyChatLineage({
    chatId: 'new-chat',
    chatUid: 'uid-new-chat',
    parentChatId: 'glm52-chat',
    chat: [message(1)],
    lineage: {
      status: LINEAGE_STATUS.MANUAL_LINKED,
      chat_id: 'new-chat',
      chat_uid: 'uid-new-chat',
      parent_chat_id: 'glm52-chat',
      manual_override: true,
    },
  });

  assert.equal(result.status, LINEAGE_STATUS.MANUAL_LINKED);
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

test('stable chat uid and rename aliases keep same-chat provenance usable after rename', () => {
  const lineage = classifyChatLineage({
    chatId: 'renamed-chat',
    chatUid: 'uid-1',
    legacyChatIds: ['old-chat'],
    parentChatId: null,
    chat: [],
  });
  const records = [
    { id: 'old', source_chat_id: 'old-chat' },
    { id: 'uid', source_chat_uid: 'uid-1' },
    { id: 'foreign', source_chat_id: 'other-chat' },
  ];

  assert.deepEqual(
    filterDerivedRecordsForChat(records, 'renamed-chat', lineage).map((record) => record.id),
    ['old', 'uid'],
  );
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

test('common prefix is found before a divergent branch tail', () => {
  const parent = [message(1), message(2), message(3), message(4), message(5)];
  const branch = [message(1), message(2), message(3), message(99, 'new tail')];

  assert.deepEqual(findCommonChatPrefix(parent, branch), {
    verified: true,
    method: 'mesId',
    commonPrefixLength: 3,
    parentPrefixEnd: 2,
    branchPrefixEnd: 2,
  });
});

test('mesId-less identical prefix uses canonical fingerprints', () => {
  const parent = [message(null, ' one  '), message(null, 'two')];
  const branch = [message(null, 'one'), message(null, 'two'), message(null, 'tail')];

  const result = findCommonChatPrefix(parent, branch);

  assert.equal(result.verified, true);
  assert.equal(result.method, 'fingerprint');
  assert.equal(result.commonPrefixLength, 2);
});

test('lineage record is created only from a verified common prefix', () => {
  const lineage = buildVerifiedPrefixLineage({
    chatId: 'branch-31',
    parentChatId: 'chat-30',
    parentChat: [message(1), message(2), message(3)],
    branchChat: [message(1), message(2), message(9, 'branch tail')],
    epochId: 'epoch-31',
  });

  assert.deepEqual(lineage, {
    status: LINEAGE_STATUS.VERIFIED_PREFIX,
    chat_id: 'branch-31',
    parent_chat_id: 'chat-30',
    prefix_end: 1,
    prefix_length: 2,
    method: 'mesId',
    epoch_id: 'epoch-31',
  });
});

test('only parent records wholly inside the shared prefix can be inherited', () => {
  const options = { parentChatId: 'chat-30', parentPrefixEnd: 2 };
  const prefixRecord = {
    id: 'prefix',
    source_chat_id: 'chat-30',
    source_messages: [[1, 2]],
  };
  const tailRecord = {
    id: 'tail',
    source_chat_id: 'chat-30',
    source_messages: [[2, 4]],
  };
  const unprovenRecord = { id: 'unknown', source_chat_id: 'chat-30', source_messages: [] };

  assert.equal(canInheritRecord(prefixRecord, options), true);
  assert.equal(canInheritRecord(tailRecord, options), false);
  assert.equal(canInheritRecord(unprovenRecord, options), false);
});

test('inherited records are copied and retagged without mutating the parent record', () => {
  const parent = {
    id: 'prefix',
    source_chat_id: 'chat-30',
    source_messages: [[1, 2]],
    content: 'shared fact',
  };

  const result = inheritDerivedRecords([parent], {
    parentChatId: 'chat-30',
    branchChatId: 'branch-31',
    parentPrefixEnd: 2,
    epochId: 'epoch-31',
  });

  assert.deepEqual(result, [
    {
      id: 'prefix',
      source_chat_id: 'branch-31',
      origin_chat_id: 'chat-30',
      source_messages: [[1, 2]],
      content: 'shared fact',
      inherited: true,
      lineage_epoch: 'epoch-31',
    },
  ]);
  assert.equal(parent.source_chat_id, 'chat-30');
});

test('chat metadata inheritance carries only proven prefix projections', () => {
  const result = inheritSmartMemoryMetadata(
    {
      schema_version: 10,
      sessionMemories: [
        { id: 'prefix', source_chat_id: 'chat-30', source_messages: [[0, 2]] },
        { id: 'tail', source_chat_id: 'chat-30', source_messages: [[3, 4]] },
        { id: 'unknown', source_chat_id: null, source_messages: [] },
      ],
      storyArcs: [{ content: 'prefix arc', source_chat_id: 'chat-30', source_messages: [[1, 2]] }],
      profiles: {
        Maeve: {
          character_state: 'prefix state',
          source_chat_id: 'chat-30',
          source_message_range: [0, 2],
        },
      },
      summary: 'prefix summary',
      summary_source_chat_id: 'chat-30',
      summary_source_message_range: [0, 2],
      narrative: {
        schema_version: 1,
        chat_uid: 'chat-30',
        branch_uid: 'parent-epoch',
        settings: { snippetsPerLayer: 2, snippetsPerPromotion: 1, maxLayers: 3 },
        layers: [[
          {
            id: 'narrative-prefix',
            text: 'prefix narrative',
            source_range: { kind: 'mesId', start: 0, end: 2 },
            scope: { chat_uid: 'chat-30', branch_uid: 'parent-epoch' },
          },
          {
            id: 'narrative-tail',
            text: 'tail narrative',
            source_range: { kind: 'mesId', start: 3, end: 4 },
            scope: { chat_uid: 'chat-30', branch_uid: 'parent-epoch' },
          },
        ]],
        processed_windows: [],
        watermark: {
          window_id: 'tail-window',
          source_range: { kind: 'mesId', start: 3, end: 4 },
          fingerprint: 'tail',
        },
      },
      structured_records: [
        {
          id: 'structured-prefix',
          kind: 'fact',
          content: 'Prefix fact.',
          source_range: { kind: 'mesId', start: 0, end: 2 },
          scope: { chat_uid: 'chat-30', branch_uid: 'parent-epoch' },
          provenance: { source_chat_uid: 'chat-30', source_messages: [0, 2] },
        },
        {
          id: 'structured-tail',
          kind: 'fact',
          content: 'Tail fact.',
          source_range: { kind: 'mesId', start: 3, end: 4 },
          scope: { chat_uid: 'chat-30', branch_uid: 'parent-epoch' },
          provenance: { source_chat_uid: 'chat-30', source_messages: [3, 4] },
        },
      ],
    },
    {
      parentChatId: 'chat-30',
      branchChatId: 'branch-31',
      branchChatUid: 'stable-branch-uid',
      parentPrefixEnd: 2,
      branchPrefixLength: 3,
      epochId: 'epoch-31',
    },
  );

  assert.deepEqual(result.sessionMemories.map((memory) => memory.id), ['prefix']);
  assert.equal(result.sessionMemories[0].source_chat_id, 'branch-31');
  assert.deepEqual(result.storyArcs.map((arc) => arc.content), ['prefix arc']);
  assert.equal(result.profiles.Maeve.source_chat_id, 'branch-31');
  assert.equal(result.summary, 'prefix summary');
  assert.equal(result.summaryEnd, 3);
  assert.equal(result.lastExtractCutoff, 3);
  assert.ok(result.narrative);
  assert.deepEqual(result.narrative.layers[0].map((snippet) => snippet.id), ['narrative-prefix']);
  assert.equal(result.narrative.chat_uid, 'stable-branch-uid');
  assert.equal(result.narrative.branch_uid, 'epoch-31');
  assert.equal(result.narrative.watermark, null);
  assert.deepEqual(result.structured_records.map((record) => record.id), ['structured-prefix']);
  assert.equal(result.structured_records[0].scope.chat_uid, 'stable-branch-uid');
  assert.equal(result.structured_records[0].scope.branch_uid, 'epoch-31');
  assert.equal(result.structured_records[0].provenance.source_chat_uid, 'stable-branch-uid');
});
