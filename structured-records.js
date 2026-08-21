/**
 * Combined structured projection contract for the single-extension runtime.
 *
 * One bounded model response may describe facts, relationships, current state,
 * active arcs, and epistemic knowledge. Parsing and merging remain pure so the
 * runtime can test them without SillyTavern or a provider.
 */

import { buildDerivedRecord, PROJECTION_KINDS, PROJECTION_OWNERS } from './projections.js';

const EMPTY_RESPONSE = Object.freeze({
  facts: [],
  relationships: [],
  state: [],
  arcs: [],
  epistemic: [],
});

const RESPONSE_KEYS = Object.keys(EMPTY_RESPONSE);

function emptyResponse() {
  return Object.fromEntries(RESPONSE_KEYS.map((key) => [key, []]));
}

function hash32(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
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

function sourceMessages(sourceRange) {
  if (sourceRange.kind !== 'mesId') return [];
  return sourceRange.start === sourceRange.end
    ? [sourceRange.start]
    : [sourceRange.start, sourceRange.end];
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
      ...(item?.scope ?? {}),
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
      ...(item?.provenance ?? {}),
      source_chat_uid: window.chat_uid,
      source_messages: item?.provenance?.source_messages ?? sourceMessages(window.source_range),
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

/** Parses model output, accepting a fenced JSON block but rejecting prose safely. */
export function parseStructuredResponse(raw) {
  if (typeof raw !== 'string') return emptyResponse();
  let source = raw.trim();
  source = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyResponse();
    return parsed;
  } catch {
    return emptyResponse();
  }
}

/** Builds the one-call structured extraction prompt. */
export function buildStructuredExtractionPrompt({
  chatText = '',
  existingRecords = [],
  respondingCharacter = '',
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
    'Return JSON only with exactly these optional arrays: facts, relationships, state, arcs, epistemic.',
    'Do not repeat unchanged information. Use null or omit unknown values; never invent dates.',
    'facts: [{content, confidence, supersedes}]',
    'relationships: [{subject, target, content, descriptors, conflict_key, confidence}]',
    'state: [{entity, entity_type, content, fields, conflict_key, confidence}]',
    'arcs: [{content, status, confidence}]',
    'epistemic: [{subject, target, type, content, witnessed_by, confidence}]',
    `Responding character: ${text(respondingCharacter) || '(unknown)'}`,
    '<existing_records>',
    JSON.stringify(existing),
    '</existing_records>',
    '<current_passage>',
    text(chatText),
    '</current_passage>',
  ].join('\n');
}

/** Converts the combined payload into canonical derived records. */
export function normalizeStructuredRecords(payload, window) {
  if (!window?.window_id || !window?.chat_uid || !window?.source_range) {
    throw new TypeError('a valid ingest window is required');
  }
  const parsed = payload ?? emptyResponse();
  const records = [];
  const append = (items, kind, contentBuilder) => {
    list(items).forEach((item, index) => {
      const content = contentBuilder(item);
      if (!content) return;
      const base = commonFields({ ...item, content }, kind, index, window);
      records.push(withMetadata(buildDerivedRecord(base), item));
    });
  };

  append(parsed.facts, PROJECTION_KINDS.FACT, (item) => item?.content);
  append(parsed.relationships, PROJECTION_KINDS.RELATIONSHIP, buildRelationshipContent);
  append(parsed.state, PROJECTION_KINDS.STATE, buildStateContent);
  append(parsed.arcs, PROJECTION_KINDS.ARC, (item) => item?.content);
  append(parsed.epistemic, PROJECTION_KINDS.EPISTEMIC, buildEpistemicContent);
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
