/**
 * Read-only summary of the single-extension product stores.
 *
 * The summary is used by the settings UI and progress reporting. It does not
 * mutate chat metadata, inject prompts, or make model calls.
 */

import { META_KEY } from './constants.js';
import { assembleNarrative } from './narrative-chain.js';

const RECORD_KINDS = Object.freeze(['fact', 'relationship', 'session', 'state', 'arc', 'epistemic']);
const INACTIVE_STATUSES = new Set(['invalid', 'superseded']);
const EPISTEMIC_VISIBLE_TYPES = new Set(['knows', 'suspects', 'unaware']);

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function partitionEpistemicRecords(records = []) {
  const visible = [];
  const spoiler = [];
  for (const record of Array.isArray(records) ? records : []) {
    const type = normalized(record?.type);
    (EPISTEMIC_VISIBLE_TYPES.has(type) ? visible : spoiler).push(record);
  }
  return { visible, spoiler };
}

export function filterEpistemicRecordsForSubject(records = [], subject = null) {
  const expected = normalized(subject);
  if (!expected) return [];
  return (Array.isArray(records) ? records : []).filter(
    (record) => normalized(record?.subject) === expected,
  );
}

function recordIsActive(record) {
  return !record?.superseded_by && !INACTIVE_STATUSES.has(record?.validity?.status);
}

function explicitChatValues(value) {
  return [
    value?.chat_uid,
    value?.source_chat_uid,
    value?._source_chat_uid,
    value?.chat_id,
    value?.source_chat_id,
    value?._source_chat_id,
    value?.scope?.chat_uid,
    value?.scope?.source_chat_uid,
    value?.scope?._source_chat_uid,
    value?.scope?.chat_id,
    value?.scope?.source_chat_id,
    value?.scope?._source_chat_id,
    value?.provenance?.chat_uid,
    value?.provenance?.source_chat_uid,
    value?.provenance?._source_chat_uid,
    value?.provenance?.chat_id,
    value?.provenance?.source_chat_id,
    value?.provenance?._source_chat_id,
  ].filter((item) => item !== null && item !== undefined && item !== '');
}

function explicitBranchValues(value) {
  return [
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
  ].filter((item) => item !== null && item !== undefined && item !== '');
}

function productStatusValueMatches(value, chatUid, branchUid) {
  const expectedChat = normalized(chatUid);
  const expectedBranch = normalized(branchUid);
  if (!expectedChat || !expectedBranch || !value || typeof value !== 'object') return false;
  const chats = explicitChatValues(value).map(normalized);
  const branches = explicitBranchValues(value).map(normalized);
  return (
    chats.length > 0 &&
    chats.every((item) => item === expectedChat) &&
    branches.length > 0 &&
    branches.every((item) => item === expectedBranch)
  );
}

/** Returns only explicitly proven Product status data for the live chat/branch. */
export function scopeProductStatus(root, { chatUid = null, branchUid = null } = {}) {
  const source = root && typeof root === 'object' ? root : {};
  const windows = Object.fromEntries(
    Object.entries(source.ingest_windows ?? {}).filter(([, value]) =>
      productStatusValueMatches(value, chatUid, branchUid),
    ),
  );
  return {
    ingest_windows: windows,
    product_cursor: productStatusValueMatches(source.product_cursor, chatUid, branchUid)
      ? structuredClone(source.product_cursor)
      : null,
    product_status: productStatusValueMatches(source.product_status, chatUid, branchUid)
      ? structuredClone(source.product_status)
      : null,
  };
}

/**
 * Summarizes product-owned data for the current chat.
 * @param {object} metadata SillyTavern chat metadata object
 * @param {string} metaKey metadata key containing Storyhold state
 * @returns {object} deterministic counts and current product status
 */
export function summarizeProductState(metadata, metaKey = META_KEY) {
  const root = metadata?.[metaKey];
  const records = Array.isArray(root?.structured_records) ? root.structured_records : [];
  const narrative = root?.narrative && typeof root.narrative === 'object' ? root.narrative : null;
  const layers = Array.isArray(narrative?.layers) ? narrative.layers : [];
  const windows = root?.ingest_windows && typeof root.ingest_windows === 'object'
    ? Object.values(root.ingest_windows)
    : [];
  const recordCounts = Object.fromEntries(
    RECORD_KINDS.map((kind) => [kind, records.filter((record) => record?.kind === kind).length]),
  );
  const activeRecordCounts = Object.fromEntries(
    RECORD_KINDS.map((kind) => [
      kind,
      records.filter((record) => record?.kind === kind && recordIsActive(record)).length,
    ]),
  );
  const completedWindows = windows.filter((window) => window?.status === 'completed').length;
  const partialWindows = windows.filter((window) => window?.status === 'partial').length;
  const quarantinedWindows = windows.filter((window) => window?.status === 'quarantined').length;
  const cancelledWindows = windows.filter((window) => window?.status === 'cancelled').length;
  const failedProjections = windows.reduce(
    (total, window) => total + (Array.isArray(window?.failures) ? window.failures.length : 0),
    0,
  );

  return {
    hasData: Boolean(narrative || records.length > 0 || windows.length > 0),
    narrativeText: narrative ? assembleNarrative(narrative) : '',
    narrativeLayers: layers.length,
    narrativeSnippets: layers.reduce(
      (total, layer) => total + (Array.isArray(layer) ? layer.length : 0),
      0,
    ),
    narrativeStale: Boolean(root?.narrative_stale),
    recordCounts,
    activeRecordCounts,
    totalRecords: records.length,
    activeRecords: records.filter(recordIsActive).length,
    windowsTotal: windows.length,
    completedWindows,
    partialWindows,
    quarantinedWindows,
    cancelledWindows,
    failedProjections,
    cursor: root?.product_cursor ?? null,
    lastStatus: root?.product_status ?? null,
  };
}
