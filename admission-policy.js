/**
 * Conservative admission policy for structured Product candidates.
 *
 * The narrative chain preserves broad scene continuity. This module decides which
 * model-produced candidates deserve a searchable structured record. It is pure,
 * domain-neutral, and deliberately does not make another model call.
 */

export const RETENTION_CLASSES = Object.freeze({
  SEARCHABLE: 'searchable',
  SESSION: 'session',
  NARRATIVE: 'narrative',
});

const ALLOWED_RETENTION = new Set(Object.values(RETENTION_CLASSES));
const REPEATED_NOVELTY = new Set(['repeat', 'repeated', 'duplicate', 'unchanged']);
const DEFAULT_MAX_TOTAL = 12;
const DEFAULT_MAX_PER_KIND = 4;

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
  } = {},
) {
  const candidates = Array.isArray(records) ? records : [];
  const rejected = [];
  const eligible = [];
  const seen = new Set();
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
    const key = contentKey(record);
    if (seen.has(key) || existing.has(key)) {
      rejected.push(rejection(record, 'duplicate'));
      return;
    }
    seen.add(key);
    eligible.push({ record: { ...clone(record), retention }, index });
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
