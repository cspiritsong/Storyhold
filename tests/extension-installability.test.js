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
  const [manifestSource, settingsHtml, lockfile] = await Promise.all([
    readFile(resolve(root, 'manifest.json'), 'utf8'),
    readFile(resolve(root, 'settings.html'), 'utf8'),
    readFile(resolve(root, 'package-lock.json'), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestSource);
  const lock = JSON.parse(lockfile);
  const report = validateExtensionPayload(payload, manifest);

  assert.deepEqual(report.errors, []);
  assert.deepEqual(manifest.requires, []);
  assert.deepEqual(manifest.optional, []);
  assert.ok(payload.files.includes('manifest.json'));
  assert.ok(payload.files.includes('index.js'));
  assert.ok(payload.files.includes('style.css'));
  assert.ok(payload.files.includes('settings.html'));
  assert.ok(payload.files.includes('product-operation.js'));
  assert.ok(payload.files.includes('product-status.js'));
  assert.match(settingsHtml, /id="sm_product_status_panel"/);
  assert.match(settingsHtml, /id="sm_product_status_counts"/);
  assert.equal(manifest.display_name, 'Storyhold');
  assert.equal(manifest.homepage, 'https://github.com/cspiritsong/Storyhold');
  assert.equal(manifest.homePage, 'https://github.com/cspiritsong/Storyhold');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.ok(payload.local_javascript.length > 10);
  assert.equal(payload.external_runtime_dependencies.length, 0);
  assert.equal(payload.external_memory_extension_imports.length, 0);
});

test('chat memory clear uses the canonical product reset', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');

  assert.match(source, /import \{ resetProductMemory \} from ['"]\.\/product-runtime\.js['"]/);
  assert.match(source, /await resetProductMemory\(context\.chatMetadata, async \(\) => \{[\s\S]*productClearBlocked/);
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

test('token bar reads the current API-specific context limit', async () => {
  const source = await readFile(resolve(root, 'ui.js'), 'utf8');

  assert.match(source, /getMaxContextTokens/);
  assert.match(source, /const maxContext = getMaxContextTokens\(\) \|\| getContext\(\)\.maxContext \|\| 0;/);
  assert.match(source, /settings\.unified_injection \|\| settings\.single_extension_mode/);
  assert.doesNotMatch(source, /const maxContext = getContext\(\)\.maxContext \|\| 0;/);
});

test('query and challenge review share one read-only console', async () => {
  const [indexSource, settingsHtml, settingsSource, uiSource] = await Promise.all([
    readFile(resolve(root, 'index.js'), 'utf8'),
    readFile(resolve(root, 'settings.html'), 'utf8'),
    readFile(resolve(root, 'settings.js'), 'utf8'),
    readFile(resolve(root, 'ui.js'), 'utf8'),
  ]);

  // Both entry points route through the shared read-only runner.
  assert.match(indexSource, /async function runMemoryReview\(mode, args, queryText\)/);
  assert.match(indexSource, /name: 'sm-challenge'/);
  assert.match(indexSource, /callback: async \(args, claim\) => runMemoryReview\('challenge', args, claim\)/);
  assert.match(indexSource, /callback: async \(args, query\) => runMemoryReview\('query', args, query\)/);
  assert.match(indexSource, /runMemoryReview,\n\s+getSelectedCharacterName,/);

  // The settings panel exposes the same console and delegates to the runner.
  assert.match(settingsHtml, /id="sm_memory_review"/);
  assert.match(settingsHtml, /id="sm_review_text"/);
  assert.match(settingsHtml, /id="sm_review_query"/);
  assert.match(settingsHtml, /id="sm_review_challenge"/);
  assert.match(settingsHtml, /Read-only\. Similarity is evidence, never a truth verdict\./);
  assert.match(settingsSource, /await ctrl\.runMemoryReview\?\.\(mode, \{ k: 10, min: 0\.5 \}, text\)/);

  // The panel renders challenge evidence without rendering a verdict.
  assert.match(uiSource, /export function showMemoryReview\(review\)/);
  assert.match(uiSource, /sm_challenge_banner/);
  assert.match(uiSource, /export function showSearchResults\(query, results\)/);

  // The review must never write memory through the provider path.
  assert.doesNotMatch(indexSource, /runMemoryReview[\s\S]{0,3000}generateMemoryExtract/);
});

test('query and challenge expose acknowledgement, progress, and outcome states', async () => {
  const [indexSource, settingsHtml, settingsSource, uiSource] = await Promise.all([
    readFile(resolve(root, 'index.js'), 'utf8'),
    readFile(resolve(root, 'settings.html'), 'utf8'),
    readFile(resolve(root, 'settings.js'), 'utf8'),
    readFile(resolve(root, 'ui.js'), 'utf8'),
  ]);

  assert.match(settingsHtml, /id="sm_review_status"/);
  assert.match(settingsHtml, /aria-live="polite"/);
  assert.match(uiSource, /export function setMemoryReviewStatus/);
  assert.match(uiSource, /aria-busy/);
  assert.match(uiSource, /Querying…/);
  assert.match(uiSource, /Challenging…/);
  assert.match(indexSource, /MEMORY_REVIEW_PHASES\.ACKNOWLEDGED/);
  assert.match(indexSource, /MEMORY_REVIEW_PHASES\.IN_PROGRESS/);
  assert.match(indexSource, /MEMORY_REVIEW_PHASES\.COMPLETED/);
  assert.match(indexSource, /MEMORY_REVIEW_PHASES\.FAILED/);
  assert.match(settingsSource, /setMemoryReviewStatus/);
  assert.match(uiSource, /Outcome/);
  assert.match(uiSource, /Next step/);
  assert.match(uiSource, /No memory was changed/);
});

test('memory review always reaches a terminal state after an early return', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('async function runMemoryReview(mode, args, queryText)');
  const end = source.indexOf('jQuery(async function ()', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);

  // The wrapper owns the busy lifecycle: its finally must clear ownership and,
  // when the executor returned before publishing a terminal state, restore the
  // controls rather than leaving the console stuck busy.
  assert.match(block, /try \{/);
  assert.match(block, /finally \{/);
  assert.match(block, /if \(memoryReviewOwner === owner\) \{/);
  assert.match(block, /memoryReviewOwner = null;/);
  assert.match(block, /MEMORY_REVIEW_PHASES\.CANCELLED/);
  assert.match(block, /'acknowledged'/);
  assert.match(block, /'in-progress'/);
  assert.match(block, /setMemoryReviewStatus\(/);
});

test('challenge adjudicates claims against records and raw source excerpts', async () => {
  const [indexSource, uiSource] = await Promise.all([
    readFile(resolve(root, 'index.js'), 'utf8'),
    readFile(resolve(root, 'ui.js'), 'utf8'),
  ]);

  // The runner builds a real adjudication and cites only shown records.
  assert.match(indexSource, /async function runChallengeAdjudication\(claim, top\)/);
  assert.match(indexSource, /buildChallengePrompt\(\{ claim, evidence, sources \}\)/);
  assert.match(indexSource, /parseChallengeAdjudication\(parseChallengeResponse\(raw\), \{ allowedRecordIds: allowedRecordIds \}\)/);
  assert.match(indexSource, /resolveRecordSources\(mem, chat\)/);
  assert.match(indexSource, /MEMORY_CHALLENGE_VERDICTS\.UNRESOLVED/);

  // Blocked chats render a reason and next step instead of a bare cancel.
  assert.match(indexSource, /challengeBlockReason\(\)/);
  assert.match(indexSource, /blocked: \{ reason, nextStep: challengeNextStep\(reason\) \}/);
  assert.match(indexSource, /challengeNextStep\(/);

  // The UI renders a verdict, citations, and a blocked outcome.
  assert.match(uiSource, /challengeVerdictLabel\(verdict\)/);
  assert.match(uiSource, /Cited memory: /);
  assert.match(uiSource, /sm_review_outcome_blocked/);
  assert.match(uiSource, /sm_challenge_\$\{review\.adjudication\.verdict\}/);
  assert.match(uiSource, /Challenge blocked\./);
});


test('product catch-up exposes progress and canonical pipeline messaging', async () => {
  const [indexSource, settingsHtml, unifiedSource] = await Promise.all([
    readFile(resolve(root, 'index.js'), 'utf8'),
    readFile(resolve(root, 'settings.html'), 'utf8'),
    readFile(resolve(root, 'unified-inject.js'), 'utf8'),
  ]);

  assert.match(indexSource, /function reportProductProgress/);
  assert.match(indexSource, /onProgress: report/);
  assert.match(settingsHtml, /one bounded product pipeline/);
  assert.match(settingsHtml, /session evidence/);
  assert.match(unifiedSource, /filterProductRecords/);
  assert.match(unifiedSource, /respondingCharacter: responder/);
});

test('product UI contract clears stale views during transitions and gates epistemic spoilers', async () => {
  const source = await readFile(resolve(root, 'ui.js'), 'utf8');

  assert.match(source, /export function clearProductViews/);
  assert.match(source, /renderProductEpistemicList/);
  assert.match(source, /This will reveal hidden character secrets/);
  assert.match(source, /partitionEpistemicRecords/);
  assert.match(source, /filterEpistemicRecordsForSubject/);
  assert.match(source, /isCurrentLineageQuarantined/);
});

test('read-only product commit disables the write block before catch-up starts', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const commitStart = source.indexOf('if (commit) {');
  const commitEnd = source.indexOf('} else {', commitStart);
  assert.ok(commitStart >= 0);
  assert.ok(commitEnd > commitStart);
  const commitBlock = source.slice(commitStart, commitEnd);

  assert.match(commitBlock, /await freshStartSave[;\s][\s\S]*runCatchUpFlow/);
  const freshSaveIndex = commitBlock.indexOf('await freshStartSave');
  const commitCallIndex = source.indexOf(
    'await commitReadOnlyWindow(startIndex, commitStillCurrent)',
    commitStart,
  );
  assert.ok(freshSaveIndex >= 0);
  assert.ok(commitCallIndex >= commitStart + freshSaveIndex);
  assert.doesNotMatch(commitBlock, /const intendedRun = productCommit \? runCatchUpFlow[\s\S]*await freshStartSave/);
});
test('product runtime guards automatic writes and legacy prompt paths', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const settings = await readFile(resolve(root, 'settings.js'), 'utf8');

  assert.match(source, /shouldRunProductIngest\(/);
  assert.match(source, /productOperationGate\.isRunning\(/);
  assert.match(source, /runExclusiveProductOperation\([\s\S]*capturedProductGen/);
  assert.match(source, /async function runSingleExtensionIngest[\s\S]*detectAndPruneInFileBranch/);
  assert.match(source, /arc_resolved_with_summary[\s\S]*settings\.single_extension_mode/);
  assert.match(source, /function onChatChanged\([^)]*\) \{[\s\S]*setCurrentLineage\(null\)[\s\S]*clearAllInjections/);
  assert.match(settings, /if \(isProductMode\(\)\) \{[\s\S]*maybeInjectUnified\(\);/);
  assert.match(settings, /single_extension_mode[\s\S]*injectSummary/);
  assert.match(settings, /REBUILD THIS BRANCH[\s\S]*isFreshStart\(\)/);
  assert.match(settings, /smart_memory:lineage_changed\.storyholdRebuild/);
  assert.match(settings, /productClearBlocked/);
});

test('swipe and delete pruning pass live control and generation guards', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  for (const eventName of ['MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
    const start = source.indexOf(`event_types.${eventName}`);
    const end = eventName === 'MESSAGE_SWIPED'
      ? source.indexOf('event_types.MESSAGE_DELETED', start)
      : source.indexOf('\n\n  onChatChanged();', start);
    assert.ok(start >= 0, `${eventName} handler is missing`);
    assert.ok(end > start, `${eventName} handler has no terminator`);
    const block = source.slice(start, end);
    assert.match(block, /detectAndPruneInFileBranch/);
    assert.match(block, /shouldAbort:/);
    assert.match(block, /isControlBusy:\s*\(\)\s*=>\s*productControl\.isHeld\(\)/);
    assert.match(block, /setCurrentLineage\(null\)/);
    assert.match(block, /smart_memory:lineage_changed/);
    assert.match(block, /allowUnclassifiedPrune:\s*true/);
    const reclassifyIndex = block.indexOf('const reclassified = classifyChatLineage');
    const injectIndex = block.indexOf('maybeInjectUnified');
    assert.ok(reclassifyIndex >= 0 && injectIndex > reclassifyIndex);
  }
});

test('swipe and delete reclassify lineage and re-inject tiers in compatibility mode', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  assert.match(source, /async function reinjectCompatibilityTiers/);
  const swipeStart = source.indexOf('event_types.MESSAGE_SWIPED');
  const swipeEnd = source.indexOf('event_types.MESSAGE_DELETED', swipeStart);
  const swipe = source.slice(swipeStart, swipeEnd);
  assert.match(swipe, /classifyChatLineage\(/);
  assert.match(swipe, /reinjectCompatibilityTiers\(/);
  assert.match(swipe, /single_extension_mode[\s\S]*reinjectCompatibilityTiers\(/);
  assert.doesNotMatch(
    swipe,
    /if \(\s*!getSettings\(\)\.single_extension_mode[\s\S]*\) return;[\s\S]*classifyChatLineage/,
  );
  const deleteStart = source.indexOf('event_types.MESSAGE_DELETED');
  const deleteEnd = source.indexOf('// ---- Slash commands', deleteStart);
  assert.ok(deleteEnd > deleteStart);
  const deleted = source.slice(deleteStart, deleteEnd);
  assert.match(deleted, /classifyChatLineage\(/);
  assert.match(deleted, /reinjectCompatibilityTiers\(/);
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

test('product UI scopes canonical records before rendering previews', async () => {
  const source = await readFile(resolve(root, 'ui.js'), 'utf8');
  assert.match(source, /filterRetrievalRecords/);
  assert.match(source, /allowLegacy:\s*false/);
  assert.match(source, /root\.chat_uid/);
  assert.match(source, /filterProductRecords/);
});

test('product status scopes narrative to the current branch identity', async () => {
  const source = await readFile(resolve(root, 'ui.js'), 'utf8');
  const start = source.indexOf('export function updateProductStatusUI');
  const end = source.indexOf('\n}\n\n', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /currentProductBranchUid/);
  assert.match(block, /filterNarrativeStateForIdentity/);
  assert.match(block, /requireChat: true/);
  assert.match(block, /requireBranch: true/);
});

test('unified product injection scopes structured records before category filtering', async () => {
  const source = await readFile(resolve(root, 'unified-inject.js'), 'utf8');
  assert.match(source, /filterRetrievalRecords\(structuredRecords,/);
  assert.match(source, /const injectableRecords = filterProductRecords\(scopedStructuredRecords,/);
});

test('product token rows never read legacy character stores', async () => {
  const source = await readFile(resolve(root, 'ui.js'), 'utf8');
  const estimateStart = source.indexOf('export function estimateCharPersonalTokens');
  const estimateEnd = source.indexOf('export function updateTokenDisplay', estimateStart);
  assert.ok(estimateStart >= 0);
  assert.ok(estimateEnd > estimateStart);
  const estimateBlock = source.slice(estimateStart, estimateEnd);
  assert.match(estimateBlock, /if \(productModeActive\(\)\) \{/);
  assert.match(estimateBlock, /scopedProductRecords/);
  const productBranch = estimateBlock.slice(0, estimateBlock.indexOf('const memories ='));
  assert.doesNotMatch(productBranch, /loadCharacterMemories/);

  const displayStart = source.indexOf('export function updateTokenDisplay');
  const displayEnd = source.indexOf('function productModeActive', displayStart);
  assert.ok(displayStart >= 0);
  assert.ok(displayEnd > displayStart);
  const displayBlock = source.slice(displayStart, displayEnd);
  assert.match(displayBlock, /estimateCharPersonalTokens\(member\)/);
});

test('product narrative UI filters every snippet by current chat and branch', async () => {
  const source = await readFile(resolve(root, 'ui.js'), 'utf8');
  const snippetsStart = source.indexOf('function productNarrativeSnippets');
  const statusStart = source.indexOf('export function updateProductStatusUI');
  const statusEnd = source.indexOf('export function', statusStart + 20);
  assert.ok(snippetsStart >= 0);
  assert.ok(statusStart > snippetsStart);
  assert.ok(statusEnd > statusStart);
  const snippetsBlock = source.slice(snippetsStart, statusStart);
  const statusBlock = source.slice(statusStart, statusEnd);
  assert.match(snippetsBlock, /filterNarrativeStateForIdentity/);
  assert.match(snippetsBlock, /requireChat: true/);
  assert.match(snippetsBlock, /requireBranch: true/);
  assert.match(statusBlock, /filterNarrativeStateForIdentity/);
  assert.match(statusBlock, /requireChat: true/);
  assert.match(statusBlock, /requireBranch: true/);
});

test('product slash commands do not read legacy stores', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const checkStart = source.indexOf("name: 'sm-check'");
  const checkEnd = source.indexOf("name: 'sm-summarize'", checkStart);
  assert.ok(checkStart >= 0);
  assert.ok(checkEnd > checkStart);
  const checkBlock = source.slice(checkStart, checkEnd);
  const productGuard = checkBlock.indexOf('single_extension_mode');
  const continuityCall = checkBlock.indexOf('checkContinuity(');
  assert.ok(productGuard >= 0 && continuityCall > productGuard);
  assert.match(checkBlock, /isCurrentLineageQuarantined/);

  const searchStart = source.indexOf("name: 'sm-search'");
  const challengeStart = source.indexOf("name: 'sm-challenge'");
  assert.ok(searchStart >= 0);
  assert.ok(challengeStart >= 0);
  // Both commands route through the shared read-only review runner.
  const searchBlock = source.slice(searchStart, challengeStart + 5000);
  assert.match(searchBlock, /runMemoryReview\('query', args, query\)/);
  assert.match(searchBlock, /runMemoryReview\('challenge', args, claim\)/);
  const runnerStart = source.indexOf('async function executeMemoryReview(mode, args, queryText, expectedIdentity = null)');
  const runnerEnd = source.indexOf('async function runMemoryReview(mode, args, queryText)', runnerStart);
  assert.ok(runnerStart >= 0 && runnerEnd > runnerStart);
  const runner = source.slice(runnerStart, runnerEnd);
  assert.match(runner, /structured_records/);
  assert.match(runner, /filterProductRecords/);
  assert.match(runner, /filterRetrievalRecords/);
  assert.match(runner, /single_extension_mode/);
});

test('product search discards embedding results after a chat transition', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('async function executeMemoryReview(mode, args, queryText, expectedIdentity = null)');
  const end = source.indexOf('async function runMemoryReview(mode, args, queryText)', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /const reviewGeneration = expectedIdentity\?\.generation \?\? chatLoadId/);
  assert.match(block, /const reviewMetadata = expectedIdentity\?\.metadata \?\? getContext\(\)\.chatMetadata/);
  assert.match(block, /const reviewStillCurrent = \(\) =>/);
  assert.match(block, /const reviewResponder = expectedIdentity\?\.responder \?\? currentProductResponder\(\)/);
  assert.match(block, /currentProductResponder\(\) === reviewResponder/);
  assert.match(block, /await getEmbeddingBatch/);
  assert.match(block, /if \(!reviewStillCurrent\(\)\)/);
});

test('manual recap paths discard results after a chat transition or blocked state', async () => {
  const indexSource = await readFile(resolve(root, 'index.js'), 'utf8');
  const recapStart = indexSource.indexOf("name: 'sm-recap'");
  assert.ok(recapStart >= 0);
  const recapBlock = indexSource.slice(recapStart);
  assert.match(recapBlock, /const recapGeneration = chatLoadId/);
  assert.match(recapBlock, /const recapStillCurrent = \(\) =>/);
  assert.match(recapBlock, /isFreshStart\(\)/);
  assert.match(recapBlock, /isCurrentLineageQuarantined\(\)/);
  assert.match(recapBlock, /if \(!recapStillCurrent\(\)\)/);

  const settingsSource = await readFile(resolve(root, 'settings.js'), 'utf8');
  const buttonStart = settingsSource.indexOf("$('#sm_recap_now')");
  const buttonEnd = settingsSource.indexOf("// ---- Catch Up", buttonStart);
  assert.ok(buttonStart >= 0);
  assert.ok(buttonEnd > buttonStart);
  const buttonBlock = settingsSource.slice(buttonStart, buttonEnd);
  assert.match(buttonBlock, /const recapGeneration = ctrl\.chatGeneration/);
  assert.match(buttonBlock, /const recapStillCurrent = \(\) =>/);
  assert.match(buttonBlock, /isFreshStart\(\)/);
  assert.match(buttonBlock, /isCurrentLineageQuarantined\(\)/);
  assert.match(buttonBlock, /if \(!recapStillCurrent\(\)\)/);
});

test('legacy catch-up rechecks current chat across every extraction and write boundary', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf('async function runCatchUpFlow');
  const end = source.indexOf("$('#sm_catch_up').on('click'", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  const guards = (block.match(/if \(!flowIsCurrent\(\) \|\| ctrl\.catchUpCancelled\) return;/g) ?? [])
    .length;
  const plainGuards = (block.match(/if \(!flowIsCurrent\(\)\) return;/g) ?? []).length;
  assert.ok(guards >= 10, `expected at least 10 combined guards, got ${guards}`);
  assert.ok(plainGuards >= 8, `expected at least 8 plain guards, got ${plainGuards}`);
});

test('legacy catch-up passes its abort predicate into final async injectors', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf('async function runCatchUpFlow');
  const finalStart = source.indexOf('// Re-inject and refresh UI for everything processed so far', start);
  const finalEnd = source.indexOf("if (ctrl.catchUpCancelled)", finalStart);
  assert.ok(start >= 0);
  assert.ok(finalStart > start);
  assert.ok(finalEnd > finalStart);
  const block = source.slice(finalStart, finalEnd);
  assert.match(block, /await injectMemories\(characterName, false, flowMustStop\)/);
  assert.match(block, /injectSessionMemories\(false, flowMustStop\)/);
});

test('legacy catch-up only restores controls for its captured current flow', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf('async function runCatchUpFlow');
  const end = source.indexOf("$('#sm_catch_up').on('click'", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  const finallyStart = block.lastIndexOf('} finally {');
  assert.ok(finallyStart >= 0);
  const finallyBlock = block.slice(finallyStart);
  assert.match(finallyBlock, /if \(flowIsCurrent\(\)\) \{/);
  assert.match(finallyBlock, /ctrl\.chatGeneration === flowGeneration/);
  assert.match(finallyBlock, /getContext\(\)\.chatMetadata === flowMetadata/);
});

test('automatic legacy scene linking carries its abort predicate into the save helper', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const scenes = await readFile(resolve(root, 'scenes.js'), 'utf8');
  assert.match(scenes, /export async function linkMemoriesToLastScene\(memoryIds, abortCheck = null\)/);
  assert.match(scenes, /abortCheck\?\.\(\)[\s\S]*saveSceneHistory/);

  const soloStart = source.indexOf('async function onCharacterMessageRendered');
  const soloEnd = source.indexOf('async function onGroupWrapperFinished', soloStart);
  const groupStart = soloEnd;
  const groupEnd = source.indexOf('// ---- Group membership changes', groupStart);
  assert.ok(soloStart >= 0 && soloEnd > soloStart);
  assert.ok(groupStart >= 0 && groupEnd > groupStart);
  assert.match(source.slice(soloStart, soloEnd), /await linkMemoriesToLastScene\(newIds, chatChanged\)/);
  assert.match(source.slice(groupStart, groupEnd), /await linkMemoriesToLastScene\(newIds, chatChanged\)/);
});

test('automatic legacy pipelines recheck currentness between awaited writer stages', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const soloStart = source.indexOf('async function onCharacterMessageRendered');
  const groupStart = source.indexOf('async function onGroupWrapperFinished', soloStart);
  const groupEnd = source.indexOf('// ---- Group membership changes', groupStart);
  assert.ok(soloStart >= 0 && groupStart > soloStart && groupEnd > groupStart);

  for (const block of [source.slice(soloStart, groupStart), source.slice(groupStart, groupEnd)]) {
    const compactAwait = block.indexOf('const needed = await shouldCompact();');
    const compactBranch = block.indexOf('if (needed)', compactAwait);
    assert.ok(compactAwait >= 0 && compactBranch > compactAwait);
    assert.match(block.slice(compactAwait, compactBranch), /if \(chatChanged\(\)\) throw CHAT_SWITCHED;/);

    const sessionAwait = block.indexOf('const count = await extractSessionMemories(sessionWindow, chatChanged)');
    const sessionConsolidation = block.indexOf('consolidateSessionMemories(false, chatChanged)', sessionAwait);
    assert.ok(sessionAwait >= 0 && sessionConsolidation > sessionAwait);
    assert.match(block.slice(sessionAwait, sessionConsolidation), /if \(chatChanged\(\)\) throw CHAT_SWITCHED;/);
  }
});

test('automatic legacy long-term stages recheck currentness before consolidation and UI', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const soloStart = source.indexOf('async function onCharacterMessageRendered');
  const groupStart = source.indexOf('async function onGroupWrapperFinished', soloStart);
  const groupEnd = source.indexOf('// ---- Group membership changes', groupStart);
  assert.ok(soloStart >= 0 && groupStart > soloStart && groupEnd > groupStart);

  for (const block of [source.slice(soloStart, groupStart), source.slice(groupStart, groupEnd)]) {
    const extraction = block.indexOf('const count = await extractAndStoreMemories(');
    const consolidation = block.indexOf('const removed = await consolidateMemories(', extraction);
    const postConsolidation = block.indexOf('if (removed > 0)', consolidation);
    assert.ok(extraction >= 0 && consolidation > extraction && postConsolidation > consolidation);
    assert.match(block.slice(extraction, consolidation), /if \(chatChanged\(\)\) throw CHAT_SWITCHED;/);
    assert.match(block.slice(consolidation, postConsolidation), /if \(chatChanged\(\)\) throw CHAT_SWITCHED;/);
  }
});

test('automatic legacy aborts do not clear stale status or save settings', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const soloStart = source.indexOf('async function onCharacterMessageRendered');
  const groupStart = source.indexOf('async function onGroupWrapperFinished', soloStart);
  const groupEnd = source.indexOf('// ---- Group membership changes', groupStart);
  assert.ok(soloStart >= 0 && groupStart > soloStart && groupEnd > groupStart);

  for (const block of [source.slice(soloStart, groupStart), source.slice(groupStart, groupEnd)]) {
    const catchStart = block.lastIndexOf('} catch (err) {');
    const finallyStart = block.indexOf('} finally {', catchStart);
    assert.ok(catchStart >= 0 && finallyStart > catchStart);
    const outer = block.slice(catchStart, finallyStart);
    assert.match(outer, /if \(err === CHAT_SWITCHED\) \{/);
    assert.match(outer, /else \{[\s\S]*if \(!chatChanged\(\)\) setStatusMessage\(''\);/);

    // The finally must release extraction ownership only after the conditional
    // settings save, so a stale abort can never clear a newer owner's flag. The
    // budget restore is equally conditional: a stale finally must not restore
    // captured adaptive budgets into a newer chat's settings.
    const finallyEnd = block.indexOf('releaseExtractionOwnership(', finallyStart);
    assert.ok(finallyEnd > finallyStart);
    assert.match(
      block.slice(finallyStart, finallyEnd),
      /if \(!chatChanged\(\)\) \{\s*Object\.assign\(settings, originalBudgets\);\s*saveSettingsDebounced\(\);\s*\}/,
    );
  }
});

test('automatic legacy pipelines return after caught stale stages before later writes', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const soloStart = source.indexOf('async function onCharacterMessageRendered');
  const groupStart = source.indexOf('async function onGroupWrapperFinished', soloStart);
  const groupEnd = source.indexOf('// ---- Group membership changes', groupStart);
  assert.ok(soloStart >= 0 && groupStart > soloStart && groupEnd > groupStart);

  for (const block of [source.slice(soloStart, groupStart), source.slice(groupStart, groupEnd)]) {
    const step2 = block.indexOf('// Step 2: scene break detection');
    const step3 = block.indexOf('// Step 3: batched extraction');
    const step5 = block.indexOf('// Step 5: clear any pending continuity repair');
    assert.ok(step2 >= 0 && step3 > step2 && step5 > step3);
    assert.match(block.slice(Math.max(0, step2 - 100), step2), /if \(chatChanged\(\)\) return;\s*$/);
    assert.match(block.slice(Math.max(0, step3 - 100), step3), /if \(chatChanged\(\)\) return;\s*$/);
    assert.match(block.slice(Math.max(0, step5 - 100), step5), /if \(chatChanged\(\)\) return;\s*$/);
  }
});

test('automatic legacy activity timestamps use the captured abort predicate', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const recap = await readFile(resolve(root, 'recap.js'), 'utf8');
  assert.match(recap, /export async function updateLastActive\(abortCheck = null\)/);
  assert.match(recap, /abortCheck\?\.\(\)[\s\S]*context\.saveMetadata/);

  const soloStart = source.indexOf('async function onCharacterMessageRendered');
  const groupStart = source.indexOf('async function onGroupWrapperFinished', soloStart);
  const groupEnd = source.indexOf('// ---- Group membership changes', groupStart);
  assert.ok(soloStart >= 0 && groupStart > soloStart && groupEnd > groupStart);
  for (const block of [source.slice(soloStart, groupStart), source.slice(groupStart, groupEnd)]) {
    const finalStep = block.includes('// Step 8: update lastActive.')
      ? block.indexOf('// Step 8: update lastActive.')
      : block.indexOf('// Step 7: update lastActive so the away recap threshold stays accurate.');
    assert.ok(finalStep >= 0);
    assert.match(block.slice(finalStep), /if \(chatChanged\(\)\) return;\s*\n\s*await updateLastActive\(chatChanged\)/);
  }
});

test('legacy async writers expose abort checks at their final write boundary', async () => {
  const longterm = await readFile(resolve(root, 'longterm.js'), 'utf8');
  assert.match(longterm, /export async function extractAndStoreMemories\([\s\S]*abortCheck = null/);
  assert.match(longterm, /if \(abortCheck\?\.\(\)\) return 0;/);
  assert.match(longterm, /abortCheck\?\.\(\)[\s\S]*saveCharacterMemories/);

  const compaction = await readFile(resolve(root, 'compaction.js'), 'utf8');
  assert.match(compaction, /export async function runCompaction\(\{ includeLastMessage = false, abortCheck = null \}\s*=\s*\{\}\)/);
  assert.match(compaction, /abortCheck\?\.\(\)[\s\S]*context\.saveMetadata/);

  const canon = await readFile(resolve(root, 'canon.js'), 'utf8');
  assert.match(canon, /generateCanon\(characterName, abortCheck = null\)/);
  assert.match(canon, /abortCheck\?\.\(\)[\s\S]*saveCanon/);
});

test('branch pruning passes its live abort predicate to session and ledger saves', async () => {
  const source = await readFile(resolve(root, 'branch-ops.js'), 'utf8');
  assert.match(source, /await saveSessionMemories\(kept, isBlocked\)/);
  assert.match(source, /await saveStateLedger\(kept, isBlocked\)/);
});

test('branch rollback restores a source proof for the surviving legacy prefix', async () => {
  const source = await readFile(resolve(root, 'branch-ops.js'), 'utf8');
  assert.match(source, /updateLegacySourceProof\(meta, chat, firstNew\)/);
  assert.match(source, /lastExtractSourceRange/);
  assert.match(source, /lastExtractFingerprint/);
});

test('summary state is branch-detected and injection requires live source proof', async () => {
  const branch = await readFile(resolve(root, 'branch-ops.js'), 'utf8');
  const compaction = await readFile(resolve(root, 'compaction.js'), 'utf8');
  assert.match(branch, /detectSummaryChanges\(chat, meta\)/);
  assert.match(branch, /summaryDetection\.truncated/);
  assert.match(compaction, /summary_source_message_range/);
  assert.match(compaction, /summary_source_fingerprint/);
  assert.match(compaction, /sourceRangeMatchesLiveChat/);
  assert.match(compaction, /!sourceRangeMatches/);
});

test('session extraction and injection pass their abort predicate to final saves', async () => {
  const source = await readFile(resolve(root, 'session.js'), 'utf8');
  assert.match(source, /await saveSessionMemories\(\[\.\.\.finalActive, \.\.\.updatedRetired\], abortCheck\)/);
  assert.match(source, /await saveSessionMemories\(updated, abortCheck\)/);
});

test('session consolidation preserves source ranges and does not launder unproven records', async () => {
  const source = await readFile(resolve(root, 'session.js'), 'utf8');
  const start = source.indexOf('export async function consolidateSessionMemories');
  const end = source.indexOf('// ---- Injection', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /const allInputs = \[\.\.\.base, \.\.\.unprocessed\]/);
  assert.match(block, /const mostRecentSource/);
  assert.match(block, /for \(const entry of reconciledType\)/);
  assert.match(block, /entry\.source_messages/);
  assert.match(block, /Object\.assign\(entry, recordStamp\)/);
  assert.match(block, /sourceRanges\(entry\)\.length/);
  assert.doesNotMatch(block, /for \(const memory of finalMemories\) Object\.assign\(memory, recordStamp\)/);
});

test('in-file branch pruning drops unverifiable session records', async () => {
  const source = await readFile(resolve(root, 'branch-ops.js'), 'utf8');
  const start = source.indexOf('// Session memories (chat-scoped).');
  const end = source.indexOf('// State ledger cards stamped from the discarded timeline.', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(
    block,
    /pruneMemoriesByBranchPoint\(\s*loadSessionMemories\(\),\s*branchPoint,\s*branchPointIndex,\s*\{\s*dropUnverifiable:\s*true\s*\},?\s*\)/,
  );
});

test('manual scene extraction stamps chat identity and source range', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf("$('#sm_extract_scenes_now')");
  const end = source.indexOf("$('#sm_clear_scenes')", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /source_chat_id/);
  assert.match(block, /source_message_range/);
  assert.match(block, /source_mes_range/);
  assert.match(block, /currentLineageRecordStamp\(\)/);
});

test('legacy catch-up scenes carry source ranges before persistence', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf('const buildSceneProvenance');
  const end = source.indexOf('// Final consolidation pass', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /source_chat_id/);
  assert.match(block, /source_message_range/);
  assert.match(block, /source_mes_range/);
  assert.match(block, /currentLineageRecordStamp\(\)/);
  assert.match(block, /if \(!sceneProvenance\)/);
});

test('chat transitions settle ownership and stale budgets fail closed', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const changeStart = source.indexOf('async function onChatChangedImpl()');
  const changeEnd = source.indexOf('lastKnownChatLength = getContext().chat?.length', changeStart);
  assert.ok(changeStart >= 0 && changeEnd > changeStart);
  const transition = source.slice(changeStart, changeEnd);
  assert.doesNotMatch(transition, /invalidateCompactionOwnership\(\)/);
  assert.doesNotMatch(transition, /invalidateContinuityOwnership\(\)/);

  const soloStart = source.indexOf('smLog(`[SmartMemory] Solo extraction finished');
  const soloEnd = source.indexOf('releaseExtractionOwnership(soloExtractionToken)', soloStart);
  assert.ok(soloStart >= 0 && soloEnd > soloStart);
  const solo = source.slice(soloStart, soloEnd);
  assert.match(solo, /if \(!chatChanged\(\)\) \{\s*Object\.assign\(settings, originalBudgets\)/);

  const groupStart = source.indexOf('smLog(`[SmartMemory] Group extraction finished');
  const groupEnd = source.indexOf('releaseExtractionOwnership(groupLegacyExtractionToken)', groupStart);
  assert.ok(groupStart >= 0 && groupEnd > groupStart);
  const group = source.slice(groupStart, groupEnd);
  assert.match(group, /if \(!chatChanged\(\)\) \{\s*Object\.assign\(settings, originalBudgets\)/);
});

test('automatic model pipeline serializes compaction, scenes, extraction, and continuity', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  assert.match(source, /let automaticPipelineOwner = null/);
  assert.match(source, /claimAutomaticPipelineOwnership/);
  assert.match(source, /releaseAutomaticPipelineOwnership/);
  assert.match(source, /const automaticPipelineToken = claimAutomaticPipelineOwnership\(\)/);
  assert.match(source, /if \(!automaticPipelineToken\) return;/);
  assert.match(source, /\.finally\(\(\) => releaseAutomaticPipelineOwnership\(automaticPipelineToken\)\)/);
  assert.equal(
    [...source.matchAll(/\.finally\(\(\) => releaseAutomaticPipelineOwnership\(automaticPipelineToken\)\)/g)].length,
    2,
  );
  assert.match(source, /continuityCheckOwner/);
});

test('state-ledger extraction passes its abort predicate to the final save', async () => {
  const source = await readFile(resolve(root, 'state-ledger.js'), 'utf8');
  assert.match(source, /export async function runStateCardExtraction\([\s\S]*abortCheck = null/);
  assert.match(source, /await saveStateLedger\(ledger, abortCheck\)/);
});

test('arc resolution carries its abort predicate through summary generation', async () => {
  const source = await readFile(resolve(root, 'arcs.js'), 'utf8');
  assert.match(source, /export async function generateArcSummary\(arcContent, abortCheck = null\)/);
  assert.match(source, /generateArcSummary\(content, abortCheck\)/);
  assert.match(source, /abortCheck\?\.\(\)[\s\S]*generateMemoryExtract/);
});

test('manual legacy handlers capture identity and gate writes', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const ranges = [
    ['#sm_extract_now', '#sm_clear_memories'],
    ['#sm_extract_session_now', '#sm_clear_session'],
    ['#sm_extract_scenes_now', '#sm_clear_scenes'],
    ['#sm_extract_arcs_now', '#sm_clear_arcs'],
  ];
  for (const [startMarker, endMarker] of ranges) {
    const start = source.indexOf(`${startMarker}`).valueOf();
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0, `missing ${startMarker}`);
    assert.ok(end > start, `missing boundary after ${startMarker}`);
    const block = source.slice(start, end);
    assert.match(block, /captureLegacyOperation/);
    assert.match(block, /operation\.stillCurrent/);
  }
  const helperStart = source.indexOf('function captureLegacyOperation');
  const helperEnd = source.indexOf('function isCatchUpRunning', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /isFreshStart\(\)/);
  assert.match(helper, /ctrl\.lineageQuarantined/);
});

test('manual UI handlers check operation identity before every legacy write', async () => {
  const source = await readFile(resolve(root, 'ui.js'), 'utf8');
  const cases = [
    {
      start: "$list.find('.sm_edit_session_memory')",
      write: 'saveSessionMemories',
      end: "$cancel.on('click', () => updateSessionUI())",
    },
    {
      start: "$list.find('.sm_delete_session_memory')",
      write: 'saveSessionMemories',
      end: "  // Add memory form at the bottom of the list.",
    },
    {
      start: "$list.find('.sm_edit_memory')",
      write: 'saveCharacterMemories',
      end: "$cancel.on('click', () =>\n      renderMemoriesList",
    },
    {
      start: "$list.find('.sm_delete_memory')",
      write: 'saveCharacterMemories',
      end: "  // Add memory form at the bottom of the list.",
    },
  ];
  for (const { start: startMarker, write: writer, end: endMarker } of cases) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0, `missing ${startMarker}`);
    assert.ok(end > start, `missing handler boundary for ${startMarker}`);
    const block = source.slice(start, end);
    const guard = block.indexOf('if (!operation.stillCurrent()) return;');
    const write = block.indexOf(writer);
    assert.ok(guard >= 0 && write > guard, `${startMarker} must guard before ${writer}`);
  }
});

test('entity-panel merge and delete operations capture current identity before writes', async () => {
  const source = await readFile(resolve(root, 'ui.js'), 'utf8');
  const panelStart = source.indexOf('export function updateEntityPanel');
  const panelEnd = source.indexOf('export function showEntityTimeline', panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart);
  const block = source.slice(panelStart, panelEnd);
  assert.match(block, /const operation = captureLegacyUiOperation\(\);/);
  assert.match(block, /if \(!operation\.stillCurrent\(\)\) return;/);
  assert.match(block, /saveSessionMemories\(sessMems, operation\.stillCurrent\)/);
  assert.match(block, /deleteStateCard\([^\n]*operation\.stillCurrent\)/);
});

test('non-Product automatic pipeline carries identity guards through every writer', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('const capturedGen = chatLoadId');
  const end = source.indexOf('const lastMsg = context.chat', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const capture = source.slice(start, end);
  assert.match(capture, /capturedChatId/);
  assert.match(capture, /capturedMetadata/);
  assert.match(capture, /capturedChatUid/);
  assert.match(capture, /isFreshStart\(\)/);
  assert.match(capture, /isCurrentLineageQuarantined\(\)/);

  const soloStart = source.indexOf('async function onCharacterMessageRendered');
  const soloEnd = source.indexOf('async function onGroupWrapperFinished', soloStart);
  assert.ok(soloStart >= 0);
  assert.ok(soloEnd > soloStart);
  const solo = source.slice(soloStart, soloEnd);
  assert.match(solo, /runCompaction\(\{ abortCheck: chatChanged \}\)/);
  assert.match(solo, /extractAndStoreMemories\([\s\S]*chatChanged/);
  assert.match(solo, /consolidateMemories\([\s\S]*chatChanged/);
  assert.match(solo, /injectMemories\([\s\S]*chatChanged/);
  assert.match(solo, /generateCanon\(characterName, chatChanged\)/);
});

test('legacy slash commands capture identity and abort late writes', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const summarizeStart = source.indexOf("name: 'sm-summarize'");
  const extractStart = source.indexOf("name: 'sm-extract'");
  const recapStart = source.indexOf("name: 'sm-recap'");
  assert.ok(summarizeStart >= 0 && extractStart > summarizeStart && recapStart > extractStart);
  const summarizeBlock = source.slice(summarizeStart, extractStart);
  const extractBlock = source.slice(extractStart, recapStart);
  for (const block of [summarizeBlock, extractBlock]) {
    assert.match(block, /captureLegacyOperation/);
    assert.match(block, /operation\.stillCurrent/);
  }
  const helperStart = source.indexOf('function captureLegacyOperation');
  const helperEnd = source.indexOf('function reserveProductControl', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /isFreshStart\(\)/);
  assert.match(helper, /isCurrentLineageQuarantined\(\)/);
  assert.match(summarizeBlock, /runCompaction\([\s\S]*abortCheck/);
  assert.match(extractBlock, /extractAndStoreMemories\([\s\S]*operation\.stillCurrent/);
  assert.match(extractBlock, /extractSessionMemories\([\s\S]*operation\.stillCurrent/);
  assert.match(extractBlock, /extractArcs\([\s\S]*operation\.stillCurrent/);
});

test('deletion resets the swipe length baseline so the next message is processed', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('eventSource.on(event_types.MESSAGE_DELETED');
  const end = source.indexOf('  onChatChanged();', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /lastKnownChatLength = context\.chat\?\.length \?\? 0/);
});

test('automatic namespace relink requires an exact stored transcript fingerprint', async () => {
  const source = await readFile(resolve(root, 'rename-ops.js'), 'utf8');
  const start = source.indexOf('if (!store[targetKey] && store[currentKey])');
  const end = source.indexOf('} else if (store[targetKey])', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /store\[currentKey\]\?\.transcript_fingerprint === fingerprint/);
  assert.match(block, /relinkNamespace\(/);
});

test('stable namespace fingerprint mismatch fails closed instead of being overwritten', async () => {
  const source = await readFile(resolve(root, 'rename-ops.js'), 'utf8');
  const start = source.indexOf('} else if (store[targetKey])');
  const end = source.indexOf('\n  }\n\n  if (metadataChanged)', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /target\.chat_uid === targetKey/);
  assert.match(block, /targetChatId === currentKey/);
  assert.match(block, /targetOwnerMatches/);
  assert.match(block, /if \(!targetOwnerMatches\)[\s\S]*meta\.lineage[\s\S]*quarantined: true/);
  assert.match(block, /else if \(!targetFingerprintMatches\)[\s\S]*meta\.lineage[\s\S]*quarantined: true/);
  assert.doesNotMatch(block, /target\.transcript_fingerprint = fingerprint/);
  assert.match(block, /targetFingerprintMatches/);
});

test('stable identity quarantines a narrative with foreign scope before retagging', async () => {
  const source = await readFile(resolve(root, 'rename-ops.js'), 'utf8');
  const start = source.indexOf('if (meta.narrative) {');
  const end = source.indexOf('context.chatMetadata[META_KEY] = meta;', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /narrativeIdentityMatches\(meta\.narrative/);
  assert.match(block, /meta\.chat_uid/);
  assert.match(block, /meta\.narrative = null/);
  assert.match(block, /retagNarrativeChatUid/);
});

test('stable identity requires current branch proof before retagging narrative', async () => {
  const source = await readFile(resolve(root, 'rename-ops.js'), 'utf8');
  const start = source.indexOf('if (meta.narrative) {');
  const end = source.indexOf('context.chatMetadata[META_KEY] = meta;', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /const currentBranchUid =/);
  assert.match(block, /branchUid: currentBranchUid/);
  assert.match(block, /requireBranch: currentBranchUid != null/);
});

test('branch rebuild uses a pinned scope and abort guards across legacy clears', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf('pinChatScope(stableChatUid ?? chatId)', source.indexOf("$('#sm_rebuild_branch')"));
  const end = source.indexOf('const parentChatId = lineage.parentChatId;', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /pinChatScope\(stableChatUid \?\? chatId\)/);
  assert.match(block, /if \(rebuildMustStop\(\)\) return;/);
  assert.match(block, /finally \{[\s\S]*unpinChatScope\(rebuildScopePin\)/);
});

test('branch inheritance revalidates metadata identity and generation around the parent fetch', async () => {
  const source = await readFile(resolve(root, 'lineage-ops.js'), 'utf8');
  assert.match(source, /export async function verifyAndInheritCurrentBranch\([^)]*isCurrent/);
  assert.match(source, /const branchMetadata = context\.chatMetadata/);
  assert.match(source, /getCurrentChatId\(\) !== branchChatId \|\|\s*\n\s*context\.chatMetadata !== branchMetadata/);
  assert.match(source, /typeof isCurrent === 'function' && !isCurrent\(\)/);
  assert.match(source, /const parentChatUid = parentSmartMemory\.chat_uid/);
  assert.match(source, /chats\?\.\[parentChatUid\]/);
  assert.match(source, /resetBranchContainer\(\s*characterName,\s*branchChatUid/);
  assert.doesNotMatch(source, /chats\?\.\[parentChatId\]/);
});

test('blocked unified injection clears individual product prompt slots', async () => {
  const source = await readFile(resolve(root, 'unified-inject.js'), 'utf8');
  const start = source.indexOf('if (isCurrentLineageQuarantined() || isFreshStart())');
  const end = source.indexOf('\n  const settings =', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /clearIndividualPromptSlots\(\)/);
  assert.match(source, /function clearIndividualPromptSlots/);
  assert.match(source, /settings\.enabled === false[\s\S]*clearIndividualPromptSlots/);
});

test('inherited metadata never synthesizes a chat uid from the filename', async () => {
  const source = await readFile(resolve(root, 'lineage.js'), 'utf8');
  const start = source.indexOf('export function inheritSmartMemoryMetadata');
  const end = source.indexOf('\n}\n\n/**', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /branchChatUid = null/);
  assert.match(block, /branchChatUid == null \? null : String\(branchChatUid\)/);
  assert.match(block, /inheritStructuredRecordsPrefix\([\s\S]*branchChatUid/);
});

test('product operations revalidate the captured responder before writes and injection', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  assert.match(source, /const expectedResponder = expectedIdentity\.responder/);
  assert.match(source, /currentProductResponder\(\) === expectedResponder/);
  assert.match(source, /responder: capturedProductCharacter/);
  const memberStart = source.indexOf('async function onGroupMemberDrafted');
  const memberEnd = source.indexOf('\n}\n\n/**', memberStart);
  assert.ok(memberStart >= 0);
  assert.ok(memberEnd > memberStart);
  const memberBlock = source.slice(memberStart, memberEnd);
  assert.match(memberBlock, /capturedSelectedResponder/);
  assert.match(memberBlock, /selectedGroupCharacter !== capturedSelectedResponder/);
});

test('Product search fails closed before embedding when the chat is blocked', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('async function executeMemoryReview(mode, args, queryText, expectedIdentity = null)');
  const end = source.indexOf('async function runMemoryReview(mode, args, queryText)', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /const reviewStillCurrent = \(\) =>[\s\S]*isFreshStart\(\)/);
  assert.match(block, /productSettings\.enabled === false \|\| isFreshStart\(\) \|\| isCurrentLineageQuarantined\(\)/);
  // The blocked-state check must happen before the embedding batch is requested.
  const guardIndex = block.indexOf('productSettings.enabled === false');
  const embeddingIndex = block.indexOf('getEmbeddingBatch(');
  assert.ok(guardIndex >= 0 && embeddingIndex >= 0 && guardIndex < embeddingIndex);
});

test('automatic recaps abort model work and never clear a newer chat status', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const recap = await readFile(resolve(root, 'recap.js'), 'utf8');
  assert.match(recap, /export async function generateRecap\(abortCheck = null\)/);
  assert.match(recap, /abortCheck\?\.\(\)[\s\S]*generateMemorySummarize[\s\S]*abortCheck\?\.\(\)/);

  const loadStart = source.indexOf('async function onChatChangedImpl');
  const loadEnd = source.indexOf('// ---- Group chat helpers', loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  const block = source.slice(loadStart, loadEnd);
  assert.match(block, /generateRecap\(transitionStale\)/);
  assert.match(block, /if \(!stillThisChat\) return;[\s\S]*setStatusMessage\(''\)/);
  assert.match(block, /if \(!transitionStale\(\)\) await updateLastActive\(transitionStale\)/);
});

test('product completion rechecks identity after asynchronous status persistence', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const ingestStart = source.indexOf('async function runSingleExtensionIngest');
  const ingestEnd = source.indexOf('/** Runs product-mode catch-up', ingestStart);
  assert.ok(ingestStart >= 0);
  assert.ok(ingestEnd > ingestStart);
  const ingest = source.slice(ingestStart, ingestEnd);

  const failedStatusStart = ingest.indexOf("phase: 'failed'");
  const failedStatusEnd = ingest.indexOf('const message =', failedStatusStart);
  assert.ok(failedStatusStart >= 0);
  assert.ok(failedStatusEnd > failedStatusStart);
  assert.match(ingest.slice(failedStatusStart, failedStatusEnd), /productAborted\(\)\) return/);

  const incompleteStart = ingest.indexOf('if (!completed) {');
  const incompleteEnd = ingest.indexOf('if (completed) {', incompleteStart);
  assert.ok(incompleteStart >= 0);
  assert.ok(incompleteEnd > incompleteStart);
  assert.match(ingest.slice(incompleteStart, incompleteEnd), /productAborted\(\)\) return/);

  const cursorStart = ingest.indexOf('await advanceProductCursor');
  const cursorEnd = ingest.indexOf('onProgress({', cursorStart);
  assert.ok(cursorStart >= 0);
  assert.ok(cursorEnd > cursorStart);
  assert.match(ingest.slice(cursorStart, cursorEnd), /productAborted\(\)\) return/);

  const catchupStart = source.indexOf('async function runSingleExtensionCatchUpUnlocked');
  const terminalStart = source.indexOf('await persistProductStatus(', source.indexOf('const terminalMessage', catchupStart));
  const terminalEnd = source.indexOf('maybeInjectUnified', terminalStart);
  assert.ok(catchupStart >= 0);
  assert.ok(terminalStart > catchupStart);
  assert.ok(terminalEnd > terminalStart);
  assert.match(source.slice(terminalStart, terminalEnd), /productChatInvalidated\(\)\) return/);
});

test('group member product injection rechecks a control reservation after pruning', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('async function onGroupMemberDrafted');
  const end = source.indexOf('\n}\n\n/**', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  const pruneEnd = block.indexOf('    });', block.indexOf('await detectAndPruneInFileBranch'));
  assert.ok(pruneEnd >= 0);
  const afterPrune = block.slice(pruneEnd);
  assert.match(afterPrune, /productControl\.isHeld\(\)/);
});

test('busy product gate clears the previous group responder envelope', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('async function onGroupMemberDrafted');
  const end = source.indexOf('\n}\n\n/**', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  const gateStart = block.indexOf('productOperationGate.isRunning');
  const pruneStart = block.indexOf('await detectAndPruneInFileBranch', gateStart);
  assert.ok(gateStart >= 0);
  assert.ok(pruneStart > gateStart);
  assert.match(block.slice(gateStart, pruneStart), /clearAllInjections\(\)/);
});

test('group member busy check covers composite queued product operation keys', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('async function onGroupMemberDrafted');
  const end = source.indexOf('\n}\n\n/**', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /productOperationGate\.isRunning\(\)/);
  assert.doesNotMatch(block, /productOperationGate\.isRunning\(capturedGeneration\)/);
});

test('group product rounds queue as distinct operations in one generation', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('async function onGroupWrapperFinished');
  const end = source.indexOf('\n}\n\n/**', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  const productStart = block.indexOf('if (settings.single_extension_mode)');
  const productEnd = block.indexOf('\n  // Capture the current chat generation', productStart);
  assert.ok(productStart >= 0);
  assert.ok(productEnd > productStart);
  const productBlock = block.slice(productStart, productEnd);
  assert.match(productBlock, /capturedProductOperationKey/);
  assert.match(productBlock, /runExclusiveProductOperation\([\s\S]*capturedProductOperationKey/);
  assert.doesNotMatch(productBlock, /productOperationGate\.isRunning\(capturedProductGen\)\)[\s\S]*return/);
});

test('solo product messages queue as distinct operations in one generation', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('async function onCharacterMessageRendered');
  const productStart = source.indexOf('if (settings.single_extension_mode)', start);
  const productEnd = source.indexOf('\n  const characterName =', productStart);
  assert.ok(start >= 0);
  assert.ok(productStart > start);
  assert.ok(productEnd > productStart);
  const block = source.slice(productStart, productEnd);
  assert.match(block, /capturedProductOperationKey/);
  assert.match(block, /runExclusiveProductOperation\([\s\S]*capturedProductOperationKey/);
  assert.doesNotMatch(block, /productOperationGate\.isRunning\(capturedProductGen\)\)[\s\S]*return/);
});

test('product chat loads do not prune legacy group arc settings', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('async function onChatChangedImpl');
  const prune = source.indexOf('pruneOrphanedGroupArcs();', start);
  const nextPhase = source.indexOf('await ensureStableChatIdentity();', start);
  assert.ok(start >= 0);
  assert.ok(prune > start);
  assert.ok(nextPhase > prune);
  const block = source.slice(start, nextPhase);
  assert.match(block, /if \(!settings\.single_extension_mode\)\s*pruneOrphanedGroupArcs\(\);/);
});

test('group branch pruning covers every active responder', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const settings = await readFile(resolve(root, 'settings.js'), 'utf8');
  const loadStart = source.indexOf('async function onChatChangedImpl');
  const loadPrune = source.indexOf('await detectAndPruneInFileBranch', loadStart);
  const loadEnd = source.indexOf('await refreshCurrentTimeline', loadPrune);
  assert.ok(loadStart >= 0 && loadPrune > loadStart && loadEnd > loadPrune);
  const loadBlock = source.slice(loadStart, loadEnd);
  assert.match(loadBlock, /const branchCharacterNames/);
  assert.match(loadBlock, /detectAndPruneInFileBranch\(branchCharacterNames/);

  const swipeStart = source.indexOf('event_types.MESSAGE_SWIPED');
  const swipeEnd = source.indexOf('event_types.MESSAGE_DELETED', swipeStart);
  const deleteStart = swipeEnd;
  const deleteEnd = source.indexOf('\n\n  onChatChanged();', deleteStart);
  assert.match(source.slice(swipeStart, swipeEnd), /branchCharacterNames/);
  assert.match(source.slice(swipeStart, swipeEnd), /detectAndPruneInFileBranch\(branchCharacterNames/);
  assert.match(source.slice(deleteStart, deleteEnd), /branchCharacterNames/);
  assert.match(source.slice(deleteStart, deleteEnd), /detectAndPruneInFileBranch\(branchCharacterNames/);

  const catchStart = settings.indexOf('async function runCatchUpFlow');
  const catchPrune = settings.indexOf('await detectAndPruneInFileBranch', catchStart);
  assert.ok(catchStart >= 0 && catchPrune > catchStart);
  assert.match(settings.slice(catchStart, catchPrune), /catchUpCharacterNames/);
});

test('rebuild wait is armed before intentional chat change and has a failure event', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const indexSource = await readFile(resolve(root, 'index.js'), 'utf8');
  const rebuildStart = source.indexOf("$('#sm_rebuild_branch').on('click'");
  const rebuildEnd = source.indexOf('\n  async function runCatchUpFlow', rebuildStart);
  assert.ok(rebuildStart >= 0);
  assert.ok(rebuildEnd > rebuildStart);
  const rebuild = source.slice(rebuildStart, rebuildEnd);
  const registerIndex = rebuild.indexOf('$(document).off(rebuildEvent).on');
  const chatChangeIndex = rebuild.indexOf('ctrl.onChatChanged({ preserveProductControl: true })');
  assert.ok(registerIndex >= 0 && chatChangeIndex > registerIndex);
  assert.match(rebuild, /rebuild_failed/);

  const chatStart = indexSource.indexOf('function onChatChanged(');
  const chatChange = indexSource.slice(chatStart);
  assert.match(chatChange, /if \(!preserveProductControl\)[\s\S]*smart_memory:rebuild_cancelled/);

  const loadStart = indexSource.indexOf('async function onChatChangedImpl');
  const disabledStart = indexSource.indexOf('const settings = getSettings();', loadStart);
  const disabledEnd = indexSource.indexOf('await ensureStableChatIdentity();', disabledStart);
  assert.ok(disabledStart >= 0 && disabledEnd > disabledStart);
  assert.match(
    indexSource.slice(disabledStart, disabledEnd),
    /if \(!settings\.enabled\) \{[\s\S]*smart_memory:rebuild_cancelled[\s\S]*return;/,
  );
});

test('chat change aborts active generation before releasing the old runtime state', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const start = source.indexOf('function onChatChanged(');
  const end = source.indexOf('\n}\n\n/**', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /\+\+chatLoadId/);
  assert.match(block, /abortCurrentMemoryGeneration\(\)/);
  assert.match(block, /clearAllInjections\(\)/);
  assert.match(block, /clearProductViews\(\)/);
  assert.match(block, /smart_memory:rebuild_cancelled/);
});

test('rebuild lineage wait cleans listeners and reservation on every callback exit', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf('let cleanupRebuildWait = releaseProductControl');
  const end = source.indexOf("$(document).off(rebuildEvent).on", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /cleanupRebuildWait\s*=\s*\(\)\s*=>/);
  assert.match(block, /if \(!activeLineage\)\s*\{[\s\S]*cleanupRebuildWait\(\)/);
  assert.match(block, /releaseProductControl/);
});

test('branch rebuild has an outer handoff finally for reservation cleanup', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf("$('#sm_rebuild_branch').on('click'");
  const end = source.indexOf('\n  async function runCatchUpFlow', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /let rebuildHandoff\s*=\s*false/);
  assert.match(block, /finally\s*\{[\s\S]*cleanupRebuildWait/);
});

test('macro mode changes recompose the current product envelope', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf("$('#sm_macros_enabled')");
  const end = source.indexOf("\n    });\n  applyInjectionOverrideUI();", start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /if \(isProductMode\(\)\)/);
  assert.match(block, /refreshProductModeViews/);
});

test('every legacy injector fails closed on master disabled, Fresh Start, or quarantine', async () => {
  const expected = {
    'longterm.js': ['injectMemories', 'injectRelationshipHistory'],
    'session.js': ['injectSessionMemories'],
    'scenes.js': ['injectSceneHistory'],
    'arcs.js': ['injectArcs'],
    'compaction.js': ['injectSummary', 'loadAndInjectSummary'],
    'canon.js': ['injectCanon'],
    'epistemic.js': ['injectEpistemicKnowledge'],
    'state-ledger.js': ['injectStateLedger'],
    'profiles.js': ['injectProfiles'],
  };

  for (const [file, names] of Object.entries(expected)) {
    const source = await readFile(resolve(root, file), 'utf8');
    for (const name of names) {
      const start = source.indexOf(`export async function ${name}`) >= 0
        ? source.indexOf(`export async function ${name}`)
        : source.indexOf(`export function ${name}`);
      assert.ok(start >= 0, `${file} must export ${name}`);
      const nextExport = source.indexOf('\nexport ', start + 1);
      const end = nextExport >= 0 ? nextExport : source.length;
      const block = source.slice(start, end);
      assert.match(block, /freshstart/i, `${file} ${name} must check freshStart`);
      assert.match(block, /isCurrentLineageQuarantined\(\)/, `${file} ${name} must check quarantine`);
      assert.match(
        block,
        /settings(?:\.enabled|\?\.enabled) === false|!settings\.enabled|settings\.enabled[^)]*\?/,
        `${file} ${name} must check master enabled`,
      );
    }
  }
});

test('compatibility manual writers fail closed on blocked state and recheck identity', async () => {
  const ledger = await readFile(resolve(root, 'state-ledger.js'), 'utf8');
  for (const fn of ['setStateCard', 'deleteStateCard']) {
    const start = ledger.indexOf(`export async function ${fn}`);
    assert.ok(start >= 0, `state-ledger.js must export ${fn}`);
    const next = ledger.indexOf('\nexport ', start + 1);
    const block = ledger.slice(start, next >= 0 ? next : ledger.length);
    assert.match(block, /settings\.enabled === false/, `${fn} must check master enabled`);
    assert.match(block, /isFreshStartActive\(\)/, `${fn} must check Fresh Start`);
    assert.match(block, /isCurrentLineageQuarantined\(\)/, `${fn} must check quarantine`);
  }

  const ui = await readFile(resolve(root, 'ui.js'), 'utf8');
  const sessionEditAnchor = ui.indexOf('memories[idx].content = newContent');
  const editStart = ui.lastIndexOf("$save.on('click', async () => {", sessionEditAnchor);
  const addStart = ui.indexOf("$addForm.find('.sm_add_memory_btn').on('click'");
  assert.ok(editStart >= 0, 'session edit-save handler must exist');
  assert.ok(addStart >= 0, 'session add handler must exist');
  for (const [label, start] of [['session edit', editStart], ['session add', addStart]]) {
    const block = ui.slice(start, ui.indexOf('\n  });', start) + 6);
    assert.match(block, /isFreshStart\(\)/, `${label} must check Fresh Start`);
    assert.match(block, /isCurrentLineageQuarantined\(\)/, `${label} must check quarantine`);
    assert.match(block, /getCurrentChatId\(\) [!=]== chatId/, `${label} must recheck chat identity after save`);
  }

  const settings = await readFile(resolve(root, 'settings.js'), 'utf8');
  const regenStart = settings.indexOf("$('#sm_profiles_regenerate').on('click'");
  assert.ok(regenStart >= 0, 'profile regeneration handler must exist');
  const regenBlock = settings.slice(regenStart, settings.indexOf('\n  });\n', regenStart) + 6);
  assert.match(regenBlock, /captureLegacyOperation\(\)/, 'profile regeneration must capture identity');
  assert.match(
    regenBlock,
    /generateProfiles\(characterName, operation\.stillCurrent\)/,
    'profile generation must receive the abort predicate',
  );
  assert.match(regenBlock, /if \(!operation\.stillCurrent\(\)\) return;/, 'profile regeneration must recheck before UI writes');
});

test('Clear Chat Memory guards apply outside Product mode and recheck after the dialog', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf("$('#sm_clear_chat_context').on('click'");
  const end = source.indexOf('// ---- Embedding deduplication', start);
  assert.ok(start >= 0, 'clear handler must exist');
  assert.ok(end > start, 'clear handler end must exist');
  const block = source.slice(start, end);
  assert.match(block, /const productClearBlocked = \(\) =>/);
  assert.match(block, /getCurrentChatId\(\) !== clearChatId/);
  assert.match(block, /ctrl\.chatGeneration !== clearGeneration/);
  assert.match(block, /getContext\(\)\.chatMetadata !== clearMetadata/);
  assert.doesNotMatch(block, /isProductMode\(\) &&\n\s*\(extension_settings/);
  const rechecks = block.split('if (productClearBlocked())').length - 1;
  assert.ok(rechecks >= 2, `clear guard must recheck after the dialog (found ${rechecks})`);
});

test('product status persistence stamps current chat and branch identity', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const catchUpStart = source.indexOf('async function runSingleExtensionCatchUpUnlocked');
  const catchUpEnd = source.indexOf('\nasync function ', catchUpStart + 1);
  assert.ok(catchUpStart >= 0);
  assert.ok(catchUpEnd > catchUpStart);
  const block = source.slice(catchUpStart, catchUpEnd);
  assert.match(block, /const capturedBranchUid =/);
  const started = block.indexOf("phase: 'started'");
  const terminal = block.indexOf('phase: terminalPhase');
  assert.ok(started >= 0);
  assert.ok(terminal >= 0);
  const startedBlock = block.slice(started, block.indexOf('saveCurrentMetadata', started));
  const terminalBlock = block.slice(terminal, block.indexOf('saveTerminalMetadata', terminal));
  assert.match(startedBlock, /chat_uid: capturedChatUid/);
  assert.match(startedBlock, /branch_uid: capturedBranchUid/);
  assert.match(terminalBlock, /chat_uid: capturedChatUid/);
  assert.match(terminalBlock, /branch_uid: capturedBranchUid/);
});

test('branch rollback resets the cursor source range and end index', async () => {
  const source = await readFile(resolve(root, 'branch-ops.js'), 'utf8');
  const start = source.indexOf('if (meta.product_cursor) {');
  const end = source.indexOf('if (isBlocked()) return null;', start);
  assert.ok(start >= 0);
  assert.ok(end > start);
  const block = source.slice(start, end);
  assert.match(block, /source_range: null/);
  assert.match(block, /end_index: null/);
});

test('extraction flags are owned and stale operations cannot clear a newer owner', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  const initializer = source.split('let extractionRunning = false;').length - 1;
  assert.equal(initializer, 1, 'the extractionRunning initializer must exist');
  const clears = source.split('extractionRunning = false;').length - 1;
  assert.equal(clears, 2, 'only the initializer and one ownership-guarded clear may exist');
  assert.match(
    source,
    /function releaseExtractionOwnership\(token\) \{\n {2}if \(extractionOwner === token\) \{\n {4}extractionOwner = null;\n {4}extractionRunning = false;/,
  );
  const claims = source.split('claimExtractionOwnership(').length - 1;
  const releases = source.split('releaseExtractionOwnership(').length - 1;
  assert.ok(claims >= 3, `claimExtractionOwnership must be used at every extraction entry (found ${claims})`);
  assert.ok(releases >= 3, `releaseExtractionOwnership must be used at every extraction exit (found ${releases})`);
  assert.match(source, /function claimExtractionOwnership\(\)/);
});

test('swipe and delete reclassify lineage before the Fresh Start guard', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  for (const marker of ['MESSAGE_SWIPED, () => {', 'MESSAGE_DELETED, () => {']) {
    const handlerStart = source.indexOf(`eventSource.on(event_types.${marker}`);
    assert.ok(handlerStart >= 0, `missing handler ${marker}`);
  }
  const swipeStart = source.indexOf("eventSource.on(event_types.MESSAGE_SWIPED");
  const deleteStart = source.indexOf("eventSource.on(event_types.MESSAGE_DELETED");
  for (const [label, start, end] of [
    ['swipe', swipeStart, deleteStart],
    ['delete', deleteStart, source.indexOf('onChatChanged();', deleteStart)],
  ]) {
    const block = source.slice(start, end);
    assert.ok(block.includes('classifyChatLineage'), `${label} handler must reclassify`);
    const thenBlocks = block.split('.then(() => {');
    for (const thenBlock of thenBlocks.slice(1)) {
      const classify = thenBlock.indexOf('classifyChatLineage');
      const freshStart = thenBlock.indexOf('isFreshStart()');
      assert.ok(classify >= 0, `${label} then block must classify lineage`);
      assert.ok(freshStart < 0 || classify < freshStart, `${label} must classify before its Fresh Start guard`);
    }
  }
});

test('rebuild and clear render no stale broker prompt during their async resets', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const rebuildStart = source.indexOf("$('#sm_rebuild_branch').on('click'");
  const rebuildEnd = source.indexOf('\n  async function runCatchUpFlow', rebuildStart);
  assert.ok(rebuildStart >= 0);
  assert.ok(rebuildEnd > rebuildStart);
  const rebuildBlock = source.slice(rebuildStart, rebuildEnd);
  const rebuildReset = rebuildBlock.indexOf('await resetProductMemory');
  assert.ok(rebuildReset >= 0);
  const rebuildPrefix = rebuildBlock.slice(0, rebuildReset);
  assert.match(rebuildPrefix, /clearAllInjections/);
  assert.match(rebuildPrefix, /clearProductViews/);

  const clearStart = source.indexOf("$('#sm_clear_chat_context').on('click'");
  const clearEnd = source.indexOf('// ---- Embedding deduplication', clearStart);
  const clearBlock = source.slice(clearStart, clearEnd);
  const clearReset = clearBlock.indexOf('await resetProductMemory');
  assert.ok(clearReset >= 0);
  const clearPrefix = clearBlock.slice(0, clearReset);
  assert.match(clearPrefix, /clearAllInjections/);
  assert.match(clearPrefix, /clearProductViews/);
});

test('in-file branch pruning covers every legacy derived tier', async () => {
  const source = await readFile(resolve(root, 'branch-ops.js'), 'utf8');
  for (const symbol of [
    'loadSceneHistory',
    'saveSceneHistory',
    'loadArcs',
    'saveArcs',
    'loadArcSummaries',
    'saveArcSummaries',
    'clearCanon',
    'clearEpistemicKnowledge',
    'clearProfiles',
  ]) {
    assert.match(source, new RegExp(`\\b${symbol}\\b`), `branch-ops must import/use ${symbol}`);
  }
  assert.match(source, /pruneMemoriesByBranchPoint\(\s*loadSceneHistory\(\)/);
  assert.match(source, /pruneMemoriesByBranchPoint\(\s*loadArcs\(\)/);
  assert.match(source, /saveArcSummaries\(\[\],\s*isBlocked\)/);
  assert.match(source, /delete meta\.summary/);
  assert.match(source, /clearCanon\(name\)/);
  assert.match(source, /clearEpistemicKnowledge\(name\)/);
  assert.match(source, /clearProfiles\(name,/);
});

test('compatibility writers stamp the current branch epoch on new records', async () => {
  const runtime = await readFile(resolve(root, 'lineage-runtime.js'), 'utf8');
  assert.match(runtime, /export function currentLineageEpochStamp/);
  assert.match(runtime, /lineageEpochStamp\(currentLineage\)/);
  for (const file of ['longterm.js', 'session.js']) {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.match(source, /currentLineageEpochStamp\(\)/, `${file} must request the current epoch stamp`);
    assert.match(source, /mem\.lineage_epoch = epochStamp\.lineage_epoch/, `${file} must stamp lineage_epoch on new records`);
  }
  for (const file of ['arcs.js', 'profiles.js']) {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.match(source, /\.\.\.\(currentLineageEpochStamp\(\) \?\? \{\}\)/, `${file} must spread the current epoch stamp into new records`);
  }
});

test('branch rollback clears every live legacy prompt and stale status channel', async () => {
  const source = await readFile(resolve(root, 'branch-ops.js'), 'utf8');
  assert.match(source, /clearUnifiedSlot\(\)/);
  assert.match(source, /clearAllMacroContent\(\)/);
  assert.match(source, /clearRelationshipHistory\(name\)/);
  assert.match(source, /delete meta\.product_status/);
  assert.match(source, /lastInjectionRefresh/);
});

test('legacy injectors scope scene, arc, and relationship data to current lineage', async () => {
  const [scenes, arcs, longterm] = await Promise.all([
    readFile(resolve(root, 'scenes.js'), 'utf8'),
    readFile(resolve(root, 'arcs.js'), 'utf8'),
    readFile(resolve(root, 'longterm.js'), 'utf8'),
  ]);
  assert.match(scenes, /filterCurrentChatRecords\(loadSceneHistory\(\),/);
  assert.match(arcs, /filterCurrentChatRecords\(loadArcs\(\),/);
  assert.match(longterm, /filterCurrentChatRecords\(\[state\],/);
});

test('remaining legacy injectors scope profiles, epistemic entries, and canon', async () => {
  const [profiles, epistemic, canon] = await Promise.all([
    readFile(resolve(root, 'profiles.js'), 'utf8'),
    readFile(resolve(root, 'epistemic.js'), 'utf8'),
    readFile(resolve(root, 'canon.js'), 'utf8'),
  ]);
  assert.match(profiles, /filterCurrentChatRecords\(\[storedProfiles\],/);
  assert.match(epistemic, /filterCurrentChatRecords\(loadEpistemicKnowledge/);
  assert.match(canon, /filterCurrentChatRecords\(\[canon\],/);
});

test('continuity repair and transition paths fail closed on disabled or Fresh Start state', async () => {
  const continuity = await readFile(resolve(root, 'continuity.js'), 'utf8');
  const index = await readFile(resolve(root, 'index.js'), 'utf8');
  assert.match(continuity, /settings\?\.enabled === false/);
  assert.match(continuity, /isFreshStartActive\(\)/);
  assert.match(index, /transitionStale[\s\S]*settings\.enabled === false/);
  assert.match(index, /transitionStale[\s\S]*isFreshStart/);
});

test('read-only discard prunes the hidden branch before lifting Fresh Start', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf("$('#sm_read_only').on('change'");
  const end = source.indexOf("$('#sm_extract_now')", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  const hide = block.indexOf('await hideChatMessageRange');
  const prune = block.indexOf('await detectAndPruneInFileBranch');
  const lift = block.indexOf('await setFreshStart(false)', prune);
  assert.equal(hide, -1);
  assert.ok(prune >= 0 && lift > prune);
  assert.match(block.slice(prune, lift), /allowUnclassifiedPrune:\s*true/);
});

test('read-only discard never mutates raw chat messages', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const start = source.indexOf("$('#sm_read_only').on('change'");
  const end = source.indexOf("$('#sm_extract_now')", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /hideChatMessageRange/);
  assert.match(block, /purgeSessionMemoriesSince/);
  assert.match(block, /detectAndPruneInFileBranch/);
});

test('production Product control uses the owned reservation helper', async () => {
  const [control, index, settings] = await Promise.all([
    readFile(resolve(root, 'product-control.js'), 'utf8'),
    readFile(resolve(root, 'index.js'), 'utf8'),
    readFile(resolve(root, 'settings.js'), 'utf8'),
  ]);
  assert.match(control, /createOwnedProductControl/);
  assert.match(index, /createOwnedProductControl/);
  assert.match(index, /productControl\.reserve/);
  assert.match(index, /productControl\.release/);
  assert.match(settings, /reserveProductControl/);
  assert.match(settings, /releaseProductControl/);
});

test('master disable invalidates Product control instead of releasing without ownership', async () => {
  const [index, settings] = await Promise.all([
    readFile(resolve(root, 'index.js'), 'utf8'),
    readFile(resolve(root, 'settings.js'), 'utf8'),
  ]);
  assert.match(index, /invalidateProductControl/);
  assert.match(settings, /ctrl\.invalidateProductControl\?\.\(\)/);
  assert.doesNotMatch(settings, /ctrl\.releaseProductControl\?\.\(\)/);
});

test('legacy operation capture returns the selected character identity', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');
  const helperStart = source.indexOf('function captureLegacyOperation');
  const helperEnd = source.indexOf('function isCatchUpRunning', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /return \{ context, characterName, stillCurrent \}/);
  assert.match(source, /const characterName = operation\.characterName/);
});

test('namespace management and duplicate removal recheck identity before mutation', async () => {
  const settings = await readFile(resolve(root, 'settings.js'), 'utf8');
  const index = await readFile(resolve(root, 'index.js'), 'utf8');
  const managerStart = settings.indexOf("$('#sm_nuke_selected_chat_memory')");
  const managerEnd = settings.indexOf('async function commitReadOnlyWindow', managerStart);
  assert.ok(managerStart >= 0 && managerEnd > managerStart);
  const manager = settings.slice(managerStart, managerEnd);
  assert.match(manager, /captureLegacyOperation\(\)/);
  assert.match(manager, /if \(!operation\.stillCurrent\(\)\) return;/);
  assert.match(manager, /await ctrl\.relinkRenameNamespace\?\.[\s\S]*operation\.stillCurrent/);
  assert.match(manager, /await ctrl\.unlinkManualMemory\?\.\(operation\.stillCurrent\)/);

  const duplicateStart = settings.indexOf("$('#sm_scan_duplicates')");
  const duplicateEnd = settings.indexOf("$('#sm_cancel_catch_up')", duplicateStart);
  assert.ok(duplicateStart >= 0 && duplicateEnd > duplicateStart);
  const duplicate = settings.slice(duplicateStart, duplicateEnd);
  assert.match(duplicate, /captureLegacyOperation\(\)/);
  assert.match(duplicate, /scanDuplicateMemories\?\.\(characterName, operation\.stillCurrent\)/);
  assert.match(duplicate, /applyDuplicateRemoval\?\.\(\s*characterName,\s*operation\.stillCurrent,\s*scan\.review,?\s*\)/);
  assert.match(duplicate, /await injectMemories\(characterName, false, operation\.stillCurrent\)/);
  assert.match(index, /import \{ planDuplicateRemoval, createDuplicateReview, duplicateReviewMatches \} from '\.\/dedup-audit\.js'/);
  assert.match(index, /async function applyDuplicateRemoval\(characterName, abortCheck = null, review = null\)/);
  assert.match(index, /if \(!duplicateReviewMatches\(memories, review\)\)/);
  assert.match(index, /const allMemories = loadCharacterMemories\(characterName\)/);
  assert.match(index, /const kept = allMemories\.filter/);
});

test('namespace relink and unlink stage shared-store mutations until metadata save settles', async () => {
  const source = await readFile(resolve(root, 'rename-ops.js'), 'utf8');
  for (const marker of ['export async function relinkCurrentNamespace', 'export async function unlinkCurrentManualMemory']) {
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `missing ${marker}`);
    const end = source.indexOf('\n}', start);
    assert.ok(end > start);
  }
  assert.match(source, /structuredClone|JSON\.parse\(JSON\.stringify/);
  assert.match(source, /await context\.saveMetadata\(\)/);
  assert.match(source, /commitNamespaceStore/);
});

test('category and macro toggles clear or recompose live prompt state in compatibility mode', async () => {
  const settings = await readFile(resolve(root, 'settings.js'), 'utf8');
  const canonStart = settings.indexOf("$('#sm_canon_enabled')");
  const canonEnd = settings.indexOf("$('#sm_canon_inject_budget')", canonStart);
  const canon = settings.slice(canonStart, canonEnd);
  assert.match(canon, /invalidateUnifiedCache\(PROMPT_KEY_CANON\)/);
  assert.match(canon, /maybeInjectUnified\(\)/);

  const profilesStart = settings.indexOf("$('#sm_profiles_enabled')");
  const profilesEnd = settings.indexOf('const $profilesThresholdVal', profilesStart);
  const profiles = settings.slice(profilesStart, profilesEnd);
  assert.match(profiles, /invalidateUnifiedCache\(PROMPT_KEY_PROFILES\)/);
  assert.match(profiles, /maybeInjectUnified\(\)/);

  const compactionStart = settings.indexOf("$('#sm_compaction_enabled')");
  const compactionEnd = settings.indexOf("$('#sm_compaction_threshold')", compactionStart);
  const compaction = settings.slice(compactionStart, compactionEnd);
  assert.match(compaction, /loadAndInjectSummary\(\)/);
  assert.match(compaction, /maybeInjectUnified\(\)/);

  const macrosStart = settings.indexOf("$('#sm_macros_enabled')");
  const macrosEnd = settings.indexOf("$('#sm_check_continuity')", macrosStart);
  const macros = settings.slice(macrosStart, macrosEnd);
  assert.match(macros, /reinjectAfterBudgetChange\(ctrl\.getSelectedCharacterName\(\)\)/);

  const recomposeToggles = [
    '#sm_longterm_enabled',
    '#sm_session_enabled',
    '#sm_scene_enabled',
    '#sm_arcs_enabled',
    '#sm_relationships_enabled',
    '#sm_epistemic_enabled',
    '#sm_state_ledger_enabled',
  ];
  for (const id of recomposeToggles) {
    const start = settings.indexOf(`$('${id}')`);
    const next = settings.indexOf("$('#sm_", start + 8);
    assert.ok(start >= 0, `missing ${id}`);
    assert.ok(next > start, `missing binding after ${id}`);
    assert.match(settings.slice(start, next), /maybeInjectUnified\(\)/);
  }
});

test('category-disabled macros fail closed at macro read time', async () => {
  const source = await readFile(resolve(root, 'macros.js'), 'utf8');
  assert.match(source, /const MACRO_ENABLE_SETTINGS/);
  assert.match(source, /MACRO_ENABLE_SETTINGS\[macroName\]/);
  assert.match(source, /settings\[enabledSetting\] === false/);
  assert.match(source, /if \(!isUnifiedMacro && enabledSetting/);
});

test('shared asynchronous flags use ownership tokens for compaction and continuity', async () => {
  const source = await readFile(resolve(root, 'index.js'), 'utf8');
  assert.match(source, /compactionOwner/);
  assert.match(source, /continuityCheckOwner/);
  assert.match(source, /releaseCompactionOwnership/);
  assert.match(source, /releaseContinuityOwnership/);
});

test('relationship injection invalidates unified cache whenever its slot is cleared', async () => {
  const source = await readFile(resolve(root, 'longterm.js'), 'utf8');
  const start = source.indexOf('export function injectRelationshipHistory');
  assert.ok(start >= 0);
  assert.match(source.slice(start), /invalidateUnifiedCache\(PROMPT_KEY_RELATIONSHIPS\)/);
});

test('consolidation preserves branch provenance after parser reconciliation', async () => {
  const [longterm, session] = await Promise.all([
    readFile(resolve(root, 'longterm.js'), 'utf8'),
    readFile(resolve(root, 'session.js'), 'utf8'),
  ]);
  assert.match(longterm, /consolidateMemories[\s\S]*currentLineageEpochStamp\(\)/);
  assert.match(longterm, /Object\.assign\(entry, recordStamp\)/);
  assert.match(session, /consolidateSessionMemories[\s\S]*currentLineageEpochStamp\(\)/);
  assert.match(session, /Object\.assign\(memory, recordStamp\)/);
});

test('manual relink and manual legacy additions preserve current branch provenance', async () => {
  const [renameOps, ui, settings] = await Promise.all([
    readFile(resolve(root, 'rename-ops.js'), 'utf8'),
    readFile(resolve(root, 'ui.js'), 'utf8'),
    readFile(resolve(root, 'settings.js'), 'utf8'),
  ]);
  assert.match(renameOps, /const manualEpochId = manual \? generateMemoryId\(\) : null/);
  assert.match(renameOps, /branch_uid: manualEpochId/);
  assert.match(renameOps, /retagChatMetadata\([\s\S]*manualEpochId/);
  assert.match(ui, /currentLineageRecordStamp\(\)/);
  assert.match(settings, /currentLineageRecordStamp\(\)/);
});

test('async legacy clear and arc resolution retain operation identity through awaits', async () => {
  const [settings, arcs, ui] = await Promise.all([
    readFile(resolve(root, 'settings.js'), 'utf8'),
    readFile(resolve(root, 'arcs.js'), 'utf8'),
    readFile(resolve(root, 'ui.js'), 'utf8'),
  ]);
  assert.match(settings, /clearOperation|clearStillCurrent/);
  assert.match(settings, /operation\.stillCurrent\(\)[\s\S]*clearSessionMemories/);
  assert.match(arcs, /resolveArcWithSummary[\s\S]*abortCheck/);
  assert.match(ui, /resolveArcWithSummary\([\s\S]*operation/);
});
