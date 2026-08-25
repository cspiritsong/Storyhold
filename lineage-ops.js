import { getCurrentChatId, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { META_KEY, MODULE_NAME, SCHEMA_VERSION, generateMemoryId } from './constants.js';
import {
  CHARACTER_TIER_KEYS,
  getScopedContainer,
  MEMORY_SCOPE_CHAT,
} from './scope-core.js';
import {
  buildVerifiedPrefixLineage,
  classifyChatLineage,
  inheritDerivedRecords,
  inheritSmartMemoryMetadata,
} from './lineage.js';

async function loadParentChat(parentChatId) {
  const context = getContext();
  if (context.groupId || !parentChatId) return null;

  const characterName = context.name2 || context.characterName;
  const character = context.characters?.find((entry) => entry.name === characterName);
  if (!characterName || !character?.avatar) return null;

  const response = await fetch('/api/chats/get', {
    method: 'POST',
    headers: getRequestHeaders(),
    cache: 'no-cache',
    body: JSON.stringify({
      ch_name: characterName,
      file_name: parentChatId,
      avatar_url: character.avatar,
    }),
  });
  if (!response.ok) return null;

  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const header = payload.shift();
  return {
    chat: payload,
    chatMetadata: header?.chat_metadata ?? {},
  };
}

function resetBranchContainer(characterName, branchChatId, inheritedMemories) {
  const store = extension_settings[MODULE_NAME]?.characters;
  if (!store || !characterName || !branchChatId) {
    return 0;
  }

  const container = getScopedContainer(
    store,
    characterName,
    branchChatId,
    MEMORY_SCOPE_CHAT,
    SCHEMA_VERSION,
  );
  for (const key of CHARACTER_TIER_KEYS) delete container[key];
  container.schema_version = SCHEMA_VERSION;
  container.memories = inheritedMemories;
  return inheritedMemories.length;
}

/**
 * Verifies and adopts a branch's shared prefix without switching the active
 * SillyTavern chat. Returns null when the parent cannot be safely inspected.
 */
export async function verifyAndInheritCurrentBranch(isCurrent = () => true) {
  const context = getContext();
  const branchChatId = getCurrentChatId() ?? null;
  const branchMetadata = context.chatMetadata;
  const parentChatId = context.chatMetadata?.main_chat ?? null;
  if (!branchChatId || !parentChatId || context.groupId) {
    return null;
  }

  if (!context.chatMetadata) context.chatMetadata = {};

  const parent = await loadParentChat(parentChatId);
  if (
    !parent ||
    getCurrentChatId() !== branchChatId ||
    context.chatMetadata !== branchMetadata ||
    (typeof isCurrent === 'function' && !isCurrent())
  ) return null;

  const parentSmartMemory = parent.chatMetadata?.[META_KEY] ?? {};
  const branchSmartMemory = context.chatMetadata?.[META_KEY] ?? {};
  const branchChatUid = context.chatMetadata?.[META_KEY]?.chat_uid ?? null;
  const parentChatUid = parentSmartMemory.chat_uid ?? null;
  if (!branchChatUid || !parentChatUid || branchChatUid === parentChatUid) return null;
  const inheritedAliases = [
    ...(Array.isArray(parentSmartMemory.chat_aliases) ? parentSmartMemory.chat_aliases : []),
    ...(Array.isArray(parentSmartMemory.lineage?.aliases) ? parentSmartMemory.lineage.aliases : []),
    ...(Array.isArray(branchSmartMemory.chat_aliases) ? branchSmartMemory.chat_aliases : []),
  ];
  const epochId = generateMemoryId();
  const lineage = buildVerifiedPrefixLineage({
    chatId: branchChatId,
    chatUid: branchChatUid,
    parentChatId,
    parentChat: parent.chat,
    branchChat: context.chat,
    epochId,
    rootChatUid: parentSmartMemory.root_chat_uid ?? parentSmartMemory.chat_uid ?? null,
    aliases: inheritedAliases,
  });
  if (lineage.status !== 'verified-prefix') return null;

  const branchPrefixMesId = context.chat[lineage.prefix_end]?.mesId;
  const parentPrefixMesId = parent.chat[lineage.prefix_end]?.mesId;
  const inheritedSmartMemory = inheritSmartMemoryMetadata(parentSmartMemory, {
    parentChatId,
    parentChatUid,
    branchChatId,
    branchChatUid,
    parentPrefixEnd: lineage.prefix_end,
    branchPrefixLength: lineage.prefix_length,
    branchPrefixMesId: typeof branchPrefixMesId === 'number' ? branchPrefixMesId : null,
    parentPrefixMesId: typeof parentPrefixMesId === 'number' ? parentPrefixMesId : null,
    epochId,
    schemaVersion: SCHEMA_VERSION,
    branchPrefixFingerprint: lineage.prefix_fingerprint,
    branchChatAliases: branchSmartMemory.chat_aliases ?? [],
  });

  const characterName = context.name2 || context.characterName;
  const parentContainer =
    extension_settings[MODULE_NAME]?.characters?.[characterName]?.chats?.[parentChatUid] ?? {};
  const inheritedMemories = inheritDerivedRecords(parentContainer.memories, {
    parentChatId,
    parentChatUid,
    branchChatId,
    branchChatUid,
    parentPrefixEnd: lineage.prefix_end,
    epochId,
  });
  const inheritedLongtermCount = resetBranchContainer(
    characterName,
    branchChatUid,
    inheritedMemories,
  );

  const inheritedSessionCount = inheritedSmartMemory.sessionMemories.length;
  const inheritedArcCount = inheritedSmartMemory.storyArcs.length;
  const inheritedProfileCount = Object.keys(inheritedSmartMemory.profiles).length;
  inheritedSmartMemory.lineage = {
    ...lineage,
    inherited_counts: {
      longterm: inheritedLongtermCount,
      session: inheritedSessionCount,
      arcs: inheritedArcCount,
      profiles: inheritedProfileCount,
    },
    rebuild_recommended:
      inheritedLongtermCount + inheritedSessionCount + inheritedArcCount + inheritedProfileCount === 0,
  };

  context.chatMetadata[META_KEY] = inheritedSmartMemory;
  await context.saveMetadata();
  saveSettingsDebounced();

  return classifyChatLineage({
    chatId: branchChatId,
    chatUid: branchChatUid,
    legacyChatIds: context.chatMetadata?.[META_KEY]?.chat_aliases ?? [],
    parentChatId,
    chat: context.chat,
    lineage: inheritedSmartMemory.lineage,
  });
}
