import { CHARACTER_TIER_KEYS } from './scope-core.js';
import { canonicalMessage, hash32 } from './identity.js';

export const NAMESPACE_STATUS = Object.freeze({
  LINKED: 'linked',
  RENAMED_CANDIDATE: 'renamed-candidate',
  ORPHANED: 'orphaned',
  AMBIGUOUS: 'ambiguous',
  UNSAFE: 'unsafe',
  NO_MATCH: 'no-match',
});

/**
 * Automatic relink requires an exact fingerprint. Legacy candidates may only
 * be relinked after an explicit user confirmation; mismatches are never safe.
 */
export function canRelinkCandidate(candidate, { manual = false } = {}) {
  if (candidate?.confidence === 'high') return true;
  return manual === true && candidate?.confidence === 'legacy';
}

const HASH_SEEDS = [0x811c9dc5, 0x01000193];

/**
 * Canonical fingerprint for rename detection. It intentionally excludes mesId,
 * timestamps, swipes, and filename metadata: a rename should not change it.
 */
export function canonicalTranscriptFingerprint(chat) {
  const messages = Array.isArray(chat) ? chat : [];
  const canonical = messages.map(canonicalMessage).join('\n');
  return `chat-v1:${messages.length}:${hash32(canonical, HASH_SEEDS[0])}:${hash32(canonical, HASH_SEEDS[1])}`;
}

/**
 * Returns the stable metadata identity for a chat without mutating its input.
 */
export function stableChatIdentity(meta = {}, chatId = null, fingerprint = null, uidFactory = null) {
  const existingUid = meta?.chat_uid ?? null;
  const chatUid = existingUid || (uidFactory ? uidFactory() : null);
  return {
    chat_uid: chatUid,
    chat_id: chatId == null ? null : String(chatId),
    transcript_fingerprint: fingerprint,
    created: !existingUid,
  };
}

function nonEmptyCount(value) {
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object') return Object.keys(value).length;
  return String(value).trim() ? 1 : 0;
}

/**
 * Counts derived tiers without returning or inspecting their narrative text.
 */
export function countNamespaceData(container = {}) {
  const counts = {};
  for (const key of CHARACTER_TIER_KEYS) counts[key] = nonEmptyCount(container[key]);
  counts.total = CHARACTER_TIER_KEYS.reduce((sum, key) => sum + counts[key], 0);
  return counts;
}

function addReference(set, value) {
  if (value === null || value === undefined || value === '') return;
  if (Array.isArray(value)) {
    for (const item of value) addReference(set, item);
    return;
  }
  set.add(String(value));
}

function collectLegacyReferences(activeMetadata = {}) {
  const refs = new Set();
  addReference(refs, activeMetadata.lineage?.chat_id);
  addReference(refs, activeMetadata.chat_id_at_creation);
  addReference(refs, activeMetadata.previous_chat_id);
  addReference(refs, activeMetadata.legacy_chat_ids);
  addReference(refs, activeMetadata.chat_aliases);
  addReference(refs, activeMetadata.lineage?.aliases);

  for (const memory of activeMetadata.sessionMemories ?? []) addReference(refs, memory?.source_chat_id);
  for (const arc of activeMetadata.storyArcs ?? []) addReference(refs, arc?.source_chat_id);
  for (const scene of activeMetadata.sceneHistory ?? []) addReference(refs, scene?.source_chat_id);
  for (const profile of Object.values(activeMetadata.profiles ?? {})) {
    addReference(refs, profile?.source_chat_id);
  }
  addReference(refs, activeMetadata.summary_source_chat_id);
  for (const fields of Object.values(activeMetadata.state_ledger ?? {})) {
    addReference(refs, fields?._source_chat_id);
  }
  return refs;
}

function publicCandidate(key, container, confidence, reason) {
  const counts = countNamespaceData(container);
  return {
    key: String(key),
    chat_uid: container?.chat_uid ?? null,
    chat_id: container?.chat_id ?? null,
    transcript_fingerprint: container?.transcript_fingerprint ?? null,
    counts,
    confidence,
    reason,
  };
}

/**
 * Audits one active chat against all namespaces for its character.
 * The result is deliberately metadata-only and safe to show in the UI.
 */
export function auditNamespaces({
  currentChatId = null,
  currentChatUid = null,
  currentFingerprint = null,
  activeMetadata = {},
  namespaces = {},
} = {}) {
  const currentId = currentChatId == null ? null : String(currentChatId);
  const currentUid = currentChatUid == null ? null : String(currentChatUid);
  const legacyRefs = collectLegacyReferences(activeMetadata);
  const all = [];
  const candidates = [];

  for (const [key, container] of Object.entries(namespaces ?? {})) {
    const keyString = String(key);
    if (keyString === 'archived_chats') continue;
    const isCurrent = keyString === currentUid || (!currentUid && keyString === currentId);
    const counts = countNamespaceData(container);
    const isArchived = Boolean(container?.archived_alias || container?.archived_at);
    const summary = {
      key: keyString,
      chat_uid: container?.chat_uid ?? null,
      chat_id: container?.chat_id ?? null,
      counts,
      status: isCurrent ? NAMESPACE_STATUS.LINKED : isArchived ? 'archived-rollback' : 'other-chat',
    };
    all.push(summary);
    if (isCurrent || isArchived || counts.total === 0) continue;

    const isReferenced =
      legacyRefs.has(keyString) ||
      legacyRefs.has(String(container?.chat_id ?? '')) ||
      legacyRefs.has(String(container?.chat_uid ?? ''));
    if (!isReferenced) continue;

    const storedFingerprint = container?.transcript_fingerprint ?? null;
    if (storedFingerprint && currentFingerprint && storedFingerprint !== currentFingerprint) {
      candidates.push(publicCandidate(keyString, container, 'none', 'transcript-fingerprint-mismatch'));
      continue;
    }
    if (storedFingerprint && currentFingerprint && storedFingerprint === currentFingerprint) {
      candidates.push(publicCandidate(keyString, container, 'high', 'exact-transcript-fingerprint'));
      continue;
    }
    candidates.push(
      publicCandidate(
        keyString,
        container,
        'legacy',
        'stale-chat-reference-without-transcript-fingerprint',
      ),
    );
  }

  const exact = candidates.filter((candidate) => candidate.confidence === 'high');
  const mismatched = candidates.filter((candidate) => candidate.confidence === 'none');
  let status = NAMESPACE_STATUS.NO_MATCH;
  if (exact.length === 1 && candidates.length === 1) status = NAMESPACE_STATUS.RENAMED_CANDIDATE;
  else if (exact.length > 1 || (exact.length > 0 && candidates.length > 1)) status = NAMESPACE_STATUS.AMBIGUOUS;
  else if (mismatched.length > 0) status = NAMESPACE_STATUS.UNSAFE;
  else if (candidates.length > 1) status = NAMESPACE_STATUS.AMBIGUOUS;
  else if (candidates.length === 1) status = NAMESPACE_STATUS.ORPHANED;
  else if (all.some((entry) => entry.status === NAMESPACE_STATUS.LINKED)) status = NAMESPACE_STATUS.LINKED;

  return {
    status,
    current_chat_id: currentId,
    current_chat_uid: currentUid,
    current_fingerprint: currentFingerprint,
    candidate_count: candidates.length,
    candidates,
    namespaces: all,
  };
}

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function retagRecord(record, sourceChatId, targetChatId, targetUid) {
  if (!record || typeof record !== 'object') return record;
  const copied = deepClone(record);
  if (copied.source_chat_id != null && String(copied.source_chat_id) === String(sourceChatId)) {
    copied.source_chat_id = String(targetChatId);
    copied.source_chat_uid = String(targetUid);
  }
  if (copied._source_chat_id != null && String(copied._source_chat_id) === String(sourceChatId)) {
    copied._source_chat_id = String(targetChatId);
    copied._source_chat_uid = String(targetUid);
  }
  return copied;
}

function retagNamespace(container, sourceChatId, targetChatId, targetUid) {
  const copied = deepClone(container);
  for (const key of ['memories', 'epistemic_knowledge', 'persistent_arcs', 'entities']) {
    if (Array.isArray(copied[key])) {
      copied[key] = copied[key].map((record) =>
        retagRecord(record, sourceChatId, targetChatId, targetUid),
      );
    }
  }
  return copied;
}

/**
 * Retags derived chat metadata after an exact namespace relink without
 * modifying the raw message array or parent-chat metadata.
 */
export function retagChatMetadata(metadata = {}, sourceChatId, targetChatId, targetUid) {
  const copied = deepClone(metadata);
  for (const key of ['sessionMemories', 'storyArcs', 'sceneHistory']) {
    if (Array.isArray(copied[key])) {
      copied[key] = copied[key].map((record) =>
        retagRecord(record, sourceChatId, targetChatId, targetUid),
      );
    }
  }
  if (copied.profiles && typeof copied.profiles === 'object') {
    copied.profiles = Object.fromEntries(
      Object.entries(copied.profiles).map(([name, profile]) => [
        name,
        retagRecord(profile, sourceChatId, targetChatId, targetUid),
      ]),
    );
  }
  if (copied.state_ledger && typeof copied.state_ledger === 'object') {
    copied.state_ledger = Object.fromEntries(
      Object.entries(copied.state_ledger).map(([name, fields]) => [
        name,
        retagRecord(fields, sourceChatId, targetChatId, targetUid),
      ]),
    );
  }
  if (String(copied.summary_source_chat_id ?? '') === String(sourceChatId)) {
    copied.summary_source_chat_id = String(targetChatId);
  }
  if (String(copied.chat_id ?? '') === String(sourceChatId)) copied.chat_id = String(targetChatId);
  if (String(copied.lineage?.chat_id ?? '') === String(sourceChatId)) {
    copied.lineage = { ...copied.lineage, chat_id: String(targetChatId) };
  }
  copied.chat_uid = String(targetUid);
  return copied;
}

/**
 * Copies a verified source namespace to the stable UID and leaves the source
 * as a rollback/archive marker. It refuses to overwrite an existing target.
 */
export function relinkNamespace(store, sourceKey, targetKey, identity = {}) {
  if (!store || !store[sourceKey]) return { ok: false, reason: 'source-missing' };
  if (!targetKey || sourceKey === targetKey) return { ok: false, reason: 'invalid-target' };
  if (store[targetKey]) return { ok: false, reason: 'target-exists' };

  const source = store[sourceKey];
  const copied = retagNamespace(
    source,
    source.chat_id ?? sourceKey,
    identity.chat_id ?? source.chat_id ?? sourceKey,
    targetKey,
  );
  copied.chat_uid = String(targetKey);
  copied.chat_id = identity.chat_id == null ? null : String(identity.chat_id);
  copied.transcript_fingerprint = identity.transcript_fingerprint ?? copied.transcript_fingerprint ?? null;
  copied.relinked_from = String(sourceKey);
  copied.relinked_at = identity.relinked_at ?? Date.now();

  store[targetKey] = copied;
  store[sourceKey] = {
    ...source,
    archived_alias: String(targetKey),
    archived_at: copied.relinked_at,
    archived_reason: 'relinked-rename-rollback',
  };
  return { ok: true, source_key: String(sourceKey), target_key: String(targetKey) };
}

/**
 * Moves a namespace out of active retrieval while preserving its full derived
 * contents under an explicit archive record. Raw chat files and vectors are
 * outside this store and are never touched.
 */
export function archiveNamespace(store, namespaceKey, { reason = 'manual-archive', archivedAt = Date.now() } = {}) {
  if (!store || !namespaceKey || !store[namespaceKey]) {
    return { ok: false, reason: 'namespace-missing' };
  }
  if (namespaceKey === 'archived_chats') return { ok: false, reason: 'invalid-namespace' };
  if (!store.archived_chats || typeof store.archived_chats !== 'object') {
    store.archived_chats = {};
  }
  if (store.archived_chats[namespaceKey]) return { ok: false, reason: 'archive-exists' };

  store.archived_chats[namespaceKey] = {
    archived_at: archivedAt,
    reason,
    container: deepClone(store[namespaceKey]),
  };
  delete store[namespaceKey];
  return { ok: true, namespace_key: String(namespaceKey), archived_at: archivedAt };
}

/**
 * Undoes a manual/force link by moving the current target namespace to the
 * rollback archive. The original source namespace is not touched.
 */
export function unlinkNamespace(store, namespaceKey, options = {}) {
  return archiveNamespace(store, namespaceKey, {
    reason: options.reason ?? 'manual-link-undone',
    archivedAt: options.archivedAt ?? Date.now(),
  });
}
