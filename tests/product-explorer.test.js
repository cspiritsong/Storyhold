import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductExplorerModel,
  buildTimelineSpine,
  filterExplorerRecords,
  unverifiedCitationNote,
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

test('Explorer surfaces unverified citations from ingest-time checks', () => {
  const flagged = record({
    id: 'partial-cite',
    provenance: { source_chat_uid: 'chat-a', source_messages: [3, 4, 99], citation_unverified: [99] },
  });
  const clean = record({ id: 'clean' });

  assert.equal(unverifiedCitationNote(flagged), 'citation outside window: 99');
  assert.equal(unverifiedCitationNote(clean), null);
  // A malformed stamp must never throw or invent a count.
  assert.equal(unverifiedCitationNote(record({ id: 'junk', provenance: { citation_unverified: 'oops' } })), null);
});

test('Explorer renders the unverified-citation note in record rows', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../product-explorer.js', import.meta.url), 'utf8');
  assert.match(source, /unverifiedCitationNote\(record\)/);
  assert.match(source, /citation outside window/);
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
    event: 0,
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

test('timeline spine orders events oldest-first with the current node marked', () => {
  const spine = buildTimelineSpine(
    {
      events: [
        {
          event_id: 'event-1',
          conversation_index: 2,
          story_time: { day: 12 },
          narrative_role: 'backstory',
          source_message_range: [2, 2],
          source_preview: 'Day 12: the old pact was made.',
        },
        {
          event_id: 'event-2',
          conversation_index: 8,
          story_time: { day: 16 },
          narrative_role: 'current',
          source_message_range: [8, 8],
          source_preview: 'Day 16: the party arrives.',
        },
      ],
    },
    [
      record({ id: 'pact', content: 'The old pact was made.', source_range: { kind: 'index', start: 2, end: 2 } }),
      record({ id: 'arrival', content: 'The party arrives.', source_range: { kind: 'index', start: 8, end: 8 } }),
    ],
    {
      layers: [
        [{ id: 'snip-pact', text: 'An old pact is struck.', source_range: { kind: 'index', start: 2, end: 2 } }],
        [{ id: 'snip-arrival', text: 'The party arrives at the temple.', source_range: { kind: 'index', start: 8, end: 8 } }],
      ],
    },
  );

  assert.equal(spine.totalNodes, 2);
  assert.deepEqual(spine.nodes.map((node) => node.event_id), ['event-1', 'event-2']);
  assert.equal(spine.currentIndex, 1);
  assert.equal(spine.hasUnresolved, false);
  assert.deepEqual(spine.nodes[0].related.map((item) => item.id), ['pact']);
  assert.deepEqual(spine.nodes[1].related.map((item) => item.id), ['arrival']);
  assert.deepEqual(spine.nodes[0].narrative.map((item) => item.id), ['snip-pact']);
});

test('timeline spine flags records without a matching event as unresolved', () => {
  const spine = buildTimelineSpine(
    { events: [] },
    [record({ id: 'orphan', content: 'An unattached memory.', source_range: { kind: 'index', start: 5, end: 5 } })],
    { layers: [] },
  );

  assert.equal(spine.totalNodes, 1);
  assert.equal(spine.nodes[0].narrative_role, 'unresolved');
  assert.equal(spine.nodes[0].event_id, null);
  assert.deepEqual(spine.nodes[0].related.map((item) => item.id), ['orphan']);
  assert.equal(spine.hasUnresolved, true);
  assert.equal(spine.currentIndex, 0);
});

test('Explorer model exposes a chronological spine projection', () => {
  const model = buildProductExplorerModel({
    chatUid: 'chat-a',
    chatId: 'chat-a.jsonl',
    records: [
      record({ id: 'later', source_range: { kind: 'index', start: 9, end: 10 } }),
      record({ id: 'earlier', source_range: { kind: 'index', start: 1, end: 2 }, kind: 'state' }),
    ],
    timeline: {
      events: [
        { event_id: 'event-2', conversation_index: 8, story_time: { day: 16 }, source_message_range: [8, 8] },
        { event_id: 'event-1', conversation_index: 2, story_time: { day: 12 }, source_message_range: [2, 2] },
      ],
    },
    narrative: {
      layers: [[{ id: 'snippet-1', text: 'The party enters the temple.', source_range: { kind: 'index', start: 1, end: 2 } }]],
    },
  });

  assert.equal(model.spine.totalNodes, 3);
  assert.deepEqual(model.spine.nodes.map((node) => node.event_id), ['event-1', 'event-2', null]);
  assert.equal(model.spine.currentIndex, 1);
  assert.equal(model.spine.hasUnresolved, true);
  assert.equal(model.spine.nodes[2].narrative_role, 'unresolved');
  assert.deepEqual(model.spine.nodes[2].related.map((item) => item.id), ['later']);
});
