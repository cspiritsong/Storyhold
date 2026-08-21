import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemoryEnvelope,
  buildMemoryEnvelopeSync,
  buildSectionsFromSlots,
  buildSectionsFromTypedState,
  createMemoryBroker,
} from '../memory-broker.js';

const record = (overrides = {}) => ({
  id: overrides.id ?? 'record',
  kind: overrides.kind ?? 'fact',
  content: overrides.content ?? 'Mira carries the silver key.',
  scope: { chat_uid: 'chat-a', branch_uid: 'branch-a', ...(overrides.scope ?? {}) },
  validity: { status: 'active', ...(overrides.validity ?? {}) },
  confidence: overrides.confidence ?? 0.9,
  ...(overrides.superseded_by ? { superseded_by: overrides.superseded_by } : {}),
  ...(overrides.conflict_key ? { conflict_key: overrides.conflict_key } : {}),
  ...(overrides.contradicts ? { contradicts: overrides.contradicts } : {}),
  ...(overrides.source_range ? { source_range: overrides.source_range } : {}),
});

test('broker collapses equivalent records and excludes superseded records', async () => {
  const result = await buildMemoryEnvelope({
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    query: { text: 'silver key' },
    records: [
      record({ id: 'duplicate-a', content: 'Mira carries the silver key.' }),
      record({ id: 'duplicate-b', content: '  Mira carries the silver key.  ' }),
      record({ id: 'old', content: 'Mira carries a bronze key.', superseded_by: 'duplicate-a' }),
    ],
    totalBudget: 200,
  });

  assert.equal(result.injected_slots.length, 1);
  assert.equal(result.injected_slots[0], 'smart_memory_unified');
  assert.match(result.text, /Mira carries the silver key/);
  assert.doesNotMatch(result.text, /bronze key/);
  assert.equal(result.selected_ids.length, 1);
});

test('broker emits a compact ordered envelope with source ids and a hard budget', async () => {
  const result = await buildMemoryEnvelope({
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    query: { text: 'temple' },
    sections: {
      narrative: [record({ id: 'narrative', kind: 'narrative_delta', content: 'The party entered the temple.' })],
      facts: [record({ id: 'fact', content: 'The silver key opens the temple door.' })],
      state: [record({ id: 'state', kind: 'state', content: 'Mira is healed and carries the key.' })],
      arcs: [record({ id: 'arc', kind: 'arc', content: 'The sealed door remains unopened.' })],
    },
    totalBudget: 30,
  });

  assert.ok(result.tokens <= 30, `expected <= 30 tokens, got ${result.tokens}`);
  assert.ok(result.text.indexOf('NARRATIVE') < result.text.indexOf('CURRENT STATE'));
  assert.match(result.text, /SOURCE IDS:/);
  assert.deepEqual(result.injected_slots, ['smart_memory_unified']);
  assert.ok(result.dropped_ids.length > 0);
});

test('quarantined lineage returns an empty envelope without selecting records', async () => {
  const result = await buildMemoryEnvelope({
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    lineage: { quarantined: true },
    records: [record({ id: 'unsafe' })],
    totalBudget: 200,
  });

  assert.equal(result.text, '');
  assert.deepEqual(result.selected_ids, []);
  assert.deepEqual(result.injectable_slots, []);
  assert.equal(result.reason, 'lineage-quarantined');
});

test('conflicting active records are marked uncertain rather than silently merged', async () => {
  const result = await buildMemoryEnvelope({
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    records: [
      record({ id: 'relationship-a', content: 'Mira trusts the priest.', conflict_key: 'mira-priest' }),
      record({ id: 'relationship-b', content: 'Mira distrusts the priest.', conflict_key: 'mira-priest', confidence: 0.8 }),
    ],
    totalBudget: 200,
  });

  assert.match(result.text, /uncertain/i);
  assert.equal(result.trace.conflicts.length, 1);
});

test('legacy slot mapping ignores foreign narrative slots and preserves current-state channels', () => {
  const sections = buildSectionsFromSlots({
    summaryception: 'foreign narrative must not be consumed',
    smart_memory_canon: 'embedded canon',
    smart_memory_long: 'long-term',
    smart_memory_triggered: 'triggered duplicate',
    smart_memory_state_ledger: 'current state',
    smart_memory_epistemic: 'private knowledge',
  });

  assert.deepEqual(sections.narrative.map((item) => item.id), ['smart_memory_canon']);
  assert.deepEqual(sections.facts.map((item) => item.id), ['smart_memory_long']);
  assert.deepEqual(sections.state.map((item) => item.id), ['smart_memory_state_ledger']);
  assert.deepEqual(sections.epistemic.map((item) => item.id), ['smart_memory_epistemic']);
});
test('typed-store broker path reads embedded narrative and only matching structured records', () => {
  const structuredRecords = [
    record({ id: 'key-state', kind: 'state', content: 'Mira carries the silver key.' }),
    record({ id: 'unrelated-state', kind: 'state', content: 'The weather is rainy.' }),
  ];
  const sections = buildSectionsFromTypedState({
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    narrativeState: {
      layers: [[{ id: 'narrative-chain-0', text: 'The party enters the temple.' }]],
    },
    structuredRecords,
  });
  assert.equal(sections.narrative[0].scope.chat_uid, 'chat-a');
  assert.equal(sections.narrative[0].scope.branch_uid, 'branch-a');
  const result = buildMemoryEnvelopeSync({
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    query: { text: 'silver key' },
    sections,
    records: structuredRecords,
    totalBudget: 200,
  });

  assert.match(result.text, /The party enters the temple/);
  assert.match(result.text, /silver key/);
  assert.doesNotMatch(result.text, /rainy/);
  assert.doesNotMatch(result.text, /summaryception/i);
});
test('broker can use a deterministic retrieval result without calling a vector provider', async () => {
  let vectorCalls = 0;
  const broker = createMemoryBroker({
    vectorSearch: async () => {
      vectorCalls++;
      return [];
    },
  });

  const result = await broker.compose({
    chatUid: 'chat-a',
    branchUid: 'branch-a',
    query: { text: 'silver key' },
    records: [record({ id: 'key', content: 'Mira carries the silver key.' })],
    totalBudget: 200,
  });

  assert.equal(vectorCalls, 0);
  assert.match(result.text, /silver key/);
});
