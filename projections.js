/**
 * Shared ingest/projection primitives.
 *
 * This module is SillyTavern-free so the ingest contract can be tested without
 * a browser, a provider, or a live chat. Raw chat remains the evidence source;
 * these helpers only add stable identity and provenance to derived projections.
 */

export const PROJECTION_OWNERS = Object.freeze({
  STRUCTURED: 'smart-memory',
  NARRATIVE: 'summaryception',
  EVIDENCE: 'st-vector-storage',
  CANON: 'lorebook',
});

export const PROJECTION_KINDS = Object.freeze({
  FACT: 'fact',
  STATE: 'state',
  RELATIONSHIP: 'relationship',
  ARC: 'arc',
  EPISTEMIC: 'epistemic',
  NARRATIVE_DELTA: 'narrative_delta',
});

const RANGE_KINDS = new Set(['mesId', 'index']);
const OWNER_BY_KIND = Object.freeze({
  fact: PROJECTION_OWNERS.STRUCTURED,
  state: PROJECTION_OWNERS.STRUCTURED,
  relationship: PROJECTION_OWNERS.STRUCTURED,
  arc: PROJECTION_OWNERS.STRUCTURED,
  epistemic: PROJECTION_OWNERS.STRUCTURED,
  narrative_delta: PROJECTION_OWNERS.NARRATIVE,
});

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function hash32(text, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function canonicalMessage(message) {
  return JSON.stringify({
    name: String(message?.name ?? ''),
    is_user: Boolean(message?.is_user),
    is_system: Boolean(message?.is_system),
    mes: String(message?.mes ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\s+/g, ' ')
      .trim(),
  });
}

/**
 * Normalizes a source range. Arrays are accepted as an imported-chat fallback
 * and become index ranges; new callers should use the object form.
 */
export function normalizeSourceRange(range) {
  const candidate = Array.isArray(range)
    ? { kind: 'index', start: range[0], end: range[1] }
    : range;
  const kind = candidate?.kind ?? 'index';
  if (!RANGE_KINDS.has(kind)) throw new TypeError(`source range kind must be one of ${[...RANGE_KINDS].join(', ')}`);
  const start = assertInteger(candidate?.start, 'source range start');
  const end = assertInteger(candidate?.end, 'source range end');
  if (start > end) throw new RangeError('source range start must not exceed end');
  return { kind, start, end };
}

/**
 * Stable content fingerprint for a transcript window. Mutable mesIds are not
 * included in the message content representation; the range remains part of
 * the window identity separately.
 */
export function fingerprintMessages(messages) {
  const normalized = Array.isArray(messages) ? messages.map(canonicalMessage).join('\n') : '';
  return `window-v1:${Array.isArray(messages) ? messages.length : 0}:${hash32(normalized, 0x811c9dc5)}:${hash32(normalized, 0x01000193)}`;
}

/** Builds an idempotency key for one ingest window. */
export function buildWindowId({ chatUid, branchUid = null, sourceRange, fingerprint }) {
  const chat = assertNonEmptyString(chatUid, 'chat uid');
  const range = normalizeSourceRange(sourceRange);
  const fp = assertNonEmptyString(fingerprint, 'window fingerprint');
  const branch = branchUid == null || branchUid === '' ? 'root' : String(branchUid);
  return `${chat}:${branch}:${range.kind}:${range.start}-${range.end}:${fp}`;
}

/**
 * Creates the canonical input passed to all projections for one transcript
 * window. The message objects are copied so projectors cannot mutate raw chat.
 */
export function buildIngestWindow({
  chatUid,
  branchUid = null,
  messages = [],
  sourceRange,
  fingerprint = null,
  lineage = null,
} = {}) {
  const chat = assertNonEmptyString(chatUid, 'chat uid');
  const range = normalizeSourceRange(sourceRange);
  const copiedMessages = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
  const resolvedFingerprint = fingerprint ?? fingerprintMessages(copiedMessages);
  const windowId = buildWindowId({
    chatUid: chat,
    branchUid,
    sourceRange: range,
    fingerprint: resolvedFingerprint,
  });

  return {
    window_id: windowId,
    chat_uid: chat,
    branch_uid: branchUid == null || branchUid === '' ? null : String(branchUid),
    source_range: range,
    fingerprint: resolvedFingerprint,
    messages: copiedMessages,
    lineage: lineage ?? null,
    quarantined: Boolean(lineage?.quarantined),
  };
}

function normalizeValidity(validity) {
  const value = typeof validity === 'string' ? { status: validity } : validity ?? {};
  const status = value.status ?? 'active';
  const allowed = new Set(['active', 'superseded', 'uncertain', 'invalid']);
  if (!allowed.has(status)) throw new TypeError(`validity status is not supported: ${status}`);
  return {
    status,
    valid_from: value.valid_from ?? null,
    valid_to: value.valid_to ?? null,
  };
}

function defaultSourceMessages(sourceRange) {
  if (sourceRange.kind !== 'mesId') return [];
  return sourceRange.start === sourceRange.end
    ? [sourceRange.start]
    : [sourceRange.start, sourceRange.end];
}

/**
 * Builds a typed derived record with the metadata required for later filtering,
 * reconciliation, and branch-safe retrieval.
 */
export function buildDerivedRecord({
  id,
  kind,
  owner = null,
  content,
  scope,
  sourceRange,
  storyTime = null,
  knowledgeTime = null,
  validity = null,
  confidence = 1,
  provenance = null,
  supersedes = null,
} = {}) {
  const recordId = assertNonEmptyString(id, 'record id');
  const recordKind = assertNonEmptyString(kind, 'record kind');
  const text = assertNonEmptyString(content, 'record content');
  const range = normalizeSourceRange(sourceRange);
  const chatUid = assertNonEmptyString(scope?.chat_uid, 'record scope.chat_uid');
  const normalizedScope = {
    ...scope,
    chat_uid: chatUid,
  };
  if (normalizedScope.branch_uid != null && normalizedScope.branch_uid !== '') {
    normalizedScope.branch_uid = String(normalizedScope.branch_uid);
  }

  const numericConfidence = Number(confidence);
  if (!Number.isFinite(numericConfidence) || numericConfidence < 0 || numericConfidence > 1) {
    throw new RangeError('record confidence must be between 0 and 1');
  }

  const normalizedProvenance = {
    ...(provenance ?? {}),
    source_chat_uid: String(provenance?.source_chat_uid ?? chatUid),
    source_messages: Array.isArray(provenance?.source_messages)
      ? [...provenance.source_messages]
      : defaultSourceMessages(range),
    source_kind: provenance?.source_kind ?? 'raw-jsonl',
  };

  return {
    id: recordId,
    kind: recordKind,
    owner: owner ?? OWNER_BY_KIND[recordKind] ?? PROJECTION_OWNERS.STRUCTURED,
    content: text,
    scope: normalizedScope,
    source_range: range,
    story_time: storyTime,
    knowledge_time: knowledgeTime,
    validity: normalizeValidity(validity),
    confidence: numericConfidence,
    provenance: normalizedProvenance,
    supersedes: supersedes ?? null,
  };
}

/**
 * Fills missing metadata on a projector result from its source window. The
 * projector remains responsible for content and kind; no classification or
 * fact extraction is performed here.
 */
export function normalizeDerivedRecord(record, window, { owner = null } = {}) {
  if (!window?.chat_uid || !window?.source_range) {
    throw new TypeError('a valid ingest window is required');
  }
  const kind = record?.kind ?? (owner === PROJECTION_OWNERS.NARRATIVE ? PROJECTION_KINDS.NARRATIVE_DELTA : null);
  if (!kind) throw new TypeError('projector result must specify a kind');
  const content = record?.content;
  const generatedId = `${window.window_id}:${kind}:${hash32(String(content ?? ''), 0x811c9dc5)}`;
  const scope = {
    ...(record?.scope ?? {}),
    chat_uid: window.chat_uid,
    ...(window.branch_uid != null ? { branch_uid: window.branch_uid } : {}),
  };
  const provenance = {
    ...(record?.provenance ?? {}),
    source_chat_uid: window.chat_uid,
    source_messages:
      record?.provenance?.source_messages ?? defaultSourceMessages(window.source_range),
    source_kind: record?.provenance?.source_kind ?? 'raw-jsonl',
  };
  return buildDerivedRecord({
    ...record,
    id: record?.id ?? generatedId,
    kind,
    owner: record?.owner ?? owner,
    content,
    scope,
    sourceRange: record?.source_range ?? window.source_range,
    storyTime: record?.story_time ?? null,
    knowledgeTime: record?.knowledge_time ?? null,
    validity: record?.validity ?? null,
    confidence: record?.confidence ?? 1,
    provenance,
    supersedes: record?.supersedes ?? null,
  });
}
