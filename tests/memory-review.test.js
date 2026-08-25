import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemoryReview,
  classifyMemoryChallenge,
  isSpoilerMemoryRecord,
  MEMORY_REVIEW_STATUS,
  splitMemoryReviewResults,
} from '../memory-review.js';

test('spoiler epistemic records are separated from ordinary review results', () => {
  const visible = { mem: { kind: 'fact', content: 'The key is silver.' }, score: 0.8 };
  const spoiler = { mem: { kind: 'epistemic', type: 'hiding', content: 'Maeve hides the key.' }, score: 0.9 };

  assert.equal(isSpoilerMemoryRecord(spoiler.mem), true);
  assert.deepEqual(splitMemoryReviewResults([visible, spoiler]), {
    visible: [visible],
    spoiler: [spoiler],
  });
});

test('challenge with no related records remains uncertain', () => {
  const review = classifyMemoryChallenge('The key was destroyed.', []);

  assert.equal(review.status, MEMORY_REVIEW_STATUS.NO_MATCH);
  assert.match(review.detail, /does not prove/i);
});

test('strong challenge matches require human review instead of claiming truth', () => {
  const result = { mem: { kind: 'fact', content: 'The key is silver.' }, score: 0.91 };
  const review = classifyMemoryChallenge('What about the key?', [result]);

  assert.equal(review.status, MEMORY_REVIEW_STATUS.STRONG_MATCH);
  assert.match(review.label, /related evidence/i);
  assert.doesNotMatch(review.detail, /true|false/i);
});

test('building a review copies the result list and does not mutate records', () => {
  const result = {
    mem: {
      kind: 'fact',
      content: 'The key is silver.',
      scope: { chat_uid: 'chat-a', branch_uid: 'branch-a' },
    },
    score: 0.7,
  };
  const before = JSON.stringify(result);
  const review = buildMemoryReview({ mode: 'challenge', query: 'key', results: [result] });

  assert.notEqual(review.results, [result]);
  assert.equal(JSON.stringify(result), before);
  assert.equal(review.challenge.status, MEMORY_REVIEW_STATUS.RELATED);
});
