import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAMESPACE_STATUS,
  auditNamespaces,
  archiveNamespace,
  canonicalTranscriptFingerprint,
  countNamespaceData,
  relinkNamespace,
  retagChatMetadata,
  stableChatIdentity,
} from '../rename-recovery.js';

const message = (mes, extra = {}) => ({
  name: extra.name ?? 'Narrator',
  is_user: Boolean(extra.is_user),
  is_system: Boolean(extra.is_system),
  mes,
  mesId: extra.mesId,
});

const chat = [message('You enter the observatory.', { is_user: true, mesId: 1 }), message('The telescope turns.', { mesId: 2 })];

test('transcript fingerprint ignores mutable mesIds but preserves message content and roles', () => {
  const renamed = chat.map((item, index) => ({ ...item, mesId: 100 + index }));
  assert.equal(canonicalTranscriptFingerprint(chat), canonicalTranscriptFingerprint(renamed));
  assert.notEqual(
    canonicalTranscriptFingerprint(chat),
    canonicalTranscriptFingerprint([message('A different scene.', { is_user: true })]),
  );
});

test('stable identity preserves an existing uid and creates one only when absent', () => {
  assert.deepEqual(stableChatIdentity({ chat_uid: 'uid-existing' }, 'new-name', 'fp'), {
    chat_uid: 'uid-existing',
    chat_id: 'new-name',
    transcript_fingerprint: 'fp',
    created: false,
  });

  const created = stableChatIdentity({}, 'new-name', 'fp', () => 'uid-created');
  assert.deepEqual(created, {
    chat_uid: 'uid-created',
    chat_id: 'new-name',
    transcript_fingerprint: 'fp',
    created: true,
  });
});

test('audit identifies a high-confidence renamed namespace without dumping memory text', () => {
  const fingerprint = canonicalTranscriptFingerprint(chat);
  const result = auditNamespaces({
    currentChatId: 'branch-alibaba-kimik3',
    currentChatUid: 'uid-new',
    currentFingerprint: fingerprint,
    activeMetadata: {
      lineage: { chat_id: 'old-branch-name' },
      transcript_fingerprint: fingerprint,
    },
    namespaces: {
      'old-branch-name': {
        chat_id: 'old-branch-name',
        transcript_fingerprint: fingerprint,
        memories: [{ id: 'm1', content: 'private fact' }],
      },
    },
  });

  assert.equal(result.status, NAMESPACE_STATUS.RENAMED_CANDIDATE);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].key, 'old-branch-name');
  assert.equal(result.candidates[0].confidence, 'high');
  assert.equal('content' in result.candidates[0], false);
});

test('audit refuses to relink a namespace with a different transcript', () => {
  const result = auditNamespaces({
    currentChatId: 'renamed',
    currentChatUid: 'uid-new',
    currentFingerprint: canonicalTranscriptFingerprint(chat),
    activeMetadata: { lineage: { chat_id: 'old-name' } },
    namespaces: {
      'old-name': {
        chat_id: 'old-name',
        transcript_fingerprint: canonicalTranscriptFingerprint([message('unrelated')]),
        memories: [{ id: 'm1', content: 'foreign' }],
      },
    },
  });

  assert.equal(result.status, NAMESPACE_STATUS.UNSAFE);
  assert.equal(result.candidates[0].confidence, 'none');
});

test('multiple stale namespaces are ambiguous and cannot be auto-relinked', () => {
  const fingerprint = canonicalTranscriptFingerprint(chat);
  const result = auditNamespaces({
    currentChatId: 'renamed',
    currentChatUid: 'uid-new',
    currentFingerprint: fingerprint,
    activeMetadata: {
      legacy_chat_ids: ['old-a', 'old-b'],
      transcript_fingerprint: fingerprint,
    },
    namespaces: {
      'old-a': { transcript_fingerprint: fingerprint, memories: [{ id: 'a' }] },
      'old-b': { transcript_fingerprint: fingerprint, memories: [{ id: 'b' }] },
    },
  });

  assert.equal(result.status, NAMESPACE_STATUS.AMBIGUOUS);
  assert.equal(result.candidates.length, 2);
});

test('relink copies the namespace, stamps the new identity, and leaves source for rollback', () => {
  const source = {
    chat_id: 'old-name',
    transcript_fingerprint: 'fp',
    memories: [{ id: 'm1', content: 'private fact', source_chat_id: 'old-name' }],
  };
  const store = { 'old-name': source };
  const result = relinkNamespace(store, 'old-name', 'uid-new', {
    chat_id: 'renamed',
    transcript_fingerprint: 'fp',
  });

  assert.equal(result.ok, true);
  assert.equal(store['uid-new'].chat_uid, 'uid-new');
  assert.equal(store['uid-new'].chat_id, 'renamed');
  assert.deepEqual(store['uid-new'].memories, [
    {
      id: 'm1',
      content: 'private fact',
      source_chat_id: 'renamed',
      source_chat_uid: 'uid-new',
    },
  ]);
  assert.equal(store['old-name'].archived_alias, 'uid-new');
  assert.equal(store['old-name'].memories[0].content, 'private fact');
});

test('archive moves an orphaned namespace out of active chats but preserves rollback data', () => {
  const store = {
    orphan: { memories: [{ id: 'm1', content: 'private fact' }] },
  };

  const result = archiveNamespace(store, 'orphan', { reason: 'no-safe-relink' });

  assert.equal(result.ok, true);
  assert.equal(store.orphan, undefined);
  assert.equal(store.archived_chats.orphan.reason, 'no-safe-relink');
  assert.deepEqual(store.archived_chats.orphan.container.memories, [
    { id: 'm1', content: 'private fact' },
  ]);
});

test('retagging chat metadata preserves raw-adjacent fields while updating provenance only', () => {
  const metadata = {
    sessionMemories: [{ id: 's1', content: 'detail', source_chat_id: 'old-name' }],
    summary: 'summary text',
    summary_source_chat_id: 'old-name',
    lineage: { status: 'standalone', chat_id: 'old-name' },
  };

  const retagged = retagChatMetadata(metadata, 'old-name', 'renamed', 'uid-new');

  assert.equal(retagged.sessionMemories[0].source_chat_id, 'renamed');
  assert.equal(retagged.sessionMemories[0].source_chat_uid, 'uid-new');
  assert.equal(retagged.summary, 'summary text');
  assert.equal(retagged.summary_source_chat_id, 'renamed');
  assert.equal(retagged.lineage.chat_id, 'renamed');
  assert.equal(metadata.sessionMemories[0].source_chat_id, 'old-name');
});

test('namespace counts are metadata-only', () => {
  assert.deepEqual(countNamespaceData({
    memories: [{ id: 'm' }],
    relationship_history: { 'A→B': {} },
    canon: 'canon',
    persistent_arcs: [],
    epistemic_knowledge: [],
    entities: [{ id: 'e' }],
  }), {
    memories: 1,
    relationship_history: 1,
    canon: 1,
    persistent_arcs: 0,
    epistemic_knowledge: 0,
    entities: 1,
    total: 4,
  });
});

test('rollback copy is reported as archived, not as a new orphan candidate', () => {
  const fingerprint = canonicalTranscriptFingerprint(chat);
  const result = auditNamespaces({
    currentChatId: 'renamed',
    currentChatUid: 'uid-new',
    currentFingerprint: fingerprint,
    activeMetadata: { chat_aliases: ['old-name'], transcript_fingerprint: fingerprint },
    namespaces: {
      'uid-new': { chat_uid: 'uid-new', transcript_fingerprint: fingerprint, memories: [{ id: 'm' }] },
      'old-name': {
        archived_alias: 'uid-new',
        memories: [{ id: 'm' }],
      },
    },
  });

  assert.equal(result.status, NAMESPACE_STATUS.LINKED);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.namespaces.find((entry) => entry.key === 'old-name').status, 'archived-rollback');
});
