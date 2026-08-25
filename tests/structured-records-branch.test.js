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

test('structured records prune sparse index-range tails', () => {
  const result = pruneStructuredRecordsAtBranch([
    { id: 'prefix', kind: 'fact', content: 'prefix', source_range: { kind: 'index', start: 0, end: 1 } },
    { id: 'tail', kind: 'fact', content: 'tail', source_range: { kind: 'index', start: 2, end: 4 } },
  ], { branchPointMesId: 20, branchPointIndex: 1 });

  assert.deepEqual(result.kept.map((record) => record.id), ['prefix']);
  assert.deepEqual(result.removed.map((record) => record.id), ['tail']);
});

test('structured records prune mesId ranges when no numeric prefix survives', () => {
  const result = pruneStructuredRecordsAtBranch([
    { id: 'mesid-record', kind: 'fact', content: 'stale', source_range: { kind: 'mesId', start: 10, end: 20 } },
  ], { branchPointMesId: null, branchPointIndex: -1 });

  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.removed.map((record) => record.id), ['mesid-record']);
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
    parentBranchUid: 'parent-branch',
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

test('structured prefix inheritance rejects mixed uid provenance and retags every explicit field', () => {
  const records = [
    {
      id: 'mixed-uid',
      kind: 'fact',
      content: 'Mixed provenance fact.',
      source_range: { kind: 'mesId', start: 1, end: 2 },
      scope: { chat_uid: 'parent', source_chat_uid: 'foreign', branch_uid: 'parent-branch' },
      provenance: { source_chat_uid: 'parent', source_chat_id: 'chat-1' },
      chat_uid: 'parent',
      branch_uid: 'parent-branch',
    },
    {
      id: 'clean',
      kind: 'fact',
      content: 'Clean fact.',
      source_range: { kind: 'mesId', start: 1, end: 2 },
      scope: { chat_uid: 'parent', source_chat_uid: 'parent', branch_uid: 'parent-branch' },
      provenance: { source_chat_uid: 'parent', source_chat_id: 'chat-1' },
      chat_uid: 'parent',
      branch_uid: 'parent-branch',
    },
  ];

  const result = inheritStructuredRecordsPrefix(records, {
    parentChatUid: 'parent',
    parentBranchUid: 'parent-branch',
    branchChatUid: 'child',
    branchUid: 'child-branch',
    parentPrefixEnd: 2,
  });

  assert.deepEqual(result.map((record) => record.id), ['clean']);
  assert.equal(result[0].chat_uid, 'child');
  assert.equal(result[0].branch_uid, 'child-branch');
  assert.equal(result[0].scope.source_chat_uid, 'child');
  assert.equal(result[0].provenance.source_chat_id, 'chat-1');
});

test('structured prefix inheritance retags lineage epoch variants', () => {
  const result = inheritStructuredRecordsPrefix([{
    id: 'epoch-record',
    kind: 'fact',
    content: 'Epoch fact.',
    source_range: { kind: 'mesId', start: 1, end: 2 },
    scope: { chat_uid: 'parent', branch_uid: 'parent-branch', lineage_epoch: 'parent-branch' },
    provenance: {
      source_chat_uid: 'parent',
      branch_uid: 'parent-branch',
      lineage_epoch: 'parent-branch',
      _lineage_epoch: 'parent-branch',
    },
    _lineage_epoch: 'parent-branch',
    lineage_epoch: 'parent-branch',
  }], {
    parentChatUid: 'parent',
    parentBranchUid: 'parent-branch',
    branchChatUid: 'child',
    branchUid: 'child-branch',
    parentPrefixEnd: 2,
  });

  assert.equal(result[0].lineage_epoch, 'child-branch');
  assert.equal(result[0]._lineage_epoch, 'child-branch');
  assert.equal(result[0].scope.lineage_epoch, 'child-branch');
  assert.equal(result[0].provenance.lineage_epoch, 'child-branch');
  assert.equal(result[0].provenance._lineage_epoch, 'child-branch');
});

test('structured prefix inheritance rejects and retags nested internal source variants', () => {
  const result = inheritStructuredRecordsPrefix([
    {
      id: 'foreign',
      kind: 'fact',
      content: 'Foreign nested provenance.',
      source_range: { kind: 'mesId', start: 1, end: 2 },
      scope: {
        chat_uid: 'parent',
        _source_chat_uid: 'foreign-uid',
        _source_chat_id: 'foreign-chat',
        branch_uid: 'parent-branch',
      },
      provenance: {
        source_chat_uid: 'parent',
        _source_chat_uid: 'foreign-uid',
        _source_chat_id: 'foreign-chat',
      },
    },
    {
      id: 'clean',
      kind: 'fact',
      content: 'Clean nested provenance.',
      source_range: { kind: 'mesId', start: 1, end: 2 },
      source_chat_id: 'parent-chat',
      _source_chat_id: 'parent-chat',
      source_chat_uid: 'parent',
      _source_chat_uid: 'parent',
      scope: {
        chat_uid: 'parent',
        _source_chat_uid: 'parent',
        _source_chat_id: 'parent-chat',
        branch_uid: 'parent-branch',
      },
      provenance: {
        source_chat_uid: 'parent',
        _source_chat_uid: 'parent',
        _source_chat_id: 'parent-chat',
      },
    },
  ], {
    parentChatUid: 'parent',
    parentChatId: 'parent-chat',
    parentBranchUid: 'parent-branch',
    branchChatUid: 'child',
    branchChatId: 'child-chat',
    branchUid: 'child-branch',
    parentPrefixEnd: 2,
  });

  assert.deepEqual(result.map((record) => record.id), ['clean']);
  assert.equal(result[0]._source_chat_uid, 'child');
  assert.equal(result[0]._source_chat_id, 'child-chat');
  assert.equal(result[0].scope._source_chat_uid, 'child');
  assert.equal(result[0].scope._source_chat_id, 'child-chat');
  assert.equal(result[0].provenance._source_chat_uid, 'child');
  assert.equal(result[0].provenance._source_chat_id, 'child-chat');
});

test('structured prefix inheritance rejects explicit branch provenance without parent proof', () => {
  const result = inheritStructuredRecordsPrefix([{
    id: 'unproven-branch',
    kind: 'fact',
    content: 'Unproven branch fact.',
    source_range: { kind: 'mesId', start: 1, end: 2 },
    scope: { chat_uid: 'parent', branch_uid: 'sibling-branch' },
  }], {
    parentChatUid: 'parent',
    branchChatUid: 'child',
    branchUid: 'child-branch',
    parentPrefixEnd: 2,
  });

  assert.deepEqual(result, []);
});
