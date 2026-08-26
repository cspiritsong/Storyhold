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

export const MEMORY_CHALLENGE_VERDICTS = Object.freeze({
  SUPPORTED: 'supported',
  CONTRADICTED: 'contradicted',
  UNRESOLVED: 'unresolved',
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
  reason = null,
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
      message = `${label} cancelled${reason ? ` — ${reason}` : ''}. No memory was changed.`;
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
  adjudication = null,
  blocked = null,
} = {}) {
  const safeMode = mode === MEMORY_REVIEW_MODES.CHALLENGE
    ? MEMORY_REVIEW_MODES.CHALLENGE
    : MEMORY_REVIEW_MODES.QUERY;
  const safeResults = Array.isArray(results) ? results.slice() : [];
  const split = splitMemoryReviewResults(safeResults);
  const safeBlocked = blocked && typeof blocked === 'object'
    ? {
        reason: String(blocked.reason ?? '').trim(),
        nextStep: String(blocked.nextStep ?? '').trim(),
      }
    : null;
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
    adjudication: adjudication && typeof adjudication === 'object' ? adjudication : null,
    blocked: safeBlocked,
  };
}

/**
 * Normalizes a model adjudication result into a safe verdict, explanation, and
 * citation list. Unknown verdicts collapse to unresolved; citations outside the
 * supplied record set are dropped so a model can never cite memory it was not
 * shown.
 * @param {object} result
 * @param {Set<string>} [options.allowedRecordIds]
 */
export function parseChallengeAdjudication(result = {}, { allowedRecordIds = null } = {}) {
  const verdict = String(result?.verdict ?? '').trim().toLowerCase();
  const normalizedVerdict = Object.values(MEMORY_CHALLENGE_VERDICTS).includes(verdict)
    ? verdict
    : MEMORY_CHALLENGE_VERDICTS.UNRESOLVED;

  const explanation = String(result?.explanation ?? '').trim() || 'No explanation was provided.';

  const rawCitations = Array.isArray(result?.citations) ? result.citations : [];
  const seen = new Set();
  const citations = [];
  for (const citation of rawCitations) {
    const id = String(citation ?? '').trim();
    if (!id || seen.has(id)) continue;
    if (allowedRecordIds && !allowedRecordIds.has(id)) continue;
    seen.add(id);
    citations.push(id);
  }

  return { verdict: normalizedVerdict, explanation, citations };
}

/**
 * Builds a read-only adjudication prompt. The model must decide whether the
 * claim is supported, contradicted, or unresolved from the supplied memory and
 * source excerpts, and may cite only the record ids it was actually shown.
 */
export function buildChallengePrompt({ claim = '', evidence = [], sources = [] } = {}) {
  const claimText = String(claim ?? '').trim();
  const evidenceLines = (Array.isArray(evidence) ? evidence : [])
    .map((record) => `[${record?.id ?? '?'}] ${String(record?.content ?? '').trim()}`)
    .filter((line) => line.trim());
  const sourceLines = (Array.isArray(sources) ? sources : [])
    .map((source) => `[${source?.id ?? '?'}]${Number.isInteger(source?.index) ? ` (source ${source.index})` : ''} ${String(source?.excerpt ?? '').trim()}`)
    .filter((line) => line.trim());

  return [
    'Role: memory challenge adjudicator.',
    'Decide whether the player claim is supported, contradicted, or unresolved by the evidence below.',
    'Respond with JSON only: {"verdict":"supported|contradicted|unresolved","explanation":"...","citations":["recordId", ...]}.',
    'Cite only record ids shown below. Never invent evidence.',
    '<claim>',
    claimText || '(empty)',
    '</claim>',
    '<memory>',
    evidenceLines.length > 0 ? evidenceLines.join('\n') : '(no matching stored memory)',
    '</memory>',
    '<source_excerpts>',
    sourceLines.length > 0 ? sourceLines.join('\n') : '(no source excerpts)',
    '</source_excerpts>',
  ].join('\n');
}

/** Parses a raw model response into an object, tolerating fenced or trailing prose. */
export function parseChallengeResponse(raw) {
  if (typeof raw !== 'string') return {};
  let source = raw.trim();
  source = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolves the raw chat excerpts a record was derived from. Returns a compact
 * list of `{ id, index, excerpt }` using the record's source range, falling
 * back to its provenance source-message index ranges.
 */
export function resolveRecordSources(record = {}, chat = []) {
  const messages = Array.isArray(chat) ? chat : [];
  const id = record?.id ?? null;
  const out = [];

  const range = record?.sourceRange ?? record?.source_range ?? null;
  if (range && Number.isInteger(range.start) && Number.isInteger(range.end)) {
    let excerpt;
    if (range.kind === 'mesId') {
      excerpt = messages
        .filter((m) => typeof m?.mesId === 'number' && m.mesId >= range.start && m.mesId <= range.end)
        .map((m) => String(m?.mes ?? ''))
        .filter(Boolean)
        .join(' ');
    } else {
      excerpt = messages
        .slice(range.start, range.end + 1)
        .map((m) => String(m?.mes ?? ''))
        .filter(Boolean)
        .join(' ');
    }
    if (excerpt) out.push({ id, index: range.start, excerpt });
  }

  if (out.length === 0) {
    const provenance = record?.provenance?.source_messages;
    if (Array.isArray(provenance)) {
      for (const pair of provenance) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const start = Number(pair[0]);
        const end = Number(pair[1]);
        if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;
        const excerpt = messages
          .slice(start, end + 1)
          .map((m) => String(m?.mes ?? ''))
          .filter(Boolean)
          .join(' ');
        if (excerpt) out.push({ id, index: start, excerpt });
      }
    }
  }

  return out;
}
