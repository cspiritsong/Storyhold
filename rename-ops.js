import {
  getCurrentChatId,
  saveSettingsDebounced,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, SCHEMA_VERSION, generateMemoryId } from './constants.js';
import { MEMORY_SCOPE_CHAT } from './scope-core.js';
import {
  auditNamespaces,
  NAMESPACE_STATUS,
  archiveNamespace,
  canonicalTranscriptFingerprint,
  relinkNamespace,
  retagChatMetadata,
  stableChatIdentity,
} from './rename-recovery.js';

function currentCharacterName(context) {
  return context?.name2 || context?.characterName || null;
}

function currentNamespaceStore(context, create = false) {
  const characterName = currentCharacterName(context);
  const characters = extension_settings[MODULE_NAME]?.characters;
  if (!characterName || !characters?.[characterName]) return null;
  const base = characters[characterName];
  if (!base.chats || typeof base.chats !== 'object') {
    if (!create) return null;
    base.chats = {};
  }
  return base.chats;
}

function mergeAliases(meta, values) {
  const aliases = new Set(Array.isArray(meta.chat_aliases) ? meta.chat_aliases.map(String) : []);
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const normalized = String(value);
    if (normalized !== String(meta.chat_id ?? '')) aliases.add(normalized);
  }
  return [...aliases];
}

/**
 * Ensures stable chat identity and migrates the current filename-keyed
 * namespace to that identity. Exact transcript matches may be relinked;
 * legacy-only candidates remain visible to the audit/recovery UI.
 */
export async function ensureStableChatIdentity() {
  if (extension_settings[MODULE_NAME]?.memory_scope !== MEMORY_SCOPE_CHAT) return null;
  const context = getContext();
  const chatId = getCurrentChatId() ?? null;
  if (!context?.chatMetadata || chatId == null) return null;

  const meta = context.chatMetadata[META_KEY] ?? {};
  const fingerprint = canonicalTranscriptFingerprint(context.chat ?? []);
  const legacySeeds = [
    meta.chat_id,
    meta.previous_chat_id,
    meta.lineage?.chat_id,
    ...(meta.legacy_chat_ids ?? []),
  ];
  const identity = stableChatIdentity(meta, chatId, fingerprint, generateMemoryId);
  const previousChatId = meta.chat_id ?? null;
  const store = currentNamespaceStore(context, true);
  let settingsChanged = false;
  let metadataChanged = false;

  if (meta.chat_uid !== identity.chat_uid) {
    meta.chat_uid = identity.chat_uid;
    metadataChanged = true;
  }
  if (meta.chat_id !== identity.chat_id) {
    if (previousChatId && previousChatId !== identity.chat_id) meta.previous_chat_id = previousChatId;
    meta.chat_id = identity.chat_id;
    metadataChanged = true;
  }
  if (meta.transcript_fingerprint !== fingerprint) {
    meta.transcript_fingerprint = fingerprint;
    metadataChanged = true;
  }
  const aliases = mergeAliases(meta, legacySeeds);
  if (JSON.stringify(meta.chat_aliases ?? []) !== JSON.stringify(aliases)) {
    meta.chat_aliases = aliases;
    metadataChanged = true;
  }
  meta.schema_version = Math.max(meta.schema_version ?? 0, SCHEMA_VERSION);
  context.chatMetadata[META_KEY] = meta;

  if (store) {
    const targetKey = String(identity.chat_uid);
    const currentKey = String(chatId);
    if (!store[targetKey] && store[currentKey]) {
      const moved = relinkNamespace(store, currentKey, targetKey, {
        chat_id: chatId,
        transcript_fingerprint: fingerprint,
        relinked_at: Date.now(),
      });
      settingsChanged = moved.ok || settingsChanged;
    } else if (store[targetKey]) {
      const target = store[targetKey];
      if (target.chat_uid !== targetKey || target.chat_id !== currentKey || target.transcript_fingerprint !== fingerprint) {
        target.chat_uid = targetKey;
        target.chat_id = currentKey;
        target.transcript_fingerprint = fingerprint;
        settingsChanged = true;
      }
    }
  }

  if (metadataChanged) await context.saveMetadata();
  if (settingsChanged) saveSettingsDebounced();

  return {
    ...identity,
    fingerprint,
    audit: auditCurrentChatNamespaces(),
    metadataChanged,
    settingsChanged,
  };
}

/**
 * Read-only metadata audit for the active character/chat.
 */
export function auditCurrentChatNamespaces() {
  if (extension_settings[MODULE_NAME]?.memory_scope !== MEMORY_SCOPE_CHAT) {
    return { status: 'not-per-chat-scope', candidates: [], namespaces: [] };
  }
  const context = getContext();
  const chatId = getCurrentChatId() ?? null;
  const meta = context?.chatMetadata?.[META_KEY] ?? {};
  const store = currentNamespaceStore(context) ?? {};
  return auditNamespaces({
    currentChatId: chatId,
    currentChatUid: meta.chat_uid ?? null,
    currentFingerprint:
      meta.transcript_fingerprint ?? canonicalTranscriptFingerprint(context?.chat ?? []),
    activeMetadata: meta,
    namespaces: store,
  });
}

/**
 * Relinks only an exact-fingerprint candidate selected from the audit result.
 */
export async function relinkCurrentNamespace(namespaceKey) {
  const context = getContext();
  const audit = auditCurrentChatNamespaces();
  const candidate = audit.candidates.find((entry) => entry.key === String(namespaceKey));
  if (!candidate || candidate.confidence !== 'high') {
    return { ok: false, reason: 'candidate-not-high-confidence', audit };
  }
  const meta = context.chatMetadata?.[META_KEY];
  const store = currentNamespaceStore(context);
  if (!meta?.chat_uid || !store) return { ok: false, reason: 'stable-identity-missing', audit };

  const result = relinkNamespace(store, candidate.key, meta.chat_uid, {
    chat_id: getCurrentChatId() ?? null,
    transcript_fingerprint: audit.current_fingerprint,
    relinked_at: Date.now(),
  });
  if (!result.ok) return { ...result, audit };

  const retaggedMeta = retagChatMetadata(
    meta,
    candidate.key,
    getCurrentChatId() ?? null,
    meta.chat_uid,
  );
  retaggedMeta.chat_aliases = mergeAliases(retaggedMeta, [candidate.key]);
  context.chatMetadata[META_KEY] = retaggedMeta;
  await context.saveMetadata();
  saveSettingsDebounced();
  return { ...result, audit: auditCurrentChatNamespaces() };
}

/**
 * Archives a selected legacy/unsafe candidate. Ambiguous and high-confidence
 * candidates are refused so cleanup cannot destroy a recoverable namespace.
 */
export async function archiveCurrentNamespace(namespaceKey, reason = 'manual-orphan-archive') {
  const audit = auditCurrentChatNamespaces();
  const candidate = audit.candidates.find((entry) => entry.key === String(namespaceKey));
  if (!candidate) return { ok: false, reason: 'candidate-missing', audit };
  if (candidate.confidence === 'high') {
    return { ok: false, reason: 'relink-high-confidence-candidate', audit };
  }
  if (![NAMESPACE_STATUS.ORPHANED, NAMESPACE_STATUS.UNSAFE].includes(audit.status)) {
    return { ok: false, reason: 'archive-status-not-safe', audit };
  }

  const context = getContext();
  const store = currentNamespaceStore(context);
  const result = archiveNamespace(store, candidate.key, { reason });
  if (!result.ok) return { ...result, audit };
  saveSettingsDebounced();
  return { ...result, audit: auditCurrentChatNamespaces() };
}
