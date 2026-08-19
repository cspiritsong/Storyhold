import { filterDerivedRecordsForChat } from './lineage.js';

// Fail closed until the active chat has completed lineage classification.
let currentLineage = null;

/** @param {Object|null} lineage */
export function setCurrentLineage(lineage) {
  currentLineage = lineage;
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
 * Filters a derived tier for the currently classified chat. A missing runtime
 * classification is treated as quarantined rather than falling back to a
 * shared/unknown store.
 */
export function filterCurrentChatRecords(records) {
  if (isCurrentLineageQuarantined()) return [];
  return filterDerivedRecordsForChat(records, currentLineage.chatId, currentLineage);
}

/**
 * Equivalent provenance filtering for the sparse state-ledger map. Metadata
 * keys beginning with `_` are internal and never enter the visible state block.
 */
export function filterCurrentStateLedger(ledger, epochId = null) {
  if (isCurrentLineageQuarantined() || !ledger || typeof ledger !== 'object') return {};

  const records = Object.entries(ledger).filter(([, fields]) => {
    const sourceChatId = fields?._source_chat_id;
    const sourceMatches =
      sourceChatId === undefined || sourceChatId === null
        ? currentLineage.chatId !== null
        : String(sourceChatId) === String(currentLineage.chatId);
    const epochMatches =
      fields?._lineage_epoch == null || epochId == null
        ? true
        : String(fields._lineage_epoch) === String(epochId);
    return sourceMatches && epochMatches;
  });
  return Object.fromEntries(records);
}
