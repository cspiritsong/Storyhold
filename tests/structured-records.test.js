import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredExtractionPrompt,
  mergeStructuredRecords,
  normalizeStructuredRecords,
  parseStructuredResponse,
  parseStructuredResponseResult,
} from '../structured-records.js';
import { buildIngestWindow } from '../projections.js';
import { buildProductSuppressionKey } from '../product-mutations.js';

const window = buildIngestWindow({
  chatUid: 'chat-uid-a',
  branchUid: 'branch-uid-a',
  messages: [
    { mesId: 101, name: 'Badi', is_user: true, mes: 'Mira takes the silver key.' },
    { mesId: 102, name: 'Mira', is_user: false, mes: 'The temple door remains sealed.' },
  ],
  sourceRange: { kind: 'mesId', start: 101, end: 102 },
});

const payload = {
  facts: [{ content: 'The silver key opens the temple door.', confidence: 0.9 }],
  events: [{
    content: 'Mira takes the silver key from the shrine.',
    story_time: { day: 15 },
    entities: ['Mira', 'silver key', 'shrine'],
    confidence: 0.9,
  }],
  relationships: [{ subject: 'Mira', target: 'Badi', content: 'Mira trusts Badi.' }],
  state: [{
    entity: 'Mira',
    entity_type: 'character',
    fields: { location: 'temple entrance', outfit: 'travel cloak', carried: 'silver key' },
  }],
  arcs: [{ content: 'Open the sealed temple door.', status: 'active' }],
  epistemic: [{ subject: 'Mira', type: 'knows', content: 'The priest lied.' }],
};

test('structured response parser accepts plain and fenced JSON', () => {
  assert.deepEqual(parseStructuredResponse(JSON.stringify(payload)), payload);
  assert.deepEqual(parseStructuredResponse(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``), payload);
});

test('structured response parser rejects malformed or non-object output safely', () => {
  assert.deepEqual(parseStructuredResponse('not json'), { facts: [], events: [], relationships: [], state: [], arcs: [], epistemic: [], session: [] });
  assert.deepEqual(parseStructuredResponse('null'), { facts: [], events: [], relationships: [], state: [], arcs: [], epistemic: [], session: [] });
  assert.equal(parseStructuredResponseResult('not json').valid, false);
  assert.equal(parseStructuredResponseResult('').valid, false);
});

test('structured response parser accepts legacy tagged extraction output', () => {
  const result = parseStructuredResponseResult(
    '[fact:2:permanent] The silver key opens the temple door.\n[scene] Rain starts outside.',
  );

  assert.equal(result.valid, true);
  assert.equal(result.format, 'tagged');
  assert.equal(result.payload.facts.length, 1);
  assert.equal(result.payload.session.length, 1);
});

test('one structured payload becomes typed records with shared scope and provenance', () => {
  const records = normalizeStructuredRecords(payload, window);

  assert.deepEqual(
    records.map((record) => record.kind).sort(),
    ['arc', 'epistemic', 'event', 'fact', 'relationship', 'state'],
  );
  assert.ok(records.every((record) => record.scope.chat_uid === 'chat-uid-a'));
  assert.ok(records.every((record) => record.scope.branch_uid === 'branch-uid-a'));
  assert.ok(records.every((record) => record.source_range.kind === 'mesId'));
  assert.ok(records.every((record) => record.provenance.source_chat_uid === 'chat-uid-a'));
  assert.ok(records.some((record) => record.kind === 'state' && /silver key/i.test(record.content)));
  const event = records.find((record) => record.kind === 'event');
  assert.ok(event);
  assert.deepEqual(event.story_time, { day: 15 });
  assert.deepEqual(event.entities, ['Mira', 'silver key', 'shrine']);
});

test('structured extraction prompt defines one combined response and includes current context', () => {
  const prompt = buildStructuredExtractionPrompt({
    chatText: 'Mira takes the silver key.',
    existingRecords: [{ kind: 'state', content: 'Mira is at the temple.' }],
    respondingCharacter: 'Mira',
    timeline: {
      current_anchor: { year: 2041, month: 9, day: 15 },
      conflicts: [{ type: 'progression-reversal' }],
    },
  });

  assert.match(prompt, /facts/i);
  assert.match(prompt, /events/i);
  assert.match(prompt, /candidates, not a checklist/i);
  assert.match(prompt, /retention: searchable, session, or narrative/i);
  assert.match(prompt, /routine actions/i);
  assert.match(prompt, /relationships/i);
  assert.match(prompt, /state/i);
  assert.match(prompt, /arcs/i);
  assert.match(prompt, /epistemic/i);
  assert.match(prompt, /Mira takes the silver key/);
  assert.match(prompt, /Mira is at the temple/);
  assert.match(prompt, /current story clock.*2041.*15/i);
  assert.match(prompt, /temporal conflict/i);
});

test('stale current-state clock projections are rejected while backstory remains admissible', () => {
  const timeline = {
    current_anchor: { year: 2041, month: 9, day: 15 },
    conflicts: [],
  };
  const result = normalizeStructuredRecords({
    facts: [{ content: 'Years ago on Day 12, Mira fought Gustav in Djibouti.' }],
    state: [{ content: 'Current story time is Day 12.', entity: 'world', entity_type: 'timeline' }],
  }, window, { timeline });

  assert.ok(result.some((record) => /Years ago on Day 12/i.test(record.content)));
  assert.equal(result.some((record) => /Current story time is Day 12/i.test(record.content)), false);
});

test('disabled structured kinds are omitted at the normalization boundary', () => {
  const records = normalizeStructuredRecords(payload, window, {
    enabledKinds: ['fact', 'relationship'],
  });

  assert.deepEqual(
    records.map((record) => record.kind).sort(),
    ['fact', 'relationship'],
  );
});

test('combined structured payload can produce session evidence records', () => {
  const records = normalizeStructuredRecords(
    { session: [{ type: 'revelation', content: 'Mira reveals the priest lied.' }] },
    window,
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'session');
  assert.equal(records[0].type, 'revelation');
  assert.match(buildStructuredExtractionPrompt({}), /session/i);
});

test('events are extracted as a first-class kind with story time and entities', () => {
  const records = normalizeStructuredRecords(
    {
      events: [{
        content: 'The sealed door swings open.',
        story_time: { day: 16 },
        knowledge_time: { conversation_index: 4 },
        entities: ['sealed door', 'Mira'],
        confidence: 0.85,
      }],
    },
    window,
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'event');
  assert.equal(records[0].content, 'The sealed door swings open.');
  assert.deepEqual(records[0].story_time, { day: 16 });
  assert.deepEqual(records[0].knowledge_time, { conversation_index: 4 });
  assert.deepEqual(records[0].entities, ['sealed door', 'Mira']);
});

test('normalization admits only searchable or session candidates and drops repeated events', () => {
  const records = normalizeStructuredRecords(
    {
      events: [
        { content: 'The candle flickers in the corner.', retention: 'narrative' },
        { content: 'Mira opens the sealed door.', retention: 'searchable', novelty: 'changed' },
        { content: 'The sealed door opens.', novelty: 'repeated' },
      ],
    },
    window,
  );

  assert.deepEqual(records.map((record) => record.content), ['Mira opens the sealed door.']);
  assert.equal(records[0].retention, 'searchable');
});

test('merge deduplicates incoming records and retires explicitly superseded state', () => {
  const existing = [{
    id: 'old-state',
    kind: 'state',
    content: 'Mira is wounded.',
    conflict_key: 'mira-health',
    validity: { status: 'active' },
    confidence: 0.8,
  }];
  const incoming = [{
    id: 'new-state',
    kind: 'state',
    content: 'Mira is healed.',
    conflict_key: 'mira-health',
    supersedes: ['old-state'],
    validity: { status: 'active' },
    confidence: 0.95,
  }, {
    id: 'duplicate',
    kind: 'state',
    content: 'Mira is healed.',
    validity: { status: 'active' },
  }];
  const result = mergeStructuredRecords(existing, incoming);

  assert.equal(result.length, 2);
  assert.equal(result.find((record) => record.id === 'old-state').superseded_by, 'new-state');
  assert.equal(result.find((record) => record.id === 'old-state').validity.status, 'superseded');
  assert.equal(result.filter((record) => record.content === 'Mira is healed.').length, 1);
  assert.equal(existing[0].superseded_by, undefined);
});

test('merge preserves manual Product edits and source-scoped deletions across rescans', () => {
  const edited = {
    id: 'edited-fact',
    kind: 'fact',
    content: 'Maeve carries the obsidian key.',
    scope: { chat_uid: 'chat-uid-a', branch_uid: 'chat-uid-a' },
    source_range: { kind: 'index', start: 0, end: 1 },
    provenance: { source_chat_uid: 'chat-uid-a', source_messages: [0, 1] },
    manual_override: { active: true, action: 'edit' },
    validity: { status: 'active' },
  };
  const deleted = {
    id: 'deleted-fact',
    kind: 'fact',
    content: 'The gate is painted red.',
    scope: { chat_uid: 'chat-uid-a', branch_uid: 'chat-uid-a' },
    source_range: { kind: 'index', start: 2, end: 3 },
    provenance: { source_chat_uid: 'chat-uid-a', source_messages: [2, 3] },
    validity: { status: 'active' },
  };
  const incoming = [
    {
      id: 'fresh-old-wording',
      kind: 'fact',
      content: 'Maeve carries the silver key.',
      scope: { chat_uid: 'chat-uid-a', branch_uid: 'chat-uid-a' },
      source_range: { kind: 'index', start: 0, end: 1 },
      provenance: { source_chat_uid: 'chat-uid-a', source_messages: [0, 1] },
      validity: { status: 'active' },
    },
    {
      id: 'recreated-deleted',
      kind: 'fact',
      content: 'The gate is painted red.',
      scope: { chat_uid: 'chat-uid-a', branch_uid: 'chat-uid-a' },
      source_range: { kind: 'index', start: 2, end: 3 },
      provenance: { source_chat_uid: 'chat-uid-a', source_messages: [2, 3] },
      validity: { status: 'active' },
    },
  ];

  const result = mergeStructuredRecords(
    [edited],
    incoming,
    { suppressedKeys: [buildProductSuppressionKey(deleted)] },
  );

  assert.deepEqual(result.map((record) => record.content), ['Maeve carries the obsidian key.']);
});

test('structured normalization removes foreign nested identity variants from model metadata', () => {
  const records = normalizeStructuredRecords(
    {
      facts: [
        {
          content: 'The key opens the door.',
          scope: { _source_chat_uid: 'foreign-chat', _lineage_epoch: 'foreign-branch' },
          provenance: { _source_chat_uid: 'foreign-chat', _lineage_epoch: 'foreign-branch' },
        },
      ],
    },
    window,
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].scope._source_chat_uid, undefined);
  assert.equal(records[0].scope._lineage_epoch, undefined);
  assert.equal(records[0].provenance._source_chat_uid, undefined);
  assert.equal(records[0].provenance._lineage_epoch, undefined);
  assert.equal(records[0].provenance.source_chat_uid, 'chat-uid-a');
});
