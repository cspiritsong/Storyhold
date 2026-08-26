import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINEAGE_STATUS,
  buildRebuiltLineageMetadata,
  buildIndependentChatTreeMetadata,
  buildVerifiedPrefixLineage,
  canInheritRecord,
  classifyChatLineage,
  classifyIndependentChatTree,
  filterDerivedRecordsForChat,
  findCommonChatPrefix,
  inheritDerivedRecords,
  inheritSmartMemoryMetadata,
  lineageEpochStamp,
} from '../lineage.js';
import {
  currentLineageEpochStamp,
  filterCurrentStateLedger,
  setCurrentLineage,
} from '../lineage-runtime.js';
import { fingerprintMessages } from '../projections.js';

const message = (mesId, text = `message-${mesId}`) => ({ mesId, mes: text });

test('missing chat identity is quarantined instead of treated as standalone', () => {
  const result = classifyChatLineage({
    chatId: null,
    chatUid: null,
    chat: [{ name: 'Badi', is_user: true, mes: 'Hello.' }],
  });

  assert.equal(result.quarantined, true);
  assert.equal(result.status, LINEAGE_STATUS.MISSING_IDENTITY);
});

test('compatibility epoch stamp is null without a branch epoch and set with one', () => {
  assert.equal(lineageEpochStamp(null), null);
  assert.equal(lineageEpochStamp({ status: LINEAGE_STATUS.STANDALONE }), null);
  assert.deepEqual(lineageEpochStamp({ epoch_id: 'ep-1' }), { lineage_epoch: 'ep-1' });
  assert.deepEqual(lineageEpochStamp({ epochId: 'ep-2' }), { lineage_epoch: 'ep-2' });
  assert.deepEqual(lineageEpochStamp({ branch_uid: 'ep-3', epoch_id: 'stale' }), {
    lineage_epoch: 'ep-3',
  });
});

test('current epoch stamp follows the runtime lineage and satisfies branch filters', () => {
  setCurrentLineage({
    status: LINEAGE_STATUS.REBUILT,
    chatId: 'chat-1',
    chatUid: 'uid-1',
    epoch_id: 'ep-1',
  });
  const stamp = currentLineageEpochStamp();
  assert.deepEqual(stamp, { lineage_epoch: 'ep-1' });

  const lineage = {
    status: LINEAGE_STATUS.REBUILT,
    chatUid: 'uid-1',
    epoch_id: 'ep-1',
  };
  const stamped = filterDerivedRecordsForChat(
    [
      {
        content: 'stamped',
        source_chat_id: 'chat-1',
        source_messages: [[0, 2]],
        lineage_epoch: stamp.lineage_epoch,
      },
    ],
    'chat-1',
    lineage,
  );
  assert.equal(stamped.length, 1);

  // An unstamped record is rejected on a branch that requires the epoch.
  const unstamped = filterDerivedRecordsForChat(
    [{ content: 'unstamped', source_chat_id: 'chat-1', source_messages: [[0, 2]] }],
    'chat-1',
    lineage,
  );
  assert.equal(unstamped.length, 0);
  setCurrentLineage(null);
});

test('cross-file lineage without a stored uid is quarantined even when chat ids match', () => {
  const result = classifyChatLineage({
    chatId: 'child-chat',
    chatUid: 'stable-child-uid',
    parentChatId: 'parent-chat',
    chat: [
      { mesId: 1, name: 'Badi', is_user: true, mes: 'Start.' },
    ],
    lineage: {
      status: LINEAGE_STATUS.REBUILT,
      chat_id: 'child-chat',
      parent_chat_id: 'parent-chat',
      rebuilt_from_raw: true,
    },
  });

  assert.equal(result.quarantined, true);
  assert.equal(result.status, LINEAGE_STATUS.UNVERIFIED_BRANCH);
});

test('rebuilt lineage classification preserves the rebuild epoch', () => {
  const result = classifyChatLineage({
    chatId: 'child-chat',
    chatUid: 'child-uid',
    parentChatId: 'parent-chat',
    chat: [message(1)],
    lineage: {
      status: LINEAGE_STATUS.REBUILT,
      chat_id: 'child-chat',
      chat_uid: 'child-uid',
      parent_chat_id: 'parent-chat',
      rebuilt_from_raw: true,
      epoch_id: 'rebuild-epoch-1',
    },
  });

  assert.equal(result.quarantined, false);
  assert.equal(result.epoch_id, 'rebuild-epoch-1');
});

test('verified branch lineage rejects a child uid equal to the parent root uid', () => {
  const parent = [message(1), message(2)];
  const branch = [message(1), message(2), message(3)];
  const result = buildVerifiedPrefixLineage({
    chatId: 'child-chat',
    chatUid: 'parent-uid',
    rootChatUid: 'parent-uid',
    parentChatId: 'parent-chat',
    parentChat: parent,
    branchChat: branch,
    epochId: 'epoch-child',
  });

  assert.equal(result.status, LINEAGE_STATUS.UNVERIFIED_BRANCH);
  assert.equal(result.quarantined, undefined);
});

test('standalone chat is trusted without a parent lineage', () => {
  const result = classifyChatLineage({
    chatId: 'chat-30',
    chatUid: 'uid-30',
    parentChatId: null,
    chat: [message(1)],
  });

  assert.deepEqual(result, {
    status: LINEAGE_STATUS.STANDALONE,
    quarantined: false,
    chatId: 'chat-30',
    parentChatId: null,
    hasRealMesIds: true,
    chatUid: 'uid-30',
  });
});

test('independent chat trees ignore parent and stale lineage metadata', () => {
  const result = classifyIndependentChatTree({
    chatId: 'branch-31',
    chatUid: 'uid-branch-31',
    parentChatId: 'parent-chat',
    chat: [message(1), message(2)],
    lineage: {
      status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
      quarantined: true,
      reason: 'stable-namespace-fingerprint-mismatch',
      parent_chat_id: 'parent-chat',
    },
  });

  assert.equal(result.status, LINEAGE_STATUS.STANDALONE);
  assert.equal(result.quarantined, false);
  assert.equal(result.parentChatId, null);
  assert.equal(result.chatUid, 'uid-branch-31');
  assert.equal(result.hasRealMesIds, true);
});

test('independent chat-tree rebuild metadata clears derived state without a parent', () => {
  const rebuilt = buildIndependentChatTreeMetadata({
    priorSmartMemory: {
      chat_uid: 'old-uid',
      root_chat_uid: 'parent-uid',
      chat_aliases: ['old-name'],
      structured_records: [{ id: 'foreign' }],
      lineage: { status: LINEAGE_STATUS.UNVERIFIED_BRANCH, parent_chat_id: 'parent-chat' },
    },
    chatId: 'current-name',
    chatUid: 'current-uid',
    aliases: ['prior-name'],
    schemaVersion: 9,
  });

  assert.equal(rebuilt.chat_uid, 'current-uid');
  assert.equal(rebuilt.root_chat_uid, 'current-uid');
  assert.deepEqual(rebuilt.chat_aliases, ['old-name', 'prior-name']);
  assert.deepEqual(rebuilt.structured_records, []);
  assert.equal(rebuilt.lineage.status, LINEAGE_STATUS.STANDALONE);
  assert.equal(rebuilt.lineage.quarantined, false);
  assert.equal(rebuilt.lineage.parent_chat_id, undefined);
  assert.equal(rebuilt.lineage.method, 'independent-chat-tree');
});

test('missing stable chat uid is quarantined instead of trusting the filename', () => {
  const result = classifyChatLineage({
    chatId: 'chat-30',
    chatUid: null,
    parentChatId: null,
    chat: [message(1)],
  });

  assert.equal(result.status, LINEAGE_STATUS.MISSING_IDENTITY);
  assert.equal(result.quarantined, true);
});

test('explicit lineage quarantine survives same-file classification', () => {
  const result = classifyChatLineage({
    chatId: 'chat-30',
    chatUid: 'uid-30',
    parentChatId: null,
    chat: [message(1)],
    lineage: {
      status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
      quarantined: true,
      reason: 'narrative-provenance-mismatch',
    },
  });

  assert.equal(result.status, LINEAGE_STATUS.UNVERIFIED_BRANCH);
  assert.equal(result.quarantined, true);
  assert.equal(result.reason, 'narrative-provenance-mismatch');
});

test('mesId-less cross-file branch is quarantined', () => {
  const result = classifyChatLineage({
    chatId: 'branch-31',
    chatUid: 'uid-branch-31',
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
    chatUid: 'uid-branch-31',
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
    chatUid: 'uid-branch-31',
    parentChatId: 'chat-30',
    chat: [message(1), message(2)],
    lineage: {
      status: LINEAGE_STATUS.VERIFIED_PREFIX,
      chat_id: 'branch-31',
      chat_uid: 'uid-branch-31',
      parent_chat_id: 'chat-30',
      prefix_end: 1,
      prefix_length: 2,
      prefix_fingerprint: fingerprintMessages([message(1), message(2)]),
      method: 'mesId',
    },
  });

  assert.equal(result.status, LINEAGE_STATUS.VERIFIED_PREFIX);
  assert.equal(result.quarantined, false);
});

test('verified prefix lineage is quarantined when the live inherited prefix changes', () => {
  const originalPrefix = [message(1, 'original')];
  const result = classifyChatLineage({
    chatId: 'branch-31',
    chatUid: 'uid-branch',
    parentChatId: 'chat-30',
    chat: [message(1, 'edited')],
    lineage: {
      status: LINEAGE_STATUS.VERIFIED_PREFIX,
      chat_id: 'branch-31',
      chat_uid: 'uid-branch',
      parent_chat_id: 'chat-30',
      prefix_end: 0,
      prefix_length: 1,
      prefix_fingerprint: fingerprintMessages(originalPrefix),
      method: 'mesId',
    },
  });

  assert.equal(result.status, LINEAGE_STATUS.UNVERIFIED_BRANCH);
  assert.equal(result.quarantined, true);
});
test('rebuilt branch lineage is trusted without inheriting parent records', () => {
  const result = classifyChatLineage({
    chatId: 'branch-31',
    chatUid: 'uid-branch',
    parentChatId: 'chat-30',
    chat: [message(null, 'rebuilt')],
    lineage: {
      status: LINEAGE_STATUS.REBUILT,
      chat_id: 'branch-31',
      chat_uid: 'uid-branch',
      parent_chat_id: 'chat-30',
      rebuilt_from_raw: true,
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
      rebuilt_from_raw: true,
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
    chatUid: 'uid-chat-30',
    parentChatId: 'chat-30',
    chat: [],
  });

  assert.equal(result.status, LINEAGE_STATUS.STANDALONE);
  assert.equal(result.quarantined, false);
});

test('stored branch lineage with a self-parent is quarantined instead of downgraded to standalone', () => {
  const result = classifyChatLineage({
    chatId: 'chat-30',
    chatUid: 'uid-chat-30',
    parentChatId: 'chat-30',
    chat: [message(1)],
    lineage: {
      status: LINEAGE_STATUS.REBUILT,
      chat_id: 'chat-30',
      chat_uid: 'uid-chat-30',
      parent_chat_id: 'chat-30',
      rebuilt_from_raw: true,
      epoch_id: 'self-parent-epoch',
    },
  });

  assert.equal(result.status, LINEAGE_STATUS.UNVERIFIED_BRANCH);
  assert.equal(result.quarantined, true);
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

test('current chat record filtering rejects sibling branch provenance', () => {
  const lineage = {
    status: LINEAGE_STATUS.VERIFIED_PREFIX,
    quarantined: false,
    chatId: 'branch-chat',
    chatUid: 'branch-uid',
    epoch_id: 'branch-epoch',
    legacyChatIds: [],
  };
  const records = [
    {
      id: 'sibling',
      source_chat_id: 'branch-chat',
      source_chat_uid: 'branch-uid',
      lineage_epoch: 'sibling-epoch',
    },
    {
      id: 'current',
      source_chat_id: 'branch-chat',
      source_chat_uid: 'branch-uid',
      lineage_epoch: 'branch-epoch',
    },
  ];

  assert.deepEqual(
    filterDerivedRecordsForChat(records, 'branch-chat', lineage).map((record) => record.id),
    ['current'],
  );
});

test('current chat record filtering rejects sibling branch variants', () => {
  const lineage = {
    status: LINEAGE_STATUS.VERIFIED_PREFIX,
    quarantined: false,
    chatId: 'branch-chat',
    chatUid: 'branch-uid',
    epoch_id: 'branch-epoch',
    legacyChatIds: [],
  };
  const records = [
    { id: 'internal-sibling', source_chat_uid: 'branch-uid', _lineage_epoch: 'sibling-epoch' },
    { id: 'nested-sibling', source_chat_uid: 'branch-uid', provenance: { lineage_epoch: 'sibling-epoch' } },
    { id: 'current', source_chat_uid: 'branch-uid', scope: { branch_uid: 'branch-epoch' } },
  ];

  assert.deepEqual(
    filterDerivedRecordsForChat(records, 'branch-chat', lineage).map((record) => record.id),
    ['current'],
  );
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
    chatUid: 'uid-branch',
  });
  try {
    const result = filterCurrentStateLedger({
      legacy: { mood: 'unknown', _source_chat_id: 'branch-31', _source_chat_uid: 'uid-branch' },
      parent: { mood: 'parent', _source_chat_id: 'chat-30', _source_chat_uid: 'uid-parent' },
      current: { mood: 'current', _source_chat_id: 'branch-31', _source_chat_uid: 'uid-branch' },
    });

    assert.deepEqual(Object.keys(result), ['legacy', 'current']);
  } finally {
    setCurrentLineage(null);
  }
});

test('foreign source uid is rejected when source chat id is absent', () => {
  const filtered = filterDerivedRecordsForChat(
    [
      { id: 'foreign', source_chat_uid: 'uid-b' },
      { id: 'current', source_chat_uid: 'uid-a' },
      { id: 'legacy' },
    ],
    'chat-a',
    { chatUid: 'uid-a', legacyChatIds: [] },
  );

  assert.deepEqual(filtered.map((record) => record.id), ['current', 'legacy']);
});

test('derived filter rejects mixed top-level and nested source uids', () => {
  const filtered = filterDerivedRecordsForChat(
    [{
      id: 'mixed',
      source_chat_uid: 'uid-a',
      provenance: { source_chat_uid: 'uid-b' },
      scope: { chat_uid: 'uid-a' },
    }],
    'chat-a',
    { chatUid: 'uid-a', legacyChatIds: [] },
  );

  assert.deepEqual(filtered, []);
});

test('derived filter rejects alternate and internal provenance variants', () => {
  const filtered = filterDerivedRecordsForChat(
    [
      { id: 'top-uid', chat_uid: 'uid-b' },
      { id: 'top-id', chat_id: 'chat-b' },
      { id: 'prov-chat-uid', provenance: { chat_uid: 'uid-b' } },
      { id: 'scope-source-uid', scope: { source_chat_uid: 'uid-b' } },
      { id: 'internal-uid', _source_chat_uid: 'uid-b' },
      { id: 'internal-id', _source_chat_id: 'chat-b' },
      { id: 'scope-id', scope: { chat_id: 'chat-b' } },
      { id: 'ok', source_chat_uid: 'uid-a', source_chat_id: 'chat-a' },
    ],
    'chat-a',
    { chatUid: 'uid-a', legacyChatIds: [] },
  );

  assert.deepEqual(filtered.map((record) => record.id), ['ok']);
});

test('derived filter rejects a foreign nested internal branch epoch', () => {
  const filtered = filterDerivedRecordsForChat(
    [{
      id: 'mixed-epoch',
      source_chat_uid: 'uid-a',
      branch_uid: 'branch-a',
      scope: { _lineage_epoch: 'branch-b' },
    }],
    'chat-a',
    {
      chatUid: 'uid-a',
      branchUid: 'branch-a',
      status: LINEAGE_STATUS.VERIFIED_PREFIX,
      epoch_id: 'branch-a',
      legacyChatIds: [],
    },
  );

  assert.deepEqual(filtered, []);
});

test('derived filter rejects nested internal source identity variants', () => {
  const filtered = filterDerivedRecordsForChat(
    [
      {
        id: 'scope-id',
        source_chat_id: 'chat-a',
        source_chat_uid: 'uid-a',
        scope: { _source_chat_id: 'chat-b' },
      },
      {
        id: 'provenance-uid',
        source_chat_id: 'chat-a',
        source_chat_uid: 'uid-a',
        provenance: { _source_chat_uid: 'uid-b' },
      },
      {
        id: 'current',
        source_chat_id: 'chat-a',
        source_chat_uid: 'uid-a',
        scope: { _source_chat_id: 'chat-a', _source_chat_uid: 'uid-a' },
        provenance: { _source_chat_id: 'chat-a', _source_chat_uid: 'uid-a' },
      },
    ],
    'chat-a',
    { chatUid: 'uid-a', legacyChatIds: [] },
  );

  assert.deepEqual(filtered.map((record) => record.id), ['current']);
});

test('derived filter rejects explicit branch provenance without current branch proof', () => {
  const filtered = filterDerivedRecordsForChat(
    [{
      id: 'unproven-branch',
      source_chat_id: 'chat-a',
      source_chat_uid: 'uid-a',
      branch_uid: 'sibling-branch',
    }],
    'chat-a',
    {
      status: LINEAGE_STATUS.STANDALONE,
      quarantined: false,
      chatUid: 'uid-a',
      legacyChatIds: [],
    },
  );

  assert.deepEqual(filtered, []);
});

test('canInheritRecord rejects foreign explicit uid provenance', () => {
  const options = { parentChatId: 'chat-30', parentPrefixEnd: 2 };
  assert.equal(
    canInheritRecord(
      { source_chat_id: 'chat-30', source_chat_uid: 'uid-b', source_messages: [[1, 2]] },
      { ...options, parentChatUid: 'uid-a' },
    ),
    false,
  );
  assert.equal(
    canInheritRecord(
      { source_chat_id: 'chat-30', source_chat_uid: 'uid-a', source_messages: [[1, 2]] },
      { ...options, parentChatUid: 'uid-a' },
    ),
    true,
  );
});

test('canInheritRecord rejects missing parent uid or branch proof', () => {
  const base = { source_chat_id: 'chat-30', source_messages: [[1, 2]] };
  assert.equal(
    canInheritRecord(base, {
      parentChatId: 'chat-30',
      parentChatUid: 'uid-a',
      parentPrefixEnd: 2,
    }),
    false,
  );
  assert.equal(
    canInheritRecord(
      { ...base, source_chat_uid: 'uid-a' },
      {
        parentChatId: 'chat-30',
        parentChatUid: 'uid-a',
        parentBranchUid: 'parent-epoch',
        parentPrefixEnd: 2,
      },
    ),
    false,
  );
});

test('canInheritRecord rejects foreign nested source identity variants', () => {
  assert.equal(
    canInheritRecord(
      {
        source_chat_id: 'chat-30',
        source_chat_uid: 'uid-a',
        scope: { _source_chat_uid: 'uid-b' },
        provenance: { _source_chat_id: 'chat-b' },
        source_messages: [[1, 2]],
      },
      { parentChatId: 'chat-30', parentChatUid: 'uid-a', parentPrefixEnd: 2 },
    ),
    false,
  );
});

test('canInheritRecord rejects sibling branch provenance', () => {
  assert.equal(
    canInheritRecord(
      {
        source_chat_id: 'chat-30',
        source_chat_uid: 'uid-a',
        lineage_epoch: 'sibling-epoch',
        source_messages: [[1, 2]],
      },
      {
        parentChatId: 'chat-30',
        parentChatUid: 'uid-a',
        parentBranchUid: 'parent-epoch',
        parentPrefixEnd: 2,
      },
    ),
    false,
  );
});

test('state ledger rejects a foreign source uid when source chat id is absent', () => {
  setCurrentLineage({ chatId: 'chat-a', chatUid: 'uid-a', legacyChatIds: [], quarantined: false });
  try {
    const filtered = filterCurrentStateLedger({
      foreign: { _source_chat_uid: 'uid-b' },
      current: { _source_chat_uid: 'uid-a' },
      legacy: {},
    });

    assert.deepEqual(Object.keys(filtered), []);
  } finally {
    setCurrentLineage(null);
  }
});

test('state ledger rejects mixed internal and alternate source uids', () => {
  setCurrentLineage({ chatId: 'chat-a', chatUid: 'uid-a', legacyChatIds: [], quarantined: false });
  try {
    const filtered = filterCurrentStateLedger({
      mixed: {
        _source_chat_uid: 'uid-a',
        _source_chat_id: 'chat-a',
        scope: { _source_chat_uid: 'uid-b', _source_chat_id: 'chat-a' },
      },
      current: {
        _source_chat_uid: 'uid-a',
        source_chat_uid: 'uid-a',
        _source_chat_id: 'chat-a',
      },
    });

    assert.deepEqual(Object.keys(filtered), ['current']);
  } finally {
    setCurrentLineage(null);
  }
});

test('state ledger rejects top-level and alternate identity variants', () => {
  setCurrentLineage({ chatId: 'chat-a', chatUid: 'uid-a', legacyChatIds: [], quarantined: false });
  try {
    const filtered = filterCurrentStateLedger({
      topUid: { chat_uid: 'uid-b' },
      topId: { chat_id: 'chat-b' },
      provChatUid: { provenance: { chat_uid: 'uid-b' } },
      scopeSourceUid: { scope: { source_chat_uid: 'uid-b' } },
      scopeId: { scope: { chat_id: 'chat-b' } },
      internalId: { _source_chat_id: 'chat-b' },
      current: { _source_chat_uid: 'uid-a', _source_chat_id: 'chat-a' },
    });

    assert.deepEqual(Object.keys(filtered), ['current']);
  } finally {
    setCurrentLineage(null);
  }
});

test('state ledger rejects foreign nested internal source identity', () => {
  setCurrentLineage({ chatId: 'chat-a', chatUid: 'uid-a', legacyChatIds: [], quarantined: false });
  try {
    const filtered = filterCurrentStateLedger({
      mixed: {
        _source_chat_uid: 'uid-a',
        _source_chat_id: 'chat-a',
        scope: { _source_chat_uid: 'uid-b' },
        provenance: { _source_chat_id: 'chat-b' },
      },
      current: {
        _source_chat_uid: 'uid-a',
        _source_chat_id: 'chat-a',
        scope: { _source_chat_uid: 'uid-a', _source_chat_id: 'chat-a' },
        provenance: { _source_chat_uid: 'uid-a', _source_chat_id: 'chat-a' },
      },
    });

    assert.deepEqual(Object.keys(filtered), ['current']);
  } finally {
    setCurrentLineage(null);
  }
});

test('state ledger rejects sibling and missing branch epochs for a verified branch', () => {
  setCurrentLineage({
    status: LINEAGE_STATUS.VERIFIED_PREFIX,
    chatId: 'chat-a',
    chatUid: 'uid-a',
    epoch_id: 'branch-epoch',
    legacyChatIds: [],
    quarantined: false,
  });
  try {
    const filtered = filterCurrentStateLedger({
      sibling: {
        _source_chat_uid: 'uid-a',
        _source_chat_id: 'chat-a',
        _lineage_epoch: 'sibling-epoch',
      },
      nestedSibling: {
        _source_chat_uid: 'uid-a',
        _source_chat_id: 'chat-a',
        provenance: { branch_uid: 'sibling-epoch' },
      },
      unscoped: { _source_chat_uid: 'uid-a', _source_chat_id: 'chat-a' },
      current: {
        _source_chat_uid: 'uid-a',
        _source_chat_id: 'chat-a',
        _lineage_epoch: 'branch-epoch',
      },
    });

    assert.deepEqual(Object.keys(filtered), ['current']);
  } finally {
    setCurrentLineage(null);
  }
});

test('state ledger keeps standalone cards when a story epoch is supplied', () => {
  setCurrentLineage({
    status: LINEAGE_STATUS.STANDALONE,
    chatId: 'chat-a',
    chatUid: 'uid-a',
    legacyChatIds: [],
    quarantined: false,
  });
  try {
    const filtered = filterCurrentStateLedger(
      {
        current: { _source_chat_uid: 'uid-a', _source_chat_id: 'chat-a' },
        foreignBranch: {
          _source_chat_uid: 'uid-a',
          _source_chat_id: 'chat-a',
          _lineage_epoch: 'foreign-branch-epoch',
        },
      },
      'story-day-12',
    );

    assert.deepEqual(Object.keys(filtered), ['current']);
  } finally {
    setCurrentLineage(null);
  }
});

test('standalone state ledger rejects cards without explicit chat identity', () => {
  setCurrentLineage({
    status: LINEAGE_STATUS.STANDALONE,
    chatId: 'chat-a',
    chatUid: 'uid-a',
    legacyChatIds: [],
    quarantined: false,
  });
  try {
    const filtered = filterCurrentStateLedger({
      empty: {},
      uidOnly: { _source_chat_uid: 'uid-a' },
      idOnly: { _source_chat_id: 'chat-a' },
      valid: { _source_chat_id: 'chat-a', _source_chat_uid: 'uid-a' },
    });

    assert.deepEqual(Object.keys(filtered), ['valid']);
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

test('fingerprint-only cross-file lineage stays unverified', () => {
  const parent = [{ mes: 'one' }, { mes: 'two' }];
  const branch = [{ mes: 'one' }, { mes: 'two' }, { mes: 'tail' }];
  const lineage = buildVerifiedPrefixLineage({
    chatId: 'branch-chat',
    chatUid: 'branch-uid',
    parentChatId: 'parent-chat',
    parentChat: parent,
    branchChat: branch,
    epochId: 'branch-epoch',
  });

  assert.equal(lineage.method, 'fingerprint');
  assert.equal(lineage.status, LINEAGE_STATUS.UNVERIFIED_BRANCH);
});

test('stored cross-file lineage is not treated as standalone when main chat evidence is absent', () => {
  const result = classifyChatLineage({
    chatId: 'child-chat',
    chatUid: 'child-uid',
    parentChatId: null,
    chat: [message(1)],
    lineage: {
      status: LINEAGE_STATUS.REBUILT,
      chat_id: 'child-chat',
      chat_uid: 'child-uid',
      parent_chat_id: 'parent-chat',
      rebuilt_from_raw: true,
      epoch_id: 'child-epoch',
    },
  });

  assert.equal(result.quarantined, true);
  assert.equal(result.status, LINEAGE_STATUS.UNVERIFIED_BRANCH);
});

test('lineage record is created only from a verified common prefix', () => {
  const lineage = buildVerifiedPrefixLineage({
    chatId: 'branch-31',
    chatUid: 'uid-branch-31',
    parentChatId: 'chat-30',
    parentChat: [message(1), message(2), message(3)],
    branchChat: [message(1), message(2), message(9, 'branch tail')],
    epochId: 'epoch-31',
  });

  assert.deepEqual(lineage, {
    status: LINEAGE_STATUS.VERIFIED_PREFIX,
    chat_id: 'branch-31',
    chat_uid: 'uid-branch-31',
    parent_chat_id: 'chat-30',
    prefix_end: 1,
    prefix_length: 2,
    prefix_fingerprint: fingerprintMessages([message(1), message(2)]),
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

test('inherited records retag every explicit uid provenance field for the child', () => {
  const result = inheritDerivedRecords(
    [{
      id: 'uid-record',
      source_chat_id: 'chat-30',
      source_chat_uid: 'parent-uid',
      provenance: { source_chat_uid: 'parent-uid', source_chat_id: 'chat-30' },
      scope: { chat_uid: 'parent-uid', branch_uid: 'parent-epoch' },
      source_messages: [[1, 2]],
    }],
    {
      parentChatId: 'chat-30',
      parentBranchUid: 'parent-epoch',
      branchChatId: 'branch-31',
      branchChatUid: 'child-uid',
      parentPrefixEnd: 2,
      epochId: 'child-epoch',
    },
  );

  assert.equal(result[0].source_chat_uid, 'child-uid');
  assert.equal(result[0].provenance.source_chat_uid, 'child-uid');
  assert.equal(result[0].provenance.source_chat_id, 'branch-31');
  assert.equal(result[0].scope.chat_uid, 'child-uid');
  assert.equal(result[0].scope.branch_uid, 'child-epoch');
});

test('inherited records retag every explicit branch provenance variant', () => {
  const result = inheritDerivedRecords(
    [{
      id: 'branch-record',
      source_chat_id: 'chat-30',
      source_chat_uid: 'uid-a',
      branch_uid: 'parent-epoch',
      _branch_uid: 'parent-epoch',
      lineage_epoch: 'parent-epoch',
      _lineage_epoch: 'parent-epoch',
      source_messages: [[1, 2]],
      provenance: { branch_uid: 'parent-epoch', lineage_epoch: 'parent-epoch' },
      scope: { chat_uid: 'uid-a', branch_uid: 'parent-epoch' },
    }],
    {
      parentChatId: 'chat-30',
      parentChatUid: 'uid-a',
      parentBranchUid: 'parent-epoch',
      branchChatId: 'chat-31',
      branchChatUid: 'uid-b',
      parentPrefixEnd: 2,
      epochId: 'child-epoch',
    },
  );

  assert.equal(result[0].branch_uid, 'child-epoch');
  assert.equal(result[0]._branch_uid, 'child-epoch');
  assert.equal(result[0].lineage_epoch, 'child-epoch');
  assert.equal(result[0]._lineage_epoch, 'child-epoch');
  assert.equal(result[0].provenance.branch_uid, 'child-epoch');
  assert.equal(result[0].provenance.lineage_epoch, 'child-epoch');
  assert.equal(result[0].scope.branch_uid, 'child-epoch');
});

test('metadata inheritance retags state ledger uid provenance for the child', () => {
  const result = inheritSmartMemoryMetadata(
    {
      schema_version: 1,
      chat_uid: 'parent-uid',
      lineage: { epoch_id: 'parent-epoch' },
      state_ledger: {
        clock: {
          _source_chat_id: 'chat-30',
          _source_chat_uid: 'parent-uid',
          _source_message_range: [1, 2],
          _lineage_epoch: 'parent-epoch',
          value: 'day 2',
        },
      },
    },
    {
      parentChatId: 'chat-30',
      parentBranchUid: 'parent-epoch',
      branchChatId: 'branch-31',
      branchChatUid: 'child-uid',
      parentPrefixEnd: 2,
      epochId: 'child-epoch',
    },
  );

  assert.equal(result.state_ledger.clock._source_chat_uid, 'child-uid');
  assert.equal(result.state_ledger.clock._source_chat_id, 'branch-31');
});

test('metadata inheritance retags nested state ledger provenance for the child', () => {
  const result = inheritSmartMemoryMetadata(
    {
      chat_uid: 'parent-uid',
      lineage: { epoch_id: 'parent-epoch' },
      state_ledger: {
        clock: {
          _source_chat_id: 'chat-30',
          _source_chat_uid: 'parent-uid',
          _source_message_range: [1, 2],
          scope: {
            _source_chat_id: 'chat-30',
            _source_chat_uid: 'parent-uid',
            _lineage_epoch: 'parent-epoch',
          },
          provenance: {
            _source_chat_id: 'chat-30',
            _source_chat_uid: 'parent-uid',
            _lineage_epoch: 'parent-epoch',
          },
        },
      },
    },
    {
      parentChatId: 'chat-30',
      parentChatUid: 'parent-uid',
      parentBranchUid: 'parent-epoch',
      branchChatId: 'branch-31',
      branchChatUid: 'child-uid',
      parentPrefixEnd: 2,
      epochId: 'child-epoch',
    },
  );

  const card = result.state_ledger.clock;
  assert.equal(card.scope._source_chat_id, 'branch-31');
  assert.equal(card.scope._source_chat_uid, 'child-uid');
  assert.equal(card.scope._lineage_epoch, 'child-epoch');
  assert.equal(card.provenance._source_chat_id, 'branch-31');
  assert.equal(card.provenance._source_chat_uid, 'child-uid');
  assert.equal(card.provenance._lineage_epoch, 'child-epoch');
});

test('metadata inheritance preserves state cards with top-level source variants', () => {
  const result = inheritSmartMemoryMetadata(
    {
      chat_uid: 'parent-uid',
      lineage: { epoch_id: 'parent-epoch' },
      state_ledger: {
        clock: {
          source_chat_id: 'chat-30',
          source_chat_uid: 'parent-uid',
          source_message_range: [1, 2],
          scope: {
            source_chat_id: 'chat-30',
            source_chat_uid: 'parent-uid',
            lineage_epoch: 'parent-epoch',
          },
          provenance: {
            source_chat_id: 'chat-30',
            source_chat_uid: 'parent-uid',
            lineage_epoch: 'parent-epoch',
          },
        },
      },
    },
    {
      parentChatId: 'chat-30',
      parentChatUid: 'parent-uid',
      parentBranchUid: 'parent-epoch',
      branchChatId: 'branch-31',
      branchChatUid: 'child-uid',
      parentPrefixEnd: 2,
      epochId: 'child-epoch',
    },
  );

  const card = result.state_ledger.clock;
  assert.equal(card.source_chat_id, 'branch-31');
  assert.equal(card.source_chat_uid, 'child-uid');
  assert.equal(card.scope.source_chat_id, 'branch-31');
  assert.equal(card.scope.source_chat_uid, 'child-uid');
  assert.equal(card.provenance.source_chat_id, 'branch-31');
  assert.equal(card.provenance.source_chat_uid, 'child-uid');
});

test('verified-prefix inheritance uses parent mesId boundary for product projections', () => {
  const result = inheritSmartMemoryMetadata(
    {
      schema_version: 10,
      chat_uid: 'parent-uid',
      narrative: {
        chat_uid: 'parent-uid',
        layers: [[
          { id: 'narrative-prefix', text: 'prefix', source_range: { kind: 'mesId', start: 10, end: 20 } },
          { id: 'narrative-tail', text: 'tail', source_range: { kind: 'mesId', start: 30, end: 40 } },
        ]],
        processed_windows: [],
      },
      structured_records: [
        {
          id: 'structured-prefix',
          kind: 'fact',
          content: 'prefix',
          source_range: { kind: 'mesId', start: 10, end: 20 },
          scope: { chat_uid: 'parent-uid' },
          provenance: { source_chat_uid: 'parent-uid', source_messages: [10, 20] },
        },
        {
          id: 'structured-tail',
          kind: 'fact',
          content: 'tail',
          source_range: { kind: 'mesId', start: 30, end: 40 },
          scope: { chat_uid: 'parent-uid' },
          provenance: { source_chat_uid: 'parent-uid', source_messages: [30, 40] },
        },
      ],
    },
    {
      parentChatId: 'parent-chat',
      branchChatId: 'branch-chat',
      branchChatUid: 'branch-uid',
      parentPrefixEnd: 1,
      parentPrefixMesId: 20,
      branchPrefixLength: 2,
      branchPrefixMesId: 20,
      epochId: 'branch-epoch',
    },
  );

  assert.deepEqual(result.narrative.layers[0].map((snippet) => snippet.id), ['narrative-prefix']);
  assert.deepEqual(result.structured_records.map((record) => record.id), ['structured-prefix']);
});

test('verified branch inheritance preserves root identity, aliases, and a usable prefix cursor', () => {
  const result = inheritSmartMemoryMetadata(
    {
      chat_uid: 'root-uid',
      chat_aliases: ['root-old-name'],
    },
    {
      parentChatId: 'root-chat',
      branchChatId: 'branch-chat',
      branchChatUid: 'branch-uid',
      parentPrefixEnd: 1,
      branchPrefixLength: 2,
      branchPrefixMesId: 20,
      parentPrefixMesId: 20,
      branchPrefixFingerprint: 'prefix-fingerprint',
      epochId: 'branch-epoch',
    },
  );

  assert.equal(result.chat_uid, 'branch-uid');
  assert.equal(result.root_chat_uid, 'root-uid');
  assert.deepEqual(result.chat_aliases, ['root-old-name']);
  assert.deepEqual(result.product_cursor, {
    window_id: null,
    fingerprint: 'prefix-fingerprint',
    source_range: { kind: 'index', start: 0, end: 1 },
    last_mes_id: 20,
    last_index: 1,
  });
});

test('branch rebuild metadata preserves stable uid, root uid, and aliases', () => {
  const result = buildRebuiltLineageMetadata({
    priorSmartMemory: {
      chat_uid: 'branch-uid',
      root_chat_uid: 'root-uid',
      chat_aliases: ['old-branch-name'],
      lineage: { aliases: ['older-branch-name'] },
      narrative: { layers: [['stale']] },
    },
    chatId: 'branch-name',
    parentChatId: 'parent-name',
    chatUid: 'branch-uid',
    aliases: ['new-alias', 'old-branch-name'],
    schemaVersion: 10,
    epochId: 'rebuild-epoch',
  });

  assert.equal(result.chat_uid, 'branch-uid');
  assert.equal(result.root_chat_uid, 'root-uid');
  assert.deepEqual(result.chat_aliases, ['old-branch-name', 'older-branch-name', 'new-alias']);
  assert.deepEqual(result.lineage, {
    status: LINEAGE_STATUS.REBUILT,
    chat_id: 'branch-name',
    chat_uid: 'branch-uid',
    root_chat_uid: 'root-uid',
    parent_chat_id: 'parent-name',
    prefix_end: null,
    prefix_length: 0,
    prefix_fingerprint: null,
    method: 'raw-rebuild',
    epoch_id: 'rebuild-epoch',
    rebuilt_from_raw: true,
    aliases: ['old-branch-name', 'older-branch-name', 'new-alias'],
  });
  assert.equal(result.narrative, null);
  assert.deepEqual(result.structured_records, []);
  assert.deepEqual(result.ingest_windows, {});
});

test('chat metadata inheritance carries only proven prefix projections', () => {
  const result = inheritSmartMemoryMetadata(
    {
      schema_version: 10,
      sessionMemories: [
        {
          id: 'prefix',
          source_chat_id: 'chat-30',
          source_chat_uid: 'parent-uid',
          lineage_epoch: 'parent-epoch',
          source_messages: [[0, 2]],
        },
        { id: 'tail', source_chat_id: 'chat-30', source_messages: [[3, 4]] },
        { id: 'unknown', source_chat_id: null, source_messages: [] },
      ],
      storyArcs: [{
        content: 'prefix arc',
        source_chat_id: 'chat-30',
        source_chat_uid: 'parent-uid',
        lineage_epoch: 'parent-epoch',
        source_messages: [[1, 2]],
      }],
      profiles: {
        Maeve: {
          character_state: 'prefix state',
          source_chat_id: 'chat-30',
          source_chat_uid: 'parent-uid',
          lineage_epoch: 'parent-epoch',
          source_message_range: [0, 2],
        },
      },
      summary: 'prefix summary',
      summary_source_chat_id: 'chat-30',
      summary_source_chat_uid: 'parent-uid',
      summary_lineage_epoch: 'parent-epoch',
      summary_source_message_range: [0, 2],
      summary_source_fingerprint: 'prefix-fingerprint',
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
      product_cursor: {
        window_id: 'parent-tail-window',
        fingerprint: 'parent-tail',
        last_mes_id: 4,
        last_index: null,
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
      branchPrefixMesId: 2,
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
  assert.equal(result.chat_uid, 'stable-branch-uid');
  assert.deepEqual(result.product_cursor, {
    window_id: null,
    fingerprint: null,
    source_range: null,
    last_mes_id: 2,
    last_index: 2,
  });
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
