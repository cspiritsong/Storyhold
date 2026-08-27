import test from 'node:test';
import assert from 'node:assert/strict';
import { admitStructuredRecords } from '../admission-policy.js';

const record = (overrides = {}) => ({
  id: overrides.id ?? 'record',
  kind: overrides.kind ?? 'event',
  content: overrides.content ?? 'The sealed door opens.',
  confidence: overrides.confidence ?? 0.9,
  ...overrides,
});

test('admission rejects narrative-only and repeated candidates but keeps meaningful changes', () => {
  const result = admitStructuredRecords([
    record({ id: 'routine', content: 'The candle flickers in the corner.', retention: 'narrative' }),
    record({ id: 'repeat', content: 'The sealed door opens.', novelty: 'repeated' }),
    record({ id: 'meaningful', content: 'Mira opens the sealed door.', novelty: 'changed', retention: 'searchable' }),
  ]);

  assert.deepEqual(result.accepted.map((item) => item.id), ['meaningful']);
  assert.deepEqual(result.rejected.map((item) => item.reason), ['narrative-only', 'repeated']);
  assert.deepEqual(result.stats, {
    accepted: 1,
    rejected: 2,
    rejected_by_reason: { 'narrative-only': 1, repeated: 1 },
  });
});

test('admission removes active duplicates and caps a verbose window without mutating input', () => {
  const records = [
    record({ id: 'existing-copy', content: 'The sealed door opens.' }),
    record({ id: 'fact-one', kind: 'fact', content: 'The temple is older than the city.', confidence: 0.8 }),
    record({ id: 'fact-two', kind: 'fact', content: 'The temple has a hidden lower level.', confidence: 0.95, novelty: 'changed' }),
    record({ id: 'fact-three', kind: 'fact', content: 'The temple was built by unknown hands.', confidence: 0.7 }),
  ];
  const original = structuredClone(records);

  const result = admitStructuredRecords(records, {
    existingRecords: [record({ id: 'stored', content: 'The sealed door opens.' })],
    maxTotal: 2,
    maxPerKind: 2,
  });

  assert.deepEqual(result.accepted.map((item) => item.id), ['fact-one', 'fact-two']);
  assert.deepEqual(result.rejected.map((item) => item.reason), ['duplicate', 'window-cap']);
  assert.deepEqual(records, original);
  assert.deepEqual(result.stats.rejected_by_reason, { duplicate: 1, 'window-cap': 1 });
});

test('admission preserves session retention for a useful temporary candidate', () => {
  const result = admitStructuredRecords([
    record({ id: 'scene-detail', kind: 'session', retention: 'session', content: 'The room smells of smoke.' }),
  ]);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].retention, 'session');
  assert.equal(result.rejected.length, 0);
});