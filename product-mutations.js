/**
 * User-controlled mutations for Product-mode memory.
 *
 * The raw SillyTavern transcript is never changed here. These operations mutate
 * only derived current-chat records and timeline interpretation overrides while
 * preserving source provenance and chat ownership.
 */

import { hash32 } from './identity.js';
import { buildDerivedRecord } from './projections.js';

const RECORD_EDIT_FIELDS = new Set([
  'content',
  'confidence',
  'validity',
  'story_time',
  'knowledge_time',
  'subject',
  'target',
  'type',
  'entity',
  'entity_type',
  'descriptors',
  'witnessed_by',
]);

const TIMELINE_OVERRIDE_FIELDS = new Set([
  'story_time',
  'knowledge_time',
  'validity',
  'narrative_role',
  'temporal_relations',
  'confidence',
  'note',
]);

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function normalized(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result === '' ? null : result;
}

function resolvedNow(value) {
  const result = typeof value === 'function' ? value() : value;
  return Number.isFinite(Number(result)) ? Number(result) : Date.now();
}

function requiredIdentity(value, label) {
  const result = normalized(value);
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function recordChatValues(record) {
  return [
    record?.scope?.chat_uid,
    record?.scope?.source_chat_uid,
    record?.scope?._source_chat_uid,
    record?.chat_uid,
    record?.source_chat_uid,
    record?.provenance?.chat_uid,
    record?.provenance?.source_chat_uid,
  ]
    .map(normalized)
    .filter(Boolean);
}

function assertOwnedRecord(record, chatUid) {
  const expected = requiredIdentity(chatUid, 'chatUid');
  const values = recordChatValues(record);
  if (values.length === 0) throw new Error('Product record has no chat ownership');
  if (values.some((value) => value !== expected)) {
    throw new Error('Product record belongs to another chat');
  }
  return expected;
}

function findOwnedRecord(records, recordId, chatUid) {
  const expectedId = requiredIdentity(recordId, 'recordId');
  const index = list(records).findIndex((record) => String(record?.id ?? '') === expectedId);
  if (index < 0) throw new Error('Product record was not found');
  const source = list(records)[index];
  assertOwnedRecord(source, chatUid);
  return { index, source, expectedId };
}

function changedValue(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function normalizeRecordPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('record patch must be an object');
  }
  const unknown = Object.keys(patch).filter((key) => !RECORD_EDIT_FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`Product record field is not editable: ${unknown[0]}`);
  if (Object.keys(patch).length === 0) throw new Error('Product record patch is empty');

  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'content') {
      const content = normalized(value);
      if (!content) throw new TypeError('Product record content cannot be empty');
      result[key] = content;
    } else if (key === 'confidence') {
      const confidence = Number(value);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new RangeError('Product record confidence must be between 0 and 1');
      }
      result[key] = confidence;
    } else if (key === 'validity') {
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        throw new TypeError('Product record validity must be an object or null');
      }
      result[key] = clone(value);
    } else if (['story_time', 'knowledge_time'].includes(key)) {
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        throw new TypeError(`Product record ${key} must be an object or null`);
      }
      result[key] = clone(value);
    } else if (['descriptors', 'witnessed_by'].includes(key)) {
      if (!Array.isArray(value)) throw new TypeError(`Product record ${key} must be an array`);
      result[key] = clone(value);
    } else if (value === null) {
      result[key] = null;
    } else {
      const text = normalized(value);
      if (!text) throw new TypeError(`Product record ${key} cannot be empty`);
      result[key] = text;
    }
  }
  return result;
}

function markManual(record, action, fields, now) {
  const previous = record?.manual_override && typeof record.manual_override === 'object'
    ? record.manual_override
    : {};
  return {
    ...record,
    manual_override: {
      ...clone(previous),
      active: true,
      action,
      source: 'user',
      fields: [...new Set([...(Array.isArray(previous.fields) ? previous.fields : []), ...fields])],
      updated_at: now,
    },
    updated_at: now,
    narrative_status: 'stale',
  };
}

/** Creates a current-chat Product record from an explicit user entry. */
export function createProductRecord({
  chatUid,
  kind,
  content,
  sourceRange,
  patch = {},
  now = Date.now(),
} = {}) {
  const expectedChatUid = requiredIdentity(chatUid, 'chatUid');
  const recordKind = requiredIdentity(kind, 'kind');
  if (!['fact', 'relationship', 'session', 'state', 'arc', 'epistemic'].includes(recordKind)) {
    throw new Error(`Product record kind is not supported: ${recordKind}`);
  }
  const normalizedPatch = normalizeRecordPatch({ ...patch, content: patch.content ?? content });
  const timestamp = resolvedNow(now);
  const source = {
    kind: sourceRange?.kind ?? 'index',
    start: sourceRange?.start,
    end: sourceRange?.end,
  };
  const base = buildDerivedRecord({
    id: `manual:${recordKind}:${hash32(`${expectedChatUid}|${JSON.stringify(source)}|${normalizedPatch.content}`)}`,
    kind: recordKind,
    owner: 'smart-memory',
    content: normalizedPatch.content,
    scope: { chat_uid: expectedChatUid, branch_uid: expectedChatUid },
    sourceRange: source,
    storyTime: normalizedPatch.story_time ?? null,
    knowledgeTime: normalizedPatch.knowledge_time ?? null,
    validity: normalizedPatch.validity ?? { status: 'active' },
    confidence: normalizedPatch.confidence ?? 0.7,
    provenance: { source_chat_uid: expectedChatUid },
  });
  const extraFields = Object.fromEntries(
    Object.entries(normalizedPatch).filter(
      ([key]) => !['content', 'confidence', 'validity', 'story_time', 'knowledge_time'].includes(key),
    ),
  );
  const record = markManual({ ...base, ...extraFields }, 'create', Object.keys(normalizedPatch), timestamp);
  record.embedding_status = 'stale';
  return record;
}

/** Edits one current-chat Product record without changing its source provenance. */
export function editProductRecord(records, { recordId, chatUid, patch, now = Date.now() } = {}) {
  const { index, source } = findOwnedRecord(records, recordId, chatUid);
  const normalizedPatch = normalizeRecordPatch(patch);
  const timestamp = resolvedNow(now);
  const nextRecord = markManual(
    { ...clone(source), ...normalizedPatch },
    'edit',
    Object.keys(normalizedPatch),
    timestamp,
  );
  const changedFields = Object.keys(normalizedPatch).filter((key) => changedValue(source?.[key], nextRecord?.[key]));
  const contentChanged = changedValue(source?.content, nextRecord?.content);
  nextRecord.embedding_status = contentChanged ? 'stale' : nextRecord.embedding_status;
  nextRecord.narrative_status = changedFields.length > 0 ? 'stale' : nextRecord.narrative_status;
  const next = list(records).map(clone);
  next[index] = nextRecord;
  return {
    records: next,
    record: clone(nextRecord),
    changedFields,
    contentChanged,
    sourcePreserved: changedValue(source?.source_range, nextRecord?.source_range) === false
      && changedValue(source?.provenance, nextRecord?.provenance) === false,
  };
}

/** Retires one record from active retrieval while preserving visible history. */
export function retireProductRecord(records, { recordId, chatUid, now = Date.now() } = {}) {
  const { index, source } = findOwnedRecord(records, recordId, chatUid);
  const timestamp = resolvedNow(now);
  const nextRecord = markManual(
    {
      ...clone(source),
      validity: { ...(source.validity ?? {}), status: 'invalid' },
      retired_at: timestamp,
    },
    'retire',
    ['validity'],
    timestamp,
  );
  const next = list(records).map(clone);
  next[index] = nextRecord;
  return { records: next, record: clone(nextRecord), changed: true };
}

/** Restores a record previously retired through the Product editor. */
export function restoreProductRecord(records, { recordId, chatUid, now = Date.now() } = {}) {
  const { index, source } = findOwnedRecord(records, recordId, chatUid);
  if (source?.manual_override?.action !== 'retire') {
    throw new Error('Only manually retired Product records can be restored');
  }
  const timestamp = resolvedNow(now);
  const nextRecord = markManual(
    {
      ...clone(source),
      validity: { ...(source.validity ?? {}), status: 'active' },
      restored_at: timestamp,
    },
    'restore',
    ['validity'],
    timestamp,
  );
  const next = list(records).map(clone);
  next[index] = nextRecord;
  return { records: next, record: clone(nextRecord), changed: true };
}

function recordSourceRange(record) {
  return record?.source_range ?? record?.sourceRange ?? null;
}

/** Builds the stable suppression key used to prevent a deliberate delete returning on rescan. */
export function buildProductSuppressionKey(record) {
  const chatUid = recordChatValues(record)[0] ?? '';
  const kind = normalized(record?.kind) ?? '';
  const content = normalized(record?.content) ?? '';
  const range = JSON.stringify(recordSourceRange(record));
  return `product-suppression:${hash32(`${chatUid}|${kind}|${range}|${content}`)}`;
}

/** Permanently removes one derived record and returns a source-scoped suppression descriptor. */
export function deleteProductRecord(records, { recordId, chatUid, now = Date.now() } = {}) {
  const { index, source } = findOwnedRecord(records, recordId, chatUid);
  const timestamp = resolvedNow(now);
  const next = list(records).filter((_record, itemIndex) => itemIndex !== index).map(clone);
  return {
    records: next,
    deleted: clone(source),
    suppression: {
      key: buildProductSuppressionKey(source),
      chat_uid: requiredIdentity(chatUid, 'chatUid'),
      kind: source.kind ?? null,
      source_range: clone(recordSourceRange(source)),
      content_hash: hash32(normalized(source.content) ?? ''),
      created_at: timestamp,
    },
  };
}

/** Adds or replaces a suppression entry by stable key. */
export function upsertProductSuppression(suppressions, suppression) {
  if (!suppression || typeof suppression !== 'object' || Array.isArray(suppression)) {
    throw new TypeError('suppression must be an object');
  }
  const key = requiredIdentity(suppression.key, 'suppression.key');
  const next = list(suppressions).map(clone);
  const index = next.findIndex((item) => String(item?.key ?? '') === key);
  const value = { ...clone(suppression), key };
  if (index >= 0) next[index] = value;
  else next.push(value);
  return next;
}

export function isProductRecordSuppressed(record, suppressions) {
  const key = buildProductSuppressionKey(record);
  const chatUid = recordChatValues(record)[0];
  return list(suppressions).some(
    (suppression) => suppression?.key === key && normalized(suppression?.chat_uid) === chatUid,
  );
}

function normalizeTimelinePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('timeline override patch must be an object');
  }
  const unknown = Object.keys(patch).filter((key) => !TIMELINE_OVERRIDE_FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`Timeline field is not overrideable: ${unknown[0]}`);
  if (Object.keys(patch).length === 0) throw new Error('timeline override patch is empty');
  return clone(patch);
}

/** Creates or replaces one explicit interpretation override for a current-chat event. */
export function applyTimelineOverride(overrides, { eventId, chatUid, patch, now = Date.now() } = {}) {
  const expectedEventId = requiredIdentity(eventId, 'eventId');
  const expectedChatUid = requiredIdentity(chatUid, 'chatUid');
  const timestamp = resolvedNow(now);
  const next = list(overrides)
    .filter((override) =>
      !(String(override?.event_id ?? '') === expectedEventId
        && normalized(override?.chat_uid) === expectedChatUid),
    )
    .map(clone);
  next.push({
    event_id: expectedEventId,
    chat_uid: expectedChatUid,
    patch: normalizeTimelinePatch(patch),
    updated_at: timestamp,
  });
  return next;
}

/** Removes one current-chat timeline override. */
export function clearTimelineOverride(overrides, { eventId, chatUid } = {}) {
  const expectedEventId = requiredIdentity(eventId, 'eventId');
  const expectedChatUid = requiredIdentity(chatUid, 'chatUid');
  return list(overrides)
    .filter((override) =>
      !(String(override?.event_id ?? '') === expectedEventId
        && normalized(override?.chat_uid) === expectedChatUid),
    )
    .map(clone);
}

/** Applies only overrides owned by the requested chat to a rebuilt raw timeline. */
export function applyTimelineOverrides(events, overrides, { chatUid } = {}) {
  const expectedChatUid = requiredIdentity(chatUid, 'chatUid');
  const byEvent = new Map(
    list(overrides)
      .filter((override) => normalized(override?.chat_uid) === expectedChatUid)
      .map((override) => [String(override.event_id), override]),
  );
  return list(events).map((event) => {
    const override = byEvent.get(String(event?.event_id ?? ''));
    if (!override) return clone(event);
    const patch = normalizeTimelinePatch(override.patch);
    return {
      ...clone(event),
      ...patch,
      ...(patch.validity && event?.validity && typeof event.validity === 'object'
        ? { validity: { ...event.validity, ...patch.validity } }
        : {}),
      manual_override: true,
      manual_override_at: override.updated_at ?? null,
      manual_override_fields: Object.keys(patch),
    };
  });
}
