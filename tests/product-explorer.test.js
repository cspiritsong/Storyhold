import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductExplorerModel,
  filterExplorerRecords,
} from '../product-explorer.js';

const record = (overrides = {}) => ({
  id: overrides.id ?? 'record-1',
  kind: overrides.kind ?? 'fact',
  content: overrides.content ?? 'Maeve carries the silver key.',
  scope: { chat_uid: 'chat-a', branch_uid: 'chat-a', ...(overrides.scope ?? {}) },
  source_range: overrides.source_range ?? { kind: 'index', start: 3, end: 4 },
  provenance: { source_chat_uid: 'chat-a', source_messages: [3, 4], ...(overrides.provenance ?? {}) },
  validity: { status: 'active', ...(overrides.validity ?? {}) },
  ...(overrides.entity ? { entity: overrides.entity } : {}),
});

test('Explorer model contains only the current chat and exposes projections', () => {
  const model = buildProductExplorerModel({
    chatUid: 'chat-a',
    chatId: 'chat-a.jsonl',
    records: [
      record({ id: 'later', source_range: { kind: 'index', start: 9, end: 10 } }),
      record({ id: 'earlier', source_range: { kind: 'index', start: 1, end: 2 }, kind: 'state' }),
      record({
        id: 'foreign',
        scope: { chat_uid: 'chat-b', branch_uid: 'chat-b' },
        provenance: { source_chat_uid: 'chat-b' },
      }),
    ],
    timeline: {
      events: [
        { event_id: 'event-2', conversation_index: 8, story_time: { day: 16 }, source_message_range: [8, 8] },
        { event_id: 'event-1', conversation_index: 2, story_time: { day: 12 }, source_message_range: [2, 2] },
      ],
    },
    timelineOverrides: [
      { event_id: 'event-1', chat_uid: 'chat-a', patch: { narrative_role: 'backstory' }, updated_at: 2 },
    ],
    chat: [
      { mes: 'unused' },
      { mes: 'unused' },
      { mes: 'Day 12: the old pact was made.' },
      { mes: 'unused' },
      { mes: 'unused' },
      { mes: 'unused' },
      { mes: 'unused' },
      { mes: 'unused' },
      { mes: 'Day 16: the party arrives.' },
    ],
    narrative: {
      layers: [[{ id: 'snippet-1', text: 'The party enters the temple.' }], [{ id: 'snippet-2', text: 'The old pact remains.' }]],
    },
    narrativeStale: true,
  });

  assert.equal(model.chatUid, 'chat-a');
  assert.equal(model.chatId, 'chat-a.jsonl');
  assert.deepEqual(model.records.map((item) => item.id), ['earlier', 'later']);
  assert.deepEqual(model.counts, {
    fact: 1,
    relationship: 0,
    session: 0,
    state: 1,
    arc: 0,
    epistemic: 0,
  });
  assert.deepEqual(model.timeline.events.map((event) => event.event_id), ['event-1', 'event-2']);
  assert.equal(model.timeline.events[0].narrative_role, 'backstory');
  assert.match(model.timeline.events[0].source_preview, /old pact/);
  assert.match(model.timeline.events[1].source_preview, /party arrives/);
  assert.equal(model.narrative.layerCount, 2);
  assert.equal(model.narrative.snippets, 2);
  assert.equal(model.narrative.stale, true);
});

test('Explorer record filters support kind, active state, and text search', () => {
  const records = [
    record({ id: 'fact', content: 'Maeve carries the silver key.' }),
    record({ id: 'state', kind: 'state', content: 'Maeve is wounded.' }),
    record({ id: 'retired', validity: { status: 'invalid' }, content: 'An old key.' }),
  ];

  assert.deepEqual(filterExplorerRecords(records, { chatUid: 'chat-a', kind: 'state' }).map((item) => item.id), ['state']);
  assert.deepEqual(filterExplorerRecords(records, { chatUid: 'chat-a', status: 'active' }).map((item) => item.id), ['fact', 'state']);
  assert.deepEqual(filterExplorerRecords(records, { chatUid: 'chat-a', search: 'SILVER KEY' }).map((item) => item.id), ['fact']);
  assert.deepEqual(filterExplorerRecords(records, { chatUid: 'chat-a', includeInactive: true, status: 'all' }).map((item) => item.id), ['fact', 'retired', 'state']);
});

test('Explorer model rejects missing chat identity rather than creating a universal view', () => {
  assert.throws(() => buildProductExplorerModel({ records: [] }), /chatUid is required/);
});
