import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, 'fixtures/ingest-window.json');
const contractPath = resolve(__dirname, '../docs/memory-contract.md');

function loadFixture() {
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

function loadContract() {
  return readFileSync(contractPath, 'utf8');
}

const REQUIRED_RECORD_FIELDS = [
  'scope',
  'source_range',
  'story_time',
  'knowledge_time',
  'validity',
  'confidence',
  'provenance',
  'supersedes',
];

test('ingest fixture identifies one stable source window', () => {
  const fixture = loadFixture();

  assert.equal(fixture.contract_version, 1);
  assert.equal(typeof fixture.window.window_id, 'string');
  assert.notEqual(fixture.window.window_id, '');
  assert.equal(fixture.window.chat_uid, 'chat-uid-a');
  assert.deepEqual(fixture.window.source_range, {
    kind: 'mesId',
    start: 101,
    end: 102,
  });
  assert.equal(typeof fixture.window.fingerprint, 'string');
  assert.notEqual(fixture.window.fingerprint, '');
});

test('every derived record carries canonical scope and provenance', () => {
  const fixture = loadFixture();

  assert.ok(fixture.records.length > 0);
  for (const record of fixture.records) {
    for (const field of REQUIRED_RECORD_FIELDS) {
      assert.ok(Object.hasOwn(record, field), `${record.id} lacks ${field}`);
    }
    assert.equal(record.scope.chat_uid, fixture.window.chat_uid);
    assert.deepEqual(record.source_range, fixture.window.source_range);
    assert.equal(record.provenance.source_chat_uid, fixture.window.chat_uid);
    assert.ok(record.confidence >= 0 && record.confidence <= 1);
    assert.equal(record.validity.status, 'active');
  }
});

test('ownership contract has exactly one narrative writer', () => {
  const fixture = loadFixture();
  const contract = loadContract();

  assert.deepEqual(fixture.ownership, {
    structured: 'smart-memory',
    narrative: 'summaryception',
    evidence: 'st-vector-storage',
    canon: 'lorebook',
  });
  assert.match(contract, /Summaryception[^\n]*single[^\n]*narrative/i);
  assert.match(contract, /Compaction[^\n]*retired[^\n]*narrative/i);
});

test('quarantined lineage produces no injectable records', () => {
  const fixture = loadFixture();

  assert.equal(fixture.quarantined_lineage.status, 'unverified-branch');
  assert.equal(fixture.quarantined_lineage.quarantined, true);
  assert.deepEqual(fixture.quarantined_lineage.injectable_record_ids, []);
});

test('the contract makes raw transcript evidence authoritative', () => {
  const contract = loadContract();

  assert.match(contract, /raw (?:chat )?JSONL/i);
  assert.match(contract, /Derived[^\n]*never[^\n]*outrank/i);
  assert.match(contract, /story[_ -]time/i);
  assert.match(contract, /knowledge[_ -]time/i);
});
