import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveMemoryResponseLength,
  isThinkingChatModel,
  buildProductNarrativePrompt,
  runSelfContainedMemorySummarizeTransport,
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

test('buildProductNarrativePrompt enforces causal, emotional, and temporal requirements', () => {
  const prompt = buildProductNarrativePrompt(
    'Mira refuses Rowan help at the bridge.',
    'Prior journey across northern borders.',
  );
  assert.match(prompt, /prior_context/);
  assert.match(prompt, /new_passage/);
  assert.match(prompt, /Prior journey across northern borders/);
  assert.match(prompt, /Mira refuses Rowan help at the bridge/);
  // causal & emotional requirements
  assert.match(prompt, /causal|cause/i);
  assert.match(prompt, /emotional|decision|motivation/i);
  // chronology & temporal modality
  assert.match(prompt, /chronology|order/i);
  assert.match(prompt, /backstory|flashback/i);
  assert.match(prompt, /hypothetical|rumor/i);
  assert.match(prompt, /date|time/i);
});

test('runSelfContainedMemorySummarizeTransport routes main source with instructOverride and effective main budget', async () => {
  const calls = [];
  const deps = {
    generateRaw: async (args) => {
      calls.push({ type: 'generateRaw', args });
      return 'Generated summary';
    },
    generateQuietPrompt: async () => {
      calls.push({ type: 'generateQuietPrompt' });
      return 'quiet';
    },
    getContext: () => ({ chat: [{ mes: 'LIVE_CHAT_ONLY_MARKER' }] }),
  };

  const result = await runSelfContainedMemorySummarizeTransport(
    {
      source: 'main',
      quietPrompt: 'Track narrative delta',
      responseLength: 500,
      effectiveMainResponseLength: 500,
    },
    deps,
  );

  assert.equal(result, 'Generated summary');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'generateRaw');
  assert.deepEqual(calls[0].args.prompt, [{ role: 'user', content: 'Track narrative delta' }]);
  assert.equal(calls[0].args.instructOverride, true);
  assert.equal(calls[0].args.quietToLoud, false);
  assert.equal(calls[0].args.responseLength, 500);
});

test('runSelfContainedMemorySummarizeTransport uses effective main budget for thinking model', async () => {
  let capturedArgs = null;
  const deps = {
    generateRaw: async (args) => {
      capturedArgs = args;
      return 'Summary';
    },
  };

  const effectiveBudget = effectiveMemoryResponseLength(500, {
    generationBudget: 32768,
    chatCompletionSource: 'makersuite',
    model: 'gemini-3.7-flash',
  });
  assert.equal(effectiveBudget, 8192);

  await runSelfContainedMemorySummarizeTransport(
    {
      source: 'main',
      quietPrompt: 'Track narrative delta',
      responseLength: 500,
      effectiveMainResponseLength: effectiveBudget,
    },
    deps,
  );

  assert.equal(capturedArgs.responseLength, 8192);
  assert.equal(capturedArgs.instructOverride, true);
});

test('runSelfContainedMemorySummarizeTransport handles WebLLM fallback vs available', async () => {
  // WebLLM unavailable falls back to main generateRaw with effectiveMainResponseLength
  let rawArgs = null;
  await runSelfContainedMemorySummarizeTransport(
    {
      source: 'webllm',
      quietPrompt: 'Prompt',
      responseLength: 300,
      effectiveMainResponseLength: 500,
    },
    {
      isWebLlmSupported: () => false,
      generateRaw: async (args) => {
        rawArgs = args;
        return 'Raw fallback';
      },
    },
  );
  assert.equal(rawArgs.responseLength, 500);
  assert.equal(rawArgs.instructOverride, true);

  // WebLLM available uses generateWebLlmChatPrompt with responseLength
  let webllmArgs = null;
  await runSelfContainedMemorySummarizeTransport(
    {
      source: 'webllm',
      quietPrompt: 'Prompt',
      responseLength: 300,
      effectiveMainResponseLength: 500,
    },
    {
      isWebLlmSupported: () => true,
      generateWebLlmChatPrompt: async (messages, opts) => {
        webllmArgs = { messages, opts };
        return 'WebLLM answer';
      },
    },
  );
  assert.deepEqual(webllmArgs.messages, [{ role: 'user', content: 'Prompt' }]);
  assert.equal(webllmArgs.opts.max_tokens, 300);
});

test('runSelfContainedMemorySummarizeTransport routes direct sources with unchanged response budget', async () => {
  let directCalled = null;
  await runSelfContainedMemorySummarizeTransport(
    {
      source: 'ollama',
      quietPrompt: 'Prompt',
      responseLength: 400,
    },
    {
      executeDirectSource: async (source, prompt, opts) => {
        directCalled = { source, prompt, opts };
        return 'Direct output';
      },
    },
  );
  assert.equal(directCalled.source, 'ollama');
  assert.equal(directCalled.prompt, 'Prompt');
  assert.equal(directCalled.opts.responseLength, 400);
});
