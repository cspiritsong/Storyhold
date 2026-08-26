import { chatHasRealMesIds } from './branch-aware.js';
import { canonicalMessage } from './identity.js';
import { fingerprintMessages } from './projections.js';
import { inheritNarrativePrefix } from './narrative-chain.js';
import { inheritStructuredRecordsPrefix } from './structured-records.js';

/**
 * Runtime lineage states. A branch is trusted only after a later branch
 * operation records a verified shared-prefix boundary.
 */
export const LINEAGE_STATUS = Object.freeze({
  STANDALONE: 'standalone',
  MISSING_IDENTITY: 'missing-identity',
  MESID_LESS_BRANCH: 'mesid-less-branch',
  UNVERIFIED_BRANCH: 'unverified-branch',
  VERIFIED_PREFIX: 'verified-prefix',
  REBUILT: 'rebuilt',
  MANUAL_LINKED: 'manual-linked',
});

function normalizeChatId(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized === '' ? null : normalized;
}

function explicitBranchUids(record) {
  return [
    record?.branch_uid,
    record?._branch_uid,
    record?.lineage_epoch,
    record?._lineage_epoch,
    record?.scope?.branch_uid,
    record?.scope?._branch_uid,
    record?.scope?.lineage_epoch,
    record?.scope?._lineage_epoch,
    record?.provenance?.branch_uid,
    record?.provenance?._branch_uid,
    record?.provenance?.lineage_epoch,
    record?.provenance?._lineage_epoch,
  ]
    .map(normalizeChatId)
    .filter(Boolean);
}

/**
 * Returns the branch-epoch stamp for newly written compatibility-mode records,
 * or null when the lineage defines no branch epoch. Standalone chats must stay
 * unstamped because the current-chat filters require NO branch fields when the
 * expected branch is null; verified/rebuilt/manual-linked branches require the
 * epoch on every record they inject.
 */
export function lineageEpochStamp(lineage = null) {
  const epoch =
    lineage?.branchUid ?? lineage?.branch_uid ?? lineage?.epoch_id ?? lineage?.epochId;
  const normalized = normalizeChatId(epoch);
  return normalized === null ? null : { lineage_epoch: normalized };
}

function retagChildProvenance(record, { branchChatId, branchChatUid = null, epochId = null } = {}) {
  const copy = { ...record };
  const nested = [];
  for (const key of ['scope', 'provenance']) {
    if (copy[key] && typeof copy[key] === 'object') {
      copy[key] = { ...copy[key] };
      nested.push(copy[key]);
    }
  }
  const identityObjects = [copy, ...nested];
  const normalizedChatId = normalizeChatId(branchChatId);
  const normalizedChatUid = normalizeChatId(branchChatUid);
  const normalizedEpoch = normalizeChatId(epochId);
  if (normalizedChatId !== null) {
    for (const object of identityObjects) {
      for (const field of ['source_chat_id', '_source_chat_id', 'chat_id']) {
        if (object[field] != null) object[field] = normalizedChatId;
      }
    }
  }
  if (normalizedChatUid !== null) {
    for (const object of identityObjects) {
      for (const field of ['source_chat_uid', '_source_chat_uid', 'chat_uid']) {
        if (object[field] != null) object[field] = normalizedChatUid;
      }
    }
  }
  if (normalizedEpoch !== null) {
    for (const object of identityObjects) {
      for (const field of ['branch_uid', '_branch_uid', 'lineage_epoch', '_lineage_epoch']) {
        if (object[field] != null) object[field] = normalizedEpoch;
      }
    }
  }
  return copy;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
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

function lineageIdentityMatches(lineage, chatId, chatUid) {
  const lineageChatUid = normalizeChatId(lineage?.chat_uid);
  const normalizedChatUid = normalizeChatId(chatUid);
  if (lineageChatUid === null || normalizedChatUid === null) return false;
  return lineageChatUid === normalizedChatUid;
}

function verifiedPrefixMatchesLiveChat(lineage, chat) {
  if (!Array.isArray(chat)) return false;
  if (!Number.isInteger(lineage?.prefix_length) || lineage.prefix_length < 1) return false;
  if (lineage.prefix_end !== lineage.prefix_length - 1) return false;
  if (lineage.prefix_length > chat.length) return false;
  if (typeof lineage.prefix_fingerprint !== 'string' || lineage.prefix_fingerprint.trim() === '') {
    return false;
  }
  const prefix = chat.slice(0, lineage.prefix_length);
  if (prefix.length !== lineage.prefix_length) return false;
  if (
    lineage.method === 'mesId' &&
    prefix.some((message) => !Number.isInteger(message?.mesId))
  ) {
    return false;
  }
  return fingerprintMessages(prefix) === lineage.prefix_fingerprint;
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
  rootChatUid = null,
  aliases = [],
} = {}) {
  const match = findCommonChatPrefix(parentChat, branchChat);
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedChatUid = normalizeChatId(chatUid);
  const normalizedParentChatId = normalizeChatId(parentChatId);
  const normalizedRootChatUid = normalizeChatId(rootChatUid);
  if (
    !match.verified ||
    match.method !== 'mesId' ||
    normalizedChatId === null ||
    normalizedChatUid === null ||
    normalizedParentChatId === null ||
    (normalizedRootChatUid !== null && normalizedRootChatUid === normalizedChatUid)
  ) {
    return {
      status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
      chat_id: normalizedChatId,
      ...(normalizedChatUid !== null ? { chat_uid: normalizedChatUid } : {}),
      parent_chat_id: normalizedParentChatId,
      prefix_end: null,
      prefix_length: match.commonPrefixLength,
      prefix_fingerprint: fingerprintMessages(branchChat.slice(0, match.commonPrefixLength)),
      method: match.method,
      epoch_id: epochId,
      ...(rootChatUid != null ? { root_chat_uid: String(rootChatUid) } : {}),
      ...(Array.isArray(aliases) && aliases.length > 0 ? { aliases: [...new Set(aliases.map(String))] } : {}),
    };
  }

  return {
    status: LINEAGE_STATUS.VERIFIED_PREFIX,
    chat_id: normalizedChatId,
    chat_uid: normalizedChatUid,
    parent_chat_id: normalizedParentChatId,
    prefix_end: match.branchPrefixEnd,
    prefix_length: match.commonPrefixLength,
    prefix_fingerprint: fingerprintMessages(branchChat.slice(0, match.commonPrefixLength)),
    method: match.method,
    epoch_id: epochId,
    ...(rootChatUid != null ? { root_chat_uid: String(rootChatUid) } : {}),
    ...(Array.isArray(aliases) && aliases.length > 0 ? { aliases: [...new Set(aliases.map(String))] } : {}),
  };
}

/**
 * Returns true only when a record has provenance wholly inside the verified
 * parent prefix. Empty/legacy provenance is deliberately not inheritable.
 */
export function canInheritRecord(
  record,
  { parentChatId, parentChatUid = null, parentBranchUid = null, parentPrefixEnd } = {},
) {
  const parentId = normalizeChatId(parentChatId);
  if (normalizeChatId(record?.source_chat_id) !== parentId) return false;
  const explicitIds = [
    record?.source_chat_id,
    record?._source_chat_id,
    record?.chat_id,
    record?.scope?.chat_id,
    record?.scope?.source_chat_id,
    record?.scope?._source_chat_id,
    record?.provenance?.source_chat_id,
    record?.provenance?.chat_id,
    record?.provenance?._source_chat_id,
  ]
    .map(normalizeChatId)
    .filter(Boolean);
  if (explicitIds.some((value) => value !== parentId)) return false;
  if (parentChatUid != null) {
    const explicitUids = [
      record?.source_chat_uid,
      record?._source_chat_uid,
      record?.chat_uid,
      record?.scope?.chat_uid,
      record?.scope?.source_chat_uid,
      record?.scope?._source_chat_uid,
      record?.provenance?.source_chat_uid,
      record?.provenance?.chat_uid,
      record?.provenance?._source_chat_uid,
    ]
      .map(normalizeChatId)
      .filter(Boolean);
    // If the parent has a stable UID, an absent UID is not legacy-compatible:
    // retagging such a record would launder an unproven namespace into the
    // verified child.
    if (
      explicitUids.length === 0 ||
      explicitUids.some((value) => value !== normalizeChatId(parentChatUid))
    ) return false;
  }
  const explicitBranches = explicitBranchUids(record);
  if (parentBranchUid == null) {
    if (explicitBranches.length > 0) return false;
  } else {
    // A supplied parent branch epoch is proof-bearing. A record without one
    // cannot be safely retagged as belonging to the child branch.
    if (
      explicitBranches.length === 0 ||
      explicitBranches.some((value) => value !== normalizeChatId(parentBranchUid))
    ) return false;
  }
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
  const {
    parentChatId,
    parentChatUid = null,
    parentBranchUid = null,
    branchChatId,
    branchChatUid = null,
    parentPrefixEnd,
    epochId = null,
  } = options;
  const normalizedBranchChatId = normalizeChatId(branchChatId);
  const normalizedBranchChatUid = normalizeChatId(branchChatUid);
  if (normalizedBranchChatId === null) return [];

  return records
    .filter((record) =>
      canInheritRecord(record, {
        parentChatId,
        parentChatUid,
        parentBranchUid,
        parentPrefixEnd,
      }),
    )
    .map((record) => {
      const copy = retagChildProvenance({
        ...record,
        source_chat_id: normalizedBranchChatId,
        origin_chat_id: record.origin_chat_id ?? normalizeChatId(parentChatId),
        inherited: true,
        lineage_epoch: epochId,
      }, {
        branchChatId: normalizedBranchChatId,
        branchChatUid: normalizedBranchChatUid,
        epochId,
      });
      if (normalizedBranchChatUid !== null) {
        copy.source_chat_uid = normalizedBranchChatUid;
        if (copy.provenance && typeof copy.provenance === 'object') {
          copy.provenance = {
            ...copy.provenance,
            source_chat_uid: normalizedBranchChatUid,
            source_chat_id: normalizedBranchChatId,
            ...(epochId != null ? { branch_uid: String(epochId) } : {}),
          };
        }
        if (copy.scope && typeof copy.scope === 'object') {
          copy.scope = {
            ...copy.scope,
            chat_uid: normalizedBranchChatUid,
            ...(epochId != null ? { branch_uid: String(epochId) } : {}),
          };
        }
      }
      return copy;
    });
}

/**
 * Builds a clean branch-scoped Storyhold metadata block from a parent's
 * proven prefix. Unproven legacy projections are intentionally omitted so a
 * branch can fall back to an explicit rebuild instead of inheriting guesses.
 */
export function inheritSmartMemoryMetadata(parentSmartMemory = {}, options = {}) {
  const {
    parentChatId,
    parentChatUid = null,
    parentBranchUid =
      parentSmartMemory.lineage?.epoch_id ??
      parentSmartMemory.lineage?.epochId ??
      parentSmartMemory.narrative?.branch_uid ??
      null,
    branchChatId,
    branchChatUid = null,
    parentPrefixEnd,
    branchPrefixLength = parentPrefixEnd + 1,
    branchPrefixMesId = null,
    parentPrefixMesId = branchPrefixMesId,
    epochId = null,
    schemaVersion = parentSmartMemory.schema_version ?? null,
    branchPrefixFingerprint = null,
    branchChatAliases = [],
  } = options;
  const rootChatUid =
    parentSmartMemory.root_chat_uid ?? parentSmartMemory.chat_uid ?? null;
  const chatAliases = [
    ...(Array.isArray(parentSmartMemory.chat_aliases) ? parentSmartMemory.chat_aliases : []),
    ...(Array.isArray(parentSmartMemory.lineage?.aliases) ? parentSmartMemory.lineage.aliases : []),
    ...(Array.isArray(branchChatAliases) ? branchChatAliases : []),
  ]
    .map(normalizeChatId)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
  const prefixLength = Number.isInteger(branchPrefixLength) && branchPrefixLength > 0
    ? branchPrefixLength
    : 0;
  const prefixFingerprint =
    typeof branchPrefixFingerprint === 'string' && branchPrefixFingerprint.trim() !== ''
      ? branchPrefixFingerprint
      : null;
  const recordOptions = {
    parentChatId,
    parentChatUid,
    parentBranchUid,
    branchChatId,
    branchChatUid,
    parentPrefixEnd,
    epochId,
  };
  const result = {
    schema_version: schemaVersion,
    chat_uid: branchChatUid == null ? null : String(branchChatUid),
    ...(rootChatUid != null ? { root_chat_uid: String(rootChatUid) } : {}),
    ...(chatAliases.length > 0 ? { chat_aliases: chatAliases } : {}),
    lastExtractCutoff: prefixLength,
    lastInjectionRefresh: prefixLength,
    product_cursor: {
      window_id: null,
      fingerprint: prefixFingerprint,
      source_range: prefixFingerprint && prefixLength > 0
        ? { kind: 'index', start: 0, end: prefixLength - 1 }
        : null,
      last_mes_id: Number.isInteger(branchPrefixMesId) ? branchPrefixMesId : null,
      last_index: prefixLength > 0 ? prefixLength - 1 : null,
    },
    ingest_windows: {},
    product_status: null,
    sessionMemories: inheritDerivedRecords(parentSmartMemory.sessionMemories, recordOptions),
    storyArcs: inheritDerivedRecords(parentSmartMemory.storyArcs, recordOptions),
    sceneHistory: inheritDerivedRecords(parentSmartMemory.sceneHistory, recordOptions),
    state_ledger: {},
    profiles: {},
    structured_records: inheritStructuredRecordsPrefix(parentSmartMemory.structured_records, {
      parentChatUid: parentSmartMemory.chat_uid ?? parentChatId,
      parentChatId,
      parentBranchUid,
      branchChatUid,
      branchChatId,
      branchUid: epochId,
      parentPrefixEnd: parentPrefixMesId,
    }),
    ...(parentSmartMemory.narrative
      ? {
          narrative: inheritNarrativePrefix(parentSmartMemory.narrative, {
            parentChatUid: parentSmartMemory.narrative.chat_uid ?? parentChatUid,
            parentBranchUid,
            branchChatUid,
            branchUid: epochId,
            parentPrefixEnd: parentPrefixMesId,
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
      source_chat_id: firstPresent(
        fields?._source_chat_id,
        fields?.source_chat_id,
        fields?.chat_id,
        fields?.scope?._source_chat_id,
        fields?.scope?.source_chat_id,
        fields?.scope?.chat_id,
        fields?.provenance?._source_chat_id,
        fields?.provenance?.source_chat_id,
        fields?.provenance?.chat_id,
      ),
      source_chat_uid: firstPresent(
        fields?._source_chat_uid,
        fields?.source_chat_uid,
        fields?.chat_uid,
        fields?.scope?._source_chat_uid,
        fields?.scope?.source_chat_uid,
        fields?.scope?.chat_uid,
        fields?.provenance?._source_chat_uid,
        fields?.provenance?.source_chat_uid,
        fields?.provenance?.chat_uid,
      ),
      source_message_range: firstPresent(
        fields?._source_message_range,
        fields?.source_message_range,
      ),
    };
    if (!canInheritRecord(candidate, {
      parentChatId,
      parentChatUid,
      parentBranchUid,
      parentPrefixEnd,
    })) continue;
    result.state_ledger[key] = retagChildProvenance({
      ...fields,
      _source_chat_id: String(branchChatId),
      _source_chat_uid: branchChatUid != null ? String(branchChatUid) : fields?._source_chat_uid,
      _origin_chat_id: String(parentChatId),
      _inherited: true,
      _lineage_epoch: epochId,
    }, {
      branchChatId,
      branchChatUid,
      epochId,
    });
  }

  for (const [name, profile] of Object.entries(parentSmartMemory.profiles ?? {})) {
    const inherited = inheritDerivedRecords([profile], recordOptions);
    if (inherited.length > 0) result.profiles[name] = inherited[0];
  }

  const summaryCandidate = {
    source_chat_id: parentSmartMemory.summary_source_chat_id,
    source_chat_uid: parentSmartMemory.summary_source_chat_uid,
    lineage_epoch: parentSmartMemory.summary_lineage_epoch,
    source_message_range: parentSmartMemory.summary_source_message_range,
  };
  const summaryRange = parentSmartMemory.summary_source_message_range;
  const summaryFingerprint = parentSmartMemory.summary_source_fingerprint;
  if (
    parentSmartMemory.summary &&
    typeof summaryFingerprint === 'string' &&
    summaryFingerprint.length > 0 &&
    canInheritRecord(summaryCandidate, {
      parentChatId,
      parentChatUid,
      parentBranchUid,
      parentPrefixEnd,
    })
  ) {
    const inheritedSummaryEnd =
      Array.isArray(summaryRange) && Number.isInteger(summaryRange[1])
        ? Math.min(prefixLength, summaryRange[1] + 1)
        : prefixLength;
    result.summary = parentSmartMemory.summary;
    result.summaryUpdated = parentSmartMemory.summaryUpdated;
    result.summaryEnd = inheritedSummaryEnd;
    result.summary_source_chat_id = String(branchChatId);
    result.summary_source_chat_uid = String(branchChatUid);
    result.summary_lineage_epoch = String(epochId);
    result.summary_source_message_range = Array.isArray(summaryRange)
      ? [...summaryRange]
      : [0, Math.max(0, inheritedSummaryEnd - 1)];
    result.summary_source_fingerprint = summaryFingerprint;
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

/** Builds the identity-preserving metadata shell used by a raw branch rebuild. */
export function buildRebuiltLineageMetadata({
  priorSmartMemory = {},
  chatId = null,
  parentChatId = null,
  chatUid = null,
  aliases = [],
  schemaVersion = priorSmartMemory.schema_version ?? null,
  epochId = null,
} = {}) {
  const normalizedChatUid = normalizeChatId(chatUid ?? priorSmartMemory.chat_uid);
  const rootChatUid = normalizeChatId(
    priorSmartMemory.root_chat_uid ?? normalizedChatUid,
  );
  const chatAliases = [
    ...(Array.isArray(priorSmartMemory.chat_aliases) ? priorSmartMemory.chat_aliases : []),
    ...(Array.isArray(priorSmartMemory.lineage?.aliases) ? priorSmartMemory.lineage.aliases : []),
    ...(Array.isArray(aliases) ? aliases : []),
  ]
    .map(normalizeChatId)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
  const lineage = {
    status: LINEAGE_STATUS.REBUILT,
    chat_id: normalizeChatId(chatId),
    chat_uid: normalizedChatUid,
    ...(rootChatUid != null ? { root_chat_uid: rootChatUid } : {}),
    parent_chat_id: normalizeChatId(parentChatId),
    prefix_end: null,
    prefix_length: 0,
    prefix_fingerprint: null,
    method: 'raw-rebuild',
    epoch_id: epochId,
    rebuilt_from_raw: true,
    ...(chatAliases.length > 0 ? { aliases: chatAliases } : {}),
  };
  return {
    schema_version: schemaVersion,
    chat_uid: normalizedChatUid,
    ...(rootChatUid != null ? { root_chat_uid: rootChatUid } : {}),
    ...(chatAliases.length > 0 ? { chat_aliases: chatAliases } : {}),
    lastExtractCutoff: 0,
    lastInjectionRefresh: 0,
    product_cursor: null,
    narrative: null,
    structured_records: [],
    ingest_windows: {},
    product_status: null,
    lineage,
  };
}

export function buildIndependentChatTreeMetadata({
  priorSmartMemory = {},
  chatId = null,
  chatUid = null,
  aliases = [],
  schemaVersion = priorSmartMemory.schema_version ?? null,
} = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedChatUid = normalizeChatId(chatUid ?? priorSmartMemory.chat_uid);
  const chatAliases = [
    ...(Array.isArray(priorSmartMemory.chat_aliases) ? priorSmartMemory.chat_aliases : []),
    ...(Array.isArray(aliases) ? aliases : []),
  ]
    .map(normalizeChatId)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
  const lineage = {
    status: LINEAGE_STATUS.STANDALONE,
    quarantined: false,
    chat_id: normalizedChatId,
    chat_uid: normalizedChatUid,
    method: 'independent-chat-tree',
  };
  return {
    schema_version: schemaVersion,
    ...(normalizedChatUid != null ? { chat_uid: normalizedChatUid, root_chat_uid: normalizedChatUid } : {}),
    ...(chatAliases.length > 0 ? { chat_aliases: chatAliases } : {}),
    lastExtractCutoff: 0,
    lastInjectionRefresh: 0,
    product_cursor: null,
    narrative: null,
    structured_records: [],
    ingest_windows: {},
    product_status: null,
    lineage,
  };
}

export function classifyIndependentChatTree({
  chatId,
  chatUid = null,
  legacyChatIds = [],
  chat,
} = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedChatUid = normalizeChatId(chatUid);
  const normalizedLegacyChatIds = [...new Set(legacyChatIds.map(normalizeChatId).filter(Boolean))];
  const hasRealMesIds = chatHasRealMesIds(chat);
  if (normalizedChatId === null || normalizedChatUid === null) {
    return {
      status: LINEAGE_STATUS.MISSING_IDENTITY,
      quarantined: true,
      chatId: normalizedChatId,
      parentChatId: null,
      hasRealMesIds,
      ...(normalizedChatUid !== null ? { chatUid: normalizedChatUid } : {}),
      ...(normalizedLegacyChatIds.length > 0 ? { legacyChatIds: normalizedLegacyChatIds } : {}),
    };
  }
  return {
    status: LINEAGE_STATUS.STANDALONE,
    quarantined: false,
    chatId: normalizedChatId,
    parentChatId: null,
    hasRealMesIds,
    chatUid: normalizedChatUid,
    ...(normalizedLegacyChatIds.length > 0 ? { legacyChatIds: normalizedLegacyChatIds } : {}),
  };
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
  if (normalizedChatId === null || normalizedChatUid === null) {
    return {
      status: LINEAGE_STATUS.MISSING_IDENTITY,
      quarantined: true,
      chatId: normalizedChatId,
      parentChatId: normalizedParentChatId,
      hasRealMesIds,
      ...(normalizedChatUid !== null ? { chatUid: normalizedChatUid } : {}),
      ...(normalizedLegacyChatIds.length > 0 ? { legacyChatIds: normalizedLegacyChatIds } : {}),
    };
  }
  if (lineage?.quarantined === true) {
    return {
      ...lineage,
      status: lineage.status ?? LINEAGE_STATUS.UNVERIFIED_BRANCH,
      quarantined: true,
      chatId: normalizedChatId,
      chatUid: normalizedChatUid,
      parentChatId: normalizedParentChatId,
      hasRealMesIds,
      ...(normalizedLegacyChatIds.length > 0 ? { legacyChatIds: normalizedLegacyChatIds } : {}),
    };
  }
  const storedParentChatId = normalizeChatId(lineage?.parent_chat_id);
  const isCrossFile =
    (normalizedParentChatId !== null && normalizedParentChatId !== normalizedChatId) ||
    (storedParentChatId !== null && storedParentChatId !== normalizedChatId);

  if (!isCrossFile) {
    const storedBranchMetadata =
      lineage?.quarantined === true ||
      [
        LINEAGE_STATUS.VERIFIED_PREFIX,
        LINEAGE_STATUS.REBUILT,
        LINEAGE_STATUS.MANUAL_LINKED,
        LINEAGE_STATUS.UNVERIFIED_BRANCH,
        LINEAGE_STATUS.MESID_LESS_BRANCH,
      ].includes(lineage?.status);
    if (storedBranchMetadata) {
      return {
        status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
        quarantined: true,
        chatId: normalizedChatId,
        parentChatId: normalizedParentChatId,
        hasRealMesIds,
        ...(normalizedChatUid !== null ? { chatUid: normalizedChatUid } : {}),
        ...(normalizedLegacyChatIds.length > 0 ? { legacyChatIds: normalizedLegacyChatIds } : {}),
        ...(lineage?.epoch_id != null ? { epoch_id: lineage.epoch_id } : {}),
      };
    }
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

  const lineageChatMatches = lineageIdentityMatches(
    lineage,
    normalizedChatId,
    normalizedChatUid,
  );
  const verifiedLineage =
    lineage?.status === LINEAGE_STATUS.VERIFIED_PREFIX &&
    lineageChatMatches &&
    normalizeChatId(lineage.parent_chat_id) === normalizedParentChatId &&
    verifiedPrefixMatchesLiveChat(lineage, chat);
  const rebuiltLineage =
    lineage?.status === LINEAGE_STATUS.REBUILT &&
    lineageChatMatches &&
    normalizeChatId(lineage.parent_chat_id) === normalizedParentChatId &&
    lineage.rebuilt_from_raw === true;
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
      ...(lineage?.epoch_id != null ? { epoch_id: lineage.epoch_id } : {}),
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
export function filterDerivedRecordsForChat(
  records,
  chatId,
  lineage = {},
  { requireExplicitChat = false, requireStableChatUid = false } = {},
) {
  if (!Array.isArray(records) || lineage.quarantined) return [];

  const normalizedChatId = normalizeChatId(chatId);
  if (normalizedChatId === null) return [];
  const allowedChatIds = new Set([
    normalizedChatId,
    ...(lineage.legacyChatIds ?? []).map(normalizeChatId),
  ].filter(Boolean));
  return records.filter((record) => {
    const sourceChatIds = [
      record?.source_chat_id,
      record?._source_chat_id,
      record?.chat_id,
      record?.scope?.chat_id,
      record?.scope?.source_chat_id,
      record?.scope?._source_chat_id,
      record?.provenance?.source_chat_id,
      record?.provenance?.chat_id,
      record?.provenance?._source_chat_id,
    ]
      .map(normalizeChatId)
      .filter(Boolean);
    const sourceChatUids = [
      record?.source_chat_uid,
      record?._source_chat_uid,
      record?.chat_uid,
      record?.scope?.chat_uid,
      record?.scope?.source_chat_uid,
      record?.scope?._source_chat_uid,
      record?.provenance?.source_chat_uid,
      record?.provenance?.chat_uid,
      record?.provenance?._source_chat_uid,
    ]
      .map(normalizeChatId)
      .filter(Boolean);
    const expectedBranchUid = normalizeChatId(
      lineage?.branchUid ?? lineage?.branch_uid ?? lineage?.epoch_id ?? lineage?.epochId,
    );
    const sourceBranchUids = explicitBranchUids(record);
    const branchRequired =
      expectedBranchUid !== null &&
      [LINEAGE_STATUS.VERIFIED_PREFIX, LINEAGE_STATUS.REBUILT, LINEAGE_STATUS.MANUAL_LINKED].includes(
        lineage?.status,
      );
    if (sourceChatIds.some((value) => !allowedChatIds.has(value))) return false;
    if (
      sourceChatUids.some(
        (value) => lineage?.chatUid == null || value !== normalizeChatId(lineage.chatUid),
      )
    ) return false;
    if (
      (expectedBranchUid === null && sourceBranchUids.length > 0) ||
      expectedBranchUid !== null &&
      (sourceBranchUids.some((value) => value !== expectedBranchUid) ||
        (branchRequired && sourceBranchUids.length === 0))
    ) return false;
    if (requireExplicitChat && sourceChatIds.length === 0 && sourceChatUids.length === 0) return false;
    if (requireStableChatUid && sourceChatUids.length === 0) return false;
    return sourceChatIds.length > 0 || sourceChatUids.length > 0 || normalizedChatId !== null;
  });
}
