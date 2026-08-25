import { filterDerivedRecordsForChat, lineageEpochStamp } from './lineage.js';

// Fail closed until the active chat has completed lineage classification.
let currentLineage = null;
// Wired by index.js at startup so this module keeps no static SillyTavern
// imports and remains loadable by the node regression tests.
let freshStartProvider = null;

/** @param {Object|null} lineage */
export function setCurrentLineage(lineage) {
  currentLineage = lineage;
}

/** Wires the live Fresh Start reader. index.js calls this once at startup. */
export function setFreshStartProvider(provider) {
  freshStartProvider = typeof provider === 'function' ? provider : null;
}

/** @returns {Object|null} */
export function getCurrentLineage() {
  return currentLineage;
}

/**
 * Returns true before chat load classification and for every quarantined branch.
 * This keeps asynchronous extraction/injection paths fail-closed during chat
 * transitions as well as on untrusted lineage.
 */
export function isCurrentLineageQuarantined() {
  return currentLineage == null || currentLineage.quarantined === true;
}

/**
 * Returns true while the active chat has Fresh Start enabled. Injectors use
 * this instead of reading chatMetadata directly so every prompt boundary
 * shares the same fail-closed semantics.
 */
export function isFreshStartActive() {
  return freshStartProvider?.() === true;
}

/**
 * Returns the current branch-epoch stamp for new compatibility-mode records,
 * or null when the current lineage defines no branch epoch.
 */
export function currentLineageEpochStamp() {
  return lineageEpochStamp(currentLineage);
}

/** Returns identity fields for a newly written compatibility record. */
export function currentLineageRecordStamp() {
  if (isCurrentLineageQuarantined()) return {};
  const stamp = {};
  if (currentLineage.chatId != null && String(currentLineage.chatId).trim() !== '') {
    stamp.source_chat_id = String(currentLineage.chatId);
  }
  if (currentLineage.chatUid != null && String(currentLineage.chatUid).trim() !== '') {
    stamp.source_chat_uid = String(currentLineage.chatUid);
  }
  return { ...stamp, ...(currentLineageEpochStamp() ?? {}) };
}

/**
 * Filters a derived tier for the currently classified chat. A missing runtime
 * classification is treated as quarantined rather than falling back to a
 * shared/unknown store.
 */
export function filterCurrentChatRecords(records, options = {}) {
  if (isCurrentLineageQuarantined()) return [];
  return filterDerivedRecordsForChat(records, currentLineage.chatId, currentLineage, options);
}

/**
 * Equivalent provenance filtering for the sparse state-ledger map. Metadata
 * keys beginning with `_` are internal and never enter the visible state block.
 */
export function filterCurrentStateLedger(ledger, epochId = null) {
  if (isCurrentLineageQuarantined() || !ledger || typeof ledger !== 'object') return {};

  const records = Object.entries(ledger).filter(([, fields]) => {
    const sourceChatIds = [
      fields?._source_chat_id,
      fields?.source_chat_id,
      fields?.chat_id,
      fields?.scope?.chat_id,
      fields?.scope?.source_chat_id,
      fields?.scope?._source_chat_id,
      fields?.provenance?.source_chat_id,
      fields?.provenance?.chat_id,
      fields?.provenance?._source_chat_id,
    ].filter((value) => value !== null && value !== undefined && value !== '');
    const sourceChatUids = [
      fields?._source_chat_uid,
      fields?.source_chat_uid,
      fields?.chat_uid,
      fields?.scope?.chat_uid,
      fields?.scope?.source_chat_uid,
      fields?.scope?._source_chat_uid,
      fields?.provenance?.source_chat_uid,
      fields?.provenance?.chat_uid,
      fields?.provenance?._source_chat_uid,
    ].filter((value) => value !== null && value !== undefined && value !== '');
    const branchUids = [
      fields?._lineage_epoch,
      fields?.lineage_epoch,
      fields?._branch_uid,
      fields?.branch_uid,
      fields?.scope?._lineage_epoch,
      fields?.scope?.lineage_epoch,
      fields?.scope?._branch_uid,
      fields?.scope?.branch_uid,
      fields?.provenance?._lineage_epoch,
      fields?.provenance?.lineage_epoch,
      fields?.provenance?._branch_uid,
      fields?.provenance?.branch_uid,
    ].filter((value) => value !== null && value !== undefined && value !== '');
    const allowedChatIds = new Set([
      currentLineage.chatId,
      ...(currentLineage.legacyChatIds ?? []),
    ].filter((value) => value !== null && value !== undefined));
    const sourceMatches = sourceChatIds.every((value) => allowedChatIds.has(String(value)));
    const uidMatches = sourceChatUids.every(
      (value) => currentLineage.chatUid != null && String(value) === String(currentLineage.chatUid),
    );
    const expectedEpoch = epochId ?? currentLineage.epoch_id ?? currentLineage.epochId ?? null;
    const branchRequired =
      expectedEpoch != null &&
      ['verified-prefix', 'rebuilt', 'manual-linked'].includes(currentLineage.status);
    // Branch-status lineages require every record to carry the current branch
    // epoch. Standalone lineages have no branch epoch at all: their valid
    // records are unstamped with a branch uid, and any record carrying one is
    // foreign and fails closed. A standalone story epoch is a timeline
    // concept, not a branch identity, so it must not gate standalone records.
    const epochMatches = branchRequired
      ? branchUids.length > 0 && branchUids.every((value) => String(value) === String(expectedEpoch))
      : branchUids.length === 0;
    // Standalone cards may omit a branch epoch, but they may not omit the
    // chat identity. Empty identity arrays would turn an unproven legacy card
    // into a universally injectable card because Array.every([]) is true.
    const hasExplicitIdentity = sourceChatIds.length > 0 && sourceChatUids.length > 0;
    return hasExplicitIdentity && sourceMatches && uidMatches && epochMatches;
  });
  return Object.fromEntries(records);
}
