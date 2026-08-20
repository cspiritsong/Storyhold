import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRescanSummary, normalizeRescanPasses } from '../rescan-policy.js';

test('rescan defaults to two passes and clamps to safe bounds', () => {
  assert.equal(normalizeRescanPasses(undefined), 2);
  assert.equal(normalizeRescanPasses(0), 1);
  assert.equal(normalizeRescanPasses(2), 2);
  assert.equal(normalizeRescanPasses(9), 3);
  assert.equal(normalizeRescanPasses(NaN), 2);
});

test('rescan summary reports only additive deltas', () => {
  const summary = buildRescanSummary(
    { longterm: 10, session: 20, arcs: 5 },
    { longterm: 13, session: 20, arcs: 7 },
  );

  assert.deepEqual(summary, {
    longterm_added: 3,
    session_added: 0,
    arcs_added: 2,
    total_added: 5,
  });
});
