#!/usr/bin/env node
/* global process */

import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FOREIGN_MEMORY_NAMES = /summaryception|mnemosyne|vectfox|memorybooks|smart[-_ ]?context/i;

function unique(values) {
  return [...new Set(values)].sort();
}

function importSpecifiers(source) {
  const result = [];
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const staticPattern = /^\s*(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gm;
  const sideEffectPattern = /^\s*import\s*['"]([^'"]+)['"]/gm;
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(staticPattern)) result.push(match[1]);
  for (const match of code.matchAll(sideEffectPattern)) result.push(match[1]);
  for (const match of code.matchAll(dynamicPattern)) result.push(match[1]);
  return result;
}

function insideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function resolveLocalImport(root, importer, specifier) {
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.json`,
    resolve(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (!insideRoot(root, candidate)) continue;
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next conventional extension.
    }
  }
  return null;
}

function classifyExternal(specifier) {
  if (FOREIGN_MEMORY_NAMES.test(specifier)) return 'memory';
  return 'runtime';
}

/** Collects the manifest-closed runtime payload without writing anything. */
export async function collectExtensionPayload(rootDir) {
  const root = resolve(rootDir);
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const entry = typeof manifest.js === 'string' ? manifest.js : manifest.js?.[0];
  const css = typeof manifest.css === 'string' ? manifest.css : manifest.css?.[0];
  const files = new Set(['manifest.json', 'settings.html']);
  if (entry) files.add(entry);
  if (css) files.add(css);

  const queue = entry ? [resolve(root, entry)] : [];
  const localJavascript = new Set();
  const hostApiImports = new Set();
  const externalRuntimeDependencies = new Set();
  const externalMemoryExtensionImports = new Set();
  const unresolvedLocalImports = [];

  while (queue.length > 0) {
    const importer = queue.shift();
    const importerRelative = relative(root, importer);
    if (localJavascript.has(importerRelative)) continue;
    localJavascript.add(importerRelative);
    files.add(importerRelative);
    const source = await readFile(importer, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith('./')) {
        const resolved = await resolveLocalImport(root, importer, specifier);
        if (!resolved) unresolvedLocalImports.push(`${importerRelative} -> ${specifier}`);
        else queue.push(resolved);
      } else if (specifier.startsWith('../')) {
        hostApiImports.add(specifier);
      } else {
        if (classifyExternal(specifier) === 'memory') externalMemoryExtensionImports.add(specifier);
        else externalRuntimeDependencies.add(specifier);
      }
    }
  }

  return {
    root,
    manifest,
    files: unique([...files]),
    local_javascript: unique([...localJavascript]),
    local_javascript_sources: await Promise.all(
      [...localJavascript].sort().map((file) => readFile(resolve(root, file), 'utf8')),
    ),
    host_api_imports: unique([...hostApiImports]),
    external_runtime_dependencies: unique([...externalRuntimeDependencies]),
    external_memory_extension_imports: unique([...externalMemoryExtensionImports]),
    unresolved_local_imports: unique(unresolvedLocalImports),
  };
}

/** Validates that the collected payload can be installed as one ST extension. */
export function validateExtensionPayload(payload, manifest = payload?.manifest ?? {}) {
  const errors = [];
  if (!Array.isArray(manifest.requires) || manifest.requires.length !== 0) {
    errors.push('manifest.requires must be []');
  }
  if (!Array.isArray(manifest.optional) || manifest.optional.length !== 0) {
    errors.push('manifest.optional must be []');
  }
  for (const required of ['manifest.json', manifest.js, manifest.css, 'settings.html']) {
    if (typeof required === 'string' && !payload.files.includes(required)) {
      errors.push(`missing payload file: ${required}`);
    }
  }
  for (const unresolved of payload.unresolved_local_imports ?? []) {
    errors.push(`unresolved local import: ${unresolved}`);
  }
  for (const dependency of payload.external_runtime_dependencies ?? []) {
    errors.push(`bare runtime dependency: ${dependency}`);
  }
  for (const dependency of payload.external_memory_extension_imports ?? []) {
    errors.push(`foreign memory-extension dependency: ${dependency}`);
  }
  return { errors };
}

/** Writes a clean local payload directory for review or manual installation. */
export async function writeExtensionPayload(rootDir, outputDir) {
  const payload = await collectExtensionPayload(rootDir);
  const report = validateExtensionPayload(payload);
  if (report.errors.length > 0) {
    throw new Error(`extension payload is not installable:\n${report.errors.join('\n')}`);
  }
  const output = resolve(outputDir);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await Promise.all(
    payload.files.map(async (file) => {
      const destination = resolve(output, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolve(payload.root, file), destination);
    }),
  );
  return { ...payload, output, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outIndex = process.argv.indexOf('--out');
  const output = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : resolve(root, 'dist/extension-payload');
  const result = await writeExtensionPayload(root, output);
  console.log(JSON.stringify({ output: result.output, files: result.files, host_api_imports: result.host_api_imports }, null, 2));
}
