import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveMemoryResponseLength,
  isThinkingChatModel,
} from '../generation-policy.js';

test('ordinary memory models keep their configured response length', () => {
  assert.equal(
    effectiveMemoryResponseLength(500, {
      generationBudget: 8192,
      chatCompletionSource: 'makersuite',
      model: 'gemini-2.0-flash',
    }),
    500,
  );
});

test('Gemini thinking models receive enough total output budget for reasoning plus answer', () => {
  assert.equal(isThinkingChatModel('makersuite', 'gemini-3.7-flash'), true);
  assert.equal(
    effectiveMemoryResponseLength(500, {
      generationBudget: 32768,
      chatCompletionSource: 'makersuite',
      model: 'gemini-3.7-flash',
    }),
    8192,
  );
});

test('thinking budget floor respects an explicit lower global generation cap', () => {
  assert.equal(
    effectiveMemoryResponseLength(700, {
      generationBudget: 4096,
      chatCompletionSource: 'makersuite',
      model: 'gemini-3.7-flash',
    }),
    4096,
  );
});

test('non-positive response lengths preserve the caller no-cap sentinel', () => {
  assert.equal(
    effectiveMemoryResponseLength(0, {
      generationBudget: 8192,
      chatCompletionSource: 'makersuite',
      model: 'gemini-3.7-flash',
    }),
    0,
  );
  assert.equal(
    effectiveMemoryResponseLength(-1, {
      generationBudget: 8192,
      chatCompletionSource: 'makersuite',
      model: 'gemini-3.7-flash',
    }),
    -1,
  );
});
