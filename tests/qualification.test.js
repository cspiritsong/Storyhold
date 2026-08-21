import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMemoryEnvelope, buildMemoryEnvelopeSync } from '../memory-broker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/qualification-story.json'), 'utf8'),
);

function occurrence(text, value) {
  return text.indexOf(value);
}

test('qualification fixture preserves current state while retaining compact narrative context', async () => {
  const result = await buildMemoryEnvelope({
    chatUid: fixture.chat_uid,
    branchUid: fixture.branch_uid,
    respondingCharacter: 'Mira',
    query: fixture.query,
    sections: fixture.sections,
    records: fixture.records,
    totalBudget: fixture.expectations.max_tokens,
  });

  assert.ok(result.tokens <= fixture.expectations.max_tokens);
  assert.deepEqual(result.injected_slots, fixture.expectations.injected_slots);
  for (const id of fixture.expectations.must_include) {
    assert.ok(result.selected_ids.includes(id), `${id} was not selected`);
  }
  for (const text of fixture.expectations.must_exclude) {
    assert.doesNotMatch(result.text, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  for (let index = 1; index < fixture.expectations.section_order.length; index++) {
    const before = fixture.expectations.section_order[index - 1];
    const after = fixture.expectations.section_order[index];
    if (result.text.includes(before) && result.text.includes(after)) {
      assert.ok(occurrence(result.text, before) < occurrence(result.text, after));
    }
  }
  assert.match(result.text, /SOURCE IDS:/);
});

test('qualification fixture excludes a foreign branch from direct record composition', () => {
  const result = buildMemoryEnvelopeSync({
    chatUid: fixture.chat_uid,
    branchUid: fixture.branch_uid,
    records: fixture.records,
    totalBudget: fixture.expectations.max_tokens,
  });

  assert.doesNotMatch(result.text, /Wrong branch/i);
  assert.ok(result.selected_ids.includes('evidence-promise'));
});

test('qualification fixture fails closed for an unverifiable branch', () => {
  const result = buildMemoryEnvelopeSync({
    chatUid: fixture.chat_uid,
    branchUid: fixture.branch_uid,
    lineage: { status: 'unverified-branch', quarantined: true },
    sections: fixture.sections,
    records: fixture.records,
    totalBudget: fixture.expectations.max_tokens,
  });

  assert.equal(result.reason, 'lineage-quarantined');
  assert.equal(result.text, '');
  assert.deepEqual(result.selected_ids, []);
});
