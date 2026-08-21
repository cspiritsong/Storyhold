import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectExtensionPayload,
  validateExtensionPayload,
} from '../tools/package-extension.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

test('extension payload is self-contained and manifest-installable', async () => {
  const payload = await collectExtensionPayload(root);
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const report = validateExtensionPayload(payload, manifest);

  assert.deepEqual(report.errors, []);
  assert.deepEqual(manifest.requires, []);
  assert.deepEqual(manifest.optional, []);
  assert.ok(payload.files.includes('manifest.json'));
  assert.ok(payload.files.includes('index.js'));
  assert.ok(payload.files.includes('style.css'));
  assert.ok(payload.files.includes('settings.html'));
  assert.ok(payload.local_javascript.length > 10);
  assert.equal(payload.external_runtime_dependencies.length, 0);
  assert.equal(payload.external_memory_extension_imports.length, 0);
});

test('product runtime has one extension-owned narrative owner and no Summaryception prompt writer', async () => {
  const payload = await collectExtensionPayload(root);
  const source = payload.local_javascript_sources.join('\n');

  assert.match(source, /smart-memory:narrative-chain/);
  assert.doesNotMatch(source, /setExtensionPrompt\s*\(\s*['"]summaryception['"]/i);
  assert.equal(payload.external_runtime_dependencies.length, 0);
  assert.equal(payload.external_memory_extension_imports.length, 0);
});
