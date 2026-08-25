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
import { META_KEY } from './constants.js';
import { isProjectionTemporallyCompatible } from './timeline.js';
import { fingerprintMessages } from './projections.js';
import { sourceRangeMatchesLiveChat } from './branch-detection.js';
import { filterNarrativeStateForIdentity } from './narrative-chain.js';
import { filterRetrievalRecords } from './retrieval.js';

function assertMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('metadata must be an object');
  }
}

function stableMesId(value) {
  const candidate = value && typeof value === 'object' ? value.mesId : value;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : null;
}

function explicitIdentityValues(value, kind) {
  const fields = kind === 'chat'
    ? [
        value?.chat_uid,
        value?.source_chat_uid,
        value?._source_chat_uid,
        value?.scope?.chat_uid,
        value?.scope?.source_chat_uid,
        value?.scope?._source_chat_uid,
        value?.provenance?.chat_uid,
        value?.provenance?.source_chat_uid,
        value?.provenance?._source_chat_uid,
      ]
    : [
        value?.branch_uid,
        value?._branch_uid,
        value?.lineage_epoch,
        value?._lineage_epoch,
        value?.scope?.branch_uid,
        value?.scope?._branch_uid,
        value?.scope?.lineage_epoch,
        value?.scope?._lineage_epoch,
        value?.provenance?.branch_uid,
        value?.provenance?._branch_uid,
        value?.provenance?.lineage_epoch,
        value?.provenance?._lineage_epoch,
      ];
  return fields
    .filter((field) => field !== null && field !== undefined && field !== '')
    .map((field) => String(field));
}

function cursorIdentityMatches(cursor, chatUid, branchUid) {
  if (!cursor || typeof cursor !== 'object') return true;
  const expectedChatUid = String(chatUid ?? '');
  const expectedBranchUid = branchUid == null || branchUid === '' ? null : String(branchUid);
  const chatValues = explicitIdentityValues(cursor, 'chat');
  const branchValues = explicitIdentityValues(cursor, 'branch');
  if (chatValues.length > 0) {
    if (!expectedChatUid || chatValues.some((value) => value !== expectedChatUid)) return false;
  }
  if (branchValues.length > 0) {
    if (expectedBranchUid === null || branchValues.some((value) => value !== expectedBranchUid)) return false;
  } else if (expectedBranchUid !== null) {
    return false;
  }
  if (expectedBranchUid !== null && chatValues.length === 0) return false;
  return true;
}

function validatedIndexCursor(chat, cursor, endExclusive) {
  const range = cursor?.source_range;
  if (
    Number.isInteger(cursor?.last_index) &&
    Number.isInteger(cursor?.end_index) &&
    cursor.last_index !== cursor.end_index
  ) return false;
  const lastIndex = Number.isInteger(cursor?.last_index)
    ? cursor.last_index
    : Number.isInteger(cursor?.end_index)
      ? cursor.end_index
      : -1;
  if (
    range?.kind !== 'index' ||
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end !== lastIndex ||
    range.end >= endExclusive ||
    typeof cursor?.fingerprint !== 'string' ||
    cursor.fingerprint.length === 0
  ) return false;
  const source = chat.slice(range.start, range.end + 1);
  if (source.length !== range.end - range.start + 1) return false;
  if (fingerprintMessages(source) !== cursor.fingerprint) return false;
  const lastMesId = stableMesId(cursor?.last_mes_id);
  if (
    lastMesId !== null &&
    source.some((message) => {
      const mesId = stableMesId(message);
      return mesId !== null && mesId > lastMesId;
    })
  ) {
    return false;
  }
  return true;
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
  maxMessages = 40,
} = {}) {
  if (!Array.isArray(chat)) throw new TypeError('chat must be an array');
  if (!Number.isInteger(maxMessages) || maxMessages < 1) {
    throw new RangeError('maxMessages must be a positive integer');
  }
  const endExclusive =
    chat.length > 0 && !chat[chat.length - 1]?.is_user && !chat[chat.length - 1]?.is_system
      ? chat.length - 1
      : chat.length;
  if (endExclusive <= 0) return null;

  const usableCursor = cursorIdentityMatches(cursor, chatUid, branchUid) ? cursor : null;
  let startIndex = 0;
  const lastMesId = stableMesId(usableCursor?.last_mes_id);
  const lastIndex = Number.isInteger(usableCursor?.last_index)
    ? usableCursor.last_index
    : Number.isInteger(usableCursor?.end_index)
      ? usableCursor.end_index
      : -1;
  const hasValidatedIndex = validatedIndexCursor(chat, usableCursor, endExclusive);
  const hasCursorSource = Boolean(usableCursor?.source_range);
  const persistedEndIndex = Number.isInteger(usableCursor?.end_index) ? usableCursor.end_index : null;
  const hasValidatedSource = hasCursorSource && sourceRangeMatchesLiveChat(
    chat,
    usableCursor.source_range,
    usableCursor.fingerprint,
    lastIndex,
    persistedEndIndex,
  );
  const hasStaleSource = hasCursorSource && !hasValidatedSource;
  if (lastMesId !== null && hasValidatedSource) {
    const watermarkIndex = chat.findLastIndex((message) => stableMesId(message) === lastMesId);
    if (watermarkIndex >= 0) {
      startIndex = hasStaleSource ? 0 : watermarkIndex + 1;
      if (!hasStaleSource && hasValidatedIndex) startIndex = Math.max(startIndex, lastIndex + 1);
    } else {
      // A missing numeric watermark cannot prove that sparse messages between
      // the old watermark and a newer surviving mesId were processed. Replay
      // conservatively; the window/idempotency layer removes duplicates.
      startIndex = 0;
    }
  } else if (lastMesId === null) {
    startIndex = hasValidatedIndex ? lastIndex + 1 : 0;
  } else {
    // A numeric watermark without a validated source range/fingerprint is
    // legacy or corrupt state. Replay rather than risk skipping messages.
    startIndex = 0;
  }

  if (startIndex >= endExclusive) return null;
  const endIndex = Math.min(startIndex + maxMessages - 1, endExclusive - 1);
  return buildWindowFromChat({
    chat,
    chatUid,
    branchUid,
    startIndex,
    endIndex,
    lineage,
  });
}

function recordsFromExtraction(extracted, window, timeline = null, enabledKinds = null) {
  const temporalFilter = (records) => {
    return records.filter((record) => {
      if (enabledKinds && !enabledKinds.includes(record?.kind)) return false;
      if (!timeline || record?.kind !== 'state') return true;
      return isProjectionTemporallyCompatible(record.content, timeline);
    });
  };
  if (Array.isArray(extracted)) {
    const canonical = extracted.every(
      (record) => record?.scope?.chat_uid && record?.source_range && record?.provenance,
    );
    if (canonical) return temporalFilter(extracted);
    const payload = { facts: [], relationships: [], state: [], arcs: [], epistemic: [], session: [] };
    const keyByKind = {
      fact: 'facts',
      relationship: 'relationships',
      state: 'state',
      arc: 'arcs',
      epistemic: 'epistemic',
      session: 'session',
    };
    for (const record of extracted) {
      const key = keyByKind[record?.kind];
      if (key) payload[key].push(record);
    }
    return normalizeStructuredRecords(payload, window, { timeline, enabledKinds });
  }
  if (typeof extracted === 'string') {
    return normalizeStructuredRecords(parseStructuredResponse(extracted), window, { timeline, enabledKinds });
  }
  if (extracted && typeof extracted === 'object') {
    if (Array.isArray(extracted.records)) return recordsFromExtraction(extracted.records, window, timeline, enabledKinds);
    return normalizeStructuredRecords(extracted, window, { timeline, enabledKinds });
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
  saveCancelledMetadata = null,
  shouldAbort = () => false,
} = {}) {
  assertMetadata(metadata);
  if (typeof summarizeNarrative !== 'function') {
    throw new TypeError('summarizeNarrative must be a function');
  }
  if (typeof extractStructured !== 'function') {
    throw new TypeError('extractStructured must be a function');
  }
  if (saveCancelledMetadata !== null && typeof saveCancelledMetadata !== 'function') {
    throw new TypeError('saveCancelledMetadata must be a function when provided');
  }
  const resolvedNarrativeSettings = narrativeSettings ?? settings.narrativeSettings ?? null;

  const productIdentity = (window = null) => {
    const root = metadata[metaKey] ?? {};
    const chatUid = window?.chat_uid ?? settings.chatUid ?? root.chat_uid ?? null;
    const branchUid = window && Object.prototype.hasOwnProperty.call(window, 'branch_uid')
      ? window.branch_uid
      : settings.branchUid !== undefined
        ? settings.branchUid
        : root.lineage?.epoch_id ?? root.lineage?.epochId ?? root.branch_uid ?? chatUid;
    const chatId = settings.chatId ?? root.chat_id ?? root.lineage?.chat_id ?? null;
    return { chatUid, branchUid, chatId };
  };

  const scopedNarrative = async (window) => {
    const identity = productIdentity(window);
    const narrative = await narrativeStore.load();
    return filterNarrativeStateForIdentity(narrative, {
      chatUid: identity.chatUid,
      chatId: identity.chatId,
      branchUid: identity.branchUid,
      requireChat: true,
      requireBranch: true,
    });
  };

  const scopedStructuredRecords = async (window) => {
    const identity = productIdentity(window);
    const records = (await structuredStore.load()) ?? [];
    return filterRetrievalRecords(records, {
      chatUid: identity.chatUid,
      branchUid: identity.branchUid,
      lineage: identity.chatId == null ? null : { chatId: identity.chatId },
      allowLegacy: false,
      includeInactive: true,
    });
  };

  const guardedSaveMetadata = async () => {
    if (shouldAbort()) throw new Error('product pipeline aborted');
    await saveMetadata();
  };
  const ingestStore = createMetadataIngestStore({
    metadata,
    metaKey,
    saveMetadata: guardedSaveMetadata,
    saveCancelledMetadata,
  });
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
    loadNarrative: (window) => scopedNarrative(window),
    saveNarrative: (_window, state) => narrativeStore.save(state),
    summarizeNarrative,
    extractStructured: async ({ window, sourceWindowId }) => {
      const priorRecords = await scopedStructuredRecords(window);
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
          enabledKinds: settings.enabledKinds ?? null,
        }),
      });
      return recordsFromExtraction(
        extracted,
        window,
        settings.timeline ?? null,
        settings.enabledKinds ?? null,
      );
    },
    applyStructured: async (extracted, { window }) => {
      const incoming = recordsFromExtraction(
        extracted,
        window,
        settings.timeline ?? null,
        settings.enabledKinds ?? null,
      );
      const existing = (await structuredStore.load()) ?? [];
      const merged = mergeStructuredRecords(existing, incoming);
      await structuredStore.save(merged);
      return { records: incoming };
    },
    narrativeSettings: resolvedNarrativeSettings,
    saveCancelledIngest: ingestStore.saveCancelled ?? null,
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
  const prior = root.product_cursor ?? {};
  const messageMesIds = (Array.isArray(window?.messages) ? window.messages : [])
    .map(stableMesId)
    .filter((value) => value !== null);
  const rangeMesId = range?.kind === 'mesId' && Number.isInteger(range.end) ? range.end : null;
  const lastMesId = messageMesIds.length > 0
    ? Math.max(...messageMesIds)
    : rangeMesId ?? prior.last_mes_id ?? null;
  const lastIndex = Number.isInteger(window?.end_index)
    ? window.end_index
    : range?.kind === 'index'
      ? range.end
      : prior.last_index ?? null;
  root.product_cursor = {
    window_id: window?.window_id ?? null,
    fingerprint: window?.fingerprint ?? null,
    source_range: range ? { ...range } : null,
    last_mes_id: lastMesId,
    last_index: lastIndex,
    end_index: lastIndex,
    ...(window?.chat_uid != null ? { chat_uid: String(window.chat_uid) } : {}),
    ...(window?.branch_uid != null ? { branch_uid: String(window.branch_uid) } : {}),
  };
  await saveMetadata();
  return root.product_cursor;
}

export function loadProductCursor(metadata, metaKey = META_KEY) {
  assertMetadata(metadata);
  return metadata[metaKey]?.product_cursor ?? null;
}

/** Persists the latest product operation status alongside the canonical stores. */
export async function persistProductStatus(
  metadata,
  status,
  saveMetadata = async () => {},
  metaKey = META_KEY,
  now = () => Date.now(),
) {
  assertMetadata(metadata);
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new TypeError('status must be an object');
  }
  if (typeof saveMetadata !== 'function') throw new TypeError('saveMetadata must be a function');
  const root = (metadata[metaKey] ??= {});
  root.product_status = {
    ...status,
    updated_at: status.updated_at ?? now(),
  };
  await saveMetadata();
  return root.product_status;
}

/** Clears only product-derived stores for an explicit rescan/rebuild. */
export async function resetProductMemory(
  metadata,
  saveMetadata = async () => {},
  metaKey = META_KEY,
  shouldAbort = () => false,
) {
  assertMetadata(metadata);
  if (typeof saveMetadata !== 'function') throw new TypeError('saveMetadata must be a function');
  if (typeof shouldAbort !== 'function') throw new TypeError('shouldAbort must be a function');
  if (shouldAbort()) throw new Error('product reset aborted');
  const root = (metadata[metaKey] ??= {});
  root.product_cursor = null;
  root.narrative = null;
  root.structured_records = [];
  root.ingest_windows = {};
  root.product_status = null;
  await saveMetadata();
  return root;
}
