/**
 * Response-budget rules for background memory generations.
 *
 * Thinking models spend part of max output on hidden reasoning. A tier's visible
 * answer length is therefore not always a sufficient total response budget.
 */

export const THINKING_RESPONSE_FLOOR = 8192;

const THINKING_SOURCES = new Set(['makersuite', 'vertexai']);

/** Returns whether a chat-completion model uses Gemini thinking output. */
export function isThinkingChatModel(chatCompletionSource = '', model = '') {
  return (
    THINKING_SOURCES.has(String(chatCompletionSource).trim().toLowerCase()) &&
    /^gemini-(?:2\.5|3(?:\.\d+)?)-(?:flash|pro)/i.test(String(model).trim())
  );
}

/**
 * Returns the total response budget for a background memory call.
 *
 * For Gemini thinking models, reserve a practical minimum for hidden reasoning
 * while retaining the caller's requested visible-output budget. A configured
 * positive global budget remains an upper bound; -1 means no global cap.
 */
export function effectiveMemoryResponseLength(
  requested,
  {
    generationBudget = 8192,
    chatCompletionSource = '',
    model = '',
  } = {},
) {
  const requestedNumber = Number(requested);
  if (!Number.isFinite(requestedNumber) || requestedNumber <= 0) return requested;
  const requestedTokens = Math.max(1, Math.floor(requestedNumber));
  const desired = isThinkingChatModel(chatCompletionSource, model)
    ? Math.max(requestedTokens, THINKING_RESPONSE_FLOOR)
    : requestedTokens;
  const cap = Number(generationBudget);
  if (generationBudget === -1 || !Number.isFinite(cap) || cap <= 0) return desired;
  return Math.max(requestedTokens, Math.min(desired, Math.floor(cap)));
}
