/**
 * SillyTavern-facing single-extension runtime adapter.
 *
 * This module contains no external service or sidecar integration. It stores the
 * embedded narrative chain and canonical structured records in the active chat's
 * Smart-Memory metadata and delegates only model calls passed by the extension.
 */

import { createRuntimePipeline } from './runtime-pipeline.js';
import {
  buildWindowFromChat,
  createMetadataIngestStore,
  createMetadataValueStore,
} from './runtime-ingest.js';
import {
  buildStructuredExtractionPrompt,
  mergeStructuredRecords,
  normalizeStructuredRecords,
  parseStructuredResponse,
} from './structured-records.js';
import { isProjectionTemporallyCompatible } from './timeline.js';

const META_KEY = 'smartMemory';

function assertMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('metadata must be an object');
  }
}

function stableMesId(value) {
  const candidate = value && typeof value === 'object' ? value.mesId : value;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : null;
}

/**
 * Builds the next bounded source window after a mesId or array-index cursor.
 * The currently generating assistant message is excluded until the next turn.
 */
export function buildProductWindow({
  chat,
  chatUid,
  branchUid = null,
  cursor = null,
  lineage = null,
} = {}) {
  if (!Array.isArray(chat)) throw new TypeError('chat must be an array');
  const endExclusive =
    chat.length > 0 && !chat[chat.length - 1]?.is_user && !chat[chat.length - 1]?.is_system
      ? chat.length - 1
      : chat.length;
  if (endExclusive <= 0) return null;

  let startIndex = 0;
  const lastMesId = stableMesId(cursor?.last_mes_id);
  if (lastMesId !== null) {
    startIndex = chat.findIndex((message) => {
      const mesId = stableMesId(message);
      return mesId !== null && mesId > lastMesId;
    });
    if (startIndex < 0) return null;
  } else {
    const lastIndex = Number.isInteger(cursor?.last_index) ? cursor.last_index : -1;
    startIndex = lastIndex + 1;
  }

  if (startIndex >= endExclusive) return null;
  return buildWindowFromChat({
    chat,
    chatUid,
    branchUid,
    startIndex,
    endIndex: endExclusive - 1,
    lineage,
  });
}

function recordsFromExtraction(extracted, window, timeline = null) {
  const temporalFilter = (records) => {
    if (!timeline) return records;
    return records.filter(
      (record) =>
        record?.kind !== 'state' || isProjectionTemporallyCompatible(record.content, timeline),
    );
  };
  if (Array.isArray(extracted)) {
    const canonical = extracted.every(
      (record) => record?.scope?.chat_uid && record?.source_range && record?.provenance,
    );
    if (canonical) return temporalFilter(extracted);
    const payload = { facts: [], relationships: [], state: [], arcs: [], epistemic: [] };
    const keyByKind = {
      fact: 'facts',
      relationship: 'relationships',
      state: 'state',
      arc: 'arcs',
      epistemic: 'epistemic',
    };
    for (const record of extracted) {
      const key = keyByKind[record?.kind];
      if (key) payload[key].push(record);
    }
    return normalizeStructuredRecords(payload, window, { timeline });
  }
  if (typeof extracted === 'string') {
    return normalizeStructuredRecords(parseStructuredResponse(extracted), window, { timeline });
  }
  if (extracted && typeof extracted === 'object') {
    if (Array.isArray(extracted.records)) return recordsFromExtraction(extracted.records, window, timeline);
    return normalizeStructuredRecords(extracted, window, { timeline });
  }
  return [];
}

/**
 * Creates the one-extension product pipeline over chat metadata.
 *
 * The caller supplies the two model functions so this module remains easy to
 * test and can reuse Smart-Memory's existing generation routing.
 */
export function createProductPipeline({
  metadata,
  metaKey = META_KEY,
  saveMetadata = async () => {},
  settings = {},
  summarizeNarrative,
  extractStructured,
  narrativeSettings = null,
  shouldAbort = () => false,
} = {}) {
  assertMetadata(metadata);
  if (typeof summarizeNarrative !== 'function') {
    throw new TypeError('summarizeNarrative must be a function');
  }
  if (typeof extractStructured !== 'function') {
    throw new TypeError('extractStructured must be a function');
  }

  const guardedSaveMetadata = async () => {
    if (shouldAbort()) throw new Error('product pipeline aborted');
    await saveMetadata();
  };
  const ingestStore = createMetadataIngestStore({ metadata, metaKey, saveMetadata: guardedSaveMetadata });
  const narrativeStore = createMetadataValueStore({
    metadata,
    metaKey,
    valueKey: 'narrative',
    saveMetadata: guardedSaveMetadata,
  });
  const structuredStore = createMetadataValueStore({
    metadata,
    metaKey,
    valueKey: 'structured_records',
    saveMetadata: guardedSaveMetadata,
  });

  return createRuntimePipeline({
    loadIngest: ingestStore.load,
    saveIngest: ingestStore.save,
    loadNarrative: () => narrativeStore.load(),
    saveNarrative: (_window, state) => narrativeStore.save(state),
    summarizeNarrative,
    extractStructured: async ({ window, sourceWindowId }) => {
      const priorRecords = (await structuredStore.load()) ?? [];
      const extracted = await extractStructured({
        window,
        sourceWindowId,
        priorRecords,
        prompt: buildStructuredExtractionPrompt({
          chatText: window.messages
            .filter((message) => message?.mes && !message.is_system)
            .map((message) => `${message.name}: ${message.mes}`)
            .join('\n\n'),
          existingRecords: priorRecords,
          respondingCharacter: settings.respondingCharacter ?? '',
          timeline: settings.timeline ?? null,
        }),
      });
      return recordsFromExtraction(extracted, window, settings.timeline ?? null);
    },
    applyStructured: async (extracted, { window }) => {
      const incoming = recordsFromExtraction(extracted, window, settings.timeline ?? null);
      const existing = (await structuredStore.load()) ?? [];
      const merged = mergeStructuredRecords(existing, incoming);
      await structuredStore.save(merged);
      return { records: incoming };
    },
    narrativeSettings: narrativeSettings ?? settings.narrativeSettings,
  });
}

/** Advances the product cursor only after a queue window completes. */
export async function advanceProductCursor(
  metadata,
  window,
  saveMetadata = async () => {},
  metaKey = META_KEY,
) {
  assertMetadata(metadata);
  const root = (metadata[metaKey] ??= {});
  const range = window?.source_range;
  root.product_cursor = {
    window_id: window?.window_id ?? null,
    fingerprint: window?.fingerprint ?? null,
    last_mes_id: range?.kind === 'mesId' ? range.end : null,
    last_index: range?.kind === 'index' ? range.end : null,
  };
  await saveMetadata();
  return root.product_cursor;
}

export function loadProductCursor(metadata, metaKey = META_KEY) {
  assertMetadata(metadata);
  return metadata[metaKey]?.product_cursor ?? null;
}
