import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDerivedRecord,
  buildIngestWindow,
  normalizeDerivedRecord,
  normalizeSourceRange,
} from '../projections.js';

test('source ranges are normalized and reject invalid boundaries', () => {
  assert.deepEqual(normalizeSourceRange({ kind: 'mesId', start: 4, end: 8 }), {
    kind: 'mesId',
    start: 4,
    end: 8,
  });
  assert.throws(() => normalizeSourceRange({ kind: 'mesId', start: 8, end: 4 }), /start.*end/i);
  assert.throws(() => normalizeSourceRange({ kind: 'unknown', start: 1, end: 2 }), /kind/i);
});

test('derived records carry the canonical metadata contract', () => {
  const record = buildDerivedRecord({
    id: 'state-a',
    kind: 'state',
    content: 'Mira is healed.',
    scope: { chat_uid: 'chat-uid-a', branch_uid: 'branch-uid-a' },
    sourceRange: { kind: 'mesId', start: 101, end: 102 },
    storyTime: { epoch: 'temple-arc', day: 12 },
    knowledgeTime: { mes_id: 102, conversation_index: 42 },
    validity: { status: 'active', valid_from: 'message-102', valid_to: null },
    confidence: 0.9,
    provenance: {
      source_chat_uid: 'chat-uid-a',
      source_messages: [101, 102],
      source_kind: 'raw-jsonl',
    },
    supersedes: null,
  });

  assert.deepEqual(record, {
    id: 'state-a',
    kind: 'state',
    owner: 'smart-memory',
    content: 'Mira is healed.',
    scope: { chat_uid: 'chat-uid-a', branch_uid: 'branch-uid-a' },
    source_range: { kind: 'mesId', start: 101, end: 102 },
    story_time: { epoch: 'temple-arc', day: 12 },
    knowledge_time: { mes_id: 102, conversation_index: 42 },
    validity: { status: 'active', valid_from: 'message-102', valid_to: null },
    confidence: 0.9,
    provenance: {
      source_chat_uid: 'chat-uid-a',
      source_messages: [101, 102],
      source_kind: 'raw-jsonl',
    },
    supersedes: null,
  });
});

test('normalizing a projector result fills window provenance without changing its content', () => {
  const window = buildIngestWindow({
    chatUid: 'chat-uid-a',
    branchUid: 'branch-uid-a',
    messages: [{ mesId: 7, name: 'Mira', mes: 'The door opens.' }],
    sourceRange: { kind: 'mesId', start: 7, end: 7 },
  });

  const record = normalizeDerivedRecord(
    { id: 'narrative-a', kind: 'narrative_delta', content: 'The door opens.' },
    window,
    { owner: 'summaryception' },
  );

  assert.equal(record.owner, 'summaryception');
  assert.equal(record.kind, 'narrative_delta');
  assert.equal(record.content, 'The door opens.');
  assert.deepEqual(record.scope, { chat_uid: 'chat-uid-a', branch_uid: 'branch-uid-a' });
  assert.deepEqual(record.source_range, { kind: 'mesId', start: 7, end: 7 });
  assert.equal(record.provenance.source_chat_uid, 'chat-uid-a');
  assert.deepEqual(record.provenance.source_messages, [7]);
});

test('ingest windows require a stable chat identity and valid source range', () => {
  assert.throws(
    () =>
      buildIngestWindow({
        chatUid: '',
        messages: [],
        sourceRange: { kind: 'index', start: 0, end: 0 },
      }),
    /chat/i,
  );
  assert.throws(
    () =>
      buildIngestWindow({
        chatUid: 'chat-uid-a',
        messages: [],
        sourceRange: { kind: 'index', start: 2, end: 1 },
      }),
    /start.*end/i,
  );
});
