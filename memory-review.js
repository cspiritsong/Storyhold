/**
 * Read-only player-facing memory review helpers.
 *
 * Search results are evidence candidates, not truth assertions. Challenge review
 * deliberately stops short of mutating records or declaring a claim true/false.
 */

export const MEMORY_REVIEW_MODES = Object.freeze({
  QUERY: 'query',
  CHALLENGE: 'challenge',
});

export const MEMORY_REVIEW_STATUS = Object.freeze({
  NO_MATCH: 'no-match',
  RELATED: 'related',
  STRONG_MATCH: 'strong-match',
});

export const MEMORY_REVIEW_PHASES = Object.freeze({
  ACKNOWLEDGED: 'acknowledged',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const SPOILER_TYPES = new Set(['believes', 'hiding']);

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

function scoreOf(result) {
  const score = Number(result?.score ?? result?.retrieval?.score ?? 0);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

/**
 * Returns the user-facing lifecycle state for a query or challenge.
 * This is deliberately pure so every entry point can render the same contract.
 */
export function memoryReviewProgress({
  mode = MEMORY_REVIEW_MODES.QUERY,
  phase = MEMORY_REVIEW_PHASES.ACKNOWLEDGED,
  totalRecords = null,
  resultCount = 0,
  challenge = null,
} = {}) {
  const label = mode === MEMORY_REVIEW_MODES.CHALLENGE ? 'Challenge' : 'Query';
  const count = Math.max(0, Number(resultCount) || 0);
  let message;
  let severity = 'info';

  switch (phase) {
    case MEMORY_REVIEW_PHASES.ACKNOWLEDGED:
      message = `${label} received — checking this chat's memory.`;
      break;
    case MEMORY_REVIEW_PHASES.IN_PROGRESS: {
      const total = Number.isFinite(Number(totalRecords))
        ? `${Math.max(0, Number(totalRecords))} active record${Number(totalRecords) === 1 ? '' : 's'}`
        : 'active memory';
      message = `${label} in progress — searching ${total}...`;
      break;
    }
    case MEMORY_REVIEW_PHASES.COMPLETED:
      severity = 'success';
      if (label === 'Challenge') {
        const finding = String(
          challenge?.label || (count > 0 ? 'Related evidence found' : 'No related evidence found'),
        );
        message = `${label} complete — ${finding}. No memory was changed.`;
      } else {
        message = `${label} complete — found ${count} matching record${count === 1 ? '' : 's'}. No memory was changed.`;
      }
      break;
    case MEMORY_REVIEW_PHASES.FAILED:
      severity = 'error';
      message = `${label} failed — no result was produced. No memory was changed.`;
      break;
    case MEMORY_REVIEW_PHASES.CANCELLED:
      message = `${label} cancelled. No memory was changed.`;
      break;
    default:
      message = `${label} is unavailable. No memory was changed.`;
      severity = 'error';
      break;
  }

  return {
    mode,
    phase,
    busy: phase === MEMORY_REVIEW_PHASES.ACKNOWLEDGED || phase === MEMORY_REVIEW_PHASES.IN_PROGRESS,
    severity,
    message,
  };
}

/** Returns true for epistemic records that can reveal hidden story information. */
export function isSpoilerMemoryRecord(record) {
  return record?.kind === 'epistemic' && SPOILER_TYPES.has(normalized(record?.type));
}

/** Splits review results without changing their order or mutating the input. */
export function splitMemoryReviewResults(results = []) {
  const visible = [];
  const spoiler = [];
  for (const result of Array.isArray(results) ? results : []) {
    if (isSpoilerMemoryRecord(result?.mem ?? result?.record ?? result)) spoiler.push(result);
    else visible.push(result);
  }
  return { visible, spoiler };
}

/**
 * Classifies how much related evidence was found for a challenge claim.
 * Similarity is intentionally never presented as a truth verdict.
 */
export function classifyMemoryChallenge(claim, results = []) {
  const text = String(claim ?? '').trim();
  const matches = Array.isArray(results) ? results : [];
  if (!text || matches.length === 0) {
    return {
      status: MEMORY_REVIEW_STATUS.NO_MATCH,
      label: 'No related evidence found',
      detail: 'This does not prove the claim is true or false; no active matching record was found.',
      topScore: 0,
    };
  }

  const topScore = scoreOf(matches[0]);
  if (topScore >= 0.85) {
    return {
      status: MEMORY_REVIEW_STATUS.STRONG_MATCH,
      label: 'Strongly related evidence found',
      detail: 'Similarity is not a truth verdict. Review the record and its source range before changing anything.',
      topScore,
    };
  }

  return {
    status: MEMORY_REVIEW_STATUS.RELATED,
    label: 'Related evidence found',
    detail: 'The claim has nearby memory records, but Storyhold has not judged them true or false.',
    topScore,
  };
}

/** Builds a serializable, read-only review model for the UI and tests. */
export function buildMemoryReview({
  mode = MEMORY_REVIEW_MODES.QUERY,
  query = '',
  results = [],
  totalRecords = null,
  stage = null,
  diagnostics = null,
} = {}) {
  const safeMode = mode === MEMORY_REVIEW_MODES.CHALLENGE
    ? MEMORY_REVIEW_MODES.CHALLENGE
    : MEMORY_REVIEW_MODES.QUERY;
  const safeResults = Array.isArray(results) ? results.slice() : [];
  const split = splitMemoryReviewResults(safeResults);
  return {
    mode: safeMode,
    query: String(query ?? '').trim(),
    results: safeResults,
    visible: split.visible,
    spoiler: split.spoiler,
    totalRecords,
    stage,
    diagnostics,
    challenge: safeMode === MEMORY_REVIEW_MODES.CHALLENGE
      ? classifyMemoryChallenge(query, safeResults)
      : null,
  };
}
