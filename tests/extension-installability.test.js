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
  assert.equal(manifest.display_name, 'Storyhold');
  assert.equal(manifest.homepage, 'https://github.com/cspiritsong/Storyhold');
  assert.equal(manifest.homePage, 'https://github.com/cspiritsong/Storyhold');
  assert.ok(payload.local_javascript.length > 10);
  assert.equal(payload.external_runtime_dependencies.length, 0);
  assert.equal(payload.external_memory_extension_imports.length, 0);
});

test('chat memory clear uses the canonical product reset', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');

  assert.match(source, /import \{ resetProductMemory \} from ['"]\.\/product-runtime\.js['"]/);
  assert.match(source, /if \(extension_settings\[MODULE_NAME\]\.single_extension_mode\) \{\s+await resetProductMemory\(context\.chatMetadata\);/);
  assert.match(source, /\/\/ Clear all injection slots and cached unified content\.\s+clearUnifiedSlot\(\);/);
});

test('runtime requests settings from the Storyhold install directory', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');

  assert.match(source, /renderExtensionTemplateAsync\(['"]third-party\/Storyhold['"],\s*['"]settings['"]/);
  assert.doesNotMatch(source, /third-party\/Smart-Memory/);
});

test('About version lookup uses the Storyhold install directory', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');

  assert.match(source, /fetch\(\s*['"]\/scripts\/extensions\/third-party\/Storyhold\/manifest\.json['"]/);
  assert.doesNotMatch(source, /\/scripts\/extensions\/third-party\/Smart-Memory\/manifest\.json/);
});

test('README explains derivative origin, credits, and independent changes', async () => {
  const readme = await readFile(resolve(root, 'README.md'), 'utf8');

  assert.match(readme, /independent derivative of \[Smart Memory\]/);
  assert.match(readme, /Summaryception/);
  assert.match(readme, /What Storyhold changed/);
  assert.match(readme, /chat-local storage as the only mutable memory boundary/);
  assert.match(readme, /https:\/\/github\.com\/cspiritsong\/Storyhold/);
});

test('product runtime has one extension-owned narrative owner and no Summaryception prompt writer', async () => {
  const payload = await collectExtensionPayload(root);
  const source = payload.local_javascript_sources.join('\n');
  assert.match(source, /smart-memory:narrative-chain/);
  assert.doesNotMatch(source, /setExtensionPrompt\s*\(\s*['"]summaryception['"]/i);
  assert.equal(payload.external_runtime_dependencies.length, 0);
  assert.equal(payload.external_memory_extension_imports.length, 0);
});
