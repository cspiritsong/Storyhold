/**
 * Combined structured projection contract for the single-extension runtime.
 *
 * One bounded model response may describe facts, relationships, current state,
 * active arcs, and epistemic knowledge. Parsing and merging remain pure so the
 * runtime can test them without SillyTavern or a provider.
 */

import {
  buildDerivedRecord,
  defaultSourceMessages,
  PROJECTION_KINDS,
  PROJECTION_OWNERS,
  stripIdentityVariants,
} from './projections.js';
import { hash32 } from './identity.js';
import { buildTimelinePromptBlock, isProjectionTemporallyCompatible } from './timeline.js';
import { parseArcOutput, parseExtractionOutput, parseSessionOutput } from './parsers.js';

const EMPTY_RESPONSE = Object.freeze({
  facts: [],
  relationships: [],
  state: [],
  arcs: [],
  epistemic: [],
  session: [],
});

const RESPONSE_KEYS = Object.keys(EMPTY_RESPONSE);

function emptyResponse() {
  return Object.fromEntries(RESPONSE_KEYS.map((key) => [key, []]));
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function confidence(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.7;
}

function recordId(kind, item, index, window) {
  const explicit = text(item?.id);
  if (explicit) return explicit;
  const content = text(item?.content) || JSON.stringify(item ?? {});
  return `structured:${kind}:${window.window_id}:${index}:${hash32(content)}`;
}

function commonFields(item, kind, index, window) {
  return {
    id: recordId(kind, item, index, window),
    kind,
    owner: PROJECTION_OWNERS.STRUCTURED,
    content: text(item?.content),
    scope: {
      ...stripIdentityVariants(item?.scope),
      chat_uid: window.chat_uid,
      ...(window.branch_uid != null ? { branch_uid: window.branch_uid } : {}),
    },
    sourceRange: window.source_range,
    storyTime: item?.story_time ?? null,
    knowledgeTime: item?.knowledge_time ?? null,
    validity: {
      status: item?.status === 'resolved' || item?.resolved === true ? 'superseded' : 'active',
      valid_from: item?.validity?.valid_from ?? null,
      valid_to: item?.validity?.valid_to ?? null,
    },
    confidence: confidence(item?.confidence),
    provenance: {
      ...stripIdentityVariants(item?.provenance),
      source_chat_uid: window.chat_uid,
      source_messages: item?.provenance?.source_messages ?? defaultSourceMessages(window.source_range),
      source_kind: 'raw-jsonl',
    },
    supersedes: item?.supersedes ?? null,
  };
}

function buildStateContent(item) {
  if (text(item?.content)) return text(item.content);
  const name = text(item?.entity) || text(item?.name);
  const fields = Object.entries(item?.fields ?? {})
    .filter(([, value]) => value !== null && value !== undefined && text(String(value)))
    .map(([key, value]) => `${key}=${String(value).trim()}`);
  return name && fields.length > 0 ? `${name}: ${fields.join(' | ')}` : '';
}

function buildRelationshipContent(item) {
  if (text(item?.content)) return text(item.content);
  const subject = text(item?.subject);
  const target = text(item?.target);
  const descriptors = list(item?.descriptors)
    .map((descriptor) => {
      if (typeof descriptor === 'string') return descriptor.trim();
      return `${text(descriptor?.word)}${descriptor?.magnitude ? `(${descriptor.magnitude})` : ''}`;
    })
    .filter(Boolean)
    .join(', ');
  return subject && target && descriptors
    ? `${subject} → ${target}: ${descriptors}`
    : '';
}

function buildEpistemicContent(item) {
  if (text(item?.content)) return text(item.content);
  const subject = text(item?.subject);
  const type = text(item?.type);
  const target = text(item?.target);
  return [subject, type, target].filter(Boolean).join(' — ');
}

function withMetadata(base, item) {
  const metadata = {};
  for (const key of [
    'conflict_key',
    'entities',
    'entity_names',
    'subject',
    'target',
    'entity',
    'entity_type',
    'witnessed_by',
    'type',
    'descriptors',
  ]) {
    if (item?.[key] !== undefined) metadata[key] = item[key];
  }
  return { ...base, ...metadata };
}

function legacyTaggedResponse(source) {
  const payload = emptyResponse();
  let recognized = false;
  const confidenceFromImportance = (importance) =>
    Math.max(0, Math.min(1, Number(importance ?? 2) / 3));

  for (const item of parseExtractionOutput(source)) {
    recognized = true;
    const target = item.expiration === 'session' || item.expiration === 'scene'
      ? payload.session
      : item.type === 'relationship'
        ? payload.relationships
        : payload.facts;
    if (target === payload.session) {
      target.push({
        type: 'detail',
        content: item.content,
        confidence: confidenceFromImportance(item.importance),
      });
    } else if (target === payload.relationships) {
      target.push({
        content: item.content,
        confidence: confidenceFromImportance(item.importance),
        ...(item._raw_entity_names?.length ? { entity_names: item._raw_entity_names } : {}),
      });
    } else {
      target.push({
        content: item.content,
        type: item.type,
        confidence: confidenceFromImportance(item.importance),
        ...(item._raw_entity_names?.length ? { entity_names: item._raw_entity_names } : {}),
      });
    }
  }

  for (const item of parseSessionOutput(source)) {
    recognized = true;
    payload.session.push({
      type: item.type,
      content: item.content,
      confidence: confidenceFromImportance(item.importance),
    });
  }

  const arcs = parseArcOutput(source, []);
  if (/^\[(?:arc|resolved)\]/im.test(source)) recognized = true;
  for (const item of arcs.add) {
    payload.arcs.push({ content: item.content, status: 'active', confidence: 0.7 });
  }

  return { payload, recognized };
}

/** Parses model output, preferring JSON and accepting legacy tagged lines. */
export function parseStructuredResponseResult(raw) {
  if (typeof raw !== 'string') {
    return { payload: emptyResponse(), valid: false, format: 'invalid' };
  }
  const source = raw.trim();
  if (!source) {
    return { payload: emptyResponse(), valid: false, format: 'empty' };
  }
  if (source.toUpperCase() === 'NONE') {
    return { payload: emptyResponse(), valid: true, format: 'empty' };
  }

  const jsonSource = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(jsonSource);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { payload: parsed, valid: true, format: 'json' };
    }
  } catch {
    // Fall through to the legacy tagged-line compatibility parser.
  }

  const legacy = legacyTaggedResponse(source);
  if (legacy.recognized) return { payload: legacy.payload, valid: true, format: 'tagged' };
  return { payload: emptyResponse(), valid: false, format: 'invalid' };
}

/** Parses model output, accepting JSON, fenced JSON, and legacy tagged lines. */
export function parseStructuredResponse(raw) {
  return parseStructuredResponseResult(raw).payload;
}

/** Builds the one-call structured extraction prompt. */
export function buildStructuredExtractionPrompt({
  chatText = '',
  existingRecords = [],
  respondingCharacter = '',
  timeline = null,
  enabledKinds = null,
} = {}) {
  const existing = list(existingRecords)
    .slice(-40)
    .map((record) => ({
      kind: record.kind,
      content: record.content,
      validity: record.validity?.status ?? 'active',
    }));
  return [
    'Extract only meaningful changes from the current roleplay passage.',
    'Return JSON only with exactly these optional arrays: facts, relationships, state, arcs, epistemic, session.',
    'Do not repeat unchanged information. Use null or omit unknown values; never invent dates.',
    'facts: [{content, confidence, supersedes}]',
    'relationships: [{subject, target, content, descriptors, conflict_key, confidence}]',
    'state: [{entity, entity_type, content, fields, conflict_key, confidence}]',
    'arcs: [{content, status, confidence}]',
    'epistemic: [{subject, target, type, content, witnessed_by, confidence}]',
    'session: [{type, content, confidence}]',
    `Responding character: ${text(respondingCharacter) || '(unknown)'}`,
    ...(Array.isArray(enabledKinds)
      ? [
          `Enabled structured categories: ${enabledKinds.join(', ') || '(none)'}`,
          'Return empty arrays for disabled structured categories.',
        ]
      : []),
    ...(timeline
      ? [
          `Current story clock: ${buildTimelinePromptBlock(timeline).replace(/\n/g, ' ')}`,
          'Backstory and flashback dates are historical; do not replace the current story clock with them.',
          ...(timeline.conflicts?.length > 0
            ? ['Temporal conflict is present; mark uncertain or preserve both readings rather than silently choosing.']
            : []),
        ]
      : []),
    '<existing_records>',
    JSON.stringify(existing),
    '</existing_records>',
    '<current_passage>',
    text(chatText),
    '</current_passage>',
  ].join('\n');
}

/** Converts the combined payload into canonical derived records. */
export function normalizeStructuredRecords(
  payload,
  window,
  { timeline = null, enabledKinds = null } = {},
) {
  if (!window?.window_id || !window?.chat_uid || !window?.source_range) {
    throw new TypeError('a valid ingest window is required');
  }
  const parsed = payload ?? emptyResponse();
  const allowedKinds = Array.isArray(enabledKinds) ? new Set(enabledKinds) : null;
  const records = [];
  const append = (items, kind, contentBuilder) => {
    list(items).forEach((item, index) => {
      if (allowedKinds && !allowedKinds.has(kind)) return;
      const content = contentBuilder(item);
      if (!content) return;
      const base = commonFields({ ...item, content }, kind, index, window);
      const record = withMetadata(buildDerivedRecord(base), item);
      if (
        kind === PROJECTION_KINDS.STATE &&
        timeline &&
        !isProjectionTemporallyCompatible(record.content, timeline)
      ) {
        return;
      }
      records.push(record);
    });
  };

  append(parsed.facts, PROJECTION_KINDS.FACT, (item) => item?.content);
  append(parsed.relationships, PROJECTION_KINDS.RELATIONSHIP, buildRelationshipContent);
  append(parsed.state, PROJECTION_KINDS.STATE, buildStateContent);
  append(parsed.arcs, PROJECTION_KINDS.ARC, (item) => item?.content);
  append(parsed.epistemic, PROJECTION_KINDS.EPISTEMIC, buildEpistemicContent);
  append(parsed.session, PROJECTION_KINDS.SESSION, (item) => item?.content);
  return records;
}

function normalizedContent(record) {
  return text(record?.content).toLowerCase().replace(/\s+/g, ' ');
}

function cloneRecord(record) {
  return typeof structuredClone === 'function' ? structuredClone(record) : JSON.parse(JSON.stringify(record));
}

function supersededStatus(record) {
  return {
    ...(record?.validity ?? {}),
    status: 'superseded',
  };
}

/**
 * Merges typed records without mutating either input. Explicit supersession or
 * a stronger same-key update retires the older state while preserving history.
 */
export function mergeStructuredRecords(existing = [], incoming = []) {
  const result = list(existing).map(cloneRecord);
  const seen = new Set(
    result
      .filter((record) => !record.superseded_by)
      .map((record) => `${record.kind}|${normalizedContent(record)}`),
  );

  for (const candidate of list(incoming)) {
    const record = cloneRecord(candidate);
    const contentKey = `${record.kind}|${normalizedContent(record)}`;
    const supersedes = new Set(
      list(record.supersedes).concat(record.supersedes ? [] : []).map(String),
    );
    if (typeof record.supersedes === 'string') supersedes.add(record.supersedes);

    for (const old of result) {
      if (supersedes.has(String(old.id))) {
        old.superseded_by = record.id;
        old.validity = supersededStatus(old);
      }
    }

    const conflictKey = record.conflict_key;
    if (conflictKey) {
      for (const old of result) {
        if (
          old.superseded_by ||
          old.conflict_key !== conflictKey ||
          normalizedContent(old) === normalizedContent(record)
        ) continue;
        const incomingConfidence = Number(record.confidence ?? 0);
        const oldConfidence = Number(old.confidence ?? 0);
        if (supersedes.has(String(old.id)) || incomingConfidence >= oldConfidence) {
          old.superseded_by = record.id;
          old.validity = supersededStatus(old);
        } else {
          record.validity = { ...(record.validity ?? {}), status: 'uncertain' };
        }
      }
    }

    if (!seen.has(contentKey)) {
      result.push(record);
      seen.add(contentKey);
    }
  }
  return result;
}

function sourceRanges(record) {
  const ranges = [];
  if (record?.source_range && typeof record.source_range === 'object') {
    ranges.push(record.source_range);
  }
  const provenanceMessages = record?.provenance?.source_messages;
  if (Array.isArray(provenanceMessages) && provenanceMessages.length > 0) {
    const numeric = provenanceMessages.filter((value) => Number.isInteger(value));
    if (numeric.length === provenanceMessages.length) {
      ranges.push({ kind: 'mesId', start: Math.min(...numeric), end: Math.max(...numeric) });
    }
  }
  const legacyRange = record?.source_message_range;
  if (Array.isArray(legacyRange) && legacyRange.length >= 2) {
    ranges.push({ kind: 'index', start: legacyRange[0], end: legacyRange[1] });
  }
  return ranges;
}

function hasTailRange(range, branchPointMesId, branchPointIndex = null) {
  if (range?.kind === 'mesId') {
    return !Number.isInteger(branchPointMesId) ||
      (Number.isInteger(range.end) && range.end > branchPointMesId);
  }
  return range?.kind === 'index' &&
    Number.isInteger(branchPointIndex) &&
    Number.isInteger(range.end) &&
    range.end > branchPointIndex;
}

function hasMesIdTail(record, branchPointMesId, branchPointIndex = null) {
  return sourceRanges(record).some((range) => hasTailRange(range, branchPointMesId, branchPointIndex));
}

function fullyWithinMesIdPrefix(record, parentPrefixEnd) {
  const ranges = sourceRanges(record);
  return (
    ranges.length > 0 &&
    ranges.every(
      (range) =>
        range?.kind === 'mesId' &&
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.start >= 0 &&
        range.end >= range.start &&
        range.end <= parentPrefixEnd,
    )
  );
}

/** Prunes product records sourced from a discarded in-file branch tail. */
export function pruneStructuredRecordsAtBranch(
  records = [],
  { branchPointMesId, branchPointIndex = null } = {},
) {
  const original = list(records);
  const removedIds = new Set();
  const kept = [];
  const removed = [];
  for (const record of original) {
    if (hasMesIdTail(record, branchPointMesId, branchPointIndex)) {
      removed.push(record);
      if (record?.id) removedIds.add(String(record.id));
    } else {
      kept.push(cloneRecord(record));
    }
  }

  if (removedIds.size > 0) {
    for (const record of kept) {
      if (record.superseded_by && removedIds.has(String(record.superseded_by))) {
        delete record.superseded_by;
        record.validity = { ...(record.validity ?? {}), status: 'active' };
      }
    }
  }
  return { kept, removed: removed.map(cloneRecord), changed: removed.length > 0 };
}

/** Inherits only fully mesId-proven structured records from a parent prefix. */
export function inheritStructuredRecordsPrefix(
  records = [],
  {
    parentChatUid,
    parentChatId = null,
    parentBranchUid = null,
    branchChatUid,
    branchChatId = null,
    branchUid = null,
    parentPrefixEnd,
  } = {},
) {
  const parent = text(parentChatUid);
  const parentId = text(parentChatId);
  const branch = text(branchChatUid);
  const branchId = text(branchChatId);
  if (!parent || !branch || !Number.isInteger(parentPrefixEnd) || parentPrefixEnd < 0) return [];
  return list(records)
    .filter((record) => {
      const explicitUids = [
        record?.scope?.chat_uid,
        record?.scope?.source_chat_uid,
        record?.scope?._source_chat_uid,
        record?._source_chat_uid,
        record?.provenance?.source_chat_uid,
        record?.provenance?.chat_uid,
        record?.provenance?._source_chat_uid,
        record?.source_chat_uid,
        record?.chat_uid,
      ].map(text).filter(Boolean);
      if (explicitUids.length === 0 || explicitUids.some((value) => value !== parent)) return false;
      if (parentId) {
        const explicitIds = [
          record?.scope?.chat_id,
          record?.scope?.source_chat_id,
          record?.scope?._source_chat_id,
          record?.provenance?.chat_id,
          record?.provenance?.source_chat_id,
          record?.provenance?._source_chat_id,
          record?.source_chat_id,
          record?._source_chat_id,
          record?.chat_id,
        ].map(text).filter(Boolean);
        if (explicitIds.some((value) => value !== parentId)) return false;
      }
      const explicitBranchUids = [
        record?.scope?.branch_uid,
        record?.scope?._branch_uid,
        record?.scope?.lineage_epoch,
        record?.scope?._lineage_epoch,
        record?.provenance?.branch_uid,
        record?.provenance?._branch_uid,
        record?.provenance?.lineage_epoch,
        record?.provenance?._lineage_epoch,
        record?.branch_uid,
        record?._branch_uid,
        record?.lineage_epoch,
        record?._lineage_epoch,
      ].map(text).filter(Boolean);
      if (parentBranchUid == null) {
        if (explicitBranchUids.length > 0) return false;
      } else {
        if (
          explicitBranchUids.length === 0 ||
          explicitBranchUids.some((value) => value !== text(parentBranchUid))
        ) return false;
      }
      return fullyWithinMesIdPrefix(record, parentPrefixEnd);
    })
    .map((record) => {
      const copy = cloneRecord(record);
      const targetBranch = branchUid == null ? null : String(branchUid);
      copy.scope = { ...(copy.scope ?? {}), chat_uid: branch };
      if (branchId) {
        if (copy.scope.source_chat_id != null) copy.scope.source_chat_id = branchId;
        if (copy.scope._source_chat_id != null) copy.scope._source_chat_id = branchId;
        if (copy.scope.chat_id != null) copy.scope.chat_id = branchId;
      }
      if (copy.scope.source_chat_uid != null) copy.scope.source_chat_uid = branch;
      if (copy.scope._source_chat_uid != null) copy.scope._source_chat_uid = branch;
      if (targetBranch != null) {
        for (const field of ['branch_uid', '_branch_uid', 'lineage_epoch', '_lineage_epoch']) {
          if (copy.scope[field] != null) copy.scope[field] = targetBranch;
        }
        copy.scope.branch_uid = targetBranch;
      }
      if (branchId) {
        if (copy.source_chat_id != null) copy.source_chat_id = branchId;
        if (copy._source_chat_id != null) copy._source_chat_id = branchId;
        if (copy.chat_id != null) copy.chat_id = branchId;
      }
      if (copy.source_chat_uid != null) copy.source_chat_uid = branch;
      if (copy._source_chat_uid != null) copy._source_chat_uid = branch;
      if (copy.chat_uid != null) copy.chat_uid = branch;
      if (targetBranch != null) {
        for (const field of ['branch_uid', '_branch_uid', 'lineage_epoch', '_lineage_epoch']) {
          if (copy[field] != null) copy[field] = targetBranch;
        }
        copy.branch_uid = targetBranch;
      }
      copy.provenance = {
        ...(copy.provenance ?? {}),
        source_chat_uid: branch,
      };
      if (branchId) {
        if (copy.provenance.source_chat_id != null) copy.provenance.source_chat_id = branchId;
        if (copy.provenance._source_chat_id != null) copy.provenance._source_chat_id = branchId;
        if (copy.provenance.chat_id != null) copy.provenance.chat_id = branchId;
      }
      if (copy.provenance.source_chat_uid != null) copy.provenance.source_chat_uid = branch;
      if (copy.provenance._source_chat_uid != null) copy.provenance._source_chat_uid = branch;
      if (copy.provenance.chat_uid != null) copy.provenance.chat_uid = branch;
      if (targetBranch != null) {
        for (const field of ['branch_uid', '_branch_uid', 'lineage_epoch', '_lineage_epoch']) {
          if (copy.provenance[field] != null) copy.provenance[field] = targetBranch;
        }
        copy.provenance.branch_uid = targetBranch;
      }
      copy.origin_chat_uid = copy.origin_chat_uid ?? parent;
      copy.inherited = true;
      return copy;
    });
}
