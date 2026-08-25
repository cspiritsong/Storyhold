import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EMBEDDING_SOURCE_DEFINITIONS, EMBEDDING_SOURCE_IDS } from '../embedding-providers.js';

const root = resolve(import.meta.dirname, '..');

test('Storyhold Embeddings settings expose every SillyTavern vector source', async () => {
  const html = await readFile(resolve(root, 'settings.html'), 'utf8');
  const sourceSelect = html.slice(
    html.indexOf('<select id="sm_embedding_source"'),
    html.indexOf('</select>', html.indexOf('<select id="sm_embedding_source"')) +
      '</select>'.length,
  );

  assert.ok(sourceSelect.length > 0, 'embedding source select is missing');
  for (const source of EMBEDDING_SOURCE_DEFINITIONS) {
    assert.match(sourceSelect, new RegExp(`value="${source.id}"`));
    assert.ok(sourceSelect.includes(`>${source.label}<`), `${source.label} label is missing`);
  }
  assert.equal((sourceSelect.match(/<option\b/g) ?? []).length, EMBEDDING_SOURCE_IDS.length + 1);
  assert.match(sourceSelect, /value="openai_compatible"/);
});

test('Storyhold settings include account and endpoint controls required by provider parity', async () => {
  const html = await readFile(resolve(root, 'settings.html'), 'utf8');

  assert.match(html, /id="sm_embedding_account_id"/);
  assert.match(html, /id="sm_embedding_vertex_region"/);
  assert.match(html, /id="sm_embedding_vertex_project_id"/);
  assert.match(html, /id="sm_embedding_siliconflow_endpoint"/);
  assert.match(html, /id="sm_embedding_url_row"/);
  assert.match(html, /id="sm_embedding_model_openai_row"/);
});

test('provider-specific embedding settings have durable defaults and model-map migration support', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');

  assert.match(source, /embedding_models:\s*\{\}/);
  assert.match(source, /embedding_api_keys:\s*\{\}/);
  assert.match(source, /embedding_account_id:\s*''/);
  assert.match(source, /embedding_vertex_region:\s*'us-central1'/);
  assert.match(source, /embedding_vertex_project_id:\s*''/);
  assert.match(source, /embedding_siliconflow_endpoint:\s*'global'/);
  assert.match(source, /getEmbeddingModelForSource/);
  assert.match(source, /getEmbeddingApiKeyForSource/);
  assert.match(source, /saveEmbeddingApiKey\(value, source/);
});

test('semantic search marks its query text for providers with query/document modes', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');

  assert.match(
    source,
    /getEmbeddingBatch\(\[qLower, \.\.\.memTexts\],\s*\{\s*queryTexts:\s*\[qLower\]/,
  );
});

test('embedding source switching resolves the next provider model before changing active source', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf("const nextSource = String($(this).val() ?? 'ollama');");
  const end = source.indexOf('clearEmbeddingFailed();', start);
  const handler = source.slice(start, end);

  const modelIndex = handler.indexOf('const nextModel = getEmbeddingModelForSource(nextSource, settings);');
  const sourceIndex = handler.indexOf('settings.embedding_source = nextSource;');
  assert.ok(modelIndex >= 0, 'next provider model is not resolved');
  assert.ok(sourceIndex > modelIndex, 'active source changes before next model resolution');
});
