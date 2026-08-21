import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inheritStructuredRecordsPrefix,
  pruneStructuredRecordsAtBranch,
} from '../structured-records.js';

test('structured records prune discarded tails and repair supersession', () => {
  const records = [
    {
      id: 'old-prefix',
      kind: 'state',
      content: 'Mira is wounded.',
      source_range: { kind: 'mesId', start: 1, end: 2 },
      scope: { chat_uid: 'chat-a', branch_uid: 'branch-a' },
      provenance: { source_chat_uid: 'chat-a', source_messages: [1, 2] },
      validity: { status: 'superseded' },
      superseded_by: 'tail-state',
    },
    {
      id: 'tail-state',
      kind: 'state',
      content: 'Mira is healed.',
      source_range: { kind: 'mesId', start: 3, end: 4 },
      scope: { chat_uid: 'chat-a', branch_uid: 'branch-a' },
      provenance: { source_chat_uid: 'chat-a', source_messages: [3, 4] },
      validity: { status: 'active' },
    },
    { id: 'legacy', kind: 'fact', content: 'Legacy without a range.' },
  ];

  const result = pruneStructuredRecordsAtBranch(records, { branchPointMesId: 2 });

  assert.deepEqual(result.kept.map((record) => record.id), ['old-prefix', 'legacy']);
  assert.deepEqual(result.removed.map((record) => record.id), ['tail-state']);
  assert.equal(result.kept[0].superseded_by, undefined);
  assert.equal(result.kept[0].validity.status, 'active');
  assert.deepEqual(records.map((record) => record.id), ['old-prefix', 'tail-state', 'legacy']);
});

test('structured prefix inheritance retags only fully proven records', () => {
  const records = [
    {
      id: 'prefix',
      kind: 'fact',
      content: 'The silver key is warm.',
      source_range: { kind: 'mesId', start: 1, end: 2 },
      scope: { chat_uid: 'parent', branch_uid: 'parent-branch' },
      provenance: { source_chat_uid: 'parent', source_messages: [1, 2] },
    },
    {
      id: 'tail',
      kind: 'fact',
      content: 'The door opened.',
      source_range: { kind: 'mesId', start: 3, end: 4 },
      scope: { chat_uid: 'parent', branch_uid: 'parent-branch' },
      provenance: { source_chat_uid: 'parent', source_messages: [3, 4] },
    },
  ];

  const result = inheritStructuredRecordsPrefix(records, {
    parentChatUid: 'parent',
    branchChatUid: 'child',
    branchUid: 'child-branch',
    parentPrefixEnd: 2,
  });

  assert.deepEqual(result.map((record) => record.id), ['prefix']);
  assert.equal(result[0].scope.chat_uid, 'child');
  assert.equal(result[0].scope.branch_uid, 'child-branch');
  assert.equal(result[0].provenance.source_chat_uid, 'child');
  assert.deepEqual(result[0].provenance.source_messages, [1, 2]);
  assert.equal(records[0].scope.chat_uid, 'parent');
});
