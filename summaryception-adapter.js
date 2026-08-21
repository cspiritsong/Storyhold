/**
 * Narrow Summaryception projection adapter.
 *
 * Summaryception owns narrative compression. This adapter accepts a snippet
 * produced by that system, adds shared Smart-Memory provenance, and optionally
 * persists it through a caller-provided store. It intentionally does not parse,
 * classify, or extract facts from the snippet.
 */

import { PROJECTION_KINDS, PROJECTION_OWNERS, normalizeDerivedRecord } from './projections.js';

export function createSummaryceptionAdapter({ appendSnippet = async () => {} } = {}) {
  if (typeof appendSnippet !== 'function') {
    throw new TypeError('appendSnippet must be a function');
  }

  return async function projectSummaryception(window, { summarySnippet = null } = {}) {
    const candidate =
      typeof summarySnippet === 'string' ? { text: summarySnippet, layer: 0 } : summarySnippet;
    const text = candidate?.text;
    if (typeof text !== 'string' || text.trim() === '') return [];

    const record = normalizeDerivedRecord(
      {
        id: candidate.record_id,
        kind: PROJECTION_KINDS.NARRATIVE_DELTA,
        owner: PROJECTION_OWNERS.NARRATIVE,
        content: text.trim(),
        scope: candidate.scope,
        source_range: candidate.source_range,
        story_time: candidate.story_time,
        knowledge_time: candidate.knowledge_time,
        validity: candidate.validity,
        confidence: candidate.confidence,
        provenance: candidate.provenance,
        supersedes: candidate.supersedes,
      },
      window,
      { owner: PROJECTION_OWNERS.NARRATIVE },
    );

    await appendSnippet({
      layer: Number.isInteger(candidate.layer) && candidate.layer >= 0 ? candidate.layer : 0,
      text: record.content,
      source_range: record.source_range,
      source_chat_uid: window.chat_uid,
      source_branch_uid: window.branch_uid,
      record_id: record.id,
    });

    return [record];
  };
}
