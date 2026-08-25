/**
 * Provider metadata and HTTP contracts for Storyhold semantic embeddings.
 *
 * This module deliberately has no SillyTavern runtime imports. It can be tested
 * in Node and keeps provider-specific URL/body/response details out of the
 * memory and settings orchestration code.
 */

const SOURCE_DEFINITIONS = [
  {
    id: 'chutes',
    label: 'Chutes',
    kind: 'openai_compatible',
    defaultModel: 'chutes-qwen-qwen3-embedding-8b',
    requiresApiKey: true,
    responseType: 'openai',
  },
  {
    id: 'workers_ai',
    label: 'Cloudflare Workers AI',
    kind: 'openai_compatible',
    defaultModel: '@cf/baai/bge-m3',
    requiresApiKey: true,
    requiresAccountId: true,
    responseType: 'openai',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    kind: 'cohere',
    defaultModel: 'embed-english-v3.0',
    requiresApiKey: true,
    responseType: 'cohere',
  },
  {
    id: 'electronhub',
    label: 'Electron Hub',
    kind: 'openai_compatible',
    defaultModel: 'text-embedding-3-small',
    requiresApiKey: true,
    responseType: 'openai',
  },
  {
    id: 'extras',
    label: 'Extras (deprecated)',
    kind: 'extras',
    defaultModel: '',
    requiresUrl: true,
    responseType: 'extras',
  },
  {
    id: 'palm',
    label: 'Google AI Studio',
    kind: 'google_ai_studio',
    defaultModel: 'text-embedding-005',
    requiresApiKey: true,
    responseType: 'google',
  },
  {
    id: 'vertexai',
    label: 'Google Vertex AI',
    kind: 'google_vertex',
    defaultModel: 'text-embedding-005',
    requiresApiKey: true,
    responseType: 'vertex',
  },
  {
    id: 'koboldcpp',
    label: 'KoboldCpp',
    kind: 'openai_compatible',
    defaultModel: '',
    requiresUrl: true,
    responseType: 'koboldcpp',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    kind: 'openai_compatible',
    defaultModel: '',
    requiresUrl: true,
    responseType: 'openai',
  },
  {
    id: 'transformers',
    label: 'Local (Transformers)',
    kind: 'runtime',
    runtime: 'transformers',
    defaultModel: '',
    responseType: 'runtime',
  },
  {
    id: 'mistral',
    label: 'MistralAI',
    kind: 'openai_compatible',
    defaultModel: 'mistral-embed',
    requiresApiKey: true,
    responseType: 'openai',
  },
  {
    id: 'nanogpt',
    label: 'NanoGPT',
    kind: 'openai_compatible',
    defaultModel: 'text-embedding-3-small',
    requiresApiKey: true,
    responseType: 'openai',
  },
  {
    id: 'nomicai',
    label: 'NomicAI',
    kind: 'nomicai',
    defaultModel: 'nomic-embed-text-v1.5',
    requiresApiKey: true,
    responseType: 'nomicai',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'ollama',
    defaultModel: 'nomic-embed-text',
    defaultUrl: 'http://localhost:11434',
    responseType: 'ollama',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai_compatible',
    defaultModel: 'text-embedding-ada-002',
    requiresApiKey: true,
    responseType: 'openai',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai_compatible',
    defaultModel: 'openai/text-embedding-3-large',
    requiresApiKey: true,
    responseType: 'openai',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    kind: 'openai_compatible',
    defaultModel: 'Qwen/Qwen3-Embedding-0.6B',
    requiresApiKey: true,
    responseType: 'openai',
  },
  {
    id: 'togetherai',
    label: 'TogetherAI',
    kind: 'openai_compatible',
    defaultModel: 'togethercomputer/m2-bert-80M-32k-retrieval',
    requiresApiKey: true,
    responseType: 'openai',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    kind: 'openai_compatible',
    defaultModel: '',
    requiresUrl: true,
    responseType: 'openai',
  },
  {
    id: 'webllm',
    label: 'WebLLM Extension',
    kind: 'runtime',
    runtime: 'webllm',
    defaultModel: '',
    responseType: 'runtime',
  },
];

const LEGACY_SOURCE_DEFINITION = {
  id: 'openai_compatible',
  label: 'OpenAI Compatible',
  kind: 'openai_compatible',
  defaultModel: '',
  defaultUrl: 'http://localhost:11434',
  requiresUrl: true,
  responseType: 'openai',
};

export const EMBEDDING_SOURCE_DEFINITIONS = Object.freeze(
  SOURCE_DEFINITIONS.map((definition) => Object.freeze({ ...definition })),
);

export const EMBEDDING_SOURCE_IDS = Object.freeze(
  EMBEDDING_SOURCE_DEFINITIONS.map((definition) => definition.id),
);

const DEFINITIONS_BY_ID = new Map(
  [...EMBEDDING_SOURCE_DEFINITIONS, LEGACY_SOURCE_DEFINITION].map((definition) => [
    definition.id,
    definition,
  ]),
);

/**
 * Returns the provider definition for a persisted source identifier.
 * @param {string} source
 * @returns {object}
 */
export function getEmbeddingSourceDefinition(source) {
  const definition = DEFINITIONS_BY_ID.get(source);
  if (!definition) throw new Error(`Unknown embedding source: ${source}`);
  return definition;
}

/**
 * Returns the recommended model for a provider. Empty means the provider gets
 * its model from the server/runtime rather than from Storyhold.
 * @param {string} source
 * @returns {string}
 */
export function getDefaultEmbeddingModel(source) {
  return getEmbeddingSourceDefinition(source).defaultModel;
}

/**
 * Normalizes SillyTavern's OpenRouter embedding catalog into safe option data.
 * The host route returns `{ id, name }` entries, but keeping this boundary
 * defensive prevents malformed provider data from reaching the settings DOM.
 * @param {unknown} data
 * @returns {{id: string, name: string}[]}
 */
export function normalizeOpenRouterEmbeddingModels(data) {
  const entries = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const seen = new Set();
  const models = [];

  for (const entry of entries) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
    models.push({ id, name });
  }

  return models;
}

/**
 * Fetches OpenRouter's embedding catalog through SillyTavern's same-origin
 * backend route. SillyTavern resolves API Connections server-side, so this
 * request deliberately carries no provider key or model secret.
 * @param {typeof fetch} [fetchImpl]
 * @param {HeadersInit} [headers]
 * @returns {Promise<{id: string, name: string}[]>}
 */
export async function fetchOpenRouterEmbeddingModels(fetchImpl = fetch, headers = {}) {
  const response = await fetchImpl('/api/openrouter/models/embedding', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  if (!response?.ok) {
    throw new Error(
      `OpenRouter embedding model catalog request failed (${response?.status ?? 'unknown'})`,
    );
  }
  return normalizeOpenRouterEmbeddingModels(await response.json());
}

function requireTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('Embedding request requires at least one text');
  }
  if (texts.some((text) => typeof text !== 'string')) {
    throw new Error('Embedding request texts must be strings');
  }
}

function requireApiKey(definition, apiKey) {
  if (definition.requiresApiKey && !String(apiKey || '').trim()) {
    throw new Error(`${definition.label} requires an API key`);
  }
}

function parseBaseUrl(value, fallback, label = 'embedding') {
  const raw = String(value || fallback || '').trim();
  if (!raw) throw new Error(`${label} URL is required`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${label} URL`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Invalid ${label} URL protocol`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} URL must not contain credentials`);
  }

  url.hash = '';
  return url;
}

function appendV1Embeddings(value, fallback) {
  const url = parseBaseUrl(value, fallback);
  const pathname = url.pathname.replace(/\/+$/, '');

  if (pathname.endsWith('/embeddings')) {
    return url.toString().replace(/\/$/, '');
  }

  const versionedPath = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  url.pathname = `${versionedPath}/embeddings`;
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function replacePath(value, path, fallback, label = 'embedding') {
  const url = parseBaseUrl(value, fallback, label);
  url.pathname = path;
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function authHeaders(apiKey, extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(String(apiKey || '').trim() ? { Authorization: `Bearer ${String(apiKey).trim()}` } : {}),
    ...extra,
  };
}

function openAiRequest(url, texts, model, apiKey, includeModel = true) {
  const body = { input: texts };
  if (includeModel && model) body.model = model;
  return {
    url,
    options: {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
    },
    responseType: 'openai',
  };
}

/**
 * Builds a provider-specific HTTP request. Runtime-backed providers are
 * intentionally rejected here and handled by embeddings.js.
 *
 * @param {string} source
 * @param {object} options
 * @param {string[]} options.texts
 * @param {string} [options.model]
 * @param {string} [options.url]
 * @param {string} [options.apiKey]
 * @param {boolean} [options.keep]
 * @param {'search_query'|'search_document'} [options.inputType]
 * @param {string} [options.accountId]
 * @param {string} [options.vertexRegion]
 * @param {string} [options.vertexProjectId]
 * @param {string} [options.siliconflowEndpoint]
 * @param {HeadersInit} [options.headers]
 * @returns {{url: string, options: RequestInit, responseType: string}}
 */
export function buildEmbeddingRequest(source, options = {}) {
  const definition = getEmbeddingSourceDefinition(source);
  const texts = options.texts;
  requireTexts(texts);
  requireApiKey(definition, options.apiKey);

  if (definition.kind === 'runtime') {
    throw new Error(`${definition.label} is a SillyTavern runtime provider`);
  }

  const model = String(options.model || definition.defaultModel || '').trim();
  if (
    !model &&
    !['llamacpp', 'koboldcpp'].includes(source) &&
    ['openai_compatible', 'cohere', 'google_ai_studio', 'google_vertex', 'nomicai'].includes(
      definition.kind,
    )
  ) {
    throw new Error(`${definition.label} requires a model`);
  }

  switch (definition.kind) {
    case 'ollama': {
      const url = replacePath(options.url, '/api/embed', definition.defaultUrl, definition.label);
      return {
        url,
        options: {
          method: 'POST',
          headers: authHeaders(options.apiKey),
          body: JSON.stringify({
            input: texts,
            model,
            keep_alive: options.keep ? -1 : undefined,
            truncate: true,
          }),
        },
        responseType: definition.responseType,
      };
    }

    case 'cohere':
      return {
        url: options.url
          ? replacePath(options.url, '/v2/embed', undefined, definition.label)
          : 'https://api.cohere.ai/v2/embed',
        options: {
          method: 'POST',
          headers: authHeaders(options.apiKey),
          body: JSON.stringify({
            texts,
            model,
            embedding_types: ['float'],
            input_type: options.inputType === 'search_query' ? 'search_query' : 'search_document',
            truncate: 'END',
          }),
        },
        responseType: definition.responseType,
      };

    case 'google_ai_studio':
      return {
        url: `${
          options.url
            ? replacePath(
                options.url,
                `/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
                undefined,
                definition.label,
              )
            : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`
        }`,
        options: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': String(options.apiKey).trim(),
          },
          body: JSON.stringify({
            requests: texts.map((text) => ({
              model: `models/${model}`,
              content: { parts: [{ text }] },
            })),
          }),
        },
        responseType: definition.responseType,
      };

    case 'google_vertex': {
      const region = String(options.vertexRegion || 'us-central1').trim();
      if (!/^[a-z0-9-]+$/i.test(region)) throw new Error('Invalid Vertex AI region');
      const baseUrl =
        region === 'global'
          ? 'https://aiplatform.googleapis.com/v1'
          : `https://${region}-aiplatform.googleapis.com/v1`;
      const projectId = String(options.vertexProjectId || '').trim();
      const path = projectId
        ? `/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/publishers/google/models/${encodeURIComponent(model)}:predict`
        : `/publishers/google/models/${encodeURIComponent(model)}:predict`;
      return {
        url: options.url
          ? replacePath(options.url, path, undefined, definition.label)
          : `${baseUrl}${path}`,
        options: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': String(options.apiKey).trim(),
          },
          body: JSON.stringify({ instances: texts.map((text) => ({ content: text })) }),
        },
        responseType: definition.responseType,
      };
    }

    case 'extras':
      return {
        url: replacePath(options.url, '/api/embeddings/compute', undefined, definition.label),
        options: {
          method: 'POST',
          headers: authHeaders(options.apiKey),
          body: JSON.stringify({ text: texts }),
        },
        responseType: definition.responseType,
      };

    case 'nomicai':
      return {
        url: options.url
          ? replacePath(options.url, '/v1/embedding/text', undefined, definition.label)
          : 'https://api-atlas.nomic.ai/v1/embedding/text',
        options: {
          method: 'POST',
          headers: authHeaders(options.apiKey),
          body: JSON.stringify({ texts, model }),
        },
        responseType: definition.responseType,
      };

    case 'openai_compatible': {
      if (source === 'koboldcpp') {
        const server = String(options.url || '')
          .trim()
          .replace(/\/+$/, '');
        parseBaseUrl(server, undefined, definition.label);
        return {
          url: '/api/backends/kobold/embed',
          options: {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(options.headers || {}),
            },
            body: JSON.stringify({ items: texts, server }),
          },
          responseType: definition.responseType,
        };
      }

      requireApiKey(definition, options.apiKey);
      let baseUrl = options.url;
      if (!baseUrl) {
        const fixedBaseUrls = {
          openai: 'https://api.openai.com/v1',
          mistral: 'https://api.mistral.ai/v1',
          togetherai: 'https://api.together.xyz/v1',
          openrouter: 'https://openrouter.ai/api/v1',
          electronhub: 'https://api.electronhub.ai/v1',
          nanogpt: 'https://nano-gpt.com/api/v1',
          siliconflow:
            options.siliconflowEndpoint === 'cn'
              ? 'https://api.siliconflow.cn/v1'
              : 'https://api.siliconflow.com/v1',
          openai_compatible: definition.defaultUrl,
        };
        if (source === 'workers_ai') {
          const accountId = String(options.accountId || '').trim();
          if (!accountId) throw new Error('Cloudflare Workers AI account ID is required');
          baseUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`;
        } else if (source === 'chutes') {
          if (!/^[A-Za-z0-9._-]+$/.test(model)) {
            throw new Error('Chutes model must be a valid model slug');
          }
          baseUrl = `https://${model}.chutes.ai/v1`;
        } else {
          baseUrl = fixedBaseUrls[source];
        }
      }
      if (!baseUrl) throw new Error(`${definition.label} embedding URL is required`);

      const request = openAiRequest(
        appendV1Embeddings(baseUrl),
        texts,
        model,
        options.apiKey,
        source !== 'chutes' && source !== 'llamacpp' && source !== 'koboldcpp',
      );
      if (source === 'openrouter') {
        request.options.headers['HTTP-Referer'] = 'https://github.com/cspiritsong/Storyhold';
        request.options.headers['X-Title'] = 'Storyhold';
      }
      return request;
    }

    default:
      throw new Error(`Unsupported embedding provider kind: ${definition.kind}`);
  }
}

/**
 * Executes one provider request and parses its response. The fetch function is
 * injectable so the contract can be tested without contacting a provider.
 * @param {string} source
 * @param {object} options
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<number[][]>}
 */
export async function requestEmbeddingBatch(source, options = {}, fetchImpl = fetch) {
  const definition = getEmbeddingSourceDefinition(source);
  const request = buildEmbeddingRequest(source, options);
  const response = await fetchImpl(request.url, request.options);
  if (!response?.ok) {
    throw new Error(`${definition.label} request failed`);
  }

  const data = await response.json();
  return parseEmbeddingResponse(source, data);
}

function assertVectors(vectors) {
  if (
    !Array.isArray(vectors) ||
    vectors.length === 0 ||
    vectors.some(
      (vector) =>
        !Array.isArray(vector) ||
        vector.length === 0 ||
        vector.some((n) => typeof n !== 'number' || !Number.isFinite(n)),
    )
  ) {
    throw new Error('Invalid embedding response');
  }
  return vectors;
}

/**
 * Converts a provider response into an ordered array of numeric vectors.
 * @param {string} source
 * @param {any} data
 * @returns {number[][]}
 */
export function parseEmbeddingResponse(source, data) {
  const definition = getEmbeddingSourceDefinition(source);

  switch (definition.responseType) {
    case 'openai': {
      if (!Array.isArray(data?.data)) throw new Error('Invalid embedding response');
      const entries = data.data.map((entry, index) => ({ entry, index }));
      if (entries.every(({ entry }) => Number.isFinite(entry?.index))) {
        entries.sort((a, b) => a.entry.index - b.entry.index);
      }
      return assertVectors(entries.map(({ entry }) => entry?.embedding));
    }
    case 'koboldcpp':
      return assertVectors(data?.embeddings);
    case 'ollama':
    case 'nomicai':
      return assertVectors(data?.embeddings);
    case 'cohere':
      return assertVectors(data?.embeddings?.float);
    case 'google':
      return assertVectors(data?.embeddings?.map((embedding) => embedding?.values));
    case 'vertex':
      return assertVectors(data?.predictions?.map((prediction) => prediction?.embeddings?.values));
    case 'extras': {
      const embedding = data?.embedding;
      if (Array.isArray(embedding) && embedding.every((item) => typeof item === 'number')) {
        return assertVectors([embedding]);
      }
      return assertVectors(embedding);
    }
    default:
      throw new Error('Runtime providers do not return HTTP responses');
  }
}
