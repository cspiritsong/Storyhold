/**
 * Embedded recursive narrative chain.
 *
 * This is a pure reducer adapted from Summaryception's useful algorithm: recent
 * narrative deltas live in layer 0, older snippets promote into deeper layers,
 * and the assembled narrative is deepest-first. SillyTavern integration,
 * prompt injection, and ghosting are deliberately outside this module.
 */

import { normalizeSourceRange } from './projections.js';
import { hash32 } from './identity.js';

const DEFAULT_SETTINGS = Object.freeze({
  snippetsPerLayer: 20,
  snippetsPerPromotion: 3,
  maxLayers: 5,
});

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, label, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return resolved;
}

function normalizeSettings(settings = {}) {
  const source = settings ?? {};
  return {
    snippetsPerLayer: positiveInteger(
      source.snippetsPerLayer,
      'snippetsPerLayer',
      DEFAULT_SETTINGS.snippetsPerLayer,
    ),
    snippetsPerPromotion: positiveInteger(
      source.snippetsPerPromotion,
      'snippetsPerPromotion',
      DEFAULT_SETTINGS.snippetsPerPromotion,
    ),
    maxLayers: positiveInteger(source.maxLayers, 'maxLayers', DEFAULT_SETTINGS.maxLayers),
  };
}

function ensureState(state = {}) {
  const next = clone(state) ?? {};
  next.schema_version = next.schema_version ?? 1;
  next.settings = normalizeSettings(next.settings);
  next.layers = Array.isArray(next.layers) ? next.layers : [];
  next.processed_windows = Array.isArray(next.processed_windows) ? next.processed_windows : [];
  next.watermark = next.watermark ?? null;
  next.chat_uid = next.chat_uid ?? null;
  next.branch_uid = next.branch_uid ?? null;
  return next;
}

/** Creates a serializable empty narrative-chain state. */
export function createNarrativeState(settings = {}) {
  const source = settings ?? {};
  return {
    schema_version: 1,
    settings: normalizeSettings(source),
    chat_uid: source.chatUid ?? null,
    branch_uid: source.branchUid ?? null,
    layers: [],
    watermark: null,
    processed_windows: [],
  };
}

function layerTexts(state, downToLayer = 0) {
  const parts = [];
  for (let index = state.layers.length - 1; index >= downToLayer; index--) {
    for (const snippet of state.layers[index] ?? []) {
      if (typeof snippet?.text === 'string' && snippet.text.trim()) parts.push(snippet.text.trim());
    }
  }
  return parts;
}

/** Returns the narrative context available to a promotion at a target layer. */
export function buildNarrativeContext(state, downToLayer = 0) {
  const parts = layerTexts(ensureState(state), downToLayer);
  return parts.length > 0 ? parts.join(' ') : '(none yet)';
}

/** Assembles all layers from deepest history to the recent layer-0 deltas. */
export function assembleNarrative(state) {
  const parts = layerTexts(ensureState(state), 0);
  return parts.join(' ');
}

function normalizeWindow({
  window_id,
  source_range,
  fingerprint,
  story_text,
  chat_uid = null,
  branch_uid = null,
} = {}) {
  return {
    window_id: nonEmptyString(window_id, 'window_id'),
    source_range: normalizeSourceRange(source_range),
    fingerprint: nonEmptyString(fingerprint, 'fingerprint'),
    story_text: typeof story_text === 'string' ? story_text.trim() : '',
    chat_uid: chat_uid ?? null,
    branch_uid: branch_uid ?? null,
  };
}

function hasProcessedWindow(state, windowId) {
  return state.processed_windows.some((window) => window?.window_id === windowId);
}

function promotionId(layerIndex, snippets, text) {
  const sourceIds = snippets.map((snippet) => snippet?.id ?? '').join('|');
  return `narrative-promotion:${layerIndex}:${hash32(`${sourceIds}|${text}`)}`;
}

function sourceRanges(snippets) {
  return snippets
    .map((snippet) => snippet?.source_range)
    .filter((range) => range && typeof range === 'object')
    .map((range) => ({ ...range }));
}

/**
 * Promotes overflowing layers transactionally. If a merge summarizer fails,
 * the original state is returned unchanged; seed promotion never calls it.
 */
export async function promoteNarrativeLayers(
  inputState,
  { summarize = null, now = () => Date.now() } = {},
) {
  const original = ensureState(inputState);
  const state = clone(original);
  let changed = false;
  let calls = 0;

  try {
    let layerIndex = 0;
    while (layerIndex < state.settings.maxLayers - 1) {
      const layer = state.layers[layerIndex] ?? [];
      state.layers[layerIndex] = layer;
      if (layer.length <= state.settings.snippetsPerLayer) {
        layerIndex++;
        continue;
      }

      const destination = state.layers[layerIndex + 1] ?? [];
      state.layers[layerIndex + 1] = destination;

      if (destination.length === 0) {
        const seed = layer.shift();
        destination.push({
          ...seed,
          layer: layerIndex + 1,
          promoted: true,
          seed_from_layer: layerIndex,
        });
        changed = true;
        continue;
      }

      if (typeof summarize !== 'function') throw new Error('narrative merge summarizer is required');
      const mergeCount = Math.min(state.settings.snippetsPerPromotion, layer.length);
      const toMerge = layer.slice(0, mergeCount);
      const storyText = toMerge.map((snippet) => snippet.text).join(' ');
      const contextText = buildNarrativeContext(state, layerIndex + 1);
      calls++;
      const summary = await summarize({
        storyText,
        contextText,
        layer: layerIndex + 1,
        promotion: true,
        sourceRanges: sourceRanges(toMerge),
      });
      if (typeof summary !== 'string' || summary.trim() === '') {
        throw new Error('narrative merge summarizer returned an empty result');
      }

      layer.splice(0, mergeCount);
      destination.push({
        id: promotionId(layerIndex + 1, toMerge, summary.trim()),
        text: summary.trim(),
        layer: layerIndex + 1,
        from_layer: layerIndex,
        merged_count: mergeCount,
        source_ranges: sourceRanges(toMerge),
        scope: {
          ...(state.chat_uid != null ? { chat_uid: state.chat_uid } : {}),
          ...(state.branch_uid != null ? { branch_uid: state.branch_uid } : {}),
        },
        timestamp: now(),
      });
      changed = true;
    }
  } catch (error) {
    return {
      state: original,
      changed: false,
      failed: true,
      calls,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { state, changed, failed: false, calls, error: null };
}

/**
 * Ingests one new transcript window into layer 0 and promotes overflow. The
 * source state is never mutated, and replaying the same window is a no-op.
 */
export async function ingestNarrativeBatch(
  inputState,
  { window_id, source_range, fingerprint, story_text, chat_uid = null, branch_uid = null, summarize, now = () => Date.now() } = {},
) {
  const original = ensureState(inputState);
  const window = normalizeWindow({
    window_id,
    source_range,
    fingerprint,
    story_text,
    chat_uid,
    branch_uid,
  });
  if (hasProcessedWindow(original, window.window_id)) {
    return {
      state: original,
      changed: false,
      failed: false,
      skipped: true,
      reason: 'already-processed',
    };
  }
  if (!window.story_text) {
    return {
      state: original,
      changed: false,
      failed: false,
      skipped: true,
      reason: 'empty-window',
    };
  }
  if (typeof summarize !== 'function') {
    return {
      state: original,
      changed: false,
      failed: true,
      skipped: false,
      reason: 'summarizer-missing',
    };
  }

  const state = clone(original);
  if (window.chat_uid != null) state.chat_uid = String(window.chat_uid);
  if (window.branch_uid != null) state.branch_uid = String(window.branch_uid);
  const summary = await summarize({
    storyText: window.story_text,
    contextText: buildNarrativeContext(state, 0),
    layer: 0,
    promotion: false,
    sourceRanges: [window.source_range],
  });
  if (typeof summary !== 'string' || summary.trim() === '') {
    return {
      state: original,
      changed: false,
      failed: true,
      skipped: false,
      reason: 'empty-summary',
    };
  }

  if (!state.layers[0]) state.layers[0] = [];
  state.layers[0].push({
    id: `narrative-window:${window.window_id}`,
    window_id: window.window_id,
    text: summary.trim(),
    layer: 0,
    source_range: window.source_range,
    fingerprint: window.fingerprint,
    scope: {
      ...(window.chat_uid != null ? { chat_uid: String(window.chat_uid) } : {}),
      ...(window.branch_uid != null ? { branch_uid: String(window.branch_uid) } : {}),
    },
    timestamp: now(),
  });
  state.watermark = {
    window_id: window.window_id,
    source_range: window.source_range,
    fingerprint: window.fingerprint,
  };
  state.processed_windows.push({
    window_id: window.window_id,
    source_range: window.source_range,
    fingerprint: window.fingerprint,
  });

  const promotion = await promoteNarrativeLayers(state, { summarize, now });
  if (promotion.failed) {
    // The new layer-0 delta is still valid. Preserve it and report that only
    // the optional compression cascade failed; no source information is lost.
    return {
      state,
      changed: true,
      failed: false,
      promotion_failed: true,
      skipped: false,
      reason: promotion.reason ?? 'promotion-failed',
      error: promotion.error,
    };
  }

  return {
    state: promotion.state,
    changed: true,
    failed: false,
    promotion_failed: false,
    skipped: false,
    reason: null,
  };
}

function snippetRanges(snippet) {
  if (Array.isArray(snippet?.source_ranges) && snippet.source_ranges.length > 0) {
    return snippet.source_ranges;
  }
  return snippet?.source_range ? [snippet.source_range] : [];
}

function rangeWithinPrefix(range, prefixEnd, requireMesIds = false) {
  if (!range || !Number.isInteger(prefixEnd) || prefixEnd < 0) return false;
  if (requireMesIds && range.kind !== 'mesId') return false;
  return (
    (range.kind === 'mesId' || range.kind === 'index') &&
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= prefixEnd
  );
}

function snippetWithinPrefix(snippet, prefixEnd, requireMesIds = false) {
  const ranges = snippetRanges(snippet);
  return ranges.length > 0 && ranges.every((range) => rangeWithinPrefix(range, prefixEnd, requireMesIds));
}

function windowWithinPrefix(window, prefixEnd, requireMesIds = false) {
  return snippetWithinPrefix({ source_range: window?.source_range }, prefixEnd, requireMesIds);
}

/** Copies only narrative layers wholly inside a verified parent prefix. */
export function inheritNarrativePrefix(
  inputState,
  {
    parentChatUid = null,
    branchChatUid,
    branchUid = null,
    parentPrefixEnd,
    requireMesIds = false,
  } = {},
) {
  const original = ensureState(inputState);
  const state = clone(original);
  state.chat_uid = branchChatUid ?? state.chat_uid;
  state.branch_uid = branchUid ?? state.branch_uid;
  state.layers = state.layers.map((layer) =>
    (layer ?? [])
      .filter((snippet) => snippetWithinPrefix(snippet, parentPrefixEnd, requireMesIds))
      .map((snippet) => ({
        ...clone(snippet),
        scope: {
          ...(snippet.scope ?? {}),
          ...(branchChatUid != null ? { chat_uid: String(branchChatUid) } : {}),
          ...(branchUid != null ? { branch_uid: String(branchUid) } : {}),
        },
        inherited: true,
        origin_chat_uid: parentChatUid ?? original.chat_uid ?? null,
      })),
  );
  state.processed_windows = state.processed_windows.filter((window) =>
    windowWithinPrefix(window, parentPrefixEnd, requireMesIds),
  );
  if (!windowWithinPrefix(state.watermark, parentPrefixEnd, requireMesIds)) {
    state.watermark = null;
  }
  return state;
}

/** Removes narrative snippets sourced from a discarded branch tail. */
export function pruneNarrativeAtBranch(
  inputState,
  { branchPointMesId, requireMesIds = true } = {},
) {
  const original = ensureState(inputState);
  const state = clone(original);
  let removed = 0;
  state.layers = state.layers.map((layer) => {
    const kept = (layer ?? []).filter((snippet) =>
      snippetWithinPrefix(snippet, branchPointMesId, requireMesIds),
    );
    removed += (layer ?? []).length - kept.length;
    return kept;
  });
  state.processed_windows = state.processed_windows.filter((window) =>
    windowWithinPrefix(window, branchPointMesId, requireMesIds),
  );
  if (!windowWithinPrefix(state.watermark, branchPointMesId, requireMesIds)) {
    state.watermark = null;
  }
  return { state, removed, changed: removed > 0 };
}

/** Retags a narrative store after a verified chat rename. */
export function retagNarrativeChatUid(inputState, { chatUid, branchUid = null } = {}) {
  const state = ensureState(inputState);
  const next = clone(state);
  next.chat_uid = chatUid == null ? next.chat_uid : String(chatUid);
  next.branch_uid = branchUid == null ? next.branch_uid : String(branchUid);
  next.layers = next.layers.map((layer) =>
    (layer ?? []).map((snippet) => ({
      ...snippet,
      scope: {
        ...(snippet.scope ?? {}),
        ...(next.chat_uid != null ? { chat_uid: next.chat_uid } : {}),
        ...(next.branch_uid != null ? { branch_uid: next.branch_uid } : {}),
      },
    })),
  );
  return next;
}

/** Rebuilds a narrative chain from raw, ordered windows. */
export async function rebuildNarrativeChain(
  windows,
  { chatUid = null, branchUid = null, settings = {}, summarize, now = () => Date.now() } = {},
) {
  let state = createNarrativeState({ ...settings, chatUid, branchUid });
  for (const window of windows ?? []) {
    const result = await ingestNarrativeBatch(state, {
      ...window,
      chat_uid: chatUid,
      branch_uid: branchUid,
      summarize,
      now,
    });
    if (result.failed) return { state, failed: true, error: result.reason ?? result.error };
    state = result.state;
  }
  return { state, failed: false, error: null };
}
