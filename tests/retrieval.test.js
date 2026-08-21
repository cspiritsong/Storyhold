import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveWithLadder } from '../retrieval.js';

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
