import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRetrievalRecords, retrieveWithLadder } from '../retrieval.js';

const record = (overrides = {}) => ({
  id: overrides.id ?? 'record',
  kind: overrides.kind ?? 'fact',
  content: overrides.content ?? 'Mira carries the silver key.',
  scope: { chat_uid: 'chat-a', branch_uid: 'branch-a', ...(overrides.scope ?? {}) },
  validity: { status: 'active', ...(overrides.validity ?? {}) },
  confidence: overrides.confidence ?? 0.9,
  ...(overrides.witnessed_by ? { witnessed_by: overrides.witnessed_by } : {}),
  ...(overrides.superseded_by ? { superseded_by: overrides.superseded_by } : {}),
  ...(overrides.entities ? { entities: overrides.entities } : {}),
});

test('exact phrase retrieval wins without calling vector search', async () => {
  let vectorCalls = 0;
  const result = await retrieveWithLadder({
    records: [
      record({ id: 'exact', content: 'Mira carries the silver key.' }),
      record({ id: 'weak', content: 'The temple has a locked door.' }),
    ],
    query: { text: 'silver key' },
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    vectorSearch: async () => {
      vectorCalls++;
      return [];
    },
  });

  assert.equal(result.candidates[0].id, 'exact');
  assert.equal(result.candidates[0].retrieval.stage, 'exact');
  assert.equal(vectorCalls, 0);
});

test('scope, branch, validity, and witness filters reject unsafe candidates', async () => {
  const result = await retrieveWithLadder({
    records: [
      record({ id: 'good', content: 'Mira saw the priest.', witnessed_by: ['Mira'] }),
      record({ id: 'foreign-chat', scope: { chat_uid: 'chat-b' } }),
      record({ id: 'foreign-branch', scope: { branch_uid: 'branch-b' } }),
      record({ id: 'retired', superseded_by: 'replacement' }),
      record({ id: 'invalid', validity: { status: 'invalid' } }),
      record({ id: 'unwitnessed', content: 'Mira saw the priest.', witnessed_by: ['Badi'] }),
    ],
    query: { text: 'Mira priest' },
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    respondingCharacter: 'Mira',
    povMode: 'strict',
  });

  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['good']);
});

test('inactive product history can be scoped explicitly without weakening default retrieval', () => {
  const records = [
    record({ id: 'active' }),
    record({ id: 'superseded', superseded_by: 'active', validity: { status: 'superseded' } }),
    record({ id: 'invalid', validity: { status: 'invalid' } }),
    record({ id: 'foreign', scope: { chat_uid: 'chat-b' }, validity: { status: 'invalid' } }),
  ];
  const scope = { chatUid: 'chat-a', branchUid: 'branch-a', allowLegacy: false };

  assert.deepEqual(filterRetrievalRecords(records, scope).map((item) => item.id), ['active']);
  assert.deepEqual(
    filterRetrievalRecords(records, { ...scope, includeInactive: true }).map((item) => item.id),
    ['active', 'superseded', 'invalid'],
  );
});

test('branch-scoped retrieval rejects records without explicit branch provenance', () => {
  const records = [
    record({ id: 'current' }),
    record({ id: 'branchless', scope: { branch_uid: null } }),
    record({ id: 'other', scope: { branch_uid: 'branch-b' } }),
  ];

  const result = filterRetrievalRecords(records, {
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    allowLegacy: false,
  });

  assert.deepEqual(result.map((item) => item.id), ['current']);
});

test('branch-scoped retrieval rejects unscoped legacy fallback records', () => {
  const result = filterRetrievalRecords(
    [{ id: 'legacy', kind: 'fact', content: 'Unscoped legacy fact.', legacy: true }],
    { chatUid: 'chat-a', branchUid: 'branch-a', allowLegacy: true },
  );

  assert.deepEqual(result, []);
});

test('retrieval rejects explicit branch provenance without an expected branch', () => {
  const result = filterRetrievalRecords(
    [record({ id: 'unproven-branch' })],
    { chatUid: 'chat-a', branchUid: null, allowLegacy: false },
  );

  assert.deepEqual(result, []);
});

test('retrieval rejects mixed explicit chat and branch provenance', () => {
  const mixed = {
    ...record({ id: 'mixed' }),
    source_chat_uid: 'chat-b',
    provenance: { source_chat_uid: 'chat-b', branch_uid: 'branch-b' },
    branch_uid: 'branch-b',
  };

  const result = filterRetrievalRecords([mixed], {
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    allowLegacy: false,
  });

  assert.deepEqual(result, []);
});

test('retrieval rejects foreign internal and alternate provenance variants', () => {
  const variants = [
    { ...record({ id: 'internal-uid' }), _source_chat_uid: 'chat-b' },
    { ...record({ id: 'internal-id' }), _source_chat_id: 'chat-b' },
    { ...record({ id: 'scope-id' }), scope: { ...record().scope, chat_id: 'chat-b' } },
    { ...record({ id: 'internal-branch' }), _branch_uid: 'branch-b' },
    { ...record({ id: 'provenance-id' }), provenance: { ...record().provenance, source_chat_id: 'chat-b' } },
  ];

  const result = filterRetrievalRecords(variants, {
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    allowLegacy: false,
  });

  assert.deepEqual(result, []);
});

test('retrieval rejects nested internal source chat id variants', () => {
  const variants = [
    {
      ...record({ id: 'scope-internal-id' }),
      scope: { ...record().scope, _source_chat_id: 'chat-b' },
    },
    {
      ...record({ id: 'provenance-internal-id' }),
      provenance: { _source_chat_id: 'chat-b' },
    },
    {
      ...record({ id: 'current' }),
      scope: { ...record().scope, _source_chat_id: 'chat-a' },
      provenance: { _source_chat_id: 'chat-a' },
    },
  ];

  const result = filterRetrievalRecords(variants, {
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    allowLegacy: false,
  });

  assert.deepEqual(result.map((item) => item.id), ['current']);
});

test('retrieval rejects nested provenance source uid and chat id variants', () => {
  const variants = [
    {
      ...record({ id: 'provenance-internal-uid' }),
      provenance: { _source_chat_uid: 'chat-b' },
    },
    {
      ...record({ id: 'provenance-chat-id' }),
      provenance: { chat_id: 'chat-b' },
    },
    {
      ...record({ id: 'current' }),
      provenance: { _source_chat_uid: 'chat-a', chat_id: 'chat-a' },
    },
  ];

  const result = filterRetrievalRecords(variants, {
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    allowLegacy: false,
  });

  assert.deepEqual(result.map((item) => item.id), ['current']);
});

test('retrieval rejects foreign nested branch variants', () => {
  const records = [
    {
      id: 'scope-branch',
      branch_uid: 'branch-a',
      scope: {
        chat_uid: 'uid-a',
        branch_uid: 'branch-a',
        _branch_uid: 'branch-b',
      },
      content: 'Mixed branch fact.',
    },
    { id: 'ok', scope: { chat_uid: 'uid-a', branch_uid: 'branch-a' }, content: 'Current fact.' },
  ];
  const filtered = filterRetrievalRecords(records, {
    chatUid: 'uid-a',
    branchUid: 'branch-a',
    allowLegacy: false,
  });
  assert.deepEqual(filtered.map((record) => record.id), ['ok']);
});

test('lexical retrieval satisfies a query before optional vector escalation', async () => {
  let vectorCalls = 0;
  const result = await retrieveWithLadder({
    records: [record({ id: 'lexical', content: 'A bronze key rests beside the sealed temple door.' })],
    query: { text: 'bronze temple door' },
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    vectorSearch: async () => {
      vectorCalls++;
      return [record({ id: 'vector' })];
    },
  });

  assert.equal(result.candidates[0].id, 'lexical');
  assert.equal(result.candidates[0].retrieval.stage, 'lexical');
  assert.equal(vectorCalls, 0);
});

test('vector retrieval is called only after deterministic retrieval misses and remains scoped', async () => {
  let vectorCalls = 0;
  const result = await retrieveWithLadder({
    records: [record({ id: 'unrelated', content: 'The rain falls outside.' })],
    query: { text: 'forgotten oath' },
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    vectorSearch: async () => {
      vectorCalls++;
      return [
        record({ id: 'vector-good', content: 'Mira promised to return.' }),
        record({ id: 'vector-foreign', scope: { chat_uid: 'chat-b' } }),
      ];
    },
  });

  assert.equal(vectorCalls, 1);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['vector-good']);
  assert.equal(result.candidates[0].retrieval.stage, 'vector');
});

test('agentic retrieval is an explicit final escalation and provider errors fail soft', async () => {
  let agenticCalls = 0;
  const result = await retrieveWithLadder({
    records: [],
    query: { text: 'what did the oracle hide?' },
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    vectorSearch: async () => {
      throw new Error('embedding service unavailable');
    },
    agenticSearch: async () => {
      agenticCalls++;
      return [{ ...record({ id: 'agentic', content: 'The oracle hid the true name.' }), scope: { chat_uid: 'chat-a', branch_uid: 'branch-a' } }];
    },
    allowAgentic: true,
  });

  assert.equal(agenticCalls, 1);
  assert.equal(result.candidates[0].id, 'agentic');
  assert.equal(result.candidates[0].retrieval.stage, 'agentic');
  assert.equal(result.diagnostics.vector_error, 'embedding service unavailable');
});

test('retrieval rejects a foreign nested scope source uid', () => {
  const result = filterRetrievalRecords(
    [
      {
        ...record({ id: 'foreign-nested-uid' }),
        scope: { ...record().scope, _source_chat_uid: 'chat-b' },
      },
    ],
    { chatUid: 'chat-a', branchUid: 'branch-a', allowLegacy: false },
  );

  assert.deepEqual(result, []);
});

test('retrieval rejects filename-only provenance even when the branch matches', () => {
  const result = filterRetrievalRecords(
    [
      {
        id: 'filename-only',
        kind: 'fact',
        content: 'Filename-scoped content.',
        source_chat_id: 'chat-a',
        branch_uid: 'branch-a',
      },
    ],
    { chatUid: 'chat-a', branchUid: 'branch-a', allowLegacy: false },
  );

  assert.deepEqual(result, []);
});
