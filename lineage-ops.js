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
  if (
    extension_settings[MODULE_NAME]?.memory_scope !== MEMORY_SCOPE_CHAT ||
    !store ||
    !characterName ||
    !branchChatId
  ) {
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
export async function verifyAndInheritCurrentBranch() {
  const context = getContext();
  const branchChatId = getCurrentChatId() ?? null;
  const parentChatId = context.chatMetadata?.main_chat ?? null;
  if (
    extension_settings[MODULE_NAME]?.memory_scope !== MEMORY_SCOPE_CHAT ||
    !branchChatId ||
    !parentChatId ||
    context.groupId
  ) {
    return null;
  }

  if (!context.chatMetadata) context.chatMetadata = {};

  const parent = await loadParentChat(parentChatId);
  if (!parent || getCurrentChatId() !== branchChatId) return null;

  const epochId = generateMemoryId();
  const lineage = buildVerifiedPrefixLineage({
    chatId: branchChatId,
    chatUid: context.chatMetadata?.[META_KEY]?.chat_uid ?? null,
    parentChatId,
    parentChat: parent.chat,
    branchChat: context.chat,
    epochId,
  });
  if (lineage.status !== 'verified-prefix') return null;

  const branchPrefixMesId = context.chat[lineage.prefix_end]?.mesId;
  const parentSmartMemory = parent.chatMetadata?.[META_KEY] ?? {};
  const inheritedSmartMemory = inheritSmartMemoryMetadata(parentSmartMemory, {
    parentChatId,
    branchChatId,
    parentPrefixEnd: lineage.prefix_end,
    branchPrefixLength: lineage.prefix_length,
    branchPrefixMesId: typeof branchPrefixMesId === 'number' ? branchPrefixMesId : null,
    epochId,
    schemaVersion: SCHEMA_VERSION,
  });

  const characterName = context.name2 || context.characterName;
  const parentContainer =
    extension_settings[MODULE_NAME]?.characters?.[characterName]?.chats?.[parentChatId] ?? {};
  const inheritedMemories = inheritDerivedRecords(parentContainer.memories, {
    parentChatId,
    branchChatId,
    parentPrefixEnd: lineage.prefix_end,
    epochId,
  });
  const inheritedLongtermCount = resetBranchContainer(
    characterName,
    branchChatId,
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
    chatUid: context.chatMetadata?.[META_KEY]?.chat_uid ?? null,
    legacyChatIds: context.chatMetadata?.[META_KEY]?.chat_aliases ?? [],
    parentChatId,
    chat: context.chat,
    lineage: inheritedSmartMemory.lineage,
  });
}
