import {
  getCurrentChatId,
  saveSettingsDebounced,
} from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { MODULE_NAME, META_KEY, SCHEMA_VERSION, generateMemoryId } from './constants.js';
import { isPerChatScope } from './scope.js';
import { LINEAGE_STATUS } from './lineage.js';
import { retagNarrativeChatUid, narrativeIdentityMatches } from './narrative-chain.js';
import {
  emptyRollbackArchive,
  listChatMemoryNamespaces,
  listRollbackArchives,
  nukeAllChatNamespaces,
  nukeChatNamespaces,
} from './chat-memory-manager.js';
import {
  auditNamespaces,
  canRelinkCandidate,
  NAMESPACE_STATUS,
  archiveNamespace,
  canonicalTranscriptFingerprint,
  relinkNamespace,
  retagChatMetadata,
  stableChatIdentity,
  unlinkNamespace,
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

function cloneData(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function commitNamespaceStore(target, staged) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, staged);
}

/**
 * Ensures stable chat identity and migrates the current filename-keyed
 * namespace to that identity. Exact transcript matches may be relinked;
 * legacy-only candidates remain visible to the audit/recovery UI.
 */
export async function ensureStableChatIdentity() {
  if (!isPerChatScope()) return null;
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
  if (meta.narrative) {
    const currentBranchUid =
      meta.lineage?.branchUid ??
      meta.lineage?.branch_uid ??
      meta.lineage?.epoch_id ??
      meta.lineage?.epochId ??
      meta.branch_uid ??
      null;
    if (
      !narrativeIdentityMatches(meta.narrative, {
        chatUid: meta.chat_uid,
        chatId,
        branchUid: currentBranchUid,
        requireChat: true,
        requireBranch: currentBranchUid != null,
      })
    ) {
      meta.narrative = null;
      meta.lineage = {
        ...(meta.lineage ?? {}),
        status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
        quarantined: true,
        reason: 'narrative-provenance-mismatch',
      };
      metadataChanged = true;
    } else {
      const retaggedNarrative = retagNarrativeChatUid(meta.narrative, {
        chatUid: meta.chat_uid,
        branchUid: currentBranchUid,
      });
      if (JSON.stringify(retaggedNarrative) !== JSON.stringify(meta.narrative)) {
        meta.narrative = retaggedNarrative;
        metadataChanged = true;
      }
    }
  }
  context.chatMetadata[META_KEY] = meta;

  if (store) {
    const targetKey = String(identity.chat_uid);
    const currentKey = String(chatId);
    if (!store[targetKey] && store[currentKey]) {
      if (store[currentKey]?.transcript_fingerprint === fingerprint) {
        const moved = relinkNamespace(store, currentKey, targetKey, {
          chat_id: chatId,
          transcript_fingerprint: fingerprint,
          relinked_at: Date.now(),
        });
        settingsChanged = moved.ok || settingsChanged;
      } else {
        // An unproven filename namespace stays visible to the audit/recovery path.
      }
    } else if (store[targetKey]) {
      const target = store[targetKey];
      const targetChatId = target.chat_id == null ? null : String(target.chat_id);
      const targetOwnerMatches =
        target.chat_uid === targetKey &&
        (targetChatId === currentKey || aliases.includes(targetChatId));
      const targetFingerprintMatches =
        typeof target.transcript_fingerprint === 'string' &&
        target.transcript_fingerprint.trim() !== '' &&
        target.transcript_fingerprint === fingerprint;
      if (!targetOwnerMatches) {
        meta.lineage = {
          ...(meta.lineage ?? {}),
          status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
          quarantined: true,
          reason: 'stable-namespace-owner-mismatch',
        };
        metadataChanged = true;
      } else if (!targetFingerprintMatches) {
        meta.lineage = {
          ...(meta.lineage ?? {}),
          status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
          quarantined: true,
          reason: 'stable-namespace-fingerprint-mismatch',
        };
        metadataChanged = true;
      } else if (target.chat_id !== currentKey) {
        target.chat_id = currentKey;
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
  if (!isPerChatScope()) {
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
export async function relinkCurrentNamespace(
  namespaceKey,
  { manual = false, abortCheck = null } = {},
) {
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale' };
  const context = getContext();
  const audit = auditCurrentChatNamespaces();
  const store = currentNamespaceStore(context);
  const candidate =
    audit.candidates.find((entry) => entry.key === String(namespaceKey)) ??
    (manual &&
    namespaceKey !== 'archived_chats' &&
    store?.[namespaceKey]
      ? {
          key: String(namespaceKey),
          confidence: 'legacy',
          reason: 'manual-selected-orphan-namespace',
        }
      : null);
  if (!candidate || !canRelinkCandidate(candidate, { manual })) {
    return { ok: false, reason: 'candidate-not-high-confidence', audit };
  }
  const meta = context.chatMetadata?.[META_KEY];
  if (!meta?.chat_uid || !store) return { ok: false, reason: 'stable-identity-missing', audit };
  const stagedStore = cloneData(store);
  const originalMeta = context.chatMetadata[META_KEY];

  const manualEpochId = manual ? generateMemoryId() : null;
  const result = relinkNamespace(stagedStore, candidate.key, meta.chat_uid, {
    chat_id: getCurrentChatId() ?? null,
    transcript_fingerprint: audit.current_fingerprint,
    relinked_at: Date.now(),
    ...(manualEpochId ? { branch_uid: manualEpochId } : {}),
  });
  if (!result.ok) return { ...result, audit };
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale', audit };

  const retaggedMeta = retagChatMetadata(
    meta,
    candidate.key,
    getCurrentChatId() ?? null,
    meta.chat_uid,
    stagedStore[candidate.key]?.chat_uid ?? candidate.key,
    manualEpochId,
  );
  retaggedMeta.chat_aliases = mergeAliases(retaggedMeta, [candidate.key]);
  if (manual) {
    retaggedMeta.lineage = {
      ...(retaggedMeta.lineage ?? {}),
      status: LINEAGE_STATUS.MANUAL_LINKED,
      chat_id: getCurrentChatId() ?? null,
      chat_uid: meta.chat_uid,
      parent_chat_id: retaggedMeta.lineage?.parent_chat_id ?? context.chatMetadata.main_chat ?? null,
      prefix_end: null,
      method: 'manual-full-namespace',
      manual_override: true,
      manual_source_namespace: String(candidate.key),
      epoch_id: manualEpochId,
    };
    retaggedMeta.manual_previous_lineage = meta.lineage ?? null;
  }
  context.chatMetadata[META_KEY] = retaggedMeta;
  const metadataStillStaged = () => context.chatMetadata?.[META_KEY] === retaggedMeta;
  if (abortCheck?.()) {
    if (metadataStillStaged()) context.chatMetadata[META_KEY] = originalMeta;
    return { ok: false, reason: 'operation-stale', audit };
  }
  try {
    await context.saveMetadata();
  } catch (error) {
    if (metadataStillStaged()) context.chatMetadata[META_KEY] = originalMeta;
    throw error;
  }
  if (abortCheck?.()) {
    if (metadataStillStaged()) context.chatMetadata[META_KEY] = originalMeta;
    return { ok: false, reason: 'operation-stale', audit };
  }
  // The shared namespace store was staged on a clone, so no stale await can
  // leave relinked data installed globally. Commit only after metadata save and
  // the final currentness check have both succeeded.
  commitNamespaceStore(store, stagedStore);
  saveSettingsDebounced();
  return { ...result, audit: auditCurrentChatNamespaces() };
}

/**
 * Archives a selected legacy/unsafe candidate. Ambiguous and high-confidence
 * candidates are refused so cleanup cannot destroy a recoverable namespace.
 */
export async function archiveCurrentNamespace(
  namespaceKey,
  reason = 'manual-orphan-archive',
  abortCheck = null,
) {
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale' };
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
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale', audit };
  const result = archiveNamespace(store, candidate.key, { reason });
  if (!result.ok) return { ...result, audit };
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale', audit };
  saveSettingsDebounced();
  return { ...result, audit: auditCurrentChatNamespaces() };
}

function chatMemoryManagerState() {
  if (!isPerChatScope()) {
    return { status: 'not-per-chat-scope', active: [], archives: [] };
  }
  const context = getContext();
  const meta = context?.chatMetadata?.[META_KEY] ?? {};
  const store = currentNamespaceStore(context) ?? {};
  return {
    status: 'ok',
    manual_linked: meta.lineage?.status === LINEAGE_STATUS.MANUAL_LINKED,
    manual_source_namespace: meta.lineage?.manual_source_namespace ?? null,
    active: listChatMemoryNamespaces(store, {
      currentChatUid: meta.chat_uid ?? null,
      currentChatId: getCurrentChatId() ?? null,
    }),
    archives: listRollbackArchives(store),
  };
}

/** Returns metadata-only active namespaces and rollback entries for the character. */
export function listCurrentCharacterChatMemory() {
  return chatMemoryManagerState();
}

/** Permanently nukes selected active derived namespaces; raw chats/vectors are untouched. */
export function nukeCurrentCharacterChatMemory(keys = [], abortCheck = null) {
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale', state: chatMemoryManagerState() };
  if (!isPerChatScope()) {
    return { ok: false, reason: 'not-per-chat-scope', state: chatMemoryManagerState() };
  }
  const store = currentNamespaceStore(getContext());
  const result = nukeChatNamespaces(store, keys);
  saveSettingsDebounced();
  return { ok: true, ...result, state: chatMemoryManagerState() };
}

/** Permanently nukes every active chat namespace for the current character. */
export function nukeAllCurrentCharacterChatMemory(abortCheck = null) {
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale', state: chatMemoryManagerState() };
  if (!isPerChatScope()) {
    return { ok: false, reason: 'not-per-chat-scope', state: chatMemoryManagerState() };
  }
  const store = currentNamespaceStore(getContext());
  const result = nukeAllChatNamespaces(store);
  saveSettingsDebounced();
  return { ok: true, ...result, state: chatMemoryManagerState() };
}

/** Permanently empties the rollback archive for the current character. */
export function emptyCurrentCharacterRollbackArchive(abortCheck = null) {
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale', state: chatMemoryManagerState() };
  if (!isPerChatScope()) {
    return { ok: false, reason: 'not-per-chat-scope', state: chatMemoryManagerState() };
  }
  const store = currentNamespaceStore(getContext());
  const result = emptyRollbackArchive(store);
  saveSettingsDebounced();
  return { ok: true, ...result, state: chatMemoryManagerState() };
}

/** Undoes a force link, archives the imported target, and restores prior lineage. */
export async function unlinkCurrentManualMemory(abortCheck = null) {
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale' };
  const context = getContext();
  const meta = context?.chatMetadata?.[META_KEY];
  if (meta?.lineage?.status !== LINEAGE_STATUS.MANUAL_LINKED) {
    return { ok: false, reason: 'no-manual-link', state: chatMemoryManagerState() };
  }
  const store = currentNamespaceStore(context);
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale', state: chatMemoryManagerState() };
  const stagedStore = cloneData(store);
  const originalMeta = context.chatMetadata[META_KEY];
  const result = unlinkNamespace(stagedStore, meta.chat_uid, { reason: 'manual-link-undone' });
  if (!result.ok) return { ...result, state: chatMemoryManagerState() };
  if (abortCheck?.()) return { ok: false, reason: 'operation-stale', state: chatMemoryManagerState() };

  const stagedMeta = cloneData(meta);
  if (stagedMeta.manual_previous_lineage) {
    stagedMeta.lineage = stagedMeta.manual_previous_lineage;
  } else {
    delete stagedMeta.lineage;
  }
  delete stagedMeta.manual_previous_lineage;
  context.chatMetadata[META_KEY] = stagedMeta;
  const metadataStillStaged = () => context.chatMetadata?.[META_KEY] === stagedMeta;
  try {
    await context.saveMetadata();
  } catch (error) {
    if (metadataStillStaged()) context.chatMetadata[META_KEY] = originalMeta;
    throw error;
  }
  if (abortCheck?.()) {
    if (metadataStillStaged()) context.chatMetadata[META_KEY] = originalMeta;
    return { ok: false, reason: 'operation-stale', state: chatMemoryManagerState() };
  }
  commitNamespaceStore(store, stagedStore);
  saveSettingsDebounced();
  return { ok: true, ...result, state: chatMemoryManagerState() };
}
