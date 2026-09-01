/**
 * Deterministic transcript grounding helpers.
 *
 * Model output is candidate input, never a truth oracle. These pure functions
 * let admission and ingest check a candidate against the actual source window
 * without another API call: lexical evidence overlap (does the text have any
 * grounding in the window at all?) and message coverage (which window
 * messages did the derived records fail to mention?).
 *
 * The concept is borrowed from community summarizer workflows; the
 * implementation here is original and window-scoped to Storyhold's ingest
 * contract. No SillyTavern runtime dependency.
 */

/** Minimum candidate token length considered for evidence overlap. */
const EVIDENCE_MIN_TOKEN_LENGTH = 4;
/** A candidate with fewer than this many evidence tokens is not judged. */
const EVIDENCE_MIN_CANDIDATE_TOKENS = 4;
/** Below this overlap ratio, a candidate counts as ungrounded. */
const EVIDENCE_OVERLAP_THRESHOLD = 0.2;
/** Below this overlap ratio, an input message counts as uncovered. */
const COVERAGE_THRESHOLD = 0.15;
/** Messages with fewer evidence tokens are never judged for coverage. */
const COVERAGE_MIN_MESSAGE_TOKENS = 3;

function tokenizeEvidence(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= EVIDENCE_MIN_TOKEN_LENGTH),
  );
}

function overlapRatio(tokens, pool) {
  if (tokens.length === 0 || pool.size === 0) return 0;
  const overlap = tokens.filter((token) => pool.has(token)).length;
  return overlap / tokens.length;
}

/** True when the candidate text has too little lexical overlap with evidence. */
export function isUngroundedText(content, evidenceText) {
  const pool = tokenizeEvidence(evidenceText);
  if (pool.size === 0) return false; // no evidence available; never reject
  const tokens = [...tokenizeEvidence(content)];
  if (tokens.length < EVIDENCE_MIN_CANDIDATE_TOKENS) return false; // too short to judge
  return overlapRatio(tokens, pool) < EVIDENCE_OVERLAP_THRESHOLD;
}

/**
 * Deterministic hygiene for text sent to models. SillyTavern messages carry
 * rendering HTML, code fences, and reasoning-model artifacts that waste
 * prompt tokens and pollute extraction. This cleans ONLY the text passed to
 * a model call; the stored raw transcript is never rewritten.
 */
export function cleanMessageText(text) {
  let value = String(text ?? '');
  if (!value.trim()) return '';
  value = value.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking\s*>/gi, ' ');
  value = value.replace(/```[^\n]*\n[\s\S]*?```/g, ' ');
  value = value.replace(/<[^>]+>/g, ' ');
  return value
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Evidence text for one ingest window: the real transcript content, cleaned
 * for model consumption, with system messages and blanks removed. Kept
 * separate from the narrative text builder so grounding does not depend on
 * speaker labels.
 */
export function windowEvidenceText(window) {
  return (window?.messages ?? [])
    .filter((message) => message?.mes && !message.is_system)
    .map((message) => cleanMessageText(message.mes))
    .filter(Boolean)
    .join('\n');
}

/**
 * Which window messages are not represented in the derived records at all?
 * Purely lexical and deterministic: same inputs always produce the same
 * report, so it is safe to persist on ingest state. System messages and
 * very short replies are never counted as uncovered.
 */
export function analyzeMessageCoverage(messages = [], records = []) {
  const pool = new Set();
  for (const record of records ?? []) {
    for (const token of tokenizeEvidence(record?.content)) pool.add(token);
  }

  const uncovered = [];
  let checked = 0;
  for (const message of messages ?? []) {
    if (!message?.mes || message.is_system) continue;
    const tokens = [...tokenizeEvidence(message.mes)];
    if (tokens.length < COVERAGE_MIN_MESSAGE_TOKENS) continue;
    checked += 1;
    const ratio = pool.size === 0 ? 0 : overlapRatio(tokens, pool);
    if (ratio >= COVERAGE_THRESHOLD) continue;
    uncovered.push({
      mesId: Number.isInteger(message.mesId) ? message.mesId : null,
      name: message.name ?? null,
      preview: String(message.mes).replace(/\s+/g, ' ').trim().slice(0, 150),
      coverageRatio: Math.round(ratio * 100) / 100,
    });
  }

  return {
    checked,
    covered: checked - uncovered.length,
    uncovered_count: uncovered.length,
    uncovered,
  };
}
