/**
 * Single-extension runtime pipeline.
 *
 * The event shell supplies one canonical transcript window. This module fans it
 * out to the embedded narrative chain and one combined structured projector,
 * while the ingest queue owns idempotency and retry state. It intentionally has
 * no compaction, canon, scene-prose, or foreign-extension hooks.
 */

import { createIngestQueue } from './ingest-queue.js';
import { createNarrativeState, ingestNarrativeBatch } from './narrative-chain.js';

function narrativeText(window) {
  return (window.messages ?? [])
    .filter((message) => message?.mes && !message.is_system)
    .map((message) => `${message.is_user ? 'Player' : 'Assistant'}: ${String(message.mes).trim()}`)
    .join('\n');
}

function resultRecords(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.records)) return result.records;
  return [];
}

function narrativeRecords(state, window) {
  return state.layers
    .flatMap((layer) => layer ?? [])
    .filter((snippet) => snippet?.window_id === window.window_id && snippet.text)
    .map((snippet) => ({
      id: snippet.id,
      kind: 'narrative_delta',
      content: snippet.text,
      source_range: snippet.source_range ?? window.source_range,
      provenance: {
        source_chat_uid: window.chat_uid,
        source_messages: snippet.source_range?.kind === 'mesId'
          ? [snippet.source_range.start, snippet.source_range.end]
          : [],
        source_kind: 'raw-jsonl',
      },
    }));
}

/**
 * Creates the product pipeline. `extractStructured` is the one combined
 * Smart-Memory extraction callback; its implementation may use the existing
 * parser/model layer, but this orchestrator will invoke it once per window.
 */
export function createRuntimePipeline({
  loadIngest,
  saveIngest,
  loadNarrative,
  saveNarrative,
  summarizeNarrative,
  extractStructured,
  applyStructured = null,
  narrativeSettings = null,
  now = () => Date.now(),
} = {}) {
  if (
    typeof loadIngest !== 'function' ||
    typeof saveIngest !== 'function' ||
    typeof loadNarrative !== 'function' ||
    typeof saveNarrative !== 'function'
  ) {
    throw new TypeError('runtime pipeline requires ingest and narrative load/save functions');
  }
  if (typeof summarizeNarrative !== 'function') {
    throw new TypeError('runtime pipeline requires summarizeNarrative');
  }
  if (typeof extractStructured !== 'function') {
    throw new TypeError('runtime pipeline requires extractStructured');
  }
  if (applyStructured !== null && typeof applyStructured !== 'function') {
    throw new TypeError('applyStructured must be a function when provided');
  }

  const projectors = {
    narrative: async (window, context = {}) => {
      const prior = (await loadNarrative(window)) ?? createNarrativeState(
        context.narrativeSettings ?? narrativeSettings,
      );
      const result = await ingestNarrativeBatch(prior, {
        window_id: window.window_id,
        source_range: window.source_range,
        fingerprint: window.fingerprint,
        story_text: context.narrativeText ?? narrativeText(window),
        summarize: async (request) =>
          summarizeNarrative({ ...request, sourceWindowId: window.window_id, window }),
        now,
      });
      if (result.failed) throw new Error(result.error ?? result.reason ?? 'narrative ingest failed');
      if (context.shouldAbort?.()) throw new Error('runtime pipeline aborted');
      if (result.changed) await saveNarrative(window, result.state);
      return narrativeRecords(result.state, window);
    },

    structured: async (window, context = {}) => {
      const extracted = await extractStructured({
        window,
        priorState: context.structuredState ?? null,
        sourceWindowId: window.window_id,
      });
      if (context.shouldAbort?.()) throw new Error('runtime pipeline aborted');
      const applied = applyStructured
        ? await applyStructured(extracted, { window, context })
        : extracted;
      return resultRecords(applied);
    },
  };

  const queue = createIngestQueue({
    load: loadIngest,
    save: saveIngest,
    projectors,
    now,
  });

  return {
    async ingest(window, context = {}) {
      return queue.ingest(window, {
        ...context,
        narrativeText: context.narrativeText ?? narrativeText(window),
      });
    },
  };
}

export { narrativeText };
