import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTimelineOverrides,
  applyTimelineOverride,
  buildProductSuppressionKey,
  createProductRecord,
  deleteProductRecord,
  editProductRecord,
  isProductRecordSuppressed,
  restoreProductRecord,
  retireProductRecord,
  upsertProductSuppression,
} from '../product-mutations.js';

const record = (overrides = {}) => ({
  id: overrides.id ?? 'fact-1',
  kind: overrides.kind ?? 'fact',
  content: overrides.content ?? 'Maeve carries the silver key.',
  scope: { chat_uid: 'chat-a', branch_uid: 'chat-a', ...(overrides.scope ?? {}) },
  source_range: overrides.source_range ?? { kind: 'index', start: 4, end: 5 },
  provenance: { source_chat_uid: 'chat-a', source_messages: [4, 5], ...(overrides.provenance ?? {}) },
  validity: { status: 'active', ...(overrides.validity ?? {}) },
  confidence: overrides.confidence ?? 0.9,
  ...(overrides.subject ? { subject: overrides.subject } : {}),
  ...(overrides.target ? { target: overrides.target } : {}),
});

test('manual Product record creation stamps current-chat ownership and source provenance', () => {
  const created = createProductRecord({
    chatUid: 'chat-a',
    kind: 'relationship',
    content: 'Maeve trusts Badi.',
    sourceRange: { kind: 'index', start: 8, end: 9 },
    patch: { subject: 'Maeve', target: 'Badi', type: 'trust' },
    now: 99,
  });

  assert.equal(created.kind, 'relationship');
  assert.equal(created.content, 'Maeve trusts Badi.');
  assert.equal(created.scope.chat_uid, 'chat-a');
  assert.equal(created.scope.branch_uid, 'chat-a');
  assert.equal(created.provenance.source_chat_uid, 'chat-a');
  assert.deepEqual(created.source_range, { kind: 'index', start: 8, end: 9 });
  assert.equal(created.manual_override.action, 'create');
  assert.equal(created.manual_override.updated_at, 99);
  assert.equal(created.embedding_status, 'stale');
});
test('editing a Product record preserves ownership and provenance while marking manual override', () => {
  const original = record();
  const result = editProductRecord([original], {
    recordId: 'fact-1',
    chatUid: 'chat-a',
    patch: { content: 'Maeve carries the obsidian key.', confidence: 0.8 },
    now: 1234,
  });

  assert.equal(original.content, 'Maeve carries the silver key.');
  assert.equal(result.record.content, 'Maeve carries the obsidian key.');
  assert.equal(result.record.scope.chat_uid, 'chat-a');
  assert.deepEqual(result.record.source_range, original.source_range);
  assert.deepEqual(result.record.provenance, original.provenance);
  assert.deepEqual(result.changedFields, ['content', 'confidence']);
  assert.equal(result.contentChanged, true);
  assert.equal(result.record.manual_override.active, true);
  assert.equal(result.record.manual_override.updated_at, 1234);
  assert.equal(result.record.embedding_status, 'stale');
  assert.equal(result.record.narrative_status, 'stale');
});

test('Product record mutations reject a foreign chat even when the record id is known', () => {
  assert.throws(
    () => editProductRecord([record()], {
      recordId: 'fact-1',
      chatUid: 'chat-b',
      patch: { content: 'foreign edit' },
    }),
    /belongs to another chat/,
  );
});

test('retiring and restoring a Product record are explicit reversible actions', () => {
  const retired = retireProductRecord([record()], {
    recordId: 'fact-1',
    chatUid: 'chat-a',
    now: 20,
  });
  assert.equal(retired.record.validity.status, 'invalid');
  assert.equal(retired.record.manual_override.action, 'retire');
  assert.equal(retired.record.retired_at, 20);

  const restored = restoreProductRecord(retired.records, {
    recordId: 'fact-1',
    chatUid: 'chat-a',
    now: 30,
  });
  assert.equal(restored.record.validity.status, 'active');
  assert.equal(restored.record.manual_override.action, 'restore');
  assert.equal(restored.record.restored_at, 30);
});

test('permanent Product deletion returns a source-scoped suppression descriptor', () => {
  const original = record();
  const deleted = deleteProductRecord([original, record({ id: 'fact-2' })], {
    recordId: 'fact-1',
    chatUid: 'chat-a',
    now: 44,
  });

  assert.deepEqual(deleted.records.map((item) => item.id), ['fact-2']);
  assert.equal(deleted.deleted.id, 'fact-1');
  assert.equal(deleted.suppression.chat_uid, 'chat-a');
  assert.equal(deleted.suppression.created_at, 44);
  assert.equal(isProductRecordSuppressed(original, [deleted.suppression]), true);
});

test('suppression upsert is idempotent and keeps unrelated chat records separate', () => {
  const first = record();
  const suppression = {
    key: buildProductSuppressionKey(first),
    chat_uid: 'chat-a',
    source_range: first.source_range,
    content_hash: 'hash-a',
    created_at: 1,
  };
  const once = upsertProductSuppression([], suppression);
  const twice = upsertProductSuppression(once, { ...suppression, created_at: 2 });
  const foreign = upsertProductSuppression(twice, { ...suppression, key: 'foreign', chat_uid: 'chat-b' });

  assert.equal(once.length, 1);
  assert.equal(twice.length, 1);
  assert.equal(foreign.length, 2);
});

test('timeline overrides apply only to the current chat and survive a raw timeline rebuild', () => {
  const overrides = applyTimelineOverride([], {
    eventId: 'event-1',
    chatUid: 'chat-a',
    patch: { story_time: { day: 15 }, narrative_role: 'backstory' },
    now: 55,
  });
  const events = [
    { event_id: 'event-1', story_time: { day: 12 }, narrative_role: 'current' },
    { event_id: 'event-2', story_time: { day: 16 }, narrative_role: 'current' },
  ];

  const applied = applyTimelineOverrides(events, overrides, { chatUid: 'chat-a' });
  const foreign = applyTimelineOverrides(events, overrides, { chatUid: 'chat-b' });

  assert.deepEqual(applied[0].story_time, { day: 15 });
  assert.equal(applied[0].narrative_role, 'backstory');
  assert.equal(applied[0].manual_override, true);
  assert.deepEqual(foreign, events);
});

test('timeline override replacement is deterministic for one event', () => {
  const first = applyTimelineOverride([], {
    eventId: 'event-1',
    chatUid: 'chat-a',
    patch: { narrative_role: 'flashback' },
    now: 1,
  });
  const second = applyTimelineOverride(first, {
    eventId: 'event-1',
    chatUid: 'chat-a',
    patch: { narrative_role: 'backstory', validity: { status: 'historical' } },
    now: 2,
  });

  assert.equal(second.length, 1);
  assert.equal(second[0].patch.narrative_role, 'backstory');
  assert.deepEqual(second[0].patch.validity, { status: 'historical' });
  assert.equal(second[0].updated_at, 2);
});
