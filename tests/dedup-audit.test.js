import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEDUP_JACCARD_THRESHOLD,
  DEDUP_SEMANTIC_THRESHOLD,
  isDuplicatePair,
  planDuplicateRemoval,
} from '../dedup-audit.js';

test('duplicate pair classification honors semantic and jaccard thresholds', () => {
  assert.equal(isDuplicatePair(0.86, { semantic: true }), true);
  assert.equal(isDuplicatePair(0.84, { semantic: true }), false);
  assert.equal(isDuplicatePair(0.8, { semantic: false }), true);
  assert.equal(isDuplicatePair(0.79, { semantic: false }), false);
});

test('planner keeps the earliest entry and removes later exact duplicates', () => {
  const items = [
    { id: 'a', content: 'Maeve owns an obsidian blade', type: 'fact' },
    { id: 'b', content: 'Maeve owns an obsidian blade', type: 'fact' },
    { id: 'c', content: 'Maeve owns an obsidian blade', type: 'fact' },
  ];
  const scoreFor = (x, y) =>
    x.content === y.content ? { score: 1.0, semantic: true } : { score: 0, semantic: true };

  const plan = planDuplicateRemoval(items, { scoreFor });

  assert.deepEqual(plan.remove_ids, ['b', 'c']);
  assert.deepEqual(plan.keep_ids, ['a']);
  assert.equal(plan.clusters.length, 1);
});

test('planner never removes a memory that carries a state-change marker', () => {
  const items = [
    { id: 'a', content: 'Maeve distrusts Kai', type: 'fact' },
    { id: 'b', content: 'Maeve no longer distrusts Kai', type: 'fact' },
  ];
  const scoreFor = () => ({ score: 0.9, semantic: true });

  const plan = planDuplicateRemoval(items, { scoreFor });

  assert.deepEqual(plan.remove_ids, []);
  assert.deepEqual(plan.keep_ids, ['a', 'b']);
});

test('planner ignores cross-type pairs and low-similarity pairs', () => {
  const items = [
    { id: 'a', content: 'Maeve is an assassin', type: 'fact' },
    { id: 'b', content: 'Maeve is an assassin', type: 'relationship' },
    { id: 'c', content: 'Maeve is an assassin', type: 'fact' },
    { id: 'd', content: 'unrelated scenery detail about fjords', type: 'fact' },
  ];
  const scoreFor = (x, y) =>
    x.content === y.content ? { score: 1.0, semantic: true } : { score: 0, semantic: true };

  const plan = planDuplicateRemoval(items, { scoreFor });

  // b is cross-type, d is unrelated: both untouched.
  assert.deepEqual(plan.remove_ids, ['c']);
  assert.deepEqual(plan.keep_ids, ['a', 'b', 'd']);
});

test('planner falls back to jaccard when no scorer result is provided', () => {
  const items = [
    { id: 'a', content: 'the black cat slept', type: 'fact' },
    { id: 'b', content: 'the black cat slept', type: 'fact' },
  ];
  const plan = planDuplicateRemoval(items, { scoreFor: () => null });

  assert.deepEqual(plan.remove_ids, ['b']);
  assert.ok(plan.pairs[0].score >= DEDUP_JACCARD_THRESHOLD);
});

test('threshold constants stay conservative for safe auto-removal', () => {
  assert.ok(DEDUP_SEMANTIC_THRESHOLD >= 0.85);
  assert.ok(DEDUP_JACCARD_THRESHOLD >= 0.8);
});
