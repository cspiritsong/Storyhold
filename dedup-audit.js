/**
 * Pure duplicate-audit helpers.
 *
 * The duplicate scanner clusters stored memories by near-duplicate similarity
 * (same tier only), keeps the earliest entry per cluster, and removes later
 * entries unless they carry an explicit state-change marker.
 */

import { hasStateChangeMarker, jaccardSimilarity } from './similarity.js';

/** Conservative thresholds: above these, a same-type pair is a duplicate. */
export const DEDUP_SEMANTIC_THRESHOLD = 0.85;
export const DEDUP_JACCARD_THRESHOLD = 0.8;

/** Returns true when the given similarity score crosses the duplicate threshold. */
export function isDuplicatePair(score, { semantic = false } = {}) {
  return semantic ? score >= DEDUP_SEMANTIC_THRESHOLD : score >= DEDUP_JACCARD_THRESHOLD;
}

/**
 * Serializes a value deterministically for a short-lived confirmation snapshot.
 * This is not a security hash; it detects any material change to the reviewed
 * memory objects before a destructive apply.
 */
function stableSnapshot(value) {
  if (Array.isArray(value)) return `[${value.map(stableSnapshot).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSnapshot(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Captures the exact eligible memory set that a user-approved duplicate plan
 * was computed against. The snapshot is process-local and is never persisted.
 */
export function createDuplicateReview(items = [], plan = {}) {
  return Object.freeze({
    items: Object.freeze(
      items.map((item) =>
        Object.freeze({
          id: item?.id,
          snapshot: stableSnapshot(item),
        }),
      ),
    ),
    clusters: Object.freeze((plan.clusters ?? []).map((cluster) => Object.freeze([...cluster]))),
    remove_ids: Object.freeze([...(plan.remove_ids ?? [])]),
    keep_ids: Object.freeze([...(plan.keep_ids ?? [])]),
  });
}

/** Returns true only when the current eligible set is byte-for-byte review-equivalent. */
export function duplicateReviewMatches(items = [], review = null) {
  if (!review || !Array.isArray(review.items) || review.items.length !== items.length) return false;
  return review.items.every(
    (entry, index) =>
      entry?.id === items[index]?.id && entry?.snapshot === stableSnapshot(items[index]),
  );
}

/**
 * Plans a safe duplicate removal over an ordered item list.
 *
 * @param {Array<{id: *, content: string, type?: string}>} items
 * @param {Object} options
 * @param {(a, b) => ({score: number, semantic: boolean} | null)} [options.scoreFor]
 *   Optional scorer; when omitted or returning null, Jaccard fallback is used.
 * @param {number} [options.semanticThreshold]
 * @param {number} [options.jaccardThreshold]
 * @returns {{clusters: Array<Array<*>>, remove_ids: Array<*>, keep_ids: Array<*>, pairs: Array<{a: *, b: *, score: number, semantic: boolean}>}}
 */
export function planDuplicateRemoval(
  items = [],
  {
    scoreFor = null,
    semanticThreshold = DEDUP_SEMANTIC_THRESHOLD,
    jaccardThreshold = DEDUP_JACCARD_THRESHOLD,
  } = {},
) {
  const normalized = items.map((item, index) => ({
    ...item,
    _index: index,
  }));

  const parent = normalized.map((_, index) => index);
  const find = (i) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== i) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const pairs = [];
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i];
      const b = normalized[j];
      if (a.type !== b.type) continue;

      let scored = typeof scoreFor === 'function' ? scoreFor(a, b) : null;
      if (!scored) {
        scored = {
          score: jaccardSimilarity(String(a.content ?? ''), String(b.content ?? '')),
          semantic: false,
        };
      }
      const duplicate =
        (scored.semantic ? scored.score >= semanticThreshold : scored.score >= jaccardThreshold);
      if (!duplicate) continue;

      pairs.push({ a: a.id, b: b.id, score: scored.score, semantic: Boolean(scored.semantic) });
      union(i, j);
    }
  }

  const clusters = new Map();
  for (let i = 0; i < normalized.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(normalized[i]);
  }

  const removeIds = [];
  const keepIds = [];
  for (const members of clusters.values()) {
    if (members.length < 2) {
      keepIds.push(members[0].id);
      continue;
    }
    members.sort((a, b) => a._index - b._index);
    const [first, ...rest] = members;
    keepIds.push(first.id);
    for (const member of rest) {
      if (hasStateChangeMarker(String(member.content ?? ''))) {
        keepIds.push(member.id);
      } else {
        removeIds.push(member.id);
      }
    }
  }

  const removeSet = new Set(removeIds);
  const clusterLists = [...clusters.values()]
    .filter((members) => members.length >= 2)
    .map((members) => members.map((m) => m.id));

  return {
    clusters: clusterLists,
    remove_ids: removeIds,
    keep_ids: normalized.filter((item) => !removeSet.has(item.id)).map((item) => item.id),
    pairs,
  };
}
