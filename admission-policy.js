/**
 * Conservative admission policy for structured Product candidates.
 *
 * The narrative chain preserves broad scene continuity. This module decides which
 * model-produced candidates deserve a searchable structured record. It is pure,
 * domain-neutral, and deliberately does not make another model call.
 */

import { isUngroundedText } from './grounding.js';

export const RETENTION_CLASSES = Object.freeze({
  SEARCHABLE: 'searchable',
  SESSION: 'session',
  NARRATIVE: 'narrative',
});

const ALLOWED_RETENTION = new Set(Object.values(RETENTION_CLASSES));
const REPEATED_NOVELTY = new Set(['repeat', 'repeated', 'duplicate', 'unchanged']);
const DEFAULT_MAX_TOTAL = 12;
const DEFAULT_MAX_PER_KIND = 4;

function citationValues(record) {
  const raw = record?.provenance?.source_messages;
  if (!Array.isArray(raw)) return [];
  const values = [];
  for (const entry of raw) {
    if (Number.isInteger(entry)) values.push(entry);
    else if (Array.isArray(entry)) {
      for (const side of entry) if (Number.isInteger(side)) values.push(side);
    }
  }
  return values;
}

function inheritedCitations(existingRecords) {
  const inherited = new Set();
  for (const record of existingRecords ?? []) {
    for (const value of citationValues(record)) inherited.add(value);
    const start = record?.source_range;
    if (start?.kind === 'mesId' && Number.isInteger(start?.start)) inherited.add(start.start);
    if (start?.kind === 'mesId' && Number.isInteger(start?.end)) inherited.add(start.end);
  }
  return inherited;
}

/**
 * Out-of-window citations are a hallucination tripwire. Index-scale records
 * are never judged (their provenance may legitimately be mesId-scaled), and
 * citations inherited from existing shard-like records are kept, flagged for
 * the Explorer rather than discarded.
 */
function inspectCitations(record, { citationRange, inherited }) {
  if (!citationRange || citationRange.kind !== 'mesId') return { verdict: null, unverified: [] };
  if (record?.source_range && record.source_range.kind !== 'mesId') return { verdict: null, unverified: [] };
  const citations = citationValues(record);
  if (citations.length === 0) return { verdict: null, unverified: [] };
  const inside = citations.filter(
    (value) => value >= citationRange.start && value <= citationRange.end,
  );
  const inheritedHits = citations.filter((value) => inherited.has(value));
  const unverified = citations.filter(
    (value) => !(value >= citationRange.start && value <= citationRange.end),
  );
  if (inside.length === 0 && inheritedHits.length === 0) {
    return { verdict: 'ungrounded-citation', unverified };
  }
  return { verdict: null, unverified };
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function normalized(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function contentKey(record) {
  return `${normalized(record?.kind) || 'unknown'}|${normalized(record?.content)}`;
}

function retentionOf(record) {
  const value = normalized(record?.retention);
  return value || (normalized(record?.kind) === 'session'
    ? RETENTION_CLASSES.SESSION
    : RETENTION_CLASSES.SEARCHABLE);
}

function candidatePriority(record, index) {
  const retention = retentionOf(record) === RETENTION_CLASSES.SEARCHABLE ? 3 : 2;
  const novelty = ['changed', 'new', 'resolved', 'revealed', 'discovered'].includes(
    normalized(record?.novelty),
  ) ? 2 : 1;
  const action = record?.supersedes || record?.conflict_key ? 2 : 0;
  const confidence = Math.max(0, Math.min(1, Number(record?.confidence ?? 0.7)));
  return retention * 100 + novelty * 10 + action + confidence - index / 100000;
}

function rejection(record, reason) {
  return { record: clone(record), reason };
}

function buildStats(accepted, rejected) {
  const rejectedByReason = {};
  for (const item of rejected) {
    rejectedByReason[item.reason] = (rejectedByReason[item.reason] ?? 0) + 1;
  }
  return {
    accepted: accepted.length,
    rejected: rejected.length,
    rejected_by_reason: rejectedByReason,
  };
}

/**
 * Admits model-produced structured candidates without mutating input records.
 *
 * `retention: "narrative"` and repeated/unchanged candidates are intentionally
 * rejected: the narrative projection already preserves broad scene flow. A
 * small per-window cap prevents a verbose model response from filling the
 * searchable store in one pass. Candidates without the new optional fields use
 * the searchable compatibility default.
 */
export function admitStructuredRecords(
  records = [],
  {
    existingRecords = [],
    maxTotal = DEFAULT_MAX_TOTAL,
    maxPerKind = DEFAULT_MAX_PER_KIND,
    sourceText = null,
    citationRange = null,
  } = {},
) {
  const candidates = Array.isArray(records) ? records : [];
  const rejected = [];
  const eligible = [];
  const seen = new Set();
  const hasEvidence = typeof sourceText === 'string' && sourceText.trim().length > 0;
  const inherited = inheritedCitations(existingRecords);
  const existing = new Set(
    (Array.isArray(existingRecords) ? existingRecords : [])
      .filter((record) => !record?.superseded_by && !['invalid', 'superseded'].includes(record?.validity?.status))
      .map(contentKey),
  );

  candidates.forEach((record, index) => {
    const content = normalized(record?.content);
    if (!record || typeof record !== 'object' || !content) {
      rejected.push(rejection(record, 'empty'));
      return;
    }
    const retention = retentionOf(record);
    if (!ALLOWED_RETENTION.has(retention)) {
      rejected.push(rejection(record, 'invalid-retention'));
      return;
    }
    if (retention === RETENTION_CLASSES.NARRATIVE) {
      rejected.push(rejection(record, 'narrative-only'));
      return;
    }
    if (record?.admission === 'skip' || record?.decision === 'skip') {
      rejected.push(rejection(record, 'model-skip'));
      return;
    }
    if (REPEATED_NOVELTY.has(normalized(record?.novelty))) {
      rejected.push(rejection(record, 'repeated'));
      return;
    }
    if (hasEvidence && isUngroundedText(record?.content, sourceText)) {
      rejected.push(rejection(record, 'ungrounded'));
      return;
    }
    const citations = inspectCitations(record, { citationRange, inherited });
    if (citations.verdict) {
      rejected.push(rejection(record, citations.verdict));
      return;
    }
    const key = contentKey(record);
    if (seen.has(key) || existing.has(key)) {
      rejected.push(rejection(record, 'duplicate'));
      return;
    }
    seen.add(key);
    const stamped = citations.unverified.length > 0
      ? {
        ...record,
        provenance: { ...(record.provenance ?? {}), citation_unverified: citations.unverified },
      }
      : record;
    eligible.push({ record: { ...clone(stamped), retention }, index });
  });

  const total = Number.isInteger(maxTotal) && maxTotal > 0 ? maxTotal : DEFAULT_MAX_TOTAL;
  const perKind = Number.isInteger(maxPerKind) && maxPerKind > 0 ? maxPerKind : DEFAULT_MAX_PER_KIND;
  const ranked = [...eligible].sort(
    (left, right) => candidatePriority(right.record, right.index) - candidatePriority(left.record, left.index),
  );
  const acceptedSet = new Set();
  const kindCounts = new Map();
  for (const candidate of ranked) {
    const kind = normalized(candidate.record.kind) || 'unknown';
    if (acceptedSet.size >= total) {
      rejected.push(rejection(candidate.record, 'window-cap'));
      continue;
    }
    const count = kindCounts.get(kind) ?? 0;
    if (count >= perKind) {
      rejected.push(rejection(candidate.record, 'kind-cap'));
      continue;
    }
    acceptedSet.add(candidate.index);
    kindCounts.set(kind, count + 1);
  }

  const accepted = eligible
    .filter((candidate) => acceptedSet.has(candidate.index))
    .map((candidate) => candidate.record);
  return {
    accepted,
    rejected,
    stats: buildStats(accepted, rejected),
  };
}
