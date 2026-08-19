import { chatHasRealMesIds } from './branch-aware.js';

/**
 * Runtime lineage states. A branch is trusted only after a later branch
 * operation records a verified shared-prefix boundary.
 */
export const LINEAGE_STATUS = Object.freeze({
  STANDALONE: 'standalone',
  MESID_LESS_BRANCH: 'mesid-less-branch',
  UNVERIFIED_BRANCH: 'unverified-branch',
  VERIFIED_PREFIX: 'verified-prefix',
});

function normalizeChatId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
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
export function classifyChatLineage({ chatId, parentChatId, chat, lineage = null } = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const normalizedParentChatId = normalizeChatId(parentChatId);
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
    };
  }

  const verifiedPrefix =
    lineage?.status === LINEAGE_STATUS.VERIFIED_PREFIX &&
    normalizeChatId(lineage.chat_id) === normalizedChatId &&
    normalizeChatId(lineage.parent_chat_id) === normalizedParentChatId &&
    Number.isInteger(lineage.prefix_end) &&
    lineage.prefix_end >= -1;

  if (verifiedPrefix) {
    return {
      status: LINEAGE_STATUS.VERIFIED_PREFIX,
      quarantined: false,
      chatId: normalizedChatId,
      parentChatId: normalizedParentChatId,
      hasRealMesIds,
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
  return records.filter((record) => {
    const sourceChatId = normalizeChatId(record?.source_chat_id);
    if (sourceChatId === null) return normalizedChatId !== null;
    return sourceChatId === normalizedChatId;
  });
}
