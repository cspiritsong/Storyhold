import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBEDDING_SOURCE_IDS,
  EMBEDDING_SOURCE_DEFINITIONS,
  buildEmbeddingRequest,
  getDefaultEmbeddingModel,
  getEmbeddingSourceDefinition,
  parseEmbeddingResponse,
  requestEmbeddingBatch,
} from '../embedding-providers.js';

const SILLYTAVERN_SOURCE_IDS = [
  'chutes',
  'workers_ai',
  'cohere',
  'electronhub',
  'extras',
  'palm',
  'vertexai',
  'koboldcpp',
  'llamacpp',
  'transformers',
  'mistral',
  'nanogpt',
  'nomicai',
  'ollama',
  'openai',
  'openrouter',
  'siliconflow',
  'togetherai',
  'vllm',
  'webllm',
];

test('embedding registry mirrors all current SillyTavern vector sources', () => {
  assert.deepEqual(EMBEDDING_SOURCE_IDS, SILLYTAVERN_SOURCE_IDS);
  assert.equal(EMBEDDING_SOURCE_DEFINITIONS.length, SILLYTAVERN_SOURCE_IDS.length);
  assert.deepEqual(
    EMBEDDING_SOURCE_DEFINITIONS.map((source) => source.id),
    SILLYTAVERN_SOURCE_IDS,
  );
});

test('legacy OpenAI-compatible source remains available without changing its identifier', () => {
  const source = getEmbeddingSourceDefinition('openai_compatible');

  assert.equal(source.id, 'openai_compatible');
  assert.equal(source.label, 'OpenAI Compatible');
  assert.equal(source.kind, 'openai_compatible');
});

test('provider defaults match SillyTavern vector configuration defaults', () => {
  assert.equal(getDefaultEmbeddingModel('ollama'), 'nomic-embed-text');
  assert.equal(getDefaultEmbeddingModel('openai'), 'text-embedding-ada-002');
  assert.equal(getDefaultEmbeddingModel('cohere'), 'embed-english-v3.0');
  assert.equal(getDefaultEmbeddingModel('palm'), 'text-embedding-005');
  assert.equal(
    getDefaultEmbeddingModel('togetherai'),
    'togethercomputer/m2-bert-80M-32k-retrieval',
  );
  assert.equal(getDefaultEmbeddingModel('mistral'), 'mistral-embed');
  assert.equal(getDefaultEmbeddingModel('nomicai'), 'nomic-embed-text-v1.5');
  assert.equal(getDefaultEmbeddingModel('openrouter'), 'openai/text-embedding-3-large');
  assert.equal(getDefaultEmbeddingModel('workers_ai'), '@cf/baai/bge-m3');
});

test('every non-runtime source has a complete request construction contract', () => {
  for (const source of EMBEDDING_SOURCE_DEFINITIONS) {
    if (source.kind === 'runtime') continue;
    const request = buildEmbeddingRequest(source.id, {
      texts: ['one'],
      model: source.defaultModel || 'server-loaded-model',
      url: source.requiresUrl ? 'http://localhost:9000/embeddings-service' : undefined,
      apiKey: source.requiresApiKey ? 'test-key' : undefined,
      accountId: source.requiresAccountId ? 'account-id' : undefined,
    });
    assert.ok(request.url, `${source.id} has no endpoint`);
    assert.equal(request.options.method, 'POST', `${source.id} is not a POST request`);
  }
});

test('OpenAI-compatible requests preserve a custom v1 path and auth header', () => {
  const request = buildEmbeddingRequest('openai_compatible', {
    texts: ['one', 'two'],
    model: 'text-embedding-3-small',
    url: 'https://embeddings.example.test/compatible/v1/',
    apiKey: 'test-key',
  });

  assert.equal(request.url, 'https://embeddings.example.test/compatible/v1/embeddings');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    input: ['one', 'two'],
    model: 'text-embedding-3-small',
  });
});

test('legacy OpenAI-compatible source keeps its localhost fallback', () => {
  const request = buildEmbeddingRequest('openai_compatible', {
    texts: ['one'],
    model: 'nomic-embed-text',
  });

  assert.equal(request.url, 'http://localhost:11434/v1/embeddings');
});

test('Ollama requests use the native batch endpoint and keep-alive setting', () => {
  const request = buildEmbeddingRequest('ollama', {
    texts: ['one', 'two'],
    model: 'nomic-embed-text',
    url: 'http://localhost:11434/',
    keep: true,
  });

  assert.equal(request.url, 'http://localhost:11434/api/embed');
  assert.deepEqual(JSON.parse(request.options.body), {
    input: ['one', 'two'],
    model: 'nomic-embed-text',
    keep_alive: -1,
    truncate: true,
  });
});

test('Cohere requests carry the query/document input type required by Vector Storage', () => {
  const request = buildEmbeddingRequest('cohere', {
    texts: ['find the key'],
    model: 'embed-v4.0',
    apiKey: 'test-key',
    inputType: 'search_query',
  });

  assert.equal(request.url, 'https://api.cohere.ai/v2/embed');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    texts: ['find the key'],
    model: 'embed-v4.0',
    embedding_types: ['float'],
    input_type: 'search_query',
    truncate: 'END',
  });
});

test('Google AI Studio requests use the batch embedding contract without putting the key in the URL', () => {
  const request = buildEmbeddingRequest('palm', {
    texts: ['one'],
    model: 'gemini-embedding-001',
    apiKey: 'test-key',
  });

  assert.equal(
    request.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
  );
  assert.equal(request.url.includes('test-key'), false);
  assert.equal(request.options.headers['x-goog-api-key'], 'test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    requests: [
      {
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: 'one' }] },
      },
    ],
  });
});

test('Vertex AI requests use prediction instances and an explicit region', () => {
  const request = buildEmbeddingRequest('vertexai', {
    texts: ['one'],
    model: 'text-embedding-005',
    apiKey: 'test-key',
    vertexRegion: 'asia-southeast1',
  });

  assert.equal(
    request.url,
    'https://asia-southeast1-aiplatform.googleapis.com/v1/publishers/google/models/text-embedding-005:predict',
  );
  assert.equal(request.options.headers['x-goog-api-key'], 'test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    instances: [{ content: 'one' }],
  });
});

test('Workers AI requires an account id and constructs the account-scoped endpoint', () => {
  assert.throws(
    () =>
      buildEmbeddingRequest('workers_ai', {
        texts: ['one'],
        model: '@cf/baai/bge-m3',
        apiKey: 'test-key',
      }),
    /account ID/i,
  );

  const request = buildEmbeddingRequest('workers_ai', {
    texts: ['one'],
    model: '@cf/baai/bge-m3',
    apiKey: 'test-key',
    accountId: 'account/with spaces',
  });

  assert.equal(
    request.url,
    'https://api.cloudflare.com/client/v4/accounts/account%2Fwith%20spaces/ai/v1/embeddings',
  );
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    input: ['one'],
    model: '@cf/baai/bge-m3',
  });
});

test('llama.cpp and vLLM preserve configured URL path prefixes', () => {
  const llama = buildEmbeddingRequest('llamacpp', {
    texts: ['one'],
    url: 'http://localhost:8080/compatible/v1',
  });
  const vllm = buildEmbeddingRequest('vllm', {
    texts: ['one'],
    model: 'intfloat/e5-mistral-7b-instruct',
    url: 'http://localhost:8000/compatible',
  });

  assert.equal(llama.url, 'http://localhost:8080/compatible/v1/embeddings');
  assert.equal(vllm.url, 'http://localhost:8000/compatible/v1/embeddings');
  assert.deepEqual(JSON.parse(vllm.options.body), {
    input: ['one'],
    model: 'intfloat/e5-mistral-7b-instruct',
  });
});

test("KoboldCpp uses SillyTavern's same-origin embedding adapter", () => {
  const request = buildEmbeddingRequest('koboldcpp', {
    texts: ['one'],
    url: 'http://localhost:5001',
  });

  assert.equal(request.url, '/api/backends/kobold/embed');
  assert.deepEqual(JSON.parse(request.options.body), {
    items: ['one'],
    server: 'http://localhost:5001',
  });
});

test('provider response parsers preserve embedding order and normalize provider shapes', () => {
  assert.deepEqual(
    parseEmbeddingResponse('openai', {
      data: [
        { index: 1, embedding: [2] },
        { index: 0, embedding: [1] },
      ],
    }),
    [[1], [2]],
  );
  assert.deepEqual(parseEmbeddingResponse('ollama', { embeddings: [[1], [2]] }), [[1], [2]]);
  assert.deepEqual(parseEmbeddingResponse('cohere', { embeddings: { float: [[1], [2]] } }), [
    [1],
    [2],
  ]);
  assert.deepEqual(
    parseEmbeddingResponse('palm', { embeddings: [{ values: [1] }, { values: [2] }] }),
    [[1], [2]],
  );
  assert.deepEqual(
    parseEmbeddingResponse('vertexai', { predictions: [{ embeddings: { values: [1] } }] }),
    [[1]],
  );
  assert.deepEqual(parseEmbeddingResponse('extras', { embedding: [1, 2] }), [[1, 2]]);
  assert.deepEqual(parseEmbeddingResponse('extras', { embedding: [[1], [2]] }), [[1], [2]]);
  assert.deepEqual(parseEmbeddingResponse('koboldcpp', { embeddings: [[1], [2]] }), [[1], [2]]);
});

test('provider response parsers reject malformed or empty vector responses', () => {
  assert.throws(() => parseEmbeddingResponse('openai', { data: [] }), /embedding response/i);
  assert.throws(() => parseEmbeddingResponse('cohere', { embeddings: {} }), /embedding response/i);
  assert.throws(
    () => parseEmbeddingResponse('ollama', { embeddings: [[]] }),
    /embedding response/i,
  );
});

test('ST-internal runtime sources are identified before request construction', () => {
  assert.equal(getEmbeddingSourceDefinition('transformers').kind, 'runtime');
  assert.equal(getEmbeddingSourceDefinition('webllm').kind, 'runtime');
  assert.throws(() => buildEmbeddingRequest('transformers', { texts: ['one'] }), /runtime/i);
});

test('requestEmbeddingBatch executes the built request and returns parsed vectors', async () => {
  let observed;
  const vectors = await requestEmbeddingBatch(
    'openai',
    {
      texts: ['one', 'two'],
      model: 'text-embedding-3-small',
      apiKey: 'test-key',
    },
    async (url, options) => {
      observed = { url, options };
      return {
        ok: true,
        json: async () => ({
          data: [
            { index: 1, embedding: [2] },
            { index: 0, embedding: [1] },
          ],
        }),
      };
    },
  );

  assert.equal(observed.url, 'https://api.openai.com/v1/embeddings');
  assert.equal(observed.options.method, 'POST');
  assert.deepEqual(vectors, [[1], [2]]);
});

test('requestEmbeddingBatch rejects failed provider responses without exposing response content', async () => {
  await assert.rejects(
    () =>
      requestEmbeddingBatch(
        'openai',
        { texts: ['one'], model: 'text-embedding-3-small', apiKey: 'test-key' },
        async () => ({
          ok: false,
          status: 401,
          text: async () => 'provider secret should not be copied',
        }),
      ),
    (error) => {
      assert.match(error.message, /OpenAI request failed/);
      assert.doesNotMatch(error.message, /provider secret/);
      return true;
    },
  );
});
