import { countNamespaceData } from './rename-recovery.js';

export const ROLLBACK_ARCHIVE_KEY = 'archived_chats';

function isActiveNamespaceKey(key) {
  return String(key) !== ROLLBACK_ARCHIVE_KEY;
}

function memoryCount(container) {
  return countNamespaceData(container).total;
}

/**
 * Lists only active per-chat derived namespaces. Narrative records are never
 * returned; the manager is intentionally metadata-only.
 */
export function listChatMemoryNamespaces(store = {}, { currentChatUid = null, currentChatId = null } = {}) {
  const activeUid = currentChatUid == null ? null : String(currentChatUid);
  const activeId = currentChatId == null ? null : String(currentChatId);
  return Object.entries(store ?? {})
    .filter(([key, container]) => isActiveNamespaceKey(key) && container && typeof container === 'object')
    .map(([key, container]) => {
      const uid = container.chat_uid == null ? null : String(container.chat_uid);
      const linkedTo = container.chat_id == null ? null : String(container.chat_id);
      const current =
        (activeUid !== null && (String(key) === activeUid || uid === activeUid)) ||
        (activeUid === null && activeId !== null && linkedTo === activeId);
      return {
        key: String(key),
        status: linkedTo || uid ? 'linked' : 'orphaned',
        linked_to: linkedTo,
        chat_uid: uid,
        current,
        memory_count: memoryCount(container),
        archived: false,
      };
    });
}

/** Lists rollback entries separately from active retrieval namespaces. */
export function listRollbackArchives(store = {}) {
  return Object.entries(store?.[ROLLBACK_ARCHIVE_KEY] ?? {}).map(([key, entry]) => ({
    key: String(key),
    archived_at: entry?.archived_at ?? null,
    reason: entry?.reason ?? null,
    memory_count: memoryCount(entry?.container ?? {}),
  }));
}

/** Permanently removes selected active derived namespaces only. */
export function nukeChatNamespaces(store, keys = []) {
  if (!store || typeof store !== 'object') return { deleted: [] };
  const deleted = [];
  for (const key of [...new Set(keys.map(String))]) {
    if (!isActiveNamespaceKey(key) || !Object.prototype.hasOwnProperty.call(store, key)) continue;
    delete store[key];
    deleted.push(key);
  }
  return { deleted };
}

/** Permanently removes every active derived namespace, never the rollback archive. */
export function nukeAllChatNamespaces(store) {
  if (!store || typeof store !== 'object') return { deleted: [] };
  return nukeChatNamespaces(
    store,
    Object.keys(store).filter(isActiveNamespaceKey),
  );
}

/** Permanently empties the explicit rollback archive. */
export function emptyRollbackArchive(store) {
  if (!store?.[ROLLBACK_ARCHIVE_KEY] || typeof store[ROLLBACK_ARCHIVE_KEY] !== 'object') {
    return { deleted: [] };
  }
  const deleted = Object.keys(store[ROLLBACK_ARCHIVE_KEY]);
  delete store[ROLLBACK_ARCHIVE_KEY];
  return { deleted };
}
