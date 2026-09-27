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

/**
 * Builds the compact narrative-state prompt for Product mode.
 *
 * Enforces causal order, emotional meaning, distinct story chronology vs transcript order,
 * preserved relative/unknown time without invented dates, labeled non-fact modalities
 * (backstory, flashback, hypothetical, rumor), and explicit return to the current scene.
 */
export function buildProductNarrativePrompt(storyText, contextText) {
  return [
    'Role: precise narrative-state tracker.',
    'Summarize only the new narrative delta needed to continue the prior context.',
    'Preserve causal order, decisions, motivations, emotional changes, relationship dynamics, and unresolved tension.',
    'Keep transcript order distinct from story chronology: label backstory and flashbacks as prior story time, and state any return to the current scene explicitly.',
    'Preserve unknown or relative timing verbatim without inventing exact dates or calendar timestamps.',
    'Label hypothetical futures, plans, rumors, suspicions, and unverified claims in prose rather than stating them as fact.',
    'Do not repeat prior context, invent connective events, or add unsupported drama. Return one compact line.',
    '<prior_context>',
    contextText || '(none yet)',
    '</prior_context>',
    '<new_passage>',
    storyText || '',
    '</new_passage>',
  ].join('\n');
}

/**
 * Production-owned self-contained transport seam for memory summarization.
 *
 * Product self-contained mode sends exactly one user message and requires
 * instructOverride: true on the main generateRaw route, while delegating to
 * effective main budget policy and leaving direct-source budgets unchanged.
 */
export async function runSelfContainedMemorySummarizeTransport(
  { source, quietPrompt, responseLength, effectiveMainResponseLength },
  deps = {},
) {
  const promptMessage = [{ role: 'user', content: quietPrompt }];

  if (source === 'main') {
    return await deps.generateRaw({
      prompt: promptMessage,
      instructOverride: true,
      quietToLoud: false,
      responseLength: effectiveMainResponseLength,
    });
  }

  if (source === 'webllm') {
    if (typeof deps.isWebLlmSupported === 'function' && !deps.isWebLlmSupported()) {
      return await deps.generateRaw({
        prompt: promptMessage,
        instructOverride: true,
        quietToLoud: false,
        responseLength: effectiveMainResponseLength,
      });
    }
    return await deps.generateWebLlmChatPrompt(promptMessage, { max_tokens: responseLength });
  }

  if (typeof deps.executeDirectSource === 'function') {
    return await deps.executeDirectSource(source, quietPrompt, { responseLength });
  }

  switch (source) {
    case 'ollama':
      return await deps.generateOllamaChat(quietPrompt, { responseLength });
    case 'openai_compatible':
      return await deps.generateOpenAiCompatibleChat(quietPrompt, { responseLength });
    case 'connection_profile':
      return await deps.generateConnectionProfileChat(quietPrompt, { responseLength });
    default:
      throw new Error(`Unsupported memory source: ${source}`);
  }
}
