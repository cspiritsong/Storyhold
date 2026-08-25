/**
 * Storyhold - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/Smart-Memory
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Semantic embedding support for memory deduplication and supersession detection.
 *
 * Supports two embedding sources: Ollama (/api/embed) and any OpenAI-compatible
 * endpoint (/v1/embeddings). Cosine similarity between vectors catches near-paraphrase
 * duplicates that word-overlap (Jaccard) misses - e.g. "Finn is Senjin's anchor" vs
 * "Finn serves as Senjin's emotional foundation" score near-zero in Jaccard but
 * ~0.92 in cosine space.
 *
 * Falls back to Jaccard automatically when embeddings are disabled, the model
 * is not available, or the API call fails - so the system degrades gracefully
 * for users who have not configured an embedding source.
 *
 * getEmbeddingBatch        - fetches vectors for multiple texts in one API call
 * cosineSimilarity         - re-exported from similarity.js for callers that import here
 * batchVerify              - compares candidates against existing memories; returns
 *                            passed (new), superseded (pattern-confirmed updates),
 *                            uncertain (same-topic pairs for model confirmation), and
 *                            rejected (duplicates)
 * clearEmbeddingCache      - clears the in-session cache (call on chat change)
 * hasEmbeddingFailed       - returns true when an embedding call has failed this session
 * clearEmbeddingFailed     - resets the failure flag (call when the user re-enables or reconfigures)
 * getHardwareProfile       - returns the active hardware profile ('a' or 'b')
 * saveEmbeddingApiKey - writes the API key to extension_settings
 * hasEmbeddingApiKey  - returns true when an API key is configured
 */

import { extension_settings } from '../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { MODULE_NAME } from './constants.js';
import {
  getDefaultEmbeddingModel,
  getEmbeddingSourceDefinition,
  requestEmbeddingBatch,
} from './embedding-providers.js';
import { memory_sources } from './generate.js';
import { cosineSimilarity, jaccardSimilarity, hasStateChangeMarker } from './similarity.js';

// In-session embedding cache: provider/model/endpoint/input-type scope -> vector.
// Embeddings are deterministic for a given text + embedding configuration, so
// caching within a session avoids redundant API calls during catch-up mode.
// Cleared on chat change.
const embeddingCache = new Map();

// Tracks whether the user has already been warned about an embedding failure
// this session so we don't spam a toastr on every extraction pass.
let embeddingWarnedThisSession = false;

function normalizeEmbeddingText(value) {
  return String(value || '').trim();
}

function isEmbeddingVector(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((number) => typeof number === 'number' && Number.isFinite(number))
  );
}

/**
 * Returns the active model for a provider, including the per-source model map
 * introduced with provider parity. The legacy embedding_model field remains
 * authoritative for the currently selected source when no map entry exists.
 * @param {string} source
 * @param {object} [settings]
 * @returns {string}
 */
export function getEmbeddingModelForSource(
  source,
  settings = extension_settings[MODULE_NAME] ?? {},
) {
  const mapped = settings.embedding_models?.[source];
  if (typeof mapped === 'string' && mapped.trim()) return mapped.trim();

  const activeSource = settings.embedding_source ?? 'ollama';
  if (source === activeSource && typeof settings.embedding_model === 'string') {
    const activeModel = settings.embedding_model.trim();
    if (activeModel) return activeModel;
  }

  return getDefaultEmbeddingModel(source);
}

/**
 * Returns the API key for one provider without falling back to another
 * provider's credential. The legacy field is used only for the active source
 * so older installations remain compatible during migration.
 * @param {string} source
 * @param {object} [settings]
 * @returns {string}
 */
export function getEmbeddingApiKeyForSource(
  source,
  settings = extension_settings[MODULE_NAME] ?? {},
) {
  const mapped = settings.embedding_api_keys?.[source];
  if (typeof mapped === 'string' && mapped.trim()) return mapped.trim();

  const activeSource = settings.embedding_source ?? 'ollama';
  if (source === activeSource && typeof settings.embedding_api_key === 'string') {
    return settings.embedding_api_key.trim();
  }

  return '';
}

function embeddingCacheKey(text, source, model, settings, inputType = '') {
  return [
    source,
    model,
    settings.embedding_url ?? '',
    settings.embedding_account_id ?? '',
    settings.embedding_vertex_region ?? '',
    settings.embedding_vertex_project_id ?? '',
    settings.embedding_siliconflow_endpoint ?? '',
    inputType,
    text,
  ].join('\u001f');
}

async function getRuntimeEmbeddingBatch(source, texts, model) {
  if (source === 'transformers') {
    throw new Error(
      'Local (Transformers) is server-side in SillyTavern and is not exposed to third-party extensions',
    );
  }

  if (source !== 'webllm') {
    throw new Error(`Unsupported runtime embedding source: ${source}`);
  }

  if (!model) throw new Error('WebLLM embedding model is not configured');

  const llm = globalThis.SillyTavern?.llm;
  if (!llm || typeof llm.getEngine !== 'function') {
    throw new Error('WebLLM extension is not installed');
  }

  const engine = llm.getEngine();
  if (
    !engine ||
    typeof engine.loadModel !== 'function' ||
    typeof engine.generateEmbedding !== 'function'
  ) {
    throw new Error('Installed WebLLM extension does not support embeddings');
  }

  await engine.loadModel(model);
  const vectors = await engine.generateEmbedding(texts);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error('WebLLM returned an invalid embedding response');
  }
  return vectors;
}

function warnEmbeddingFailure(source, error) {
  if (error?.message) console.warn(`[Storyhold] ${source} embedding failed: ${error.message}`);
  if (embeddingWarnedThisSession) return;

  embeddingWarnedThisSession = true;
  const label = (() => {
    try {
      return getEmbeddingSourceDefinition(source).label;
    } catch {
      return 'Embedding provider';
    }
  })();
  toastr?.warning(
    `${label} unavailable - falling back to keyword matching. Check the provider settings.`,
    'Storyhold',
    { timeOut: 8000 },
  );
}

/**
 * Fetches embedding vectors for a list of texts in one or more provider calls.
 * Texts already in the cache are not re-fetched. Returns a Map from normalized
 * text to vector. Any text that fails (bad response, network error) is absent
 * from the returned Map and callers fall back to Jaccard.
 *
 * Cohere receives separate query/document batches when queryTexts is supplied,
 * matching SillyTavern Vector Storage's input_type contract.
 *
 * @param {string[]} texts
 * @param {{queryTexts?: string[]}} [options]
 * @returns {Promise<Map<string, number[]>>}
 */
export async function getEmbeddingBatch(texts, { queryTexts = [] } = {}) {
  const settings = extension_settings[MODULE_NAME] ?? {};
  const result = new Map();

  if (!settings.embedding_enabled || !Array.isArray(texts) || texts.length === 0) return result;

  const normalized = texts.map(normalizeEmbeddingText).filter(Boolean);
  if (normalized.length === 0) return result;

  const source = settings.embedding_source ?? 'ollama';
  const queryTextSet = new Set((Array.isArray(queryTexts) ? queryTexts : []).map(normalizeEmbeddingText));
  let definition;
  let model;
  const apiKey = getEmbeddingApiKeyForSource(source, settings);
  try {
    definition = getEmbeddingSourceDefinition(source);
    model = getEmbeddingModelForSource(source, settings);
  } catch (error) {
    warnEmbeddingFailure(source, error);
    return result;
  }

  // Group uncached texts by Cohere's query/document mode. Other providers use
  // one group because they accept the same request shape for both roles.
  const groups = new Map();
  for (const text of normalized) {
    const inputType =
      source === 'cohere'
        ? queryTextSet.has(text)
          ? 'search_query'
          : 'search_document'
        : '';
    const cacheKey = embeddingCacheKey(text, source, model, settings, inputType);
    if (embeddingCache.has(cacheKey)) {
      result.set(text, embeddingCache.get(cacheKey));
      continue;
    }

    const groupKey = inputType || 'default';
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ text, cacheKey });
  }

  if (groups.size === 0) return result;

  const customUrlSources = new Set([
    'openai_compatible',
    'ollama',
    'extras',
    'llamacpp',
    'vllm',
    'koboldcpp',
  ]);

  try {
    for (const [inputType, items] of groups) {
      const groupTexts = items.map((item) => item.text);
      const vectors =
        definition.kind === 'runtime'
          ? await getRuntimeEmbeddingBatch(source, groupTexts, model)
          : await requestEmbeddingBatch(
              source,
              {
                texts: groupTexts,
                model,
                url: customUrlSources.has(source) ? settings.embedding_url : '',
                apiKey,
                keep: settings.embedding_keep ?? false,
                inputType: inputType || undefined,
                accountId: settings.embedding_account_id,
                vertexRegion: settings.embedding_vertex_region,
                vertexProjectId: settings.embedding_vertex_project_id,
                siliconflowEndpoint: settings.embedding_siliconflow_endpoint,
                headers: source === 'koboldcpp' ? getRequestHeaders() : undefined,
              },
              fetch,
            );

      if (!Array.isArray(vectors) || vectors.length !== items.length) {
        throw new Error(`${definition.label} returned an unexpected number of embeddings`);
      }

      for (let i = 0; i < items.length; i++) {
        const vector = vectors[i];
        if (!isEmbeddingVector(vector)) {
          throw new Error(`${definition.label} returned an invalid embedding`);
        }
        embeddingCache.set(items[i].cacheKey, vector);
        result.set(items[i].text, vector);
      }
    }
  } catch (error) {
    // Network error, missing credentials, model not found, server not running -
    // callers fall back to Jaccard. Warn once per session so the user knows
    // deduplication quality is degraded.
    warnEmbeddingFailure(source, error);
  }

  return result;
}

// cosineSimilarity, jaccardSimilarity, STATE_CHANGE_PATTERNS, and hasStateChangeMarker
// live in similarity.js (no ST runtime deps) so unit tests can load embeddings
// consumers without pulling in extensions.js. Re-exported here for callers that
// already import from embeddings.js.
export { cosineSimilarity } from './similarity.js';

/**
 * Writes the embedding API key to extension_settings.
 * @param {string} value
 * @param {string} [source] Provider source to associate with the key
 */
export function saveEmbeddingApiKey(
  value,
  source = extension_settings[MODULE_NAME]?.embedding_source ?? 'ollama',
) {
  const settings = extension_settings[MODULE_NAME];
  const apiKey = String(value ?? '');
  settings.embedding_api_key = apiKey;
  settings.embedding_api_keys = {
    ...(settings.embedding_api_keys ?? {}),
    [source]: apiKey,
  };
  saveSettingsDebounced();
}

/**
 * Returns true when an embedding API key is configured.
 * @returns {boolean}
 */
export function hasEmbeddingApiKey(source = extension_settings[MODULE_NAME]?.embedding_source ?? 'ollama') {
  return !!getEmbeddingApiKeyForSource(source);
}

/**
 * Returns true if an embedding API call has failed at least once this session.
 * Used by the UI to show a persistent warning when embeddings are silently
 * falling back to keyword matching.
 * @returns {boolean}
 */
export function hasEmbeddingFailed() {
  return embeddingWarnedThisSession;
}

/**
 * Resets the embedding failure flag. Call when the user re-enables embeddings
 * or changes the URL/model so the next call gets a fresh chance.
 */
export function clearEmbeddingFailed() {
  embeddingWarnedThisSession = false;
}

/**
 * Returns the active hardware profile: 'a' (local/low-VRAM) or 'b' (hosted).
 *
 * Auto-detects from the configured memory source:
 *   - ollama or webllm -> Profile A
 *   - main or openai_compatible -> Profile B
 *
 * Can be overridden by the user in settings (hardware_profile: 'a' | 'b').
 *
 * Defined here (rather than index.js) so all modules can import it without
 * creating circular dependencies.
 *
 * @returns {'a'|'b'}
 */
export function getHardwareProfile() {
  const s = extension_settings[MODULE_NAME] ?? {};
  const override = s.hardware_profile ?? 'auto';
  if (override === 'a') return 'a';
  if (override === 'b') return 'b';
  const source = s.source ?? memory_sources.main;
  return source === memory_sources.ollama || source === memory_sources.webllm ? 'a' : 'b';
}

/**
 * Batch-verifies a list of candidate memories against existing memories,
 * classifying each candidate into one of three buckets:
 *
 *   passed     - genuinely new information, should be added
 *   superseded - same topic as an existing memory but state has changed;
 *                the existing memory should be retired and this one added
 *   (neither)  - near-duplicate with no state change; silently dropped
 *
 * All unique texts are embedded in a single API call, then cosine similarity
 * is computed locally. Falls back to Jaccard when embeddings are unavailable.
 *
 * Supersession heuristic (Profile A - no model call):
 *   When a candidate scores above the "same-topic" lower threshold against an
 *   existing memory of the same type, AND the candidate text contains a
 *   state-change marker (e.g. "no longer", "moved to", "became"), it is
 *   classified as superseding the best-matching existing memory rather than
 *   being rejected as a duplicate.
 *
 * Thresholds (semantic / Jaccard fallback):
 *   duplicate threshold  0.82 / 0.65  - above this, same-type = duplicate
 *   same-topic threshold 0.55 / 0.40  - above this, same-topic check applies
 *   cross-type duplicate 0.88 / 0.75
 *
 * @param {Array<{content: string, type: string, id?: string}>} candidates
 * @param {Array<{content: string, type: string, id?: string}>} existing
 * @returns {Promise<{passed: Set<string>, superseded: Map<string, string>, confirmed: Set<string>, uncertain: Array, semantic: boolean}>}
 *   passed     - Set of candidate content strings (lowercase) that are new
 *   superseded - Map from candidate content string to the id of the existing
 *                memory it replaces (only present when ex.id is available)
 *   confirmed  - Set of existing memory ids that were re-extracted this pass
 *                (duplicate candidate matched them, confirming they are still true)
 *   uncertain  - Pairs that scored above the same-topic threshold but had no
 *                state-change pattern; the caller should run a model confirmation
 *                call (method B) for each before deciding
 *                Each entry: { candText, candObj, existingId, existingContent, score }
 *   semantic   - true if cosine similarity was used, false if Jaccard
 */
export async function batchVerify(candidates, existing) {
  const passed = new Set();
  const superseded = new Map(); // candContent -> existingId
  const confirmed = new Set(); // existingId -> confirmed this extraction pass
  const uncertain = []; // pairs for model confirmation (B)
  if (!candidates || candidates.length === 0)
    return { passed, superseded, confirmed, uncertain, semantic: false };

  // Embed all unique texts in one call.
  const allTexts = [
    ...candidates.map((m) =>
      String(m.content || '')
        .toLowerCase()
        .trim(),
    ),
    ...existing.map((m) =>
      String(m.content || '')
        .toLowerCase()
        .trim(),
    ),
  ];
  const vectorMap = await getEmbeddingBatch(allTexts);
  const anyEmbeddings = vectorMap.size > 0;

  // Hoist the profile lookup: it can't change mid-pass and calling it inside
  // the inner loop is pure overhead proportional to candidates * existing.
  const profile = getHardwareProfile();

  for (const cand of candidates) {
    const candText = String(cand.content || '')
      .toLowerCase()
      .trim();
    const candVec = anyEmbeddings ? (vectorMap.get(candText) ?? null) : null;
    const candHasStateChange = hasStateChangeMarker(candText);

    let isDuplicate = false;
    let confirmedId = null; // id of the existing memory being confirmed by this duplicate
    let bestSupersessionScore = 0;
    let bestSupersessionId = null;
    // Best same-type pair above the same-topic threshold that had no pattern match.
    // Collected so the caller can run a model confirmation call (B) if needed.
    let bestUncertainScore = 0;
    let bestUncertainId = null;
    let bestUncertainContent = null;

    for (const ex of existing) {
      const exText = String(ex.content || '')
        .toLowerCase()
        .trim();
      const exVec = anyEmbeddings ? (vectorMap.get(exText) ?? null) : null;

      // Choose scoring method and thresholds. Fall back to Jaccard with its
      // own thresholds when either vector is missing - mixing methods and
      // thresholds produces wrong results.
      //
      // Profile B (hosted) uses slightly higher dup thresholds so nuanced
      // memories from powerful models are less likely to be incorrectly
      // rejected as duplicates of semantically adjacent but distinct facts.
      // Profile B also uses a lower same-topic threshold to catch more
      // supersession candidates, since hosted models write more varied prose.
      let score, dupThreshold, crossDupThreshold, sameTopicThreshold;
      if (candVec && exVec) {
        score = cosineSimilarity(candVec, exVec);
        if (profile === 'b') {
          dupThreshold = 0.85;
          crossDupThreshold = 0.91;
          sameTopicThreshold = 0.52;
        } else {
          dupThreshold = 0.82;
          crossDupThreshold = 0.88;
          sameTopicThreshold = 0.55;
        }
      } else {
        score = jaccardSimilarity(candText, exText);
        if (profile === 'b') {
          dupThreshold = 0.68;
          crossDupThreshold = 0.78;
          sameTopicThreshold = 0.38;
        } else {
          dupThreshold = 0.65;
          crossDupThreshold = 0.75;
          sameTopicThreshold = 0.4;
        }
      }

      const isSameType = ex.type === cand.type;
      const effectiveDupThreshold = isSameType ? dupThreshold : crossDupThreshold;

      if (score >= effectiveDupThreshold) {
        // High similarity: would normally be a duplicate. If the candidate
        // contains a state-change marker it is superseding this fact instead.
        // Without a pattern, mark as uncertain so B can make the call.
        // Exception: if the content is identical after normalization, always
        // treat as a duplicate - a memory cannot supersede itself.
        const contentIdentical = candText === exText;
        if (isSameType && ex.id && !contentIdentical) {
          if (candHasStateChange && score > bestSupersessionScore) {
            bestSupersessionScore = score;
            bestSupersessionId = ex.id;
          } else if (!candHasStateChange && score > bestUncertainScore) {
            bestUncertainScore = score;
            bestUncertainId = ex.id;
            bestUncertainContent = ex.content;
          }
        } else {
          isDuplicate = true;
          confirmedId = ex.id ?? null;
          break;
        }
      } else if (isSameType && score >= sameTopicThreshold && ex.id) {
        if (candHasStateChange && score > bestSupersessionScore) {
          // Medium similarity on same topic + state-change marker: likely supersession.
          bestSupersessionScore = score;
          bestSupersessionId = ex.id;
        } else if (!candHasStateChange && score > bestUncertainScore) {
          // Same topic, no pattern - let B decide.
          bestUncertainScore = score;
          bestUncertainId = ex.id;
          bestUncertainContent = ex.content;
        }
      }
    }

    if (isDuplicate) {
      // The candidate matched an existing memory - that memory is confirmed still true.
      if (confirmedId) confirmed.add(confirmedId);
      continue; // silently drop the candidate
    }

    if (bestSupersessionId !== null) {
      // Pattern confirmed supersession.
      superseded.set(candText, bestSupersessionId);
      passed.add(candText);
    } else {
      passed.add(candText);
      // Queue for model confirmation if there was a same-topic pair with no pattern.
      if (bestUncertainId !== null) {
        uncertain.push({
          candText,
          candObj: cand,
          existingId: bestUncertainId,
          existingContent: bestUncertainContent,
          score: bestUncertainScore,
        });
      }
    }
  }

  return { passed, superseded, confirmed, uncertain, semantic: anyEmbeddings };
}

/**
 * Clears the in-session embedding cache.
 * Called on CHAT_CHANGED / CHAT_LOADED to prevent unbounded memory growth.
 */
export function clearEmbeddingCache() {
  embeddingCache.clear();
}
