/**
 * Smart Memory - SillyTavern Extension (fork: badiyee85/Smart-Memory)
 *
 * Memory scope - one chat-local boundary for all mutable Smart-Memory data.
 *
 * All long-term tier accessors (longterm.js, canon.js, arcs.js, epistemic.js,
 * graph-migration.js) route through getCharacterContainer() / getGroupContainer()
 * so the rest of the extension is unaware of the scope: injection, extraction,
 * UI, and clear paths automatically read and write the scoped container.
 *
 * Pure resolution logic lives in scope-core.js (unit-testable without ST).
 */

import { getCurrentChatId } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, SCHEMA_VERSION } from './constants.js';
import {
  MEMORY_SCOPE_CHAT,
  getScopedContainer,
  deleteScopedContainer,
  resolveChatScopeId,
} from './scope-core.js';

export {
  MEMORY_SCOPE_CHAT,
  pinChatScope,
  unpinChatScope,
} from './scope-core.js';

/**
 * Smart-Memory has one mutable memory boundary: the current chat.
 * Character cards are reference material, not a shared memory store.
 * @returns {string}
 */
export function getMemoryScope() {
  return MEMORY_SCOPE_CHAT;
}

/**
 * Returns true when per-chat isolation is enabled.
 * @returns {boolean}
 */
export function isPerChatScope() {
  return getMemoryScope() === MEMORY_SCOPE_CHAT;
}

/**
 * Returns the current chat id as a string, or null when no chat id is
 * available (e.g. no chat loaded). A missing chat id fails closed so no
 * mutable memory can fall back to a character-level container.
 * @returns {string|null}
 */
export function getChatScopeId() {
  const stableChatUid = getContext()?.chatMetadata?.[META_KEY]?.chat_uid ?? null;
  return resolveChatScopeId(stableChatUid ?? getCurrentChatId());
}

/**
 * Ensures the extension settings store and characters map exist.
 * @returns {Object} The extension_settings[MODULE_NAME] object.
 */
function ensureStore() {
  if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
  if (!extension_settings[MODULE_NAME].characters) {
    extension_settings[MODULE_NAME].characters = {};
  }
  return extension_settings[MODULE_NAME];
}

/**
 * Returns the storage container for the current scope of a character.
 * In chat scope this is characters[characterName].chats[stableChatUid].
 * The stable UID is stored in chat metadata and survives filename changes;
 * the live filename remains available as provenance/alias data.
 * @param {string} characterName
 * @returns {Object|null}
 */
export function getCharacterContainer(characterName) {
  const s = ensureStore();
  const chatId = getChatScopeId();
  if (chatId == null) return null;
  return getScopedContainer(
    s.characters,
    characterName,
    chatId,
    MEMORY_SCOPE_CHAT,
    SCHEMA_VERSION,
  );
}

/**
 * Deletes the storage container for the current scope of a character.
 * In chat scope only the current chat's container is removed.
 * @param {string} characterName
 */
export function deleteCharacterContainer(characterName) {
  const s = ensureStore();
  const chatId = getChatScopeId();
  if (chatId == null) return;
  deleteScopedContainer(s.characters, characterName, chatId, MEMORY_SCOPE_CHAT);
}

/**
 * Returns the storage container for the current scope of a group.
 * In chat scope this is group_arcs[groupId].chats[chatId].
 * @param {string} groupId
 * @returns {Object|null}
 */
export function getGroupContainer(groupId) {
  ensureStore();
  if (!extension_settings[MODULE_NAME].group_arcs) {
    extension_settings[MODULE_NAME].group_arcs = {};
  }
  const chatId = getChatScopeId();
  if (chatId == null) return null;
  return getScopedContainer(
    extension_settings[MODULE_NAME].group_arcs,
    groupId,
    chatId,
    MEMORY_SCOPE_CHAT,
    SCHEMA_VERSION,
  );
}

/**
 * Deletes the storage container for the current scope of a group.
 * @param {string} groupId
 */
export function deleteGroupContainer(groupId) {
  ensureStore();
  if (!extension_settings[MODULE_NAME].group_arcs) return;
  const chatId = getChatScopeId();
  if (chatId == null) return;
  deleteScopedContainer(
    extension_settings[MODULE_NAME].group_arcs,
    groupId,
    chatId,
    MEMORY_SCOPE_CHAT,
  );
}
