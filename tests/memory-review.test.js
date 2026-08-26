import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemoryReview,
  buildChallengePrompt,
  classifyMemoryChallenge,
  isSpoilerMemoryRecord,
  MEMORY_CHALLENGE_VERDICTS,
  MEMORY_REVIEW_PHASES,
  MEMORY_REVIEW_STATUS,
  memoryReviewProgress,
  parseChallengeAdjudication,
  parseChallengeResponse,
  resolveRecordSources,
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

test('review lifecycle gives acknowledgement, progress, and explicit completion messages', () => {
  const acknowledged = memoryReviewProgress({
    mode: 'challenge',
    phase: MEMORY_REVIEW_PHASES.ACKNOWLEDGED,
    query: 'The key was destroyed.',
  });
  assert.equal(acknowledged.busy, true);
  assert.match(acknowledged.message, /Challenge received/i);

  const inProgress = memoryReviewProgress({
    mode: 'query',
    phase: MEMORY_REVIEW_PHASES.IN_PROGRESS,
    totalRecords: 12,
  });
  assert.equal(inProgress.busy, true);
  assert.match(inProgress.message, /Query in progress/i);
  assert.match(inProgress.message, /12/);

  const completed = memoryReviewProgress({
    mode: 'challenge',
    phase: MEMORY_REVIEW_PHASES.COMPLETED,
    resultCount: 2,
    challenge: { label: 'Related evidence found' },
  });
  assert.equal(completed.busy, false);
  assert.match(completed.message, /Challenge complete/i);
  assert.match(completed.message, /no memory was changed/i);
});

test('review errors explain that the query did not change memory', () => {
  const failed = memoryReviewProgress({
    mode: 'query',
    phase: MEMORY_REVIEW_PHASES.FAILED,
  });

  assert.equal(failed.busy, false);
  assert.match(failed.message, /failed/i);
  assert.match(failed.message, /no memory was changed/i);
});

test('cancelled reviews are terminal and report that no memory changed', () => {
  const cancelled = memoryReviewProgress({
    mode: 'challenge',
    phase: MEMORY_REVIEW_PHASES.CANCELLED,
  });

  assert.equal(cancelled.busy, false);
  assert.equal(cancelled.severity, 'info');
  assert.match(cancelled.message, /cancelled/i);
  assert.match(cancelled.message, /no memory was changed/i);
});

test('empty completed queries still report an explicit outcome', () => {
  const completed = memoryReviewProgress({
    mode: 'query',
    phase: MEMORY_REVIEW_PHASES.COMPLETED,
    resultCount: 0,
  });

  assert.equal(completed.busy, false);
  assert.match(completed.message, /found 0 matching records/i);
  assert.match(completed.message, /no memory was changed/i);
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

test('challenge adjudication accepts supported, contradicted, and unresolved verdicts', () => {
  const supported = parseChallengeAdjudication({
    verdict: 'supported',
    explanation: 'The stored fact confirms the claim.',
    citations: ['r1'],
  });
  assert.equal(supported.verdict, MEMORY_CHALLENGE_VERDICTS.SUPPORTED);
  assert.match(supported.explanation, /confirms/i);
  assert.deepEqual(supported.citations, ['r1']);

  const contradicted = parseChallengeAdjudication({
    verdict: 'contradicted',
    explanation: 'The transcript contradicts this.',
    citations: ['r2', 'r3'],
  });
  assert.equal(contradicted.verdict, MEMORY_CHALLENGE_VERDICTS.CONTRADICTED);
  assert.deepEqual(contradicted.citations, ['r2', 'r3']);

  const unresolved = parseChallengeAdjudication({ verdict: 'unresolved', explanation: 'Not enough evidence.' });
  assert.equal(unresolved.verdict, MEMORY_CHALLENGE_VERDICTS.UNRESOLVED);
});

test('challenge adjudication rejects unknown verdicts and foreign citations', () => {
  const unknown = parseChallengeAdjudication({ verdict: 'definitely-wrong', explanation: 'x' });
  assert.equal(unknown.verdict, MEMORY_CHALLENGE_VERDICTS.UNRESOLVED);

  const valid = new Set(['r1', 'r2']);
  const cited = parseChallengeAdjudication(
    { verdict: 'supported', explanation: 'ok', citations: ['r1', 'r99'] },
    { allowedRecordIds: valid },
  );
  assert.deepEqual(cited.citations, ['r1']);
});

test('challenge prompt embeds the claim, memory evidence, and raw source excerpts', () => {
  const prompt = buildChallengePrompt({
    claim: 'The key was destroyed in the forge.',
    evidence: [
      { id: 'r1', content: 'The key is silver.' },
    ],
    sources: [
      { id: 'r1', excerpt: 'She melted the silver key in the forge.', index: 42 },
    ],
  });

  assert.match(prompt, /The key was destroyed in the forge/);
  assert.match(prompt, /The key is silver\./);
  assert.match(prompt, /She melted the silver key in the forge\./);
  assert.match(prompt, /r1/);
  assert.match(prompt, /supported|contradicted|unresolved/i);
});

test('blocked challenge reports the reason and next step instead of a generic cancel', () => {
  const blocked = memoryReviewProgress({
    mode: 'challenge',
    phase: MEMORY_REVIEW_PHASES.CANCELLED,
    reason: 'stable-namespace-fingerprint-mismatch',
  });

  assert.equal(blocked.busy, false);
  assert.match(blocked.message, /stable-namespace-fingerprint-mismatch/);
  assert.match(blocked.message, /no memory was changed/i);
});

test('challenge response parser extracts fenced or bare JSON and tolerates garbage', () => {
  const fenced = parseChallengeResponse('```json\n{"verdict":"contradicted","explanation":"no","citations":["r1"]}\n```');
  assert.equal(fenced.verdict, 'contradicted');
  assert.deepEqual(fenced.citations, ['r1']);

  const bare = parseChallengeResponse('{"verdict":"supported"}');
  assert.equal(bare.verdict, 'supported');

  const garbage = parseChallengeResponse('not json at all');
  assert.deepEqual(garbage, {});
});

test('record source excerpts resolve index and mesId ranges from raw chat', () => {
  const chat = [
    { mes: 'A', mesId: 10 },
    { mes: 'B', mesId: 11 },
    { mes: 'C', mesId: 12 },
  ];

  const byIndex = resolveRecordSources({ id: 'r1', sourceRange: { kind: 'index', start: 0, end: 1 } }, chat);
  assert.equal(byIndex.length, 1);
  assert.match(byIndex[0].excerpt, /A/);
  assert.match(byIndex[0].excerpt, /B/);

  const byMesId = resolveRecordSources({ id: 'r2', sourceRange: { kind: 'mesId', start: 11, end: 12 } }, chat);
  assert.equal(byMesId.length, 1);
  assert.match(byMesId[0].excerpt, /B/);
  assert.match(byMesId[0].excerpt, /C/);
});
