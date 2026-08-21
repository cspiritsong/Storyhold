import { chatHasRealMesIds } from './branch-aware.js';
import { canonicalMessage } from './identity.js';
import { inheritNarrativePrefix } from './narrative-chain.js';
import { inheritStructuredRecordsPrefix } from './structured-records.js';

/**
 * Runtime lineage states. A branch is trusted only after a later branch
 * operation records a verified shared-prefix boundary.
 */
export const LINEAGE_STATUS = Object.freeze({
  STANDALONE: 'standalone',
  MESID_LESS_BRANCH: 'mesid-less-branch',
  UNVERIFIED_BRANCH: 'unverified-branch',
  VERIFIED_PREFIX: 'verified-prefix',
  REBUILT: 'rebuilt',
  MANUAL_LINKED: 'manual-linked',
});

function normalizeChatId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function messagesMatch(parentMessage, branchMessage, method) {
  if (method === 'mesId') {
    if (
      typeof parentMessage?.mesId !== 'number' ||
      typeof branchMessage?.mesId !== 'number' ||
      parentMessage.mesId !== branchMessage.mesId
    ) {
      return false;
    }
  }
  return canonicalMessage(parentMessage) === canonicalMessage(branchMessage);
}

/**
 * Finds the verified common prefix of two raw ST chat arrays.
 *
 * Numeric mesIds are preferred when both chats have them. MesId-less/imported
 * chats use a conservative canonical message fingerprint instead. A prefix is
 * never guessed from array length alone.
 */
export function findCommonChatPrefix(parentChat, branchChat) {
  const parent = Array.isArray(parentChat) ? parentChat : [];
  const branch = Array.isArray(branchChat) ? branchChat : [];
  const method = chatHasRealMesIds(parent) && chatHasRealMesIds(branch) ? 'mesId' : 'fingerprint';
  let commonPrefixLength = 0;
  const max = Math.min(parent.length, branch.length);

  while (
    commonPrefixLength < max &&
    messagesMatch(parent[commonPrefixLength], branch[commonPrefixLength], method)
  ) {
    commonPrefixLength++;
  }

  return {
    verified: commonPrefixLength > 0,
    method,
    commonPrefixLength,
    parentPrefixEnd: commonPrefixLength - 1,
    branchPrefixEnd: commonPrefixLength - 1,
  };
}

/**
 * Builds the lineage record written after a shared prefix has been verified.
 */
export function buildVerifiedPrefixLineage({
  chatId,
  chatUid = null,
  parentChatId,
  parentChat,
  branchChat,
  epochId = null,
} = {}) {
  const match = findCommonChatPrefix(parentChat, branchChat);
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedParentChatId = normalizeChatId(parentChatId);
  if (!match.verified || normalizedChatId === null || normalizedParentChatId === null) {
    return {
      status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
      chat_id: normalizedChatId,
      ...(chatUid !== null ? { chat_uid: String(chatUid) } : {}),
      parent_chat_id: normalizedParentChatId,
      prefix_end: null,
      prefix_length: match.commonPrefixLength,
      method: match.method,
      epoch_id: epochId,
    };
  }

  return {
    status: LINEAGE_STATUS.VERIFIED_PREFIX,
    chat_id: normalizedChatId,
    ...(chatUid !== null ? { chat_uid: String(chatUid) } : {}),
    parent_chat_id: normalizedParentChatId,
    prefix_end: match.branchPrefixEnd,
    prefix_length: match.commonPrefixLength,
    method: match.method,
    epoch_id: epochId,
  };
}

/**
 * Returns true only when a record has provenance wholly inside the verified
 * parent prefix. Empty/legacy provenance is deliberately not inheritable.
 */
export function canInheritRecord(record, { parentChatId, parentPrefixEnd } = {}) {
  if (normalizeChatId(record?.source_chat_id) !== normalizeChatId(parentChatId)) return false;
  if (!Number.isInteger(parentPrefixEnd) || parentPrefixEnd < 0) return false;
  const ranges =
    record?.source_messages ??
    (Array.isArray(record?.source_message_range) ? [record.source_message_range] : null) ??
    (Array.isArray(record?._source_message_range) ? [record._source_message_range] : null);
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  return ranges.every(
    (range) =>
      Array.isArray(range) &&
      range.length >= 2 &&
      Number.isInteger(range[0]) &&
      Number.isInteger(range[1]) &&
      range[0] >= 0 &&
      range[1] >= range[0] &&
      range[1] <= parentPrefixEnd,
  );
}

/**
 * Copies safe prefix records and retags them for the branch. The parent array
 * and its records are never mutated.
 */
export function inheritDerivedRecords(records, options = {}) {
  if (!Array.isArray(records)) return [];
  const { parentChatId, branchChatId, parentPrefixEnd, epochId = null } = options;
  const normalizedBranchChatId = normalizeChatId(branchChatId);
  if (normalizedBranchChatId === null) return [];

  return records
    .filter((record) => canInheritRecord(record, { parentChatId, parentPrefixEnd }))
    .map((record) => ({
      ...record,
      source_chat_id: normalizedBranchChatId,
      origin_chat_id: record.origin_chat_id ?? normalizeChatId(parentChatId),
      inherited: true,
      lineage_epoch: epochId,
    }));
}

/**
 * Builds a clean branch-scoped Storyhold metadata block from a parent's
 * proven prefix. Unproven legacy projections are intentionally omitted so a
 * branch can fall back to an explicit rebuild instead of inheriting guesses.
 */
export function inheritSmartMemoryMetadata(parentSmartMemory = {}, options = {}) {
  const {
    parentChatId,
    branchChatId,
    branchChatUid = branchChatId,
    parentPrefixEnd,
    branchPrefixLength = parentPrefixEnd + 1,
    branchPrefixMesId = null,
    epochId = null,
    schemaVersion = parentSmartMemory.schema_version ?? null,
  } = options;
  const recordOptions = { parentChatId, branchChatId, parentPrefixEnd, epochId };
  const result = {
    schema_version: schemaVersion,
    lastExtractCutoff: Math.max(0, branchPrefixLength ?? 0),
    lastInjectionRefresh: Math.max(0, branchPrefixLength ?? 0),
    sessionMemories: inheritDerivedRecords(parentSmartMemory.sessionMemories, recordOptions),
    storyArcs: inheritDerivedRecords(parentSmartMemory.storyArcs, recordOptions),
    sceneHistory: inheritDerivedRecords(parentSmartMemory.sceneHistory, recordOptions),
    state_ledger: {},
    profiles: {},
    structured_records: inheritStructuredRecordsPrefix(parentSmartMemory.structured_records, {
      parentChatUid: parentSmartMemory.chat_uid ?? parentChatId,
      branchChatUid,
      branchUid: epochId,
      parentPrefixEnd,
    }),
    ...(parentSmartMemory.narrative
      ? {
          narrative: inheritNarrativePrefix(parentSmartMemory.narrative, {
            parentChatUid: parentSmartMemory.narrative.chat_uid ?? parentChatId,
            branchChatUid,
            branchUid: epochId,
            parentPrefixEnd,
            // A verified narrative inheritance must be mesId-proven. A
            // fingerprint-only branch remains eligible for explicit rebuild,
            // but cannot silently receive recursive history.
            requireMesIds: true,
          }),
        }
      : {}),
  };

  if (branchPrefixMesId !== null && branchPrefixMesId !== undefined) {
    result.lastExtractMesId = branchPrefixMesId;
  }

  for (const [key, fields] of Object.entries(parentSmartMemory.state_ledger ?? {})) {
    const candidate = {
      ...fields,
      source_chat_id: fields?._source_chat_id,
      source_message_range: fields?._source_message_range,
    };
    if (!canInheritRecord(candidate, { parentChatId, parentPrefixEnd })) continue;
    result.state_ledger[key] = {
      ...fields,
      _source_chat_id: String(branchChatId),
      _origin_chat_id: String(parentChatId),
      _inherited: true,
      _lineage_epoch: epochId,
    };
  }

  for (const [name, profile] of Object.entries(parentSmartMemory.profiles ?? {})) {
    const inherited = inheritDerivedRecords([profile], recordOptions);
    if (inherited.length > 0) result.profiles[name] = inherited[0];
  }

  const summaryCandidate = {
    source_chat_id: parentSmartMemory.summary_source_chat_id,
    source_message_range: parentSmartMemory.summary_source_message_range,
  };
  if (parentSmartMemory.summary && canInheritRecord(summaryCandidate, { parentChatId, parentPrefixEnd })) {
    result.summary = parentSmartMemory.summary;
    result.summaryUpdated = parentSmartMemory.summaryUpdated;
    result.summaryEnd = Math.max(0, branchPrefixLength ?? 0);
    result.summary_source_chat_id = String(branchChatId);
    result.summary_source_message_range = parentSmartMemory.summary_source_message_range;
    if (parentSmartMemory.summary_source_mes_range) {
      result.summary_source_mes_range = parentSmartMemory.summary_source_mes_range;
    }
  }

  const inheritedMemoryIds = new Set(result.sessionMemories.map((memory) => memory.id).filter(Boolean));
  const entities = (parentSmartMemory.sessionEntities ?? []).filter((entity) => {
    const ids = Array.isArray(entity.memory_ids) ? entity.memory_ids : [];
    return ids.length > 0 && ids.every((id) => inheritedMemoryIds.has(id));
  });
  if (entities.length > 0) result.sessionEntities = entities;

  return result;
}

/**
 * Classifies whether derived memory may be trusted for the current chat.
 *
 * `main_chat` is lineage evidence, not proof of safe inheritance. A branch
 * remains quarantined until a verified-prefix record matches both chat IDs and
 * carries a concrete prefix boundary. This deliberately errs toward no memory
 * rather than allowing a parent timeline to decide the branch's story.
 *
 * @param {Object} args
 * @param {string|number|null} args.chatId - Current ST chat filename/id.
 * @param {string|number|null} args.parentChatId - `chat_metadata.main_chat`.
 * @param {Array} args.chat - Current ST message array.
 * @param {Object|null} [args.lineage] - Future verified lineage record.
 * @returns {{status: string, quarantined: boolean, chatId: string|null,
 *            parentChatId: string|null, hasRealMesIds: boolean}}
 */
export function classifyChatLineage({
  chatId,
  chatUid = null,
  parentChatId,
  legacyChatIds = [],
  chat,
  lineage = null,
} = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedChatUid = normalizeChatId(chatUid);
  const normalizedParentChatId = normalizeChatId(parentChatId);
  const normalizedLegacyChatIds = [...new Set(legacyChatIds.map(normalizeChatId).filter(Boolean))];
  const hasRealMesIds = chatHasRealMesIds(chat);
  const isCrossFile =
    normalizedParentChatId !== null && normalizedParentChatId !== normalizedChatId;

  if (!isCrossFile) {
    return {
      status: LINEAGE_STATUS.STANDALONE,
      quarantined: false,
      chatId: normalizedChatId,
      parentChatId: normalizedParentChatId,
      hasRealMesIds,
      ...(normalizedChatUid !== null ? { chatUid: normalizedChatUid } : {}),
      ...(normalizedLegacyChatIds.length > 0 ? { legacyChatIds: normalizedLegacyChatIds } : {}),
    };
  }

  const lineageChatMatches =
    normalizeChatId(lineage?.chat_id) === normalizedChatId ||
    (normalizedChatUid !== null && normalizeChatId(lineage?.chat_uid) === normalizedChatUid);
  const verifiedLineage =
    lineage?.status === LINEAGE_STATUS.VERIFIED_PREFIX &&
    lineageChatMatches &&
    normalizeChatId(lineage.parent_chat_id) === normalizedParentChatId &&
    Number.isInteger(lineage.prefix_end) &&
    lineage.prefix_end >= -1;
  const rebuiltLineage =
    lineage?.status === LINEAGE_STATUS.REBUILT &&
    lineageChatMatches &&
    normalizeChatId(lineage.parent_chat_id) === normalizedParentChatId;
  const manualLinked =
    lineage?.status === LINEAGE_STATUS.MANUAL_LINKED &&
    lineageChatMatches &&
    lineage.manual_override === true;

  if (verifiedLineage || rebuiltLineage || manualLinked) {
    return {
      status: lineage.status,
      quarantined: false,
      chatId: normalizedChatId,
      parentChatId: normalizedParentChatId,
      hasRealMesIds,
      ...(normalizedChatUid !== null ? { chatUid: normalizedChatUid } : {}),
      ...(normalizedLegacyChatIds.length > 0 ? { legacyChatIds: normalizedLegacyChatIds } : {}),
    };
  }

  return {
    status: hasRealMesIds
      ? LINEAGE_STATUS.UNVERIFIED_BRANCH
      : LINEAGE_STATUS.MESID_LESS_BRANCH,
    quarantined: true,
    chatId: normalizedChatId,
    parentChatId: normalizedParentChatId,
    hasRealMesIds,
    ...(normalizedChatUid !== null ? { chatUid: normalizedChatUid } : {}),
    ...(normalizedLegacyChatIds.length > 0 ? { legacyChatIds: normalizedLegacyChatIds } : {}),
  };
}

/**
 * Filters derived records before prompt injection.
 *
 * Legacy records without source_chat_id remain usable in a trusted standalone
 * chat for compatibility. They are not usable while a branch is quarantined.
 * A later verified-branch implementation can stamp inherited records with the
 * new branch chat id before releasing them.
 *
 * @param {Array} records
 * @param {string|number|null} chatId
 * @param {{quarantined?: boolean}} lineage
 * @returns {Array}
 */
export function filterDerivedRecordsForChat(records, chatId, lineage = {}) {
  if (!Array.isArray(records) || lineage.quarantined) return [];

  const normalizedChatId = normalizeChatId(chatId);
  const allowedChatIds = new Set([
    normalizedChatId,
    ...(lineage.legacyChatIds ?? []).map(normalizeChatId),
  ].filter(Boolean));
  return records.filter((record) => {
    const sourceChatId = normalizeChatId(record?.source_chat_id);
    if (sourceChatId !== null && allowedChatIds.has(sourceChatId)) return true;
    if (
      record?.source_chat_uid != null &&
      lineage?.chatUid != null &&
      normalizeChatId(record.source_chat_uid) === normalizeChatId(lineage.chatUid)
    ) {
      return true;
    }
    if (sourceChatId === null) return normalizedChatId !== null;
    return false;
  });
}
