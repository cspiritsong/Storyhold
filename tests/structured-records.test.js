import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStructuredExtractionPrompt,
  mergeStructuredRecords,
  normalizeStructuredRecords,
  parseStructuredResponse,
} from '../structured-records.js';
import { buildIngestWindow } from '../projections.js';

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
  assert.deepEqual(parseStructuredResponse('not json'), { facts: [], relationships: [], state: [], arcs: [], epistemic: [] });
  assert.deepEqual(parseStructuredResponse('null'), { facts: [], relationships: [], state: [], arcs: [], epistemic: [] });
});

test('one structured payload becomes typed records with shared scope and provenance', () => {
  const records = normalizeStructuredRecords(payload, window);

  assert.deepEqual(
    records.map((record) => record.kind).sort(),
    ['arc', 'epistemic', 'fact', 'relationship', 'state'],
  );
  assert.ok(records.every((record) => record.scope.chat_uid === 'chat-uid-a'));
  assert.ok(records.every((record) => record.scope.branch_uid === 'branch-uid-a'));
  assert.ok(records.every((record) => record.source_range.kind === 'mesId'));
  assert.ok(records.every((record) => record.provenance.source_chat_uid === 'chat-uid-a'));
  assert.ok(records.some((record) => record.kind === 'state' && /silver key/i.test(record.content)));
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
