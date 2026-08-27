/**
 * Storyhold - SillyTavern Extension
 * Copyright (C) 2026 Senjin the Dragon
 * https://github.com/senjinthedragon/Smart-Memory
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Main entry point: wires all modules together, manages event handlers,
 * and drives the per-message processing loop.
 *
 * Multi-tier memory and narrative context system:
 *   Short-term    Token-threshold structured summary (progressive compaction).
 *   Long-term     Durable facts and state within the current chat.
 *   Session       Detailed within-session facts (scene details, revelations).
 *   Scene history Mini-summaries of completed scenes for scene-transition context.
 *   Story arcs    Open plot threads - promises made, tensions, mysteries.
 *   Away recap    "Previously on..." summary when returning after a long break.
 *   Continuity    Manual check: does the last response contradict known facts?
 *   /sm-search    Slash command: semantic search across all tiers, shows results popup.
 *   Graph view    Force-directed canvas visualization of entities and memories.
 *   Activity      Sticky toastr notification shown during background extraction (startActivityLoader/stopActivityLoader).
 */

import {
  eventSource,
  event_types,
  getCurrentChatId,
  saveSettingsDebounced,
  setExtensionPrompt,
  extension_prompt_types,
} from '../../../../script.js';
import {
  getContext,
  extension_settings,
  renderExtensionTemplateAsync,
} from '../../../extensions.js';
import {
  MODULE_NAME,
  META_KEY,
  PROMPT_KEY_SHORT,
  PROMPT_KEY_LONG,
  PROMPT_KEY_SESSION,
  PROMPT_KEY_SCENES,
  PROMPT_KEY_ARCS,
  PROMPT_KEY_REPAIR,
  PROMPT_KEY_PROFILES,
  PROMPT_KEY_CANON,
  PROMPT_KEY_TRIGGERED,
  PROMPT_KEY_RELATIONSHIPS,
  PROMPT_KEY_EPISTEMIC,
  PROMPT_KEY_STATE_LEDGER,
} from './constants.js';
import {
  memory_sources,
  abortCurrentMemoryGeneration,
  generateMemoryExtract,
  generateMemorySummarize,
} from './generate.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import {
  ARGUMENT_TYPE,
  SlashCommandArgument,
  SlashCommandNamedArgument,
} from '../../../slash-commands/SlashCommandArgument.js';

import { shouldCompact, runCompaction, injectSummary, loadAndInjectSummary } from './compaction.js';
import {
  extractAndStoreMemories,
  consolidateMemories,
  injectMemories,
  loadCharacterMemories,
  saveCharacterMemories,
  isFreshStart,
  injectRelationshipHistory,
} from './longterm.js';
import { updateLastActive, getAwayHours, generateRecap, displayRecap } from './recap.js';
import {
  extractSessionMemories,
  consolidateSessionMemories,
  injectSessionMemories,
  loadSessionMemories,
} from './session.js';
import { processSceneBreak, injectSceneHistory, linkMemoriesToLastScene } from './scenes.js';
import {
  extractArcs,
  injectArcs,
  loadArcs,
  loadArcSummaries,
  loadGroupPersistentArcs,
  saveGroupPersistentArcs,
  pruneOrphanedGroupArcs,
} from './arcs.js';
import {
  checkContinuity,
  generateRepair,
  injectRepair,
  clearRepair,
  loadAndInjectRepair,
} from './continuity.js';
import {
  clearEmbeddingCache,
  getHardwareProfile,
  getEmbeddingBatch,
  cosineSimilarity,
} from './embeddings.js';
import { hash32 } from './identity.js';
import { jaccardSimilarity } from './similarity.js';
import { planDuplicateRemoval, createDuplicateReview, duplicateReviewMatches } from './dedup-audit.js';
import { generateCanon, injectCanon } from './canon.js';
import {
  ensureChatMigrated,
  loadCharacterEntityRegistry,
  saveCharacterEntityRegistry,
  seedCharacterEntity,
} from './graph-migration.js';
import { generateProfiles, injectProfiles, loadProfiles } from './profiles.js';
import { classifyTurn, adaptiveBudgets } from './memory-utils.js';
import { invalidateChatScopePin } from './scope.js';
import { clearUnifiedSlot, maybeInjectUnified } from './unified-inject.js';
import { registerSmartMemoryMacros, clearAllMacroContent } from './macros.js';
import { smLog } from './logging.js';
import {
  isEpistemicEnabled,
  extractEpistemicKnowledge,
  injectEpistemicKnowledge,
  loadAndInjectEpistemicKnowledge,
  resetEpistemicWarnFlag,
} from './epistemic.js';
import {
  runStateCardExtraction,
  injectStateLedger,
  loadAndInjectStateLedger,
} from './state-ledger.js';
import { detectAndPruneInFileBranch } from './branch-ops.js';
import { chatHasRealMesIds, getMesIdWindow, updateLegacySourceProof, watermarkFromChat } from './branch-aware.js';
import { classifyIndependentChatTree } from './lineage.js';
import {
  getCurrentLineage,
  isCurrentLineageQuarantined,
  setCurrentLineage,
  setFreshStartProvider,
} from './lineage-runtime.js';
// Wire the live Fresh Start reader so lineage-runtime.js stays free of static
// SillyTavern imports (the node regression tests import that module directly).
setFreshStartProvider(() => getContext().chatMetadata?.[META_KEY]?.freshStart === true);
import { ensureStableChatIdentity } from './rename-ops.js';
import {
  archiveCurrentNamespace,
  auditCurrentChatNamespaces,
  emptyCurrentCharacterRollbackArchive,
  listCurrentCharacterChatMemory,
  nukeAllCurrentCharacterChatMemory,
  nukeCurrentCharacterChatMemory,
  relinkCurrentNamespace,
  unlinkCurrentManualMemory,
} from './rename-ops.js';
import { buildProductExplorerModel } from './product-explorer.js';
import { rebuildTimeline } from './timeline.js';
import {
  applyTimelineOverride,
  applyTimelineOverrides,
  clearTimelineOverride,
  createProductRecord,
  buildProductSuppressionKey,
  deleteProductRecord,
  editProductRecord,
  restoreProductRecord,
  retireProductRecord,
  upsertProductSuppression,
} from './product-mutations.js';
import {
  buildProductWindow,
  createProductPipeline,
  advanceProductCursor,
  loadProductCursor,
  persistProductStatus,
  resetProductMemory,
} from './product-runtime.js';
import { runProductCatchUp } from './product-catchup.js';
import {
  captureProductOperationIdentity,
  createProductOperationGate,
} from './product-operation.js';
import { createOwnedProductControl } from './product-control.js';
import { enabledProductKinds, filterProductRecords, shouldRunProductIngest } from './runtime-policy.js';
import { filterRetrievalRecords } from './retrieval.js';
import {
  buildChallengePrompt,
  buildMemoryReview,
  MEMORY_CHALLENGE_VERDICTS,
  MEMORY_REVIEW_MODES,
  MEMORY_REVIEW_PHASES,
  memoryReviewProgress,
  parseChallengeAdjudication,
  parseChallengeResponse,
  resolveRecordSources,
} from './memory-review.js';
import {
  setStatusMessage,
  updateProductStatusUI,
  clearProductViews,
  updateShortTermUI,
  updateLongTermUI,
  updateSessionUI,
  updateScenesUI,
  updateArcsUI,
  updateTokenDisplay,
  updateFreshStartUI,
  updateCanonUI,
  updateProfilesUI,
  updateRelationshipHistoryUI,
  updateEpistemicUI,
  updateEntityPanel,
  updateEmbeddingNotice,
  setContinuityBadge,
  setMemoryReviewStatus,
  showMemoryReview,
  initTooltips,
  initTypePickers,
} from './ui.js';
import { defaultSettings, loadSettings, bindSettingsUI, autoTuneBudgets } from './settings.js';
import { clearTierTrimStats, resetTrimToastFlag, markChatLoadComplete } from './trim-stats.js';

// ---- Module-level state -------------------------------------------------

// Set to true by GENERATION_STARTED (type='normal' only) and cleared by MESSAGE_RECEIVED.
// Used instead of ST's is_send_press to guard onCharacterMessageRendered
// against intermediate streaming renders. is_send_press is still true when
// CHARACTER_MESSAGE_RENDERED fires in non-streaming mode, which would cause
// extraction to be silently skipped. MESSAGE_RECEIVED always fires before
// CHARACTER_MESSAGE_RENDERED in both streaming and non-streaming paths.
// Quiet generations (background calls from other extensions) are intentionally
// excluded - setting the flag for them causes extraction to be skipped when
// another extension fires a quiet generation between MESSAGE_RECEIVED and
// CHARACTER_MESSAGE_RENDERED.
let generationInProgress = false;

// Guards prevent re-entrant model calls if ST fires events faster than
// the previous async job completes.
let messagesSinceLastExtraction = 0;
// Tracks messages since the last profile generation (extraction-pass or scheduled).
// Reset to 0 whenever profiles are regenerated so the two triggers don't stack.
let messagesSinceLastProfileRegen = 0;
let compactionRunning = false;
let compactionOwner = null;
let extractionRunning = false;
let consolidationRunning = false;
let memoryReviewOwner = null;
const productOperationGate = createProductOperationGate();
const productControl = createOwnedProductControl();
let productControlToken = null;
let extractionOwner = null;
function claimExtractionOwnership() {
  if (extractionOwner) return null;
  const token = Symbol('extraction-owner');
  extractionOwner = token;
  extractionRunning = true;
  return token;
}
function releaseExtractionOwnership(token) {
  if (extractionOwner === token) {
    extractionOwner = null;
    extractionRunning = false;
  }
}
function claimCompactionOwnership() {
  if (compactionOwner) return null;
  const token = Symbol('compaction-owner');
  compactionOwner = token;
  compactionRunning = true;
  return token;
}

function releaseCompactionOwnership(token) {
  if (compactionOwner !== token) return false;
  compactionOwner = null;
  compactionRunning = false;
  return true;
}

// Guards the Profile B auto-continuity check so at most one runs at a time.
let continuityCheckOwner = null;
function claimContinuityOwnership() {
  if (continuityCheckOwner) return null;
  const token = Symbol('continuity-owner');
  continuityCheckOwner = token;
  return token;
}
function releaseContinuityOwnership(token) {
  if (continuityCheckOwner !== token) return false;
  continuityCheckOwner = null;
  return true;
}

let automaticPipelineOwner = null;
function claimAutomaticPipelineOwnership() {
  if (automaticPipelineOwner) return null;
  const token = Symbol('automatic-pipeline-owner');
  automaticPipelineOwner = token;
  return token;
}
function releaseAutomaticPipelineOwnership(token) {
  if (automaticPipelineOwner !== token) return false;
  automaticPipelineOwner = null;
  return true;
}

// Guards recap generation so a slow model call cannot produce a second toast
// if onChatChangedImpl fires again before updateLastActive() has run.
// Holds a reference to the chatMetadata object for the chat whose recap is
// currently in progress, null when idle. Using the metadata object reference
// as the identity key means:
//   - Same chat double-fire: both calls get the same object reference, so the
//     second call is blocked and the first recap can still display its result.
//   - Navigation away: getContext().chatMetadata returns a different object, so
//     the in-flight recap is correctly discarded at completion time.
// This variable must NOT be reset in the onChatChangedImpl reset block.
let recapRunningForChat = null;

// Set to true when MESSAGE_SENT fires while a recap is in progress. Prevents
// the popup from appearing after the recap finishes - the user already sent a
// message so showing "Previously on..." after the fact would be confusing.
// Reset at the start of each chat load and after each recap completes.
let recapSuppressed = false;

// Active activity loader handle for an in-progress recap, stored at module
// level so the reset block can clear a stuck toast if the chat changes before
// the recap promise settles (e.g. Ollama drops the request on an error).
let activeRecapHandle = null;

// Set to true by the Cancel button to abort an in-progress catch-up loop.
let catchUpCancelled = false;

// Tracks which character names have responded in the current group chat round.
// Populated by onCharacterMessageRendered when context.groupId is set, cleared
// by onGroupWrapperStarted at the top of each new round.
let respondedThisRound = new Set();

// True once loadAndInjectRepair() has been called for the first character in a
// group round. Prevents the one-shot repair note from being re-injected for
// every subsequent character in the same round.
let repairInjectedThisRound = false;

// Last observed chat length, used to distinguish new messages from swipes.
// CHARACTER_MESSAGE_RENDERED fires on both; swipes do not grow the chat array.
let lastKnownChatLength = 0;

// ---- Activity indicator helpers -----------------------------------------

/**
 * Shows a sticky toastr notification if the activity indicator setting is enabled.
 * Returns the toast element so it can be cleared when the operation finishes.
 * Returns null if the setting is off.
 * @param {object} settings - The Storyhold settings object.
 * @param {string} [message] - Status text to display.
 * @returns {JQuery|null}
 */
function startActivityLoader(settings, message = 'Processing...') {
  if (!(settings.show_activity_indicator ?? true)) return null;
  return toastr.info(message, 'Storyhold', {
    timeOut: 0,
    extendedTimeOut: 0,
    tapToDismiss: false,
  });
}

/**
 * Clears the toast returned by startActivityLoader.
 * Safe to call with null (when the setting was off).
 * @param {JQuery|null} handle
 */
function stopActivityLoader(handle) {
  // Use direct DOM removal rather than toastr.clear() - toastr's clear()
  // resolves by queue position rather than by element identity, which causes
  // it to dismiss the wrong toast when multiple toasts exist concurrently
  // (e.g. a continuity check toast still lingering when extraction starts).
  if (handle) handle.remove();
}

/**
 * Returns a stable extraction window that excludes the currently swipable
 * assistant reply (the trailing non-user message in 1:1 chats). This prevents
 * storing memories from temporary swipe candidates the user may discard.
 *
 * The latest assistant reply is naturally included on the next turn after the
 * user responds, so accepted content is still captured with a one-turn delay.
 *
 * @param {Array} chat - Full chat array from SillyTavern context.
 * @param {number} windowSize - Max number of messages to return.
 * @returns {Array} Stable message slice safe for extraction.
 */
function getStableExtractionWindow(chat, windowSize) {
  if (!Array.isArray(chat) || chat.length === 0) return [];

  const last = chat[chat.length - 1];
  const cutoff = last && !last.is_user && !last.is_system ? chat.length - 1 : chat.length;
  if (cutoff <= 0) return [];

  const start = Math.max(0, cutoff - windowSize);
  return chat.slice(start, cutoff);
}

/**
 * Smart extraction window for memory tiers.
 *
 * On first extraction (lastCutoff null) falls back to maxWindow. On subsequent
 * passes, starts from just after the last processed message but always includes
 * at least extractEvery * 2 messages so the model has enough context to make
 * meaningful distinctions. Capped at maxWindow to avoid unbounded growth when
 * the chat has advanced a long way since the last pass.
 *
 * @param {Array} chat - Full chat array from SillyTavern context.
 * @param {number|null} lastCutoff - Exclusive end index used in the previous pass, or null.
 * @param {number} extractEvery - Current extraction interval setting.
 * @param {number} maxWindow - Hard cap on window size.
 * @returns {Array} Stable message slice.
 */
function getSmartExtractionWindow(chat, lastCutoff, extractEvery, maxWindow) {
  if (!Array.isArray(chat) || chat.length === 0) return [];

  const last = chat[chat.length - 1];
  const cutoff = last && !last.is_user && !last.is_system ? chat.length - 1 : chat.length;
  if (cutoff <= 0) return [];

  let start;
  if (lastCutoff === null || lastCutoff === undefined) {
    start = Math.max(0, cutoff - maxWindow);
  } else {
    // Start from just after the last processed message, but ensure at least
    // extractEvery * 2 messages of context. Cap at maxWindow so a very old
    // lastCutoff does not produce a huge window.
    const newStart = lastCutoff;
    const minContextStart = cutoff - extractEvery * 2;
    start = Math.max(Math.min(newStart, minContextStart), cutoff - maxWindow, 0);
  }
  return chat.slice(start, cutoff);
}

/**
 * Stable extraction window with fallback for small/new chats.
 *
 * @param {Array} chat - Full chat array from SillyTavern context.
 * @param {number} windowSize - Max number of messages to return.
 * @returns {Array} Stable message slice, or plain tail slice if none exist yet.
 */
function getStableExtractionWindowWithFallback(chat, windowSize) {
  const stable = getStableExtractionWindow(chat, windowSize);
  if (stable.length > 0) return stable;

  if (!Array.isArray(chat) || chat.length === 0) return [];
  const start = Math.max(0, chat.length - windowSize);
  return chat.slice(start);
}

// Accumulates messages since the last detected scene break. Reset to []
// when a break is detected so the next scene starts from a clean buffer.
let sceneMessageBuffer = [];
// Index of the last chat message already pushed into sceneMessageBuffer.
// Prevents duplicate pushes when CHARACTER_MESSAGE_RENDERED fires more than
// once for the same message (e.g. during swipes or re-renders).
let sceneBufferLastIndex = -1;

// ---- Helpers ------------------------------------------------------------

/** Returns the settings object for this extension. */
function getSettings() {
  return extension_settings[MODULE_NAME];
}

function buildProductNarrativePrompt(storyText, contextText) {
  return [
    'Role: precise narrative-state tracker.',
    'Summarize only the new narrative delta needed to continue the prior context.',
    'Preserve names, relationships, motivations, location, time, important objects, and unresolved tension.',
    'Do not repeat information already present in the prior context. Return one compact line.',
    '<prior_context>',
    contextText || '(none yet)',
    '</prior_context>',
    '<new_passage>',
    storyText || '',
    '</new_passage>',
  ].join('\n');
}

function productProgressMessage(event = {}) {
  const windowBase = event.windowNumber ? `window ${event.windowNumber}` : 'product pipeline';
  const windowLabel =
    event.windowNumber && Number.isInteger(event.totalWindows)
      ? `window ${event.windowNumber} of ${event.totalWindows}`
      : windowBase;
  const rangeText = (() => {
    if (!Number.isInteger(event.totalMessages)) return '';
    const start = Number(event?.sourceRange?.start);
    const end = Number(event?.sourceRange?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || start < 0) return '';
    return ` (messages ${start + 1}-${end + 1} of ${event.totalMessages})`;
  })();
  const projectionLabel = {
    narrative: 'narrative continuity',
    structured: 'structured memory',
  }[event.projection] ?? event.projection ?? 'projection';
  switch (event.phase) {
    case 'started':
      return 'Memorize Chat: preparing the product memory pipeline...';
    case 'window_start':
      return `Memorize Chat: reading ${windowLabel}${rangeText}...`;
    case 'window_ready':
      return `Memorize Chat: ${windowLabel} — processing ${event.messageCount ?? 0} message${event.messageCount === 1 ? '' : 's'}${rangeText}...`;
    case 'projection_start':
      return `Memorize Chat: ${windowLabel}${rangeText} — writing ${projectionLabel}...`;
    case 'projection_complete':
      return `Memorize Chat: ${windowLabel}${rangeText} — ${projectionLabel} written (${event.recordCount ?? 0} record${event.recordCount === 1 ? '' : 's'}).`;
    case 'projection_failed':
      return `Memorize Chat: ${windowLabel}${rangeText} — ${projectionLabel} failed. Retry is available.`;
    case 'cursor_advanced':
      return `Memorize Chat: ${windowLabel} saved.`;
    case 'window_complete':
      return `Memorize Chat: ${event.windows ?? 0}${Number.isInteger(event.totalWindows) ? ` of ${event.totalWindows}` : ''} window${event.windows === 1 ? '' : 's'} complete (${event.recordCount ?? 0} record${event.recordCount === 1 ? '' : 's'}).`;
    case 'finished':
      return `Memorize Chat: finished — ${event.windows ?? 0} window${event.windows === 1 ? '' : 's'} processed.`;
    case 'cancelled':
      return `Memorize Chat: cancelled after ${event.windows ?? 0} window${event.windows === 1 ? '' : 's'}.`;
    case 'partial':
      return `Memorize Chat: incomplete after ${event.windows ?? 0} window${event.windows === 1 ? '' : 's'}; retry is available.`;
    case 'capped':
      return `Memorize Chat: safety limit reached after ${event.windows ?? 0} window${event.windows === 1 ? '' : 's'}; run again to continue.`;
    default:
      return null;
  }
}

function reportProductProgress(event, externalCallback = null, characterName = null) {
  const message = productProgressMessage(event);
  if (message) {
    const progress = { ...event, message };
    setStatusMessage(message);
    if (['projection_complete', 'projection_failed', 'window_complete', 'finished'].includes(event.phase)) {
      refreshProductViews(progress, characterName || selectedGroupCharacter || getCurrentCharacterName());
    } else {
      updateProductStatusUI(progress);
      updateEpistemicUI(characterName || selectedGroupCharacter || getCurrentCharacterName());
    }
  }
  if (typeof externalCallback === 'function') {
    try {
      const result = externalCallback(event);
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          console.warn('[Storyhold] External product progress callback failed:', error);
        });
      }
    } catch (error) {
      console.warn('[Storyhold] External product progress callback failed:', error);
    }
  }
}

function refreshProductViews(progress = null, characterName = getCurrentCharacterName()) {
  updateProductStatusUI(progress);
  updateLongTermUI(characterName);
  updateRelationshipHistoryUI(characterName);
  updateSessionUI();
  updateScenesUI();
  updateArcsUI();
  updateEpistemicUI(characterName);
  updateProfilesUI(null);
  updateFreshStartUI(isFreshStart());
  updateCanonUI(null);
  updateTokenDisplay();
}

function productIngestAllowed(settings = getSettings()) {
  return shouldRunProductIngest(settings, {
    freshStart: isFreshStart(),
    lineageQuarantined: isCurrentLineageQuarantined(),
    controlBusy: productControl.isHeld(),
  });
}

function captureLegacyOperation(characterName = getCurrentCharacterName()) {
  const context = getContext();
  const metadata = context.chatMetadata;
  const chatId = getCurrentChatId();
  const chatUid = metadata?.[META_KEY]?.chat_uid ?? null;
  const generation = chatLoadId;
  const mode = getSettings().single_extension_mode === true;
  const stillCurrent = () =>
    chatLoadId === generation &&
    getCurrentChatId() === chatId &&
    getContext().chatMetadata === metadata &&
    getContext().chatMetadata?.[META_KEY]?.chat_uid === chatUid &&
    getCurrentCharacterName() === characterName &&
    getSettings().single_extension_mode === mode &&
    getSettings().enabled !== false &&
    !isFreshStart() &&
    !isCurrentLineageQuarantined();
  if (
    mode ||
    getSettings().enabled === false ||
    isFreshStart() ||
    isCurrentLineageQuarantined() ||
    !metadata
  ) return null;
  return { context, characterName, stillCurrent };
}

function reserveProductControl(identity = {}) {
  if (productControl.isHeld() || productOperationGate.isRunning()) return null;
  const token = productControl.reserve({
    generation: chatLoadId,
    chatId: getCurrentChatId(),
    chatUid: getContext().chatMetadata?.[META_KEY]?.chat_uid ?? null,
    ...identity,
  });
  productControlToken = token;
  return token;
}

function releaseProductControl(token = null) {
  if (!token) return false;
  const released = productControl.release(token);
  if (released && productControlToken === token) productControlToken = null;
  return released;
}

function invalidateProductControl() {
  productControl.invalidate();
  productControlToken = null;
}

function runExclusiveProductOperation(operation, key = chatLoadId) {
  return productOperationGate.run(async () => {
    const extractionToken = claimExtractionOwnership();
    try {
      return await operation();
    } finally {
      releaseExtractionOwnership(extractionToken);
    }
  }, key);
}

/**
 * Runs the single-extension product pipeline for the current chat tip.
 * Legacy compaction/canon/scene-prose writers are deliberately not called here.
 */
async function runSingleExtensionIngest(
  characterName,
  chatChanged,
  onProgress = () => {},
  shouldCancel = () => false,
  expectedIdentity = {},
  productOptions = {},
) {
  const context = getContext();
  const settings = getSettings();
  const meta = context.chatMetadata?.[META_KEY];
  const expectedGeneration = expectedIdentity.generation;
  const expectedChatId = expectedIdentity.chatId !== undefined
    ? expectedIdentity.chatId
    : getCurrentChatId();
  const expectedChatUid = expectedIdentity.chatUid !== undefined
    ? expectedIdentity.chatUid
    : meta?.chat_uid ?? null;
  const expectedMetadata = expectedIdentity.metadata;
  const expectedResponder = expectedIdentity.responder !== undefined
    ? expectedIdentity.responder
    : characterName;
  const recentOnly = productOptions.recentOnly === true;
  const maxMessages = productOptions.maxMessages ?? settings.product_window_size ?? 40;
  const enabledKinds = productOptions.enabledKinds ?? enabledProductKinds(settings);
  const advanceCursor = productOptions.advanceCursor !== false && !recentOnly;
  const currentIdentityMatches = () =>
    (expectedGeneration === undefined || chatLoadId === expectedGeneration) &&
    getCurrentChatId() === expectedChatId &&
    (expectedMetadata === undefined || context.chatMetadata === expectedMetadata) &&
    context.chatMetadata?.[META_KEY]?.chat_uid === expectedChatUid &&
    currentProductResponder() === expectedResponder;
  if (!productIngestAllowed(settings)) return null;
  if (!meta?.chat_uid || !Array.isArray(context.chat) || !currentIdentityMatches()) return null;
  const lineage = getCurrentLineage();
  const productAborted = () =>
    chatChanged() ||
    !currentIdentityMatches() ||
    isFreshStart() ||
    getSettings().enabled === false ||
    getSettings().single_extension_mode !== true ||
    productControl.isHeld() ||
    isCurrentLineageQuarantined();
  if (!lineage || lineage.quarantined || productAborted()) return null;

  await detectAndPruneInFileBranch(characterName, {
    shouldAbort: productAborted,
    isControlBusy: () => productControl.isHeld(),
    expectedChatId,
    expectedChatUid,
    expectedMetadata,
    expectedResponder,
  });
  if (productAborted()) return null;

  const branchUid = meta.chat_uid;
  const rawTimeline = rebuildTimeline(context.chat, {
    chatId: meta.chat_uid,
    epochId: branchUid,
  });
  const timeline = {
    ...rawTimeline,
    events: applyTimelineOverrides(rawTimeline.events, meta.timeline_overrides, {
      chatUid: meta.chat_uid,
    }),
  };
  const cursor = loadProductCursor(context.chatMetadata);
  const window = buildProductWindow({
    chat: context.chat,
    chatUid: meta.chat_uid,
    branchUid,
    cursor: recentOnly ? null : cursor,
    lineage,
    maxMessages,
    recentOnly,
  });
  if (!window) return null;
  onProgress({
    phase: 'window_ready',
    windowId: window.window_id,
    messageCount: window.messages?.length ?? 0,
    sourceRange: window.source_range,
  });
  await persistProductStatus(
    context.chatMetadata,
    {
      phase: 'window_start',
      window_id: window.window_id,
      chat_uid: expectedChatUid,
      branch_uid: branchUid,
      messageCount: window.messages?.length ?? 0,
      message: 'Memorize Chat: product window is ready for projection.',
    },
    async () => {
      if (productAborted()) throw CHAT_SWITCHED;
      await context.saveMetadata();
    },
  );

  const narrativeSettings = {
    snippetsPerLayer: settings.narrative_snippets_per_layer,
    snippetsPerPromotion: settings.narrative_snippets_per_promotion,
    maxLayers: settings.narrative_max_layers,
  };
  const pipeline = createProductPipeline({
    metadata: context.chatMetadata,
    settings: {
      respondingCharacter: characterName,
      chatUid: expectedChatUid,
      chatId: expectedChatId,
      branchUid,
      narrativeSettings,
      timeline,
      enabledKinds,
    },
    shouldAbort: productAborted,
    saveMetadata: async () => {
      if (productAborted()) throw CHAT_SWITCHED;
      await context.saveMetadata();
    },
    saveCancelledMetadata: async () => {
      if (!shouldCancel() || !currentIdentityMatches()) throw CHAT_SWITCHED;
      await context.saveMetadata();
    },
    summarizeNarrative: async ({ storyText, contextText }) => {
      if (productAborted()) throw CHAT_SWITCHED;
      const result = await generateMemorySummarize(
        buildProductNarrativePrompt(storyText, contextText),
        {
          responseLength: settings.narrative_response_length ?? 500,
          chatMessages: [],
        },
      );
      if (productAborted()) throw CHAT_SWITCHED;
      return result;
    },
    extractStructured: async ({ prompt }) => {
      if (productAborted()) throw CHAT_SWITCHED;
      const result = await generateMemoryExtract(prompt, {
        responseLength: settings.structured_response_length ?? 700,
      });
      if (productAborted()) throw CHAT_SWITCHED;
      return result;
    },
  });

  let result;
  try {
    result = await pipeline.ingest(window, {
      shouldAbort: productAborted,
      isCancelled: shouldCancel,
      onProgress,
      forceReprocess: productOptions.forceReprocess === true,
    });
  } catch (error) {
    if (shouldCancel()) {
      return {
        window_id: window.window_id,
        status: 'cancelled',
        records: [],
        record_ids: [],
        failures: [],
        cancelled: true,
        replayed: false,
      };
    }
    if (!productAborted()) {
      await persistProductStatus(
        context.chatMetadata,
        {
          phase: 'failed',
          window_id: window.window_id,
          chat_uid: expectedChatUid,
          branch_uid: branchUid,
          error: error instanceof Error ? error.message : String(error),
          message: 'Product window failed. Retry is available.',
        },
        async () => {
          if (productAborted()) throw CHAT_SWITCHED;
          await context.saveMetadata();
        },
      ).catch((statusError) => console.error('[Storyhold] Product status save failed:', statusError));
      if (productAborted()) return null;
      const message = 'Product window failed. Retry is available.';
      setStatusMessage(message);
      updateProductStatusUI({ message });
    }
    throw error;
  }
  if (productAborted()) return result;
  const recordCount = result.records?.length ?? result.record_ids?.length ?? 0;
  const completed = result.status === 'completed';
  const status = {
    phase: completed ? 'window_complete' : 'projection_failed',
    window_id: window.window_id,
    chat_uid: expectedChatUid,
    branch_uid: branchUid,
    status: result.status,
    recordCount,
    failures: result.failures ?? [],
    message: completed
      ? productProgressMessage({ phase: 'window_complete', windows: 1, recordCount })
      : 'Product window incomplete. Retry is available.',
  };
  if (!completed) {
    await persistProductStatus(
      context.chatMetadata,
      status,
      async () => {
        if (productAborted()) throw CHAT_SWITCHED;
        await context.saveMetadata();
      },
    );
    if (productAborted()) return result;
  }
  if (completed) {
    const root = (context.chatMetadata[META_KEY] ??= {});
    if (!result.replayed) root.narrative_stale = null;
    root.product_status = {
      ...status,
      updated_at: Date.now(),
    };
    if (advanceCursor) {
      await advanceProductCursor(context.chatMetadata, window, async () => {
        if (productAborted()) throw CHAT_SWITCHED;
        await context.saveMetadata();
      });
      if (productAborted()) return result;
      onProgress({
        phase: 'cursor_advanced',
        windowId: window.window_id,
        status: result.status,
      });
    } else {
      await context.saveMetadata();
      if (productAborted()) return result;
      onProgress({
        phase: 'projection_complete',
        windowId: window.window_id,
        status: result.status,
        recentOnly: true,
      });
    }
  }
  if (!productAborted()) {
    maybeInjectUnified({ respondingCharacter: characterName });
    refreshProductViews(null, characterName);
  }
  return result;
}

/** Runs product-mode catch-up over bounded windows until the chat is current. */
async function runSingleExtensionCatchUpUnlocked({
  rescan = false,
  onProgress = () => {},
  expectedGeneration = undefined,
  expectedChatId = undefined,
  expectedChatUid = undefined,
  expectedResponder = undefined,
  expectedMetadata = undefined,
  maxWindows = undefined,
  maxMessages = undefined,
  recentOnly = false,
  enabledKinds = null,
  advanceCursor = true,
  forceReprocess = false,
} = {}) {
  const capturedGen = expectedGeneration !== undefined ? expectedGeneration : chatLoadId;
  const capturedChatId = expectedChatId !== undefined ? expectedChatId : getCurrentChatId();
  const context = getContext();
  const capturedChatUid = expectedChatUid !== undefined
    ? expectedChatUid
    : context.chatMetadata?.[META_KEY]?.chat_uid ?? null;
  const capturedBranchUid = capturedChatUid;
  const productResponder = expectedResponder !== undefined
    ? expectedResponder
    : selectedGroupCharacter || getCurrentCharacterName();
  if (
    chatLoadId !== capturedGen ||
    getCurrentChatId() !== capturedChatId ||
    (expectedMetadata !== undefined && context.chatMetadata !== expectedMetadata) ||
    context.chatMetadata?.[META_KEY]?.chat_uid !== capturedChatUid ||
    currentProductResponder() !== productResponder
  ) {
    return {
      windows: 0,
      last: null,
      cancelled: true,
      exhausted: true,
      skipped: true,
      reason: 'chat-switched',
    };
  }
  const settings = getSettings();
  const chatChanged = () =>
    chatLoadId !== capturedGen ||
    getCurrentChatId() !== capturedChatId ||
    (expectedMetadata !== undefined && context.chatMetadata !== expectedMetadata) ||
    context.chatMetadata?.[META_KEY]?.chat_uid !== capturedChatUid ||
    currentProductResponder() !== productResponder;
  const productChatInvalidated = () =>
    chatChanged() ||
    isFreshStart() ||
    getSettings().enabled === false ||
    getSettings().single_extension_mode !== true ||
    productControl.isHeld() ||
    isCurrentLineageQuarantined();
  const stoppedBeforeWrite = () => productChatInvalidated() || catchUpCancelled;
  const stoppedOutcome = () => ({
    windows: 0,
    last: null,
    cancelled: catchUpCancelled,
    exhausted: true,
    skipped: productChatInvalidated(),
    reason: productChatInvalidated() ? 'chat-invalidated' : 'cancelled',
  });
  if (!productIngestAllowed(settings)) {
    return { windows: 0, last: null, cancelled: false, exhausted: true, skipped: true };
  }
  if (!context.chatMetadata || !Array.isArray(context.chat)) {
    return { windows: 0, last: null, cancelled: false, exhausted: true };
  }
  if (!capturedChatUid) {
    return {
      windows: 0,
      last: null,
      cancelled: false,
      exhausted: true,
      skipped: true,
      reason: 'missing-chat-identity',
    };
  }
  if (stoppedBeforeWrite()) return stoppedOutcome();

  const saveCurrentMetadata = async () => {
    if (stoppedBeforeWrite()) throw CHAT_SWITCHED;
    await context.saveMetadata();
  };
  const saveTerminalMetadata = async () => {
    if (productChatInvalidated()) throw CHAT_SWITCHED;
    await context.saveMetadata();
  };
  if (rescan) {
    clearAllInjections();
    clearProductViews();
    await resetProductMemory(context.chatMetadata, saveCurrentMetadata, META_KEY, stoppedBeforeWrite);
    if (stoppedBeforeWrite()) return stoppedOutcome();
  }
  if (stoppedBeforeWrite()) return stoppedOutcome();
  await persistProductStatus(
    context.chatMetadata,
    {
      phase: 'started',
      rescan,
      chat_uid: capturedChatUid,
      branch_uid: capturedBranchUid,
      message: 'Memorize Chat: preparing the product memory pipeline...',
    },
    saveCurrentMetadata,
  );

  const report = (event) => {
    if (productChatInvalidated() || catchUpCancelled) return;
    reportProductProgress(event, onProgress, productResponder);
  };
  // Estimate the total window/message counts once, up front, so progress can
  // read "window x of y (messages a-b of N)" like the classic catch-up did.
  // The estimate may drift slightly if the chat grows mid-run; that is fine.
  let progressTotals = {};
  try {
    const windowSize = maxMessages ?? settings.product_window_size ?? 40;
    const chatLength = Array.isArray(context.chat) ? context.chat.length : 0;
    const endExclusive =
      chatLength > 0 && !context.chat[chatLength - 1]?.is_user && !context.chat[chatLength - 1]?.is_system
        ? chatLength - 1
        : chatLength;
    let startIndex = 0;
    if (!recentOnly) {
      const cursor = loadProductCursor(context.chatMetadata);
      if (Number.isInteger(cursor?.last_index)) startIndex = cursor.last_index + 1;
      else if (Number.isInteger(cursor?.end_index)) startIndex = cursor.end_index;
      startIndex = Math.max(0, Math.min(startIndex, endExclusive));
    } else {
      startIndex = Math.max(0, endExclusive - windowSize);
    }
    const remaining = Math.max(0, endExclusive - startIndex);
    if (remaining > 0) {
      progressTotals = {
        totalMessages: endExclusive,
        totalWindows: Math.ceil(remaining / windowSize),
      };
    }
  } catch (error) {
    console.warn('[Storyhold] Product progress total estimate failed:', error);
  }
  try {
    const result = await runProductCatchUp({
      ingestOne: async ({ onProgress: windowProgress }) =>
        runSingleExtensionIngest(
          productResponder,
          () => productChatInvalidated() || catchUpCancelled,
          windowProgress,
          () => catchUpCancelled,
          {
            chatId: capturedChatId,
            chatUid: capturedChatUid,
            generation: capturedGen,
            metadata: expectedMetadata,
            responder: productResponder,
          },
          { recentOnly, maxMessages, enabledKinds, advanceCursor, forceReprocess },
        ),
      shouldAbort: () => productChatInvalidated() || catchUpCancelled,
      maxWindows: maxWindows ?? settings.product_catchup_max_windows ?? 1000,
      rescan,
      ...progressTotals,
      onProgress: report,
    });
    if (!productChatInvalidated()) {
      const terminalPhase = result.cancelled
        ? 'cancelled'
        : result.noProgress
          ? 'partial'
          : result.last && result.last.status !== 'completed'
          ? 'partial'
          : recentOnly && result.last?.status === 'completed'
            ? 'finished'
            : result.exhausted
              ? 'finished'
              : 'capped';
      const terminalMessage = productProgressMessage({
        phase: terminalPhase,
        windows: result.windows,
      });
      await persistProductStatus(
        context.chatMetadata,
        {
          phase: terminalPhase,
          rescan,
          chat_uid: capturedChatUid,
          branch_uid: capturedBranchUid,
          windows: result.windows,
          cancelled: result.cancelled,
          noProgress: result.noProgress,
          exhausted: result.exhausted,
          lastStatus: result.last?.status ?? null,
          message: terminalMessage,
        },
        saveTerminalMetadata,
      );
      if (productChatInvalidated()) return result;
      maybeInjectUnified({ respondingCharacter: productResponder });
      refreshProductViews(null, productResponder);
    }
    return result;
  } catch (error) {
    if (catchUpCancelled && !productChatInvalidated()) {
      await persistProductStatus(
        context.chatMetadata,
        {
          phase: 'cancelled',
          rescan,
          chat_uid: capturedChatUid,
          branch_uid: capturedBranchUid,
          windows: 0,
          cancelled: true,
          message: productProgressMessage({ phase: 'cancelled', windows: 0 }),
        },
        saveTerminalMetadata,
      ).catch((statusError) => console.error('[Storyhold] Product cancellation status save failed:', statusError));
      return stoppedOutcome();
    }
    if (!productChatInvalidated()) {
      await persistProductStatus(
        context.chatMetadata,
        {
          phase: 'failed',
          rescan,
          chat_uid: capturedChatUid,
          branch_uid: capturedBranchUid,
          error: error instanceof Error ? error.message : String(error),
          message: 'Memorize Chat failed. Retry is available.',
        },
        saveCurrentMetadata,
      ).catch((statusError) => console.error('[Storyhold] Product status save failed:', statusError));
    }
    throw error;
  }
}

function runSingleExtensionCatchUp(options = {}) {
  if (!productIngestAllowed()) {
    return Promise.resolve({ windows: 0, last: null, cancelled: false, exhausted: true, skipped: true });
  }
  const capturedGeneration = chatLoadId;
  const capturedChatId = getCurrentChatId();
  const capturedChatUid = getContext().chatMetadata?.[META_KEY]?.chat_uid ?? null;
  const capturedResponder = selectedGroupCharacter || getCurrentCharacterName();
  const capturedMetadata = getContext().chatMetadata;
  const operationIdentity = captureProductOperationIdentity({
    generation: capturedGeneration,
    chatId: capturedChatId,
    chatUid: capturedChatUid,
    responder: capturedResponder,
    metadata: capturedMetadata,
  });
  return runExclusiveProductOperation(
    () =>
      runSingleExtensionCatchUpUnlocked({
        ...options,
        expectedGeneration: operationIdentity.generation,
        expectedChatId: operationIdentity.chatId,
        expectedChatUid: operationIdentity.chatUid,
        expectedResponder: operationIdentity.responder,
        expectedMetadata: operationIdentity.metadata,
      }),
    capturedGeneration,
  );
}

function getCurrentCharacterName() {
  const context = getContext();
  return context.name2 || context.characterName || null;
}

/**
 * Rebuilds the deterministic timeline projection from the current raw chat.
 * The event ledger is a derived chat field; it never changes transcript data.
 */
async function refreshCurrentTimeline(abortCheck = null) {
  if (isCurrentLineageQuarantined()) return null;
  const context = getContext();
  const chatId = getCurrentChatId() ?? null;
  if (!Array.isArray(context.chat) || !context.chatMetadata) return null;

  const meta = context.chatMetadata[META_KEY] ?? (context.chatMetadata[META_KEY] = {});
  const epochId = meta.lineage?.epoch_id ?? meta.timeline?.story_epoch ?? chatId ?? null;
  const rawTimeline = rebuildTimeline(context.chat, { chatId, epochId });
  const timeline = {
    ...rawTimeline,
    events: applyTimelineOverrides(rawTimeline.events, meta.timeline_overrides, {
      chatUid: meta.chat_uid,
    }),
  };
  if (abortCheck?.()) return null;
  if (JSON.stringify(meta.timeline) !== JSON.stringify(timeline)) {
    if (abortCheck?.()) return null;
    meta.timeline = timeline;
    if (abortCheck?.()) return null;
    await context.saveMetadata();
  }
  return timeline;
}

function currentProductExplorerModel() {
  const context = getContext();
  const root = context.chatMetadata?.[META_KEY] ?? null;
  if (!root?.chat_uid) return null;
  return buildProductExplorerModel({
    chatUid: root.chat_uid,
    chatId: getCurrentChatId(),
    records: root.structured_records,
    timeline: root.timeline,
    timelineOverrides: root.timeline_overrides,
    chat: context.chat,
    narrative: root.narrative,
    narrativeStale: Boolean(root.narrative_stale),
  });
}

function captureProductMutation() {
  const context = getContext();
  const metadata = context.chatMetadata;
  const root = metadata?.[META_KEY];
  const identity = captureProductOperationIdentity({
    generation: chatLoadId,
    chatId: getCurrentChatId(),
    chatUid: root?.chat_uid ?? null,
    responder: currentProductResponder(),
    metadata,
  });
  const stillCurrent = () =>
    chatLoadId === identity.generation &&
    getCurrentChatId() === identity.chatId &&
    getContext().chatMetadata === identity.metadata &&
    getContext().chatMetadata?.[META_KEY]?.chat_uid === identity.chatUid &&
    currentProductResponder() === identity.responder &&
    getSettings().enabled !== false &&
    getSettings().single_extension_mode === true &&
    !isFreshStart() &&
    !isCurrentLineageQuarantined();
  if (!metadata || !root?.chat_uid || !stillCurrent()) return null;
  return { context, identity, stillCurrent };
}

async function runProductMutation(mutator) {
  const operation = captureProductMutation();
  if (!operation) return { ok: false, reason: 'This chat is not ready for Product memory changes.' };
  if (productOperationGate.isRunning() || productControl.isHeld()) {
    return { ok: false, reason: 'Product memory is already processing this chat.' };
  }
  return runExclusiveProductOperation(
    async () => {
      if (!operation.stillCurrent()) return { ok: false, reason: 'The active chat changed.' };
      const root = operation.context.chatMetadata[META_KEY];
      const result = await mutator(root, operation.stillCurrent);
      if (!operation.stillCurrent()) return { ok: false, reason: 'The active chat changed.' };
      if (result?.records) root.structured_records = result.records;
      if (result?.timelineOverrides) root.timeline_overrides = result.timelineOverrides;
      if (result?.suppression) {
        root.product_suppressions = upsertProductSuppression(
          root.product_suppressions,
          result.suppression,
        );
      }
      if (Array.isArray(result?.suppressions)) {
        root.product_suppressions = result.suppressions.reduce(
          (current, suppression) => upsertProductSuppression(current, suppression),
          root.product_suppressions,
        );
      }
      if (result?.contentChanged || result?.timelineChanged || result?.records) {
        root.narrative_stale = {
          reason: result?.contentChanged ? 'record-edited' : result?.timelineChanged ? 'timeline-edited' : 'records-changed',
          updated_at: Date.now(),
        };
      }
      if (result?.contentChanged) clearEmbeddingCache();
      await operation.context.saveMetadata();
      if (!operation.stillCurrent()) return { ok: false, reason: 'The active chat changed.' };
      await refreshCurrentTimeline(operation.stillCurrent);
      if (!operation.stillCurrent()) return { ok: false, reason: 'The active chat changed.' };
      maybeInjectUnified({ respondingCharacter: operation.identity.responder });
      refreshProductViews(null, operation.identity.responder);
      $(document).trigger('smart_memory:product_memory_changed');
      return { ok: true, ...result };
    },
    `product-mutation-${operation.identity.generation}`,
  );
}

async function createCurrentProductRecord(kind, content, patch = {}, sourceRange = null) {
  return runProductMutation((root) => {
    const chat = getContext().chat ?? [];
    const fallbackIndex = Math.max(0, chat.length - 1);
    const record = createProductRecord({
      chatUid: root.chat_uid,
      kind,
      content,
      sourceRange: sourceRange ?? { kind: 'index', start: fallbackIndex, end: fallbackIndex },
      patch,
    });
    const existing = Array.isArray(root.structured_records) ? root.structured_records : [];
    if (existing.some((item) => String(item?.id) === String(record.id))) {
      return { records: existing, record, contentChanged: false, changed: false };
    }
    return { records: [...existing, record], record, contentChanged: true, changed: true };
  });
}

async function editCurrentProductRecord(recordId, patch) {
  return runProductMutation((root) => editProductRecord(root.structured_records ?? [], {
    recordId,
    chatUid: root.chat_uid,
    patch,
  }));
}

async function retireCurrentProductRecord(recordId) {
  return runProductMutation((root) => retireProductRecord(root.structured_records ?? [], {
    recordId,
    chatUid: root.chat_uid,
  }));
}

async function restoreCurrentProductRecord(recordId) {
  return runProductMutation((root) => restoreProductRecord(root.structured_records ?? [], {
    recordId,
    chatUid: root.chat_uid,
  }));
}

async function deleteCurrentProductRecord(recordId) {
  return runProductMutation((root) => deleteProductRecord(root.structured_records ?? [], {
    recordId,
    chatUid: root.chat_uid,
  }));
}

async function setCurrentTimelineOverride(eventId, patch) {
  return runProductMutation((root) => ({
    timelineOverrides: applyTimelineOverride(root.timeline_overrides ?? [], {
      eventId,
      chatUid: root.chat_uid,
      patch,
    }),
    timelineChanged: true,
  }));
}

async function clearCurrentTimelineOverride(eventId) {
  return runProductMutation((root) => ({
    timelineOverrides: clearTimelineOverride(root.timeline_overrides ?? [], {
      eventId,
      chatUid: root.chat_uid,
    }),
    timelineChanged: true,
  }));
}

async function refreshCurrentProductTimeline() {
  const operation = captureProductMutation();
  if (!operation) return null;
  const timeline = await refreshCurrentTimeline(operation.stillCurrent);
  return operation.stillCurrent() ? timeline : null;
}

// Tracks which group member the settings panel is currently showing.
// Only meaningful when context.groupId is set. Null means "no selection yet"
// which falls back to context.name2 in getSelectedCharacterName.
let selectedGroupCharacter = null;

/**
 * Returns the character name the settings panel should operate on.
 * In group chats this is the explicitly-selected group member; in 1:1 chats
 * it falls through to the standard active-character lookup.
 *
 * @returns {string|null}
 */
function getSelectedCharacterName() {
  if (getContext().groupId) {
    // selectedGroupCharacter is briefly null during chat transitions (reset at
    // the start of onChatChangedImpl, set again after updateGroupCharSelector).
    // Fall back to the DOM selector value so buttons still work during that window.
    return selectedGroupCharacter || $('#sm_group_char_select').val() || null;
  }
  return getCurrentCharacterName();
}

function currentProductResponder() {
  const context = getContext();
  return context.groupId ? selectedGroupCharacter || getCurrentCharacterName() : getCurrentCharacterName();
}

/**
 * Clears all active injection slots. Called when the master toggle is turned
 * off so that no Storyhold content lingers in the current prompt.
 * This only removes the live prompt injections - stored memories and metadata
 * are not touched. Re-enabling the extension restores them from storage.
 */
function clearAllInjections() {
  const none = extension_prompt_types.NONE;
  setExtensionPrompt(PROMPT_KEY_SHORT, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_LONG, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_SESSION, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_SCENES, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_ARCS, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_REPAIR, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_PROFILES, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_CANON, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_TRIGGERED, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_RELATIONSHIPS, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_EPISTEMIC, '', none, 0);
  setExtensionPrompt(PROMPT_KEY_STATE_LEDGER, '', none, 0);
  clearUnifiedSlot();
  clearAllMacroContent();
  updateTokenDisplay();
}

// ---- Event handlers -----------------------------------------------------

/**
 * Fires after each AI message is rendered (registered with makeLast so Smart
 * Memory runs after all other extensions have processed the message).
 *
 * Swipe detection: CHARACTER_MESSAGE_RENDERED fires on swipes (alternative
 * generations) as well as on new messages. ST passes a `type` parameter -
 * 'swipe', 'impersonate', and 'quiet' should not trigger extraction. The type
 * check is the primary guard; the length comparison is kept as a belt-and-
 * suspenders fallback for any ST version that omits the parameter.
 *
 * Orchestration order (new messages only):
 *   1. Check for compaction threshold and run if needed (async, non-blocking).
 *   2. Check for scene break in the latest message (async, non-blocking).
 *   3. Every N messages: batch extraction for session + long-term + arcs.
 *   4. Update lastActive timestamp for the away recap system.
 *
 * The entire async pipeline (steps 1-7) is deferred via setTimeout(fn, 0) so
 * the handler returns before any model call begins. This prevents the non-
 * streaming path from holding ST's CHARACTER_MESSAGE_RENDERED emit open for the
 * full extraction duration (several seconds on Ollama), which blocks ST's
 * saveChatConditional. All cross-chat races are still guarded by chatLoadId.
 *
 * Compaction and extraction both pass a responseLength to ST's generateRaw /
 * generateQuietPrompt, which temporarily modifies the global amount_gen via
 * ST's TempResponseLength singleton. Running them concurrently corrupts that
 * singleton and leaves amount_gen at the extraction value. They therefore run
 * sequentially: compaction first, extraction only after compaction completes.
 * Compaction is also gated on !extractionRunning so a re-entrant handler call
 * (possible after the deferral) cannot start compaction while a previous turn's
 * extraction is still running. Compaction fires infrequently (only at the
 * context threshold) so the latency cost is negligible in practice.
 */
async function onCharacterMessageRendered(messageId, type) {
  // Skip intermediate streaming renders - MESSAGE_RECEIVED clears this flag
  // before the final CHARACTER_MESSAGE_RENDERED fires in both streaming and
  // non-streaming paths, so extraction only runs once per completed message.
  if (generationInProgress) return;

  const settings = getSettings();
  if (!settings.enabled) return;

  // Fail closed while a chat is transitioning or when its cross-file lineage
  // has not been verified. This prevents delayed render events from extracting
  // into or injecting from a parent-derived branch.
  if (isCurrentLineageQuarantined()) return;

  const context = getContext();
  if (!context.chat || context.chat.length === 0) return;

  // ST passes a type string for non-committed generations. Skip these - the user
  // has not settled on a final message so nothing should be extracted or stored.
  // 'continue' extends the current message in place and may be swiped away;
  // its content will be captured on the next real extraction pass.
  if (type === 'swipe' || type === 'continue' || type === 'impersonate' || type === 'quiet') {
    updateLastActive().catch(console.error);
    return;
  }

  // Belt-and-suspenders fallback: if type is absent (older ST version) fall back
  // to the length comparison. A swipe replaces the last message in-place without
  // growing the chat array, so a non-growing length means skip.
  const currentLength = context.chat.length;
  const isSwipe = currentLength <= lastKnownChatLength;
  lastKnownChatLength = currentLength;
  if (isSwipe) {
    updateLastActive().catch(console.error);
    return;
  }

  // In group chats, all round-level work (extraction, compaction, scene detection,
  // continuity) runs in onGroupWrapperFinished. Here we just track participation
  // and feed new messages into the scene buffer so WRAPPER_FINISHED has the full
  // round's context. Injection is handled by onGroupMemberDrafted before each
  // character generates, so there is nothing further to do here.
  if (context.groupId) {
    const name = getCurrentCharacterName();
    if (name) respondedThisRound.add(name);

    // Accumulate messages so scene break detection in WRAPPER_FINISHED sees
    // everything that happened this round.
    const newGroupMessages = context.chat.slice(sceneBufferLastIndex + 1);
    if (newGroupMessages.length > 0) {
      sceneMessageBuffer.push(...newGroupMessages);
      sceneBufferLastIndex = context.chat.length - 1;
    }

    if (settings.single_extension_mode) {
      updateLastActive().catch(console.error);
      return;
    }

    updateLastActive().catch(console.error);
    return;
  }

  if (settings.single_extension_mode) {
    const capturedProductGen = chatLoadId;
    const capturedProductChatId = getCurrentChatId();
    const capturedProductChatUid = context.chatMetadata?.[META_KEY]?.chat_uid ?? null;
    const capturedProductCharacter = selectedGroupCharacter || getCurrentCharacterName();
    const capturedProductMetadata = context.chatMetadata;
    const capturedProductOperationKey =
      `solo:${capturedProductGen}:${capturedProductChatId}:${capturedProductChatUid}:${context.chat.length}`;
    if (!productIngestAllowed(settings)) {
      updateLastActive().catch(console.error);
      return;
    }
    const productChatChanged = () => chatLoadId !== capturedProductGen;
    const soloProductDeferralToken = claimExtractionOwnership();
    setTimeout(() => {
      releaseExtractionOwnership(soloProductDeferralToken);
      runExclusiveProductOperation(
        () =>
          runSingleExtensionIngest(
            capturedProductCharacter,
            productChatChanged,
            () => {},
            () => false,
            {
              chatId: capturedProductChatId,
              chatUid: capturedProductChatUid,
              generation: capturedProductGen,
              metadata: capturedProductMetadata,
              responder: capturedProductCharacter,
            },
          ),
        capturedProductOperationKey,
      ).catch((err) => console.error('[SmartMemory] Product ingest error:', err));
    }, 0);
    updateLastActive().catch(console.error);
    return;
  }

  const characterName = getCurrentCharacterName();

  // Capture the current chat generation so we can abort before any write if
  // the user switches chats while a model call is in progress.
  const capturedGen = chatLoadId;
  const capturedChatId = getCurrentChatId();
  const capturedMetadata = context.chatMetadata;
  const capturedChatUid = capturedMetadata?.[META_KEY]?.chat_uid ?? null;
  const capturedMode = settings.single_extension_mode === true;
  const chatChanged = () =>
    chatLoadId !== capturedGen ||
    getCurrentChatId() !== capturedChatId ||
    getContext().chatMetadata !== capturedMetadata ||
    getContext().chatMetadata?.[META_KEY]?.chat_uid !== capturedChatUid ||
    getSettings().single_extension_mode !== capturedMode ||
    getSettings().enabled === false ||
    isFreshStart() ||
    isCurrentLineageQuarantined();

  const lastMsg = context.chat
    .slice()
    .reverse()
    .find((m) => !m.is_user && !m.is_system && m.mes);
  const lastMsgText = lastMsg?.mes ?? '';

  // Also grab the last user message so scene break detection catches
  // transitions the user wrote (e.g. "a year passed") that the AI may
  // not have echoed back in its own response.
  const lastUserMsg = context.chat
    .slice()
    .reverse()
    .find((m) => m.is_user && !m.is_system && m.mes);
  const lastUserMsgText = lastUserMsg?.mes ?? '';

  // Previous AI message - passed to scene break detection as context so the
  // model can distinguish a continuation from a genuine transition.
  const aiMessages = context.chat.filter((m) => !m.is_user && !m.is_system && m.mes);
  const prevAiMsgText = aiMessages.length >= 2 ? aiMessages[aiMessages.length - 2].mes : '';

  // Push only messages not yet in the buffer. Using the chat index as a
  // cursor prevents duplicate pushes when the event fires more than once
  // for the same message (swipes, re-renders).
  const newMessages = context.chat.slice(sceneBufferLastIndex + 1);
  if (newMessages.length > 0) {
    sceneMessageBuffer.push(...newMessages);
    sceneBufferLastIndex = context.chat.length - 1;
  }

  // Defer the async pipeline so this handler returns immediately. ST awaits all
  // CHARACTER_MESSAGE_RENDERED listeners before continuing to saveChatConditional;
  // returning here lets that proceed while extraction runs in the background.
  setTimeout(() => {
    if (compactionOwner || extractionOwner || continuityCheckOwner) return;
    const automaticPipelineToken = claimAutomaticPipelineOwnership();
    if (!automaticPipelineToken) return;
    (async () => {
      // Guard: if the user switched chats in the gap between the event handler
      // returning and this timeout firing, bail immediately. Without this check,
      // compaction evaluates the new chat and injectCanon briefly injects the
      // previous character's canon into the wrong chat.
      if (chatChanged()) return;
      await refreshCurrentTimeline(chatChanged);
      if (chatChanged()) return;

      // Step 1: compaction - awaited before extraction to prevent concurrent use
      // of ST's TempResponseLength singleton, which would corrupt amount_gen.
      // Also gated on !extractionRunning: after the deferral a re-entrant handler
      // call (new message during extraction) must not start compaction concurrently.
      // Gated by !isFreshStart() so read-only sessions never advance summaryEnd
      // past the ghosted window; the discard path then has nothing to roll back.
      if (
        settings.compaction_enabled &&
        !compactionOwner &&
        !extractionRunning &&
        !isFreshStart()
      ) {
        const compactionToken = claimCompactionOwnership();
        try {
          const needed = await shouldCompact();
          if (chatChanged()) throw CHAT_SWITCHED;
          if (needed) {
            setStatusMessage('Updating story summary...');
            // Only show the activity indicator for external sources - with the main
            // API, ST's own pipeline blocks swipes with its own message so a second
            // toast would be redundant.
            const source = extension_settings[MODULE_NAME]?.source ?? memory_sources.main;
            const compactionHandle =
              source !== memory_sources.main
                ? startActivityLoader(settings, 'Updating story summary...')
                : null;
            const summary = await runCompaction({ abortCheck: chatChanged });
            stopActivityLoader(compactionHandle);
            if (chatChanged()) throw CHAT_SWITCHED;
            if (summary) {
              injectSummary(summary);
              injectCanon(characterName);
              updateShortTermUI(summary);
              updateTokenDisplay();
              setStatusMessage('Summary updated.');
            } else {
              setStatusMessage('');
            }
          }
        } catch (err) {
          console.error('[SmartMemory] Compaction error:', err);
        } finally {
          releaseCompactionOwnership(compactionToken);
        }
      }
      if (chatChanged()) return;

      // Step 2: scene break detection - awaited before extraction for the same
      // reason as compaction: the AI detection path uses responseLength: 5 which
      // would corrupt amount_gen if it raced with extraction.
      // Also gated on !extractionRunning for the same re-entry reason as step 1.
      // Check both the AI response and the preceding user message - transitions
      // are often written by the user and not echoed by the AI.
      // Gated by !isFreshStart() so no scene summaries are written during read-only.
      const sceneCheckText = [lastUserMsgText, lastMsgText].filter(Boolean).join('\n');
      if (settings.scene_enabled && sceneCheckText && !isFreshStart() && !extractionRunning) {
        try {
          const wasBreak = await processSceneBreak(
            sceneCheckText,
            sceneMessageBuffer,
            prevAiMsgText,
            chatChanged,
          );
          if (chatChanged()) throw CHAT_SWITCHED;
          if (wasBreak) {
            injectSceneHistory();
            updateScenesUI();
            updateTokenDisplay();
            if (isEpistemicEnabled()) {
              await extractEpistemicKnowledge(sceneMessageBuffer, characterName, '', chatChanged);
              if (chatChanged()) throw CHAT_SWITCHED;
              injectEpistemicKnowledge(characterName, characterName, true, true);
            }
            sceneMessageBuffer = [];
            sceneBufferLastIndex = -1;
            setStatusMessage('Scene break detected.');
          }
        } catch (err) {
          console.error('[SmartMemory] Scene detection error:', err);
        }
      }
      if (chatChanged()) return;

      // Step 3: batched extraction every N messages.
      // extractEvery uses the smaller of the two intervals so neither tier
      // falls behind if one is configured more frequently than the other.
      if (!extractionRunning) {
        messagesSinceLastExtraction++;
        messagesSinceLastProfileRegen++;
        const extractEvery = Math.min(
          settings.session_extract_every ?? 3,
          settings.longterm_extract_every ?? 3,
        );

        smLog(
          `[SmartMemory] Solo counter: ${messagesSinceLastExtraction}/${extractEvery} (extractionRunning=${extractionRunning})`,
        );

        if (messagesSinceLastExtraction >= extractEvery) {
          const soloExtractionToken = claimExtractionOwnership();
          smLog(`[SmartMemory] Solo extraction starting at ${new Date().toISOString()}`);

          // Use separate windows per tier. Both memory tiers use a smart window
          // that starts from just after the last processed message so already-seen
          // messages are not re-fed on every pass. A minimum of extractEvery * 2
          // messages is always included so the model has enough context to make
          // meaningful distinctions. Arc extraction uses a fixed wide window to
          // catch threads that were introduced earlier in the session.
          // Detect in-file branch points before choosing extraction windows so
          // the windows start from the divergent tail, not the dead one.
          // Chat loads are covered by onChatChangedImpl; this catches mid-session
          // regenerates without a chat switch.
          const branchExpectedChatId = getCurrentChatId();
          const branchExpectedMetadata = context.chatMetadata;
          const branchExpectedChatUid = branchExpectedMetadata?.[META_KEY]?.chat_uid ?? null;
          await detectAndPruneInFileBranch(characterName, {
            shouldAbort: () =>
              chatChanged() ||
              getCurrentChatId() !== branchExpectedChatId ||
              context.chatMetadata !== branchExpectedMetadata ||
              context.chatMetadata?.[META_KEY]?.chat_uid !== branchExpectedChatUid ||
              productControl.isHeld(),
            isControlBusy: () => productControl.isHeld(),
            expectedChatId: branchExpectedChatId,
            expectedChatUid: branchExpectedChatUid,
            expectedMetadata: branchExpectedMetadata,
          });

          // Prefer mesId-driven windows when the chat carries real mesIds: the
          // watermark survives truncation while the legacy index cutoff does
          // not. Chats without mesIds (imported logs) keep the index behavior.
          const extractMeta = context.chatMetadata?.[META_KEY];
          const useMesIds = chatHasRealMesIds(context.chat);
          const lastExtractMesId = useMesIds ? (extractMeta?.lastExtractMesId ?? null) : null;
          const sessionWindow = useMesIds
            ? getMesIdWindow(context.chat, lastExtractMesId, extractEvery, 40)
            : getSmartExtractionWindow(
                context.chat,
                extractMeta?.lastExtractCutoff ?? null,
                extractEvery,
                40,
              );
          const longtermWindow = useMesIds
            ? getMesIdWindow(context.chat, lastExtractMesId, extractEvery, 20)
            : getSmartExtractionWindow(
                context.chat,
                extractMeta?.lastExtractCutoff ?? null,
                extractEvery,
                20,
              );

          // Determine whether to refresh injection slots this pass. When the
          // refresh period is > 1, long-term and session slots stay stable between
          // refreshes so cloud API prompt caches remain valid. Recent events are
          // covered by chat history during the gap.
          const injRefreshPeriod = settings.injection_refresh_period ?? 1;
          // Clamp the stored index to the current chat tip so message deletions
          // reset the delta to 0 rather than stalling refreshes until the chat
          // regrows past the stale index.
          const injLastRefresh = Math.min(
            context.chatMetadata?.[META_KEY]?.lastInjectionRefresh ?? 0,
            Math.max(0, context.chat.length - 1),
          );
          const shouldRefreshInjections =
            injRefreshPeriod <= 1 || context.chat.length - 1 - injLastRefresh >= injRefreshPeriod;

          // Snapshot the cutoff index now, before any awaits, so messages that
          // arrive during extraction are not silently swallowed by advancing the
          // window boundary after the model calls complete.
          const snapshotLast = context.chat[context.chat.length - 1];
          const snapshotCutoff =
            context.chat.length > 0 &&
            snapshotLast &&
            !snapshotLast.is_user &&
            !snapshotLast.is_system
              ? context.chat.length - 1
              : context.chat.length;

          // If only a fresh assistant reply exists beyond the stable boundary,
          // postpone extraction until the next turn so swipes settle first.
          // Do NOT reset the counter here - no extraction happened, so the next
          // message should retry immediately rather than waiting another extractEvery
          // cycle.
          if (longtermWindow.length === 0 && sessionWindow.length === 0) {
            releaseExtractionOwnership(soloExtractionToken);
            return;
          }

          // Only reset the counter once we know extraction will actually proceed.
          messagesSinceLastExtraction = 0;

          setStatusMessage(`Extracting memories for ${characterName}...`);

          // Run extraction tiers sequentially rather than in parallel.
          // Parallel model calls overwhelm local hardware (RTX 2080 / 8GB VRAM)
          // and gain nothing on Ollama which serializes requests anyway.
          // Awaiting here also prevents compaction/scene detection on the next
          // message from racing against an ongoing extraction and corrupting
          // ST's TempResponseLength singleton (the same hazard fixed in 1.0.1).
          // Capture original budgets before entering try/finally so the finally
          // block can restore them regardless of where the error occurred.
          const originalBudgets = {
            longterm_inject_budget: settings.longterm_inject_budget,
            session_inject_budget: settings.session_inject_budget,
            scene_inject_budget: settings.scene_inject_budget,
            arcs_inject_budget: settings.arcs_inject_budget,
            profiles_inject_budget: settings.profiles_inject_budget,
          };
          const activityHandle = startActivityLoader(settings, 'Extracting memories...');
          try {
            let total = 0;

            // Classify the current turn and apply adaptive per-tier token budgets.
            // The last AI message drives the classifier; budgets are patched directly
            // into settings so injection calls pick them up without signature changes.
            const lastAiMessage = context.chat?.at(-1)?.mes ?? '';
            const turnType = classifyTurn(lastAiMessage);
            const budgets = adaptiveBudgets(settings, turnType);
            settings.longterm_inject_budget = budgets.longterm;
            settings.session_inject_budget = budgets.session;
            settings.scene_inject_budget = budgets.scenes;
            settings.arcs_inject_budget = budgets.arcs;
            settings.profiles_inject_budget = budgets.profiles;

            if (chatChanged()) throw CHAT_SWITCHED;
            if (settings.session_enabled && sessionWindow.length > 0 && !isFreshStart()) {
              // Snapshot existing memory ids before extraction so we can identify
              // which memories are new and link them to the current scene.
              const priorSessionIds = new Set(
                loadSessionMemories()
                  .map((m) => m.id)
                  .filter(Boolean),
              );

              const count = await extractSessionMemories(sessionWindow, chatChanged).catch(
                (err) => {
                  console.error('[SmartMemory] Session extraction error:', err);
                  return 0;
                },
              );
              if (chatChanged()) throw CHAT_SWITCHED;
              // Run session consolidation after extraction - fires per-type when threshold is reached.
              if (!consolidationRunning) {
                consolidationRunning = true;
                await consolidateSessionMemories(false, chatChanged).catch((err) => {
                  console.error('[SmartMemory] Session consolidation error:', err);
                });
                consolidationRunning = false;
                if (chatChanged()) throw CHAT_SWITCHED;
              }
              if (shouldRefreshInjections) {
                await injectSessionMemories(true, chatChanged);
                if (chatChanged()) throw CHAT_SWITCHED;
              }
              updateSessionUI();
              total += count;

              // Link newly-added session memory ids to the most recent scene entry
              // (layer 1 -> layer 2 backlink for three-layer summarization).
              if (settings.scene_enabled && count > 0) {
                const newIds = loadSessionMemories()
                  .map((m) => m.id)
                  .filter((id) => id && !priorSessionIds.has(id));
                if (newIds.length > 0) {
                  await linkMemoriesToLastScene(newIds, chatChanged).catch((err) =>
                    console.error('[SmartMemory] Scene memory linking failed:', err),
                  );
                }
              }
            }

            if (chatChanged()) throw CHAT_SWITCHED;
            if (
              settings.longterm_enabled &&
              characterName &&
              longtermWindow.length > 0 &&
              !isFreshStart()
            ) {
              const count = await extractAndStoreMemories(
                characterName,
                longtermWindow,
                setStatusMessage,
                chatChanged,
              ).catch((err) => {
                console.error('[SmartMemory] Long-term extraction error:', err);
                return 0;
              });
              if (chatChanged()) throw CHAT_SWITCHED;
              // Run consolidation after extraction if new memories were added.
              if (count > 0 && settings.consolidation_enabled && !consolidationRunning) {
                consolidationRunning = true;
                const removed = await consolidateMemories(characterName, false, chatChanged).catch((err) => {
                  console.error('[SmartMemory] Consolidation error:', err);
                  return 0;
                });
                consolidationRunning = false;
                if (chatChanged()) throw CHAT_SWITCHED;
                if (removed > 0) {
                  setStatusMessage(
                    `Consolidated ${removed} redundant memories for ${characterName}.`,
                  );
                  toastr.info(
                    `Merged ${removed} redundant ${removed === 1 ? 'memory' : 'memories'}.`,
                    'Storyhold',
                    { timeOut: 3000 },
                  );
                }
              }
              // Inject once after extraction (and any consolidation). Gated by the
              // refresh period so the slot stays stable between refreshes for
              // cloud API prompt cache hits.
              if (shouldRefreshInjections) {
                await injectMemories(characterName, true, chatChanged);
                if (chatChanged()) throw CHAT_SWITCHED;
                injectRelationshipHistory(characterName);
              }
              if (chatChanged()) throw CHAT_SWITCHED;
              updateLongTermUI(characterName);
              updateRelationshipHistoryUI(characterName);
              updateEpistemicUI(characterName);
              total += count;
            }

            // Snapshot arc summary count before extraction so we can detect a new
            // resolution in this pass (the count only grows when an arc closes).
            const arcSummaryCountBefore = settings.arcs_enabled ? loadArcSummaries().length : 0;

            if (chatChanged()) throw CHAT_SWITCHED;
            if (settings.arcs_enabled && !isFreshStart()) {
              // Arc extraction uses a wider window than other tiers so it can catch
              // arcs opened earlier in the session, but is capped to avoid overflowing
              // the model's context on long chats. Existing arcs are passed to the
              // prompt so resolution still works even outside this window.
              const arcWindow = getStableExtractionWindow(context.chat, 100);
              const count = await extractArcs(arcWindow, characterName, chatChanged).catch(
                (err) => {
                  console.error('[SmartMemory] Arc extraction error:', err);
                  return 0;
                },
              );
              if (chatChanged()) throw CHAT_SWITCHED;
              injectArcs();
              updateArcsUI();
              total += count;
            }

            if (chatChanged()) throw CHAT_SWITCHED;
            if (!isFreshStart()) {
              await runStateCardExtraction(characterName, longtermWindow, chatChanged).catch(
                (err) => {
                  console.error('[SmartMemory] State ledger extraction error:', err);
                },
              );
              if (chatChanged()) throw CHAT_SWITCHED;
              injectStateLedger(true);
            }

            // Regenerate profiles after each extraction pass so they reflect the
            // latest memories. Sequential - same constraint as the other tiers.
            // Skipped in freshStart chats - no new memories were written so
            // regeneration would waste a model call producing the same output.
            if (chatChanged()) throw CHAT_SWITCHED;
            if (settings.profiles_enabled && characterName && !isFreshStart()) {
              await generateProfiles(characterName, chatChanged)
                .then((profiles) => {
                  if (profiles && !chatChanged()) {
                    injectProfiles(characterName);
                    updateProfilesUI(profiles);
                  }
                })
                .catch((err) => console.error('[SmartMemory] Profile generation error:', err));
              if (chatChanged()) throw CHAT_SWITCHED;
              // Reset the scheduled-regen counter since we just regenerated.
              messagesSinceLastProfileRegen = 0;
            }

            // Profile B only: auto-regenerate canon when a new arc resolved this
            // pass. Gating on an increase (not just count >= 2) avoids a model call
            // on every extraction batch once the chat has two summaries.
            if (chatChanged()) throw CHAT_SWITCHED;
            if (
              settings.canon_enabled &&
              settings.arcs_enabled &&
              characterName &&
              !isFreshStart() &&
              getHardwareProfile() === 'b' &&
              loadArcSummaries().length > arcSummaryCountBefore
            ) {
              await generateCanon(characterName, chatChanged)
                .then(() => {
                  if (!chatChanged()) injectCanon(characterName);
                })
                .catch((err) => console.error('[SmartMemory] Auto-canon error:', err));
              if (chatChanged()) throw CHAT_SWITCHED;
            }

            // Refresh entity panel after extraction since new entities may have been linked.
            if (chatChanged()) throw CHAT_SWITCHED;
            updateEntityPanel(characterName);
            if (chatChanged()) throw CHAT_SWITCHED;
            if (shouldRefreshInjections) maybeInjectUnified();
            if (chatChanged()) throw CHAT_SWITCHED;
            updateTokenDisplay();
            autoTuneBudgets(characterName);
            if (chatChanged()) throw CHAT_SWITCHED;
            setStatusMessage(
              total > 0
                ? `${total} item${total === 1 ? '' : 's'} stored for ${characterName}.`
                : '',
            );

            // Persist the cutoff so the next extraction pass knows where this one ended.
            // Use the index snapshotted before the model calls so messages that arrived
            // during extraction are not skipped on the next pass.
            const metaAfter = context.chatMetadata?.[META_KEY];
            if (metaAfter) {
              if (chatChanged()) throw CHAT_SWITCHED;
              metaAfter.lastExtractCutoff = snapshotCutoff;
              if (useMesIds) {
                metaAfter.lastExtractMesId = watermarkFromChat(context.chat, snapshotCutoff);
              }
              if (shouldRefreshInjections) metaAfter.lastInjectionRefresh = snapshotCutoff;
              updateLegacySourceProof(metaAfter, context.chat, snapshotCutoff);
              if (chatChanged()) throw CHAT_SWITCHED;
              context.saveMetadata();
            }
          } catch (err) {
            if (err === CHAT_SWITCHED) {
              smLog('[SmartMemory] Extraction aborted: chat switched mid-extraction.');
            } else {
              console.error('[SmartMemory] Extraction error:', err);
            }
            if (!chatChanged()) setStatusMessage('');
          } finally {
            smLog(`[SmartMemory] Solo extraction finished at ${new Date().toISOString()}`);
            stopActivityLoader(activityHandle);
            // Restore original budget settings so chat-load / settings-change injection
            // paths use the user's configured values, not this turn's adapted values.
            // saveSettingsDebounced is called here rather than inside the try block to
            // ensure the debounce never fires while adapted budgets are still patched in.
            // On Ollama, LLM calls take several seconds - long enough for a 1000ms debounce
            // to fire with wrong values and persist them to disk. If the chat changed while
            // this extraction was settling, fail closed: the new context owns the budget
            // state now, and a stale finally must not restore captured values into it.
            if (!chatChanged()) {
              Object.assign(settings, originalBudgets);
              saveSettingsDebounced();
            }
            releaseExtractionOwnership(soloExtractionToken);
          }
        }
      }
      if (chatChanged()) return;

      // Step 4 (Profile B only): scheduled profile regeneration between extraction passes.
      // Fires when profiles_regen_every > 0 and enough messages have elapsed since the
      // last generation (extraction-pass or a previous scheduled regen). Fire-and-forget
      // so it does not block the handler. Profile A skips this - profiles regenerate on
      // extraction passes there and extra calls are too expensive on local hardware.
      if (
        settings.profiles_enabled &&
        (settings.profiles_regen_every ?? 0) > 0 &&
        getHardwareProfile() === 'b' &&
        characterName &&
        !isFreshStart() &&
        messagesSinceLastProfileRegen >= settings.profiles_regen_every
      ) {
        messagesSinceLastProfileRegen = 0;
        const schedProfileHandle = startActivityLoader(settings, 'Updating profiles...');
        generateProfiles(characterName, chatChanged)
          .then((profiles) => {
            stopActivityLoader(schedProfileHandle);
            if (profiles && !chatChanged()) {
              injectProfiles(characterName);
              updateProfilesUI(profiles);
            }
          })
          .catch((err) => {
            stopActivityLoader(schedProfileHandle);
            console.error('[SmartMemory] Scheduled profile regeneration error:', err);
          });
      }
      if (chatChanged()) return;

      // Step 5: clear any pending continuity repair - it was injected for this
      // response turn and should not carry over to the next message.
      clearRepair();

      // Step 6 (Profile B only): silent continuity check after each AI turn.
      // Fire-and-forget so it does not block the event handler while the model
      // responds. The badge in the settings header updates when the check finishes.
      // On Profile A (local hardware) this stays manual-only - too expensive for
      // every turn on an RTX 2080.
      if (
        getHardwareProfile() === 'b' &&
        settings.continuity_auto_check &&
        !continuityCheckOwner
      ) {
        const continuityToken = claimContinuityOwnership();
        if (!continuityToken) return;
        const continuityHandle = startActivityLoader(settings, 'Checking continuity...');
        checkContinuity(characterName)
          .then(async (contradictions) => {
            if (chatChanged()) return;
            setContinuityBadge(contradictions.length);
            // Populate the result panel so the user can read the contradictions
            // when they open the settings panel - same display as the manual check.
            const $result = $('#sm_continuity_result');
            $result.empty().removeClass('sm_continuity_clean sm_continuity_warn');
            if (contradictions.length === 0) {
              $result.addClass('sm_continuity_clean').text('No contradictions found.').show();
            } else {
              $result.addClass('sm_continuity_warn');
              $result.append('<b>Contradictions found:</b>');
              const $ul = $('<ul>');
              contradictions.forEach((c) => $ul.append($('<li>').text(c)));
              $result.append($ul).show();
              if (getSettings().continuity_auto_repair) {
                try {
                  const note = await generateRepair(contradictions, characterName, chatChanged);
                  if (chatChanged() || !note) return;
                  injectRepair(note);
                  const $repairBlock = $('<div class="sm_repair_queued">');
                  $repairBlock.append($('<p>').text('Correction queued for next response:'));
                  $repairBlock.append($('<p class="sm_repair_note">').text(note));
                  const $cancel = $(
                    '<button class="menu_button sm_repair_cancel">Cancel correction</button>',
                  );
                  $cancel.on('click', () => {
                    clearRepair();
                    $repairBlock.remove();
                  });
                  $repairBlock.append($cancel);
                  $result.append($repairBlock);
                  toastr.info(
                    `${contradictions.length} contradiction${contradictions.length === 1 ? '' : 's'} found - correction queued for next response.`,
                    'Storyhold',
                  );
                } catch (repairErr) {
                  console.error('[SmartMemory] Auto-repair failed:', repairErr);
                  $result.append(
                    $('<p class="sm_repair_queued">').text(
                      'Correction could not be generated - check console.',
                    ),
                  );
                }
              }
            }
          })
          .catch((err) => {
            console.error('[SmartMemory] Auto-continuity check failed:', err);
          })
          .finally(() => {
            stopActivityLoader(continuityHandle);
            releaseContinuityOwnership(continuityToken);
          });
      }

      // Step 7: update lastActive so the away recap threshold stays accurate.
      if (chatChanged()) return;
      await updateLastActive(chatChanged);
    })()
      .catch(console.error)
      .finally(() => releaseAutomaticPipelineOwnership(automaticPipelineToken));
  }, 0);
}

// Debounce timer for onChatChanged. ST fires both CHAT_LOADED and CHAT_CHANGED
// on a fresh load, sometimes before context.groupId is set. Collapsing them
// into one deferred run ensures the context is stable before we act on it.
let chatChangedTimer = null;

// Incremented immediately when onChatChanged receives an event. Async callbacks (recap,
// extraction) capture this value and bail out if it has changed by the time they resolve - prevents
// a slow operation from a previous chat writing into a different chat's metadata.
let chatLoadId = 0;

// Sentinel thrown inside the extraction try/finally when a chat switch is detected
// mid-extraction. Caught separately from real errors so it is not logged as a failure.
const CHAT_SWITCHED = Symbol('chat-switched');

function onChatChanged({ preserveProductControl = false } = {}) {
  ++chatLoadId;
  abortCurrentMemoryGeneration();
  invalidateChatScopePin();
  if (!preserveProductControl) invalidateProductControl();
  setCurrentLineage(null);
  clearAllInjections();
  $(document).trigger('smart_memory:lineage_changed');
  if (!preserveProductControl) $(document).trigger('smart_memory:rebuild_cancelled');
  clearProductViews();
  $('#sm_cancel_catch_up').hide().prop('disabled', false);
  $('#sm_catch_up, #sm_rescan_chat').show();
  clearTimeout(chatChangedTimer);
  chatChangedTimer = setTimeout(
    () =>
      onChatChangedImpl().catch((error) => {
        $(document).trigger('smart_memory:rebuild_failed', [error]);
        console.error('[Storyhold] Chat transition failed:', error);
      }),
    100,
  );
}

/**
 * Fires when a chat is loaded or switched (debounced via onChatChanged).
 * Resets all module-level state, restores stored injections, and generates
 * an away recap if the user has been gone longer than the configured threshold.
 */
async function onChatChangedImpl() {
  const transitionGeneration = chatLoadId;
  const transitionChatId = getCurrentChatId();
  const transitionMetadata = getContext().chatMetadata;
  const transitionStale = () =>
    chatLoadId !== transitionGeneration ||
    getCurrentChatId() !== transitionChatId ||
    getContext().chatMetadata !== transitionMetadata ||
    extension_settings[MODULE_NAME]?.enabled === false;
  const transitionBlocked = () => transitionStale() || isFreshStart();

  // Fail closed during the asynchronous chat transition. The new chat is
  // classified below, before any stored tier is restored or extracted.
  setCurrentLineage(null);
  $(document).trigger('smart_memory:lineage_changed');

  // Reset per-load flags so warnings and trim indicators start fresh for the new chat.
  resetEpistemicWarnFlag();
  clearTierTrimStats();
  resetTrimToastFlag();

  // Dismiss any recap overlay from the previous chat immediately - it is modal
  // and blocks input, so leaving it up over the new chat is confusing.
  $('#sm_recap_overlay').remove();

  messagesSinceLastExtraction = 0;
  messagesSinceLastProfileRegen = 0;
  // Ownership is settlement-safe: the transition does NOT invalidate
  // compaction, extraction, or continuity ownership. Old asynchronous jobs
  // observe chatLoadId via their own chatChanged()/abort predicates, settle,
  // and release their own tokens in finally blocks. Forcibly clearing
  // ownership here would let a new chat's operation claim the guard while the
  // old model request is still in flight, overlapping two generations.
  releaseExtractionOwnership(null);
  recapSuppressed = false;
  catchUpCancelled = true;
  stopActivityLoader(activeRecapHandle);
  activeRecapHandle = null;
  sceneMessageBuffer = [];
  sceneBufferLastIndex = -1;
  respondedThisRound = new Set();
  selectedGroupCharacter = null;
  setContinuityBadge(null);
  setStatusMessage('');
  // Initialise to the current chat length so the first CHARACTER_MESSAGE_RENDERED
  // after a chat load is not mistaken for a new message when the user swipes
  // immediately without generating anything first. A swipe does not grow the
  // chat array, so currentLength <= lastKnownChatLength correctly identifies it.
  lastKnownChatLength = getContext().chat?.length ?? 0;
  clearEmbeddingCache();
  clearUnifiedSlot();
  clearProductViews();

  // Migrate chat data first - no character name needed, operates on chatMetadata.
  // Fast no-op when the container is already at the current schema version.
  if (transitionStale()) return;
  await ensureChatMigrated();
  if (transitionStale()) return;

  // Remove group arc stores for groups that no longer exist. Runs once per
  // chat load; cheap enough that it does not need further throttling.
  const settings = getSettings();
  if (!settings.enabled) {
    $(document).trigger('smart_memory:rebuild_cancelled');
    return;
  }
  if (!settings.single_extension_mode) pruneOrphanedGroupArcs();

  await ensureStableChatIdentity();
  if (transitionStale()) return;
  const activeMeta = getContext().chatMetadata?.[META_KEY] ?? {};
  const lineage = classifyIndependentChatTree({
    chatId: getCurrentChatId(),
    chatUid: activeMeta.chat_uid ?? null,
    legacyChatIds: activeMeta.chat_aliases ?? [],
    chat: getContext().chat,
  });

  if (transitionStale()) return;
  setCurrentLineage(lineage);
  $(document).trigger('smart_memory:lineage_changed');
  catchUpCancelled = false;

  if (lineage.quarantined) {
    clearAllInjections();
    setStatusMessage('Storyhold needs a stable identity for this chat.');
    if (typeof toastr !== 'undefined') {
      toastr.warning(
        'This chat has no stable Storyhold identity yet. Reopen the chat, then run Scan & Memorize This Chat.',
        'Storyhold',
        { timeOut: 8000, positionClass: 'toast-bottom-right' },
      );
    }
    markChatLoadComplete();
    return;
  }

  // Detect an in-file branch (regenerate/swipe that truncated the timeline)
  // and prune memories sourced from the discarded timeline before any injections
  // or extractions run on the new timeline. Fast no-op when no truncation.
  const branchCharacterNames = getContext().groupId
    ? getCurrentGroupCharacterNames(getContext())
    : [getCurrentCharacterName()].filter(Boolean);
  const lineageChatId = getCurrentChatId();
  const lineageMetadata = getContext().chatMetadata;
  const lineageChatUid = lineageMetadata?.[META_KEY]?.chat_uid ?? null;
  await detectAndPruneInFileBranch(branchCharacterNames, {
    shouldAbort: () => transitionStale() || productControl.isHeld(),
    isControlBusy: () => productControl.isHeld(),
    expectedChatId: lineageChatId,
    expectedChatUid: lineageChatUid,
    expectedMetadata: lineageMetadata,
  });
  if (transitionStale()) return;
  await refreshCurrentTimeline(transitionStale);
  if (transitionStale()) return;
  if (transitionBlocked()) {
    clearAllInjections();
    clearProductViews();
    return;
  }

  if (settings.single_extension_mode) {
    clearAllInjections();
    if (getContext().groupId) updateGroupCharSelector();
    const productResponder = getContext().groupId
      ? selectedGroupCharacter
      : getCurrentCharacterName();
    maybeInjectUnified({ respondingCharacter: productResponder });
    refreshProductViews(null, productResponder);
    markChatLoadComplete();
    await updateLastActive();
    return;
  }

  // Group chats: clear stale slots first (they may hold content from the
  // previous session's last responder), then inject fresh. onGroupMemberDrafted
  // will overwrite the character-specific slots before each Generate().
  if (getContext().groupId) {
    clearAllInjections();
    const summary = loadAndInjectSummary();
    updateShortTermUI(summary);
    injectSceneHistory();
    injectArcs();
    updateScenesUI();
    updateArcsUI();

    // Show the group character selector and pre-populate panels and token
    // display for whichever member is selected (first member by default).
    updateGroupCharSelector();
    // All mutable memory is resolved from the current chat namespace.
    await injectMemories(selectedGroupCharacter, false, transitionStale);
    if (transitionStale()) return;
    injectRelationshipHistory(selectedGroupCharacter);
    loadAndInjectEpistemicKnowledge(selectedGroupCharacter, selectedGroupCharacter);
    loadAndInjectStateLedger();
    await injectSessionMemories(false, transitionStale);
    if (transitionStale()) return;
    injectCanon(selectedGroupCharacter);
    injectProfiles(selectedGroupCharacter);
    loadAndInjectRepair();
    updateLongTermUI(selectedGroupCharacter);
    updateRelationshipHistoryUI(selectedGroupCharacter);
    updateEpistemicUI(selectedGroupCharacter);
    updateSessionUI();
    updateFreshStartUI(isFreshStart());
    updateCanonUI(selectedGroupCharacter);
    updateProfilesUI(loadProfiles(selectedGroupCharacter));
    updateEntityPanel(selectedGroupCharacter);

    maybeInjectUnified();
    updateTokenDisplay();
    autoTuneBudgets(selectedGroupCharacter);
    // Mark load complete so the trim toast can fire on the next injection cycle,
    // not immediately on load before the user has done anything.
    markChatLoadComplete();

    const groupChatMeta = getContext().chatMetadata;
    if (settings.recap_enabled) {
      const hoursAway = getAwayHours();
      if (hoursAway > 0) {
        if (recapRunningForChat === groupChatMeta) {
          // Same chat fired again before the recap finished - already handled.
        } else {
          recapRunningForChat = groupChatMeta;
          setStatusMessage('Generating recap...');
          activeRecapHandle = startActivityLoader(settings, 'Generating recap...');
          const groupRecapHandle = activeRecapHandle;
          generateRecap(transitionStale)
            .then((recap) => {
              stopActivityLoader(groupRecapHandle);
              activeRecapHandle = null;
              const stillThisChat = !transitionStale() && getContext().chatMetadata === groupChatMeta;
              if (recapRunningForChat === groupChatMeta) recapRunningForChat = null;
              const suppressed = recapSuppressed;
              recapSuppressed = false;
              if (!stillThisChat) return;
              setStatusMessage('');
              if (suppressed) return;
              if (recap) displayRecap(recap, hoursAway);
            })
            .catch((err) => {
              stopActivityLoader(groupRecapHandle);
              activeRecapHandle = null;
              if (recapRunningForChat === groupChatMeta) recapRunningForChat = null;
              recapSuppressed = false;
              console.error('[SmartMemory] Auto-recap failed:', err);
              if (!transitionStale()) setStatusMessage('');
            });
        }
      }
    }

    if (!transitionStale()) await updateLastActive(transitionStale);
    return;
  }

  const characterName = getCurrentCharacterName();

  // Seed the active character's canonical name into this chat's entity registry
  // if not already present, so the main character appears in the entity panel and
  // benefits from entity overlap scoring from the first message.
  if (characterName) {
    const ltReg = loadCharacterEntityRegistry(characterName);
    const before = ltReg.length;
    seedCharacterEntity(characterName, ltReg);
    if (ltReg.length > before) {
      saveCharacterEntityRegistry(characterName, ltReg);
      saveSettingsDebounced();
    }
  }

  const freshStart = isFreshStart();

  // Restore all injected context from the previous session.
  const summary = loadAndInjectSummary();
  injectCanon(characterName);
  updateShortTermUI(summary);

  await injectMemories(characterName, false, transitionStale);
  if (transitionStale()) return;
  injectRelationshipHistory(characterName);
  loadAndInjectEpistemicKnowledge(characterName, characterName);
  loadAndInjectStateLedger();

  await injectSessionMemories(false, transitionStale);
  if (transitionStale()) return;
  injectSceneHistory();
  injectArcs();
  injectProfiles(characterName);
  loadAndInjectRepair();

  updateLongTermUI(characterName);
  updateRelationshipHistoryUI(characterName);
  updateEpistemicUI(characterName);
  updateFreshStartUI(freshStart);
  updateSessionUI();
  updateScenesUI();
  updateArcsUI();
  updateCanonUI(characterName);
  updateProfilesUI(loadProfiles(characterName));
  maybeInjectUnified();
  updateTokenDisplay();
  autoTuneBudgets(characterName);
  updateEmbeddingNotice();

  // Show a recap popup if the user has been away long enough.
  const soloChatMeta = getContext().chatMetadata;
  if (settings.recap_enabled) {
    const hoursAway = getAwayHours();
    if (hoursAway > 0) {
      if (recapRunningForChat === soloChatMeta) {
        // Same chat fired again before the recap finished - already handled.
      } else {
        recapRunningForChat = soloChatMeta;
        setStatusMessage('Generating recap...');
        activeRecapHandle = startActivityLoader(settings, 'Generating recap...');
        const soloRecapHandle = activeRecapHandle;
        generateRecap(transitionStale)
          .then((recap) => {
            stopActivityLoader(soloRecapHandle);
            activeRecapHandle = null;
            const stillThisChat = !transitionStale() && getContext().chatMetadata === soloChatMeta;
            if (recapRunningForChat === soloChatMeta) recapRunningForChat = null;
            const suppressed = recapSuppressed;
            recapSuppressed = false;
            if (!stillThisChat) return;
            setStatusMessage('');
            if (suppressed) return;
            if (recap) {
              // Pass hoursAway explicitly - updateLastActive() runs after this
              // async block starts, so getAwayHours() inside displayRecap would
              // return 0 and always show "short break" regardless of actual gap.
              displayRecap(recap, hoursAway);
            }
          })
          .catch((err) => {
            stopActivityLoader(soloRecapHandle);
            activeRecapHandle = null;
            if (recapRunningForChat === soloChatMeta) recapRunningForChat = null;
            recapSuppressed = false;
            console.error('[SmartMemory] Auto-recap failed:', err);
            if (!transitionStale()) setStatusMessage('');
          });
      }
    }
  }

  if (!transitionStale()) await updateLastActive(transitionStale);
}

// ---- Group chat helpers -------------------------------------------------

/**
 * Populates the group character selector dropdown with the current group's
 * members, shows the selector row, and sets selectedGroupCharacter to
 * whichever member is currently selected (or the first member if none is).
 * Should be called from onChatChanged when context.groupId is set.
 */
function updateGroupCharSelector() {
  const context = getContext();
  const group = context.groups?.find((g) => g.id === context.groupId);
  if (!group) {
    smLog('[SmartMemory] updateGroupCharSelector: group not found for groupId', context.groupId);
    return;
  }

  const members = (group.members ?? [])
    .map((avatarId) => context.characters.find((c) => c.avatar === avatarId)?.name)
    .filter(Boolean);

  if (members.length === 0) {
    smLog('[SmartMemory] updateGroupCharSelector: no resolvable members in group', group.id);
    return;
  }

  const $select = $('#sm_group_char_select');
  $select.empty();
  for (const name of members) {
    $select.append($('<option>', { value: name, text: name }));
  }

  // Preserve the current selection if the character is still in the group;
  // otherwise default to the first member.
  if (selectedGroupCharacter && members.includes(selectedGroupCharacter)) {
    $select.val(selectedGroupCharacter);
  } else {
    selectedGroupCharacter = members[0];
    $select.val(selectedGroupCharacter);
  }
}

function getCurrentGroupCharacterNames(context = getContext()) {
  if (!context?.groupId) return [];
  const group = context.groups?.find((entry) => entry.id === context.groupId);
  if (!group) return [];
  return group.members
    .filter((avatar) => !(group.disabled_members ?? []).includes(avatar))
    .map((avatar) => context.characters?.find((character) => character.avatar === avatar)?.name)
    .filter(Boolean);
}

// ---- Group chat handlers ------------------------------------------------

/**
 * Fires at the start of each group chat round (GROUP_WRAPPER_STARTED).
 * Clears the per-round participation set so the new round starts clean.
 *
 * @param {{ type?: string }} [event] - ST event payload; type='quiet' for background generates.
 */
function onGroupWrapperStarted({ type } = {}) {
  // Quiet generates (e.g. the Expressions extension classifying emotion after each round)
  // are not real user turns. Clearing the set here would erase the responders from the
  // preceding real round before onGroupWrapperFinished can loop over them.
  if (type === 'quiet') return;
  respondedThisRound = new Set();
  repairInjectedThisRound = false;
}

/**
 * Fires before each group member generates their response (GROUP_MEMBER_DRAFTED).
 * Swaps all injection slots to the character about to respond so Generate()
 * sees the correct context rather than the previous character's memories.
 *
 * @param {number} chId - ST character array index of the character being drafted.
 */
async function onGroupMemberDrafted(chId) {
  const settings = getSettings();
  if (!settings.enabled) return;
  if (isCurrentLineageQuarantined() || isFreshStart()) return;

  const context = getContext();
  if (!context.chat) return;

  const characterName = context.characters[chId]?.name;
  if (!characterName) return;
  const draftGeneration = chatLoadId;
  const draftChatId = getCurrentChatId();
  const draftMetadata = context.chatMetadata;
  const draftChatUid = draftMetadata?.[META_KEY]?.chat_uid ?? null;
  const draftGroupId = context.groupId ?? null;
  const draftStillCurrent = () =>
    chatLoadId === draftGeneration &&
    getCurrentChatId() === draftChatId &&
    getContext().chatMetadata === draftMetadata &&
    getContext().chatMetadata?.[META_KEY]?.chat_uid === draftChatUid &&
    getContext().groupId === draftGroupId &&
    getSettings().enabled !== false &&
    !isFreshStart() &&
    !isCurrentLineageQuarantined();

  if (settings.single_extension_mode) {
    const capturedGeneration = chatLoadId;
    const capturedChatId = getCurrentChatId();
    const capturedMetadata = context.chatMetadata;
    const capturedChatUid = capturedMetadata?.[META_KEY]?.chat_uid ?? null;
    const capturedSelectedResponder = selectedGroupCharacter;
    if (productOperationGate.isRunning()) {
      clearAllInjections();
      return;
    }
    await detectAndPruneInFileBranch(characterName, {
      shouldAbort: () =>
        chatLoadId !== capturedGeneration ||
        getCurrentChatId() !== capturedChatId ||
        getContext().chatMetadata !== capturedMetadata ||
        getContext().chatMetadata?.[META_KEY]?.chat_uid !== capturedChatUid ||
        selectedGroupCharacter !== capturedSelectedResponder ||
        productControl.isHeld(),
      isControlBusy: () => productControl.isHeld(),
      expectedChatId: capturedChatId,
      expectedChatUid: capturedChatUid,
      expectedMetadata: capturedMetadata,
    });
    if (
      chatLoadId !== capturedGeneration ||
      isFreshStart() ||
      settings.enabled === false ||
      productControl.isHeld() ||
      selectedGroupCharacter !== capturedSelectedResponder
    ) return;
    // E3 populates the single broker envelope for this responder.
    clearAllInjections();
    maybeInjectUnified({ respondingCharacter: characterName });
    return;
  }

  // Seed the character entity in this chat so it benefits from overlap scoring
  // from the first message.
  const ltReg = loadCharacterEntityRegistry(characterName);
  const before = ltReg.length;
  seedCharacterEntity(characterName, ltReg);
  if (ltReg.length > before) {
    saveCharacterEntityRegistry(characterName, ltReg);
    saveSettingsDebounced();
  }

  // Restore all injected context for this character.
  const summary = loadAndInjectSummary();
  injectCanon(characterName);
  updateShortTermUI(summary);

  await injectMemories(characterName, false, draftStillCurrent);
  if (!draftStillCurrent()) return;
  injectRelationshipHistory(characterName);
  injectEpistemicKnowledge(characterName, characterName);
  await injectSessionMemories(false, draftStillCurrent);
  if (!draftStillCurrent()) return;
  injectSceneHistory();
  injectArcs();
  injectProfiles(characterName);
  // Repair is one-shot - only the first character in a round gets it.
  // Subsequent characters call clearRepair() so the slot doesn't carry over.
  if (!repairInjectedThisRound) {
    loadAndInjectRepair();
    repairInjectedThisRound = true;
  } else {
    clearRepair();
  }

  // The token display is NOT updated here. Injecting this character's slots
  // is correct for the model, but updating the display here would overwrite
  // the selected character's token bars with the generating character's data.
  // onGroupWrapperFinished restores the selected character's slots and
  // updates the display once the entire round is done.
}

/**
 * Fires after all characters in a group round have responded
 * (GROUP_WRAPPER_FINISHED). Runs compaction, scene break detection, and
 * batched extraction once per round rather than once per character response.
 * Profile B continuity also fires once here instead of per-character.
 *
 * @param {{ type?: string }} [event] - ST event payload; type='quiet' for background generates.
 */
async function onGroupWrapperFinished({ type } = {}) {
  // Quiet generates (e.g. the Expressions extension) are not real user turns.
  // Skipping them keeps the extraction counter and respondedThisRound in sync with
  // actual story progress rather than firing on every post-round expression classify.
  if (type === 'quiet') return;
  // Swipes and continues are not committed user turns. GROUP_WRAPPER_FINISHED
  // fires with type='swipe' or type='continue' for these, so without this guard
  // every swipe or /continue increments the extraction counter. The content will
  // be captured correctly once the user sends a real message and extraction fires.
  if (type === 'swipe' || type === 'continue') return;
  if (generationInProgress) return;
  const settings = getSettings();
  if (!settings.enabled) return;
  if (isCurrentLineageQuarantined()) return;
  const context = getContext();
  if (!context.chat || context.chat.length === 0) return;

  if (settings.single_extension_mode) {
    const capturedProductGen = chatLoadId;
    const capturedProductChatId = getCurrentChatId();
    const capturedProductChatUid = context.chatMetadata?.[META_KEY]?.chat_uid ?? null;
    const capturedProductCharacter = selectedGroupCharacter || getCurrentCharacterName();
    const capturedProductMetadata = context.chatMetadata;
    const capturedProductOperationKey =
      `group:${capturedProductGen}:${capturedProductChatId}:${capturedProductChatUid}:${context.chat.length}`;
    if (!productIngestAllowed(settings)) {
      updateLastActive().catch(console.error);
      return;
    }
    const productChatChanged = () =>
      chatLoadId !== capturedProductGen ||
      getCurrentChatId() !== capturedProductChatId ||
      context.chatMetadata !== capturedProductMetadata ||
      context.chatMetadata?.[META_KEY]?.chat_uid !== capturedProductChatUid;
    const groupProductDeferralToken = claimExtractionOwnership();
    setTimeout(() => {
      releaseExtractionOwnership(groupProductDeferralToken);
      runExclusiveProductOperation(
        () =>
          runSingleExtensionIngest(
            capturedProductCharacter,
            productChatChanged,
            () => {},
            () => false,
            {
              chatId: capturedProductChatId,
              chatUid: capturedProductChatUid,
              generation: capturedProductGen,
              metadata: capturedProductMetadata,
              responder: capturedProductCharacter,
            },
          ),
        capturedProductOperationKey,
      ).catch((err) => console.error('[SmartMemory] Product group ingest error:', err));
    }, 0);
    updateLastActive().catch(console.error);
    return;
  }

  // Capture the current chat generation so we can abort before any write if
  // the user switches chats while a model call is in progress.
  const capturedGen = chatLoadId;
  const capturedChatId = getCurrentChatId();
  const capturedMetadata = context.chatMetadata;
  const capturedChatUid = capturedMetadata?.[META_KEY]?.chat_uid ?? null;
  const capturedGroupId = context.groupId ?? null;
  const capturedMode = settings.single_extension_mode === true;
  const chatChanged = () =>
    chatLoadId !== capturedGen ||
    getCurrentChatId() !== capturedChatId ||
    getContext().chatMetadata !== capturedMetadata ||
    getContext().chatMetadata?.[META_KEY]?.chat_uid !== capturedChatUid ||
    getContext().groupId !== capturedGroupId ||
    getSettings().single_extension_mode !== capturedMode ||
    getSettings().enabled === false ||
    isFreshStart() ||
    isCurrentLineageQuarantined();
  // for the next round and can fire while this function is mid-await if the user
  // sends a new message quickly. Everything below uses the snapshot.
  const roundResponders = new Set(respondedThisRound);

  // Build scene check text from the end of the completed round.
  const lastMsg = context.chat
    .slice()
    .reverse()
    .find((m) => !m.is_user && !m.is_system && m.mes);
  const lastMsgText = lastMsg?.mes ?? '';
  const lastUserMsg = context.chat
    .slice()
    .reverse()
    .find((m) => m.is_user && !m.is_system && m.mes);
  const lastUserMsgText = lastUserMsg?.mes ?? '';
  const aiMessages = context.chat.filter((m) => !m.is_user && !m.is_system && m.mes);
  const prevAiMsgText = aiMessages.length >= 2 ? aiMessages[aiMessages.length - 2].mes : '';

  // Defer the async pipeline - same reason as the solo handler.
  setTimeout(() => {
    if (compactionOwner || extractionOwner || continuityCheckOwner) return;
    const automaticPipelineToken = claimAutomaticPipelineOwnership();
    if (!automaticPipelineToken) return;
    (async () => {
      // Guard: bail if the user switched chats during the deferral window.
      if (chatChanged()) return;
      await refreshCurrentTimeline(chatChanged);
      if (chatChanged()) return;

      // Step 1: compaction - once per round rather than per character response.
      // Gated by !isFreshStart() and !extractionRunning matching the solo path.
      if (
        settings.compaction_enabled &&
        !compactionOwner &&
        !extractionRunning &&
        !isFreshStart()
      ) {
        const compactionToken = claimCompactionOwnership();
        try {
          const needed = await shouldCompact();
          if (chatChanged()) throw CHAT_SWITCHED;
          if (needed) {
            setStatusMessage('Updating story summary...');
            const source = extension_settings[MODULE_NAME]?.source ?? memory_sources.main;
            const compactionHandle =
              source !== memory_sources.main
                ? startActivityLoader(settings, 'Updating story summary...')
                : null;
            const summary = await runCompaction({ abortCheck: chatChanged });
            stopActivityLoader(compactionHandle);
            if (chatChanged()) throw CHAT_SWITCHED;
            if (summary) {
              injectSummary(summary);
              updateShortTermUI(summary);
              maybeInjectUnified();
              updateTokenDisplay();
              setStatusMessage('Summary updated.');
            } else {
              setStatusMessage('');
            }
          }
        } catch (err) {
          console.error('[SmartMemory] Compaction error:', err);
        } finally {
          releaseCompactionOwnership(compactionToken);
        }
      }
      if (chatChanged()) return;

      // Step 2: scene break detection - once for the round using accumulated buffer.
      // Gated by !isFreshStart() and !extractionRunning matching the solo path.
      const sceneCheckText = [lastUserMsgText, lastMsgText].filter(Boolean).join('\n');
      if (settings.scene_enabled && sceneCheckText && !isFreshStart() && !extractionRunning) {
        try {
          const wasBreak = await processSceneBreak(
            sceneCheckText,
            sceneMessageBuffer,
            prevAiMsgText,
            chatChanged,
          );
          if (chatChanged()) throw CHAT_SWITCHED;
          if (wasBreak) {
            injectSceneHistory();
            updateScenesUI();
            maybeInjectUnified();
            updateTokenDisplay();
            if (isEpistemicEnabled()) {
              // Store under the selected character; fall back to first responder this round.
              const epistemicChar = selectedGroupCharacter || [...roundResponders][0] || null;
              if (epistemicChar) {
                await extractEpistemicKnowledge(sceneMessageBuffer, epistemicChar, '', chatChanged);
                if (chatChanged()) throw CHAT_SWITCHED;
                injectEpistemicKnowledge(epistemicChar, epistemicChar, true, true);
              }
            }
            sceneMessageBuffer = [];
            sceneBufferLastIndex = -1;
            setStatusMessage('Scene break detected.');
          }
        } catch (err) {
          console.error('[SmartMemory] Scene detection error:', err);
        }
      }
      if (chatChanged()) return;

      // Step 3: batched extraction - counter increments once per round, not per
      // character response, so extractEvery=3 means every 3 user turns as intended.
      if (!extractionRunning) {
        messagesSinceLastExtraction++;
        messagesSinceLastProfileRegen++;

        const extractEvery = Math.min(
          settings.session_extract_every ?? 3,
          settings.longterm_extract_every ?? 3,
        );

        smLog(
          `[SmartMemory] Group counter: ${messagesSinceLastExtraction}/${extractEvery} (extractionRunning=${extractionRunning})`,
        );

        if (messagesSinceLastExtraction >= extractEvery) {
          const groupLegacyExtractionToken = claimExtractionOwnership();
          smLog(`[SmartMemory] Group extraction starting at ${new Date().toISOString()}`);

          const lastExtractCutoff = context.chatMetadata?.[META_KEY]?.lastExtractCutoff ?? null;
          const sessionWindow = getSmartExtractionWindow(
            context.chat,
            lastExtractCutoff,
            extractEvery,
            40,
          );
          // Scale the raw window by character count so that after per-character
          // filtering each character still gets roughly 20 messages of context.
          const longtermRawSize = 20 * Math.max(1, roundResponders.size);
          const longtermWindow = getSmartExtractionWindow(
            context.chat,
            lastExtractCutoff,
            extractEvery,
            longtermRawSize,
          );

          // Injection refresh period check - same logic as solo path.
          const injRefreshPeriodGroup = settings.injection_refresh_period ?? 1;
          const injLastRefreshGroup = Math.min(
            context.chatMetadata?.[META_KEY]?.lastInjectionRefresh ?? 0,
            Math.max(0, context.chat.length - 1),
          );
          const shouldRefreshInjectionsGroup =
            injRefreshPeriodGroup <= 1 ||
            context.chat.length - 1 - injLastRefreshGroup >= injRefreshPeriodGroup;

          // Snapshot before any awaits - same reason as solo path.
          const snapshotLastGroup = context.chat[context.chat.length - 1];
          const snapshotCutoffGroup =
            context.chat.length > 0 &&
            snapshotLastGroup &&
            !snapshotLastGroup.is_user &&
            !snapshotLastGroup.is_system
              ? context.chat.length - 1
              : context.chat.length;

          if (longtermWindow.length === 0 && sessionWindow.length === 0) {
            releaseExtractionOwnership(groupLegacyExtractionToken);
          } else {
            messagesSinceLastExtraction = 0;
            setStatusMessage('Extracting memories...');

            const originalBudgets = {
              longterm_inject_budget: settings.longterm_inject_budget,
              session_inject_budget: settings.session_inject_budget,
              scene_inject_budget: settings.scene_inject_budget,
              arcs_inject_budget: settings.arcs_inject_budget,
              profiles_inject_budget: settings.profiles_inject_budget,
            };
            const activityHandle = startActivityLoader(settings, 'Extracting memories...');

            try {
              let total = 0;

              const lastAiMessage = context.chat?.at(-1)?.mes ?? '';
              const turnType = classifyTurn(lastAiMessage);
              const budgets = adaptiveBudgets(settings, turnType);
              settings.longterm_inject_budget = budgets.longterm;
              settings.session_inject_budget = budgets.session;
              settings.scene_inject_budget = budgets.scenes;
              settings.arcs_inject_budget = budgets.arcs;
              settings.profiles_inject_budget = budgets.profiles;

              if (chatChanged()) throw CHAT_SWITCHED;
              // Session extraction is chat-wide - all characters share one session store.
              if (settings.session_enabled && sessionWindow.length > 0 && !isFreshStart()) {
                const priorSessionIds = new Set(
                  loadSessionMemories()
                    .map((m) => m.id)
                    .filter(Boolean),
                );

                const count = await extractSessionMemories(sessionWindow, chatChanged).catch(
                  (err) => {
                    console.error('[SmartMemory] Session extraction error:', err);
                    return 0;
                  },
                );
                if (chatChanged()) throw CHAT_SWITCHED;
                if (!consolidationRunning) {
                  consolidationRunning = true;
                  await consolidateSessionMemories(false, chatChanged).catch((err) => {
                    console.error('[SmartMemory] Session consolidation error:', err);
                  });
                  consolidationRunning = false;
                  if (chatChanged()) throw CHAT_SWITCHED;
                }
                if (shouldRefreshInjectionsGroup) {
                  await injectSessionMemories(true, chatChanged);
                  if (chatChanged()) throw CHAT_SWITCHED;
                }
                if (chatChanged()) throw CHAT_SWITCHED;
                updateSessionUI();
                total += count;

                if (settings.scene_enabled && count > 0) {
                  const newIds = loadSessionMemories()
                    .map((m) => m.id)
                    .filter((id) => id && !priorSessionIds.has(id));
                  if (newIds.length > 0) {
                    await linkMemoriesToLastScene(newIds, chatChanged).catch((err) =>
                      console.error('[SmartMemory] Scene memory linking failed:', err),
                    );
                    if (chatChanged()) throw CHAT_SWITCHED;
                  }
                }
              }

              if (chatChanged()) throw CHAT_SWITCHED;
              // Long-term extraction and profiles run per character since each
              // character has their own store. Sequential per CLAUDE.md constraint.
              for (const characterName of roundResponders) {
                // Filter to this character's messages plus user messages so the
                // model only sees context directly relevant to the character being
                // extracted. User messages are included because they address all
                // characters and provide shared narrative context.
                const characterLongtermWindow = longtermWindow.filter(
                  (m) => m.is_user || m.name === characterName,
                );

                if (
                  settings.longterm_enabled &&
                  characterLongtermWindow.length > 0 &&
                  !isFreshStart()
                ) {
                  const count = await extractAndStoreMemories(
                    characterName,
                    characterLongtermWindow,
                    setStatusMessage,
                    chatChanged,
                  ).catch((err) => {
                    console.error('[SmartMemory] Long-term extraction error:', err);
                    return 0;
                  });
                  if (chatChanged()) throw CHAT_SWITCHED;
                  if (count > 0 && settings.consolidation_enabled && !consolidationRunning) {
                    consolidationRunning = true;
                    const removed = await consolidateMemories(characterName, false, chatChanged).catch((err) => {
                      console.error('[SmartMemory] Consolidation error:', err);
                      return 0;
                    });
                    consolidationRunning = false;
                    if (chatChanged()) throw CHAT_SWITCHED;
                    if (removed > 0) {
                      setStatusMessage(
                        `Consolidated ${removed} redundant memories for ${characterName}.`,
                      );
                      toastr.info(
                        `Merged ${removed} redundant ${removed === 1 ? 'memory' : 'memories'}.`,
                        'Storyhold',
                        { timeOut: 3000 },
                      );
                    }
                  }
                  total += count;
                }

                if (settings.profiles_enabled && characterName && !isFreshStart()) {
                  await generateProfiles(characterName, chatChanged)
                    .then((profiles) => {
                      if (profiles && !chatChanged()) {
                        // Only update the UI panel if this is the character currently
                        // shown in the selector - other characters' profiles are stored
                        // but the display follows the selector.
                        if (characterName === selectedGroupCharacter) updateProfilesUI(profiles);
                      }
                    })
                    .catch((err) => console.error('[SmartMemory] Profile generation error:', err));
                  if (chatChanged()) throw CHAT_SWITCHED;
                  messagesSinceLastProfileRegen = 0;
                }
              }

              if (chatChanged()) throw CHAT_SWITCHED;
              // Arc extraction is chat-wide - once per round after all characters.
              // Snapshot summary count first so the canon check below can detect a
              // new resolution without re-running extraction.
              const arcSummaryCountBefore = settings.arcs_enabled ? loadArcSummaries().length : 0;

              if (settings.arcs_enabled && !isFreshStart()) {
                const arcWindow = getStableExtractionWindow(context.chat, 100);
                const count = await extractArcs(arcWindow, null, chatChanged).catch((err) => {
                  console.error('[SmartMemory] Arc extraction error:', err);
                  return 0;
                });
                if (chatChanged()) throw CHAT_SWITCHED;
                injectArcs();
                updateArcsUI();
                total += count;

                // Sync resolved flags into the group persistent store. The solo path
                // handles this inside extractArcs via characterName, but group arc
                // extraction is chat-wide with no single characterName. Any arc now
                // marked resolved in chatMetadata should also be marked resolved in
                // the group store so the state carries into future chats.
                const groupId = context.groupId;
                if (groupId) {
                  const currentArcs = loadArcs();
                  const resolvedContents = new Set(
                    currentArcs.filter((a) => a.resolved).map((a) => a.content),
                  );
                  if (resolvedContents.size > 0) {
                    if (chatChanged()) throw CHAT_SWITCHED;
                    const groupPersistent = loadGroupPersistentArcs(groupId);
                    let changed = false;
                    for (const p of groupPersistent) {
                      if (resolvedContents.has(p.content) && !p.resolved) {
                        p.resolved = true;
                        changed = true;
                      }
                    }
                    if (changed) {
                      if (chatChanged()) throw CHAT_SWITCHED;
                      saveGroupPersistentArcs(groupId, groupPersistent);
                    }
                  }
                }
              }

              if (chatChanged()) throw CHAT_SWITCHED;
              if (!isFreshStart()) {
                await runStateCardExtraction(null, longtermWindow, chatChanged).catch((err) => {
                  console.error('[SmartMemory] State ledger extraction error:', err);
                });
                if (chatChanged()) throw CHAT_SWITCHED;
                injectStateLedger(true);
              }

              // Profile B only: auto-regenerate canon per responding character when
              // a new arc resolved this pass. Runs after arc extraction so it can
              // react to arcs closed in this round.
              if (
                settings.canon_enabled &&
                settings.arcs_enabled &&
                !isFreshStart() &&
                getHardwareProfile() === 'b' &&
                loadArcSummaries().length > arcSummaryCountBefore
              ) {
                for (const characterName of roundResponders) {
                  await generateCanon(characterName, chatChanged)
                    .then(() => {
                      if (!chatChanged()) injectCanon(characterName);
                    })
                    .catch((err) => console.error('[SmartMemory] Auto-canon error:', err));
                  if (chatChanged()) throw CHAT_SWITCHED;
                }
              }

              // Refresh entity panel with the last character who responded.
              if (chatChanged()) throw CHAT_SWITCHED;
              const lastResponder = [...roundResponders].at(-1);
              if (lastResponder) updateEntityPanel(lastResponder);

              // Refresh the settings panel for whichever character the selector
              // is showing so new memories appear without the user having to
              // manually switch selection.
              updateLongTermUI(selectedGroupCharacter);
              updateRelationshipHistoryUI(selectedGroupCharacter);
              updateSessionUI();

              if (chatChanged()) throw CHAT_SWITCHED;
              setStatusMessage(total > 0 ? `${total} item${total === 1 ? '' : 's'} stored.` : '');
              autoTuneBudgets(selectedGroupCharacter);

              const metaAfterGroup = context.chatMetadata?.[META_KEY];
              if (metaAfterGroup) {
                if (chatChanged()) throw CHAT_SWITCHED;
                metaAfterGroup.lastExtractCutoff = snapshotCutoffGroup;
                if (shouldRefreshInjectionsGroup)
                  metaAfterGroup.lastInjectionRefresh = snapshotCutoffGroup;
                updateLegacySourceProof(metaAfterGroup, context.chat, snapshotCutoffGroup);
                if (chatChanged()) throw CHAT_SWITCHED;
                context.saveMetadata();
              }
            } catch (err) {
              if (err === CHAT_SWITCHED) {
                smLog('[SmartMemory] Group extraction aborted: chat switched mid-extraction.');
              } else {
                console.error('[SmartMemory] Extraction error:', err);
              }
              if (!chatChanged()) setStatusMessage('');
            } finally {
              smLog(`[SmartMemory] Group extraction finished at ${new Date().toISOString()}`);
              stopActivityLoader(activityHandle);
              // Fail closed on a chat switch: a stale group extraction must not
              // restore its captured adaptive budgets into the new context.
              if (!chatChanged()) {
                Object.assign(settings, originalBudgets);
                saveSettingsDebounced();
              }
              releaseExtractionOwnership(groupLegacyExtractionToken);
            }
          }
        }
      }
      if (chatChanged()) return;

      // Step 4 (Profile B only): scheduled profile regen between extraction passes.
      // Run for each character who responded this round.
      // Note: step 3 resets messagesSinceLastProfileRegen to 0 whenever profiles
      // are regenerated during extraction, so this block only fires on rounds
      // where extraction did not run (i.e. between extraction-frequency intervals).
      if (
        settings.profiles_enabled &&
        (settings.profiles_regen_every ?? 0) > 0 &&
        getHardwareProfile() === 'b' &&
        !isFreshStart() &&
        messagesSinceLastProfileRegen >= settings.profiles_regen_every
      ) {
        messagesSinceLastProfileRegen = 0;
        for (const characterName of roundResponders) {
          const schedProfileHandle = startActivityLoader(settings, 'Updating profiles...');
          generateProfiles(characterName, chatChanged)
            .then((profiles) => {
              stopActivityLoader(schedProfileHandle);
              if (profiles && !chatChanged()) {
                injectProfiles(characterName);
                if (characterName === selectedGroupCharacter) updateProfilesUI(profiles);
              }
            })
            .catch((err) => {
              stopActivityLoader(schedProfileHandle);
              console.error('[SmartMemory] Scheduled profile regeneration error:', err);
            });
        }
      }
      if (chatChanged()) return;

      // Step 5: clear any pending continuity repair carried over from last round.
      clearRepair();

      // Step 6 (Profile B only): silent continuity check - once per round using
      // the last character who responded. Running per-character would multiply
      // model calls by character count for the same round of messages.
      const lastResponder = [...roundResponders].at(-1);
      if (
        getHardwareProfile() === 'b' &&
        settings.continuity_auto_check &&
        lastResponder &&
        !continuityCheckOwner
      ) {
        const continuityToken = claimContinuityOwnership();
        if (!continuityToken) return;
        const continuityHandle = startActivityLoader(settings, 'Checking continuity...');
        checkContinuity(lastResponder)
          .then(async (contradictions) => {
            if (chatChanged()) return;
            setContinuityBadge(contradictions.length);
            if (contradictions.length > 0 && getSettings().continuity_auto_repair) {
              const note = await generateRepair(contradictions, lastResponder, chatChanged);
              if (chatChanged() || !note) return;
              injectRepair(note);
            }
          })
          .catch((err) => {
            console.error('[SmartMemory] Auto-continuity check failed:', err);
          })
          .finally(() => {
            stopActivityLoader(continuityHandle);
            releaseContinuityOwnership(continuityToken);
          });
      }

      // Step 7: restore injection slots to the selected character. onGroupMemberDrafted
      // swaps slots to each generating character in turn; after the round ends the
      // last responder's data is still in the slots. Re-inject for the selector choice
      // so the token display reflects what the panel is showing, not who generated last.
      if (selectedGroupCharacter) {
        if (chatChanged()) return;
        await injectMemories(selectedGroupCharacter, false, chatChanged);
        if (chatChanged()) return;
        injectRelationshipHistory(selectedGroupCharacter);
        injectEpistemicKnowledge(selectedGroupCharacter, selectedGroupCharacter);
        injectCanon(selectedGroupCharacter);
        injectProfiles(selectedGroupCharacter);
        if (chatChanged()) return;
        maybeInjectUnified();
        updateTokenDisplay();
      }

      // Step 8: update lastActive.
      if (chatChanged()) return;
      await updateLastActive(chatChanged);
    })()
      .catch(console.error)
      .finally(() => releaseAutomaticPipelineOwnership(automaticPipelineToken));
  }, 0);
}

// ---- Group membership changes -------------------------------------------

/**
 * Fires when the group roster changes (GROUP_UPDATED) - a member was added
 * or removed while a chat is open. Rebuilds the group character selector so
 * the new member appears immediately, and refreshes the token display to
 * include or drop their memory footprint row.
 *
 * Injection context for a newly added member is handled automatically:
 * onGroupMemberDrafted fires before their first generation and sets up all
 * slots at that point, so no pre-injection is needed here.
 */
function onGroupUpdated() {
  const context = getContext();
  if (!context.groupId) return;
  updateGroupCharSelector();
  updateTokenDisplay();
}

// ---- Init ---------------------------------------------------------------

/**
 * Builds a similarity scorer over the given memory items using a single
 * embedding batch with Jaccard fallback for missing vectors.
 */
function buildMemoryScorer(vectorMap) {
  return (a, b) => {
    const va = vectorMap.get(String(a.content).toLowerCase().trim());
    const vb = vectorMap.get(String(b.content).toLowerCase().trim());
    if (va && vb) return { score: cosineSimilarity(va, vb), semantic: true };
    return {
      score: jaccardSimilarity(String(a.content), String(b.content)),
      semantic: false,
    };
  };
}

/** Active long-term memories eligible for duplicate comparison. */
function dedupEligibleMemories(characterName) {
  return loadCharacterMemories(characterName).filter(
    (m) => m && !m.superseded_by && m.content,
  );
}

function duplicateScanResult(memories, plan) {
  const review = createDuplicateReview(memories, plan);
  return {
    scanned: memories.length,
    clusters: plan.clusters.length,
    remove_count: plan.remove_ids.length,
    kept: plan.keep_ids.length,
    review,
  };
}

/** Scans stored long-term memories for near-duplicates without modifying anything. */
async function scanDuplicateMemories(characterName, abortCheck = null) {
  if (abortCheck?.()) return null;
  const memories = dedupEligibleMemories(characterName);
  if (memories.length < 2) {
    return duplicateScanResult(memories, planDuplicateRemoval(memories));
  }
  if (abortCheck?.()) return null;
  const texts = memories.map((m) => String(m.content).toLowerCase().trim());
  const vectorMap = await getEmbeddingBatch(texts);
  if (abortCheck?.()) return null;
  const plan = planDuplicateRemoval(memories, { scoreFor: buildMemoryScorer(vectorMap) });
  return duplicateScanResult(memories, plan);
}

/** Applies only the exact duplicate plan the user reviewed and confirmed. */
async function applyDuplicateRemoval(characterName, abortCheck = null, review = null) {
  if (abortCheck?.() || !review || !Array.isArray(review.remove_ids)) return null;
  const allMemories = loadCharacterMemories(characterName);
  const memories = dedupEligibleMemories(characterName);
  if (!duplicateReviewMatches(memories, review)) {
    return {
      stale: true,
      reason: 'review-stale',
      scanned: memories.length,
      clusters: review.clusters?.length ?? 0,
      remove_count: 0,
      kept: memories.length,
      removed: 0,
    };
  }
  const eligibleIds = new Set(memories.map((memory) => memory.id));
  const removeSet = new Set(review.remove_ids);
  if ([...removeSet].some((id) => !eligibleIds.has(id)) || abortCheck?.()) return null;
  const kept = allMemories.filter((memory) => !removeSet.has(memory.id));
  if (abortCheck?.()) return null;
  saveCharacterMemories(characterName, kept);
  saveSettingsDebounced();
  return {
    scanned: memories.length,
    clusters: review.clusters?.length ?? 0,
    remove_count: review.remove_ids.length,
    kept: memories.length - review.remove_ids.length,
    removed: review.remove_ids.length,
  };
}

async function scanProductDuplicateMemories(abortCheck = null) {
  const operation = captureProductMutation();
  if (!operation || abortCheck?.()) return null;
  const memories = productDuplicateEligibleRecords();
  if (memories.length < 2) return duplicateScanResult(memories, planDuplicateRemoval(memories));
  const texts = memories.map((memory) => String(memory.content).toLowerCase().trim());
  const vectorMap = await getEmbeddingBatch(texts);
  if (!operation.stillCurrent() || abortCheck?.()) return null;
  const plan = planDuplicateRemoval(memories, { scoreFor: buildMemoryScorer(vectorMap) });
  return duplicateScanResult(memories, plan);
}

function productDuplicateEligibleRecords() {
  const model = currentProductExplorerModel();
  return model?.activeRecords?.filter((record) => record?.content) ?? [];
}

async function applyProductDuplicateRemoval(review, abortCheck = null) {
  if (!review || !Array.isArray(review.remove_ids) || abortCheck?.()) return null;
  return runProductMutation((root, stillCurrent) => {
    const allRecords = Array.isArray(root.structured_records) ? root.structured_records : [];
    const memories = allRecords.filter(
      (record) => record?.scope?.chat_uid === root.chat_uid
        && !record?.superseded_by
        && record?.content,
    );
    if (!duplicateReviewMatches(memories, review)) {
      return {
        stale: true,
        reason: 'review-stale',
        scanned: memories.length,
        clusters: review.clusters?.length ?? 0,
        remove_count: 0,
        kept: memories.length,
        removed: 0,
      };
    }
    const eligibleIds = new Set(memories.map((memory) => memory.id));
    const removeSet = new Set(review.remove_ids);
    if ([...removeSet].some((id) => !eligibleIds.has(id)) || !stillCurrent() || abortCheck?.()) {
      return { stale: true, reason: 'review-invalidated', removed: 0 };
    }
    const removedRecords = memories.filter((record) => removeSet.has(record.id));
    return {
      records: allRecords.filter((record) => !removeSet.has(record.id)),
      suppressions: removedRecords.map((record) => ({
        key: buildProductSuppressionKey(record),
        chat_uid: root.chat_uid,
        kind: record.kind ?? null,
        source_range: record.source_range ?? null,
        content_hash: hash32(String(record.content ?? '').trim()),
        created_at: Date.now(),
      })),
      removed: removedRecords.length,
      kept: memories.length - removedRecords.length,
      remove_count: removedRecords.length,
      clusters: review.clusters?.length ?? 0,
      scanned: memories.length,
    };
  });
}
function publishMemoryReviewProgress(progress) {
  const state = setMemoryReviewStatus(memoryReviewProgress(progress));
  setStatusMessage(state.message);
  return state;
}

function yieldToMemoryReviewUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Human-readable reason the current chat's memory cannot back a challenge. */
function challengeBlockReason() {
  if (getSettings().enabled === false) return 'Storyhold is disabled';
  if (isFreshStart()) return 'read-only mode is active';
  return 'this chat has no stable Storyhold identity yet';
}

function challengeNextStep() {
  return 'Run Scan & Memorize This Chat to build this chat\'s memory, then challenge again.';
}

/**
 * Adjudicates a challenge claim against the matched records and their raw
 * source excerpts using the configured memory LLM. Returns a safe verdict
 * object; any model failure degrades to an unresolved verdict. Never writes.
 */
async function runChallengeAdjudication(claim, top) {
  const chat = getContext().chat ?? [];
  const evidence = top
    .map(({ mem }) => ({ id: mem?.id ?? mem?._id ?? null, content: String(mem?.content ?? '') }))
    .filter((record) => record.content);
  const allowedRecordIds = new Set(evidence.map((record) => record.id).filter(Boolean));
  const sources = [];
  for (const { mem } of top) {
    sources.push(...resolveRecordSources(mem, chat));
  }

  let raw = '';
  try {
    raw = await generateMemoryExtract(buildChallengePrompt({ claim, evidence, sources }), {
      responseLength: 700,
    });
  } catch (error) {
    console.warn('[Storyhold] Challenge adjudication failed:', error);
    raw = '';
  }

  if (!raw) {
    return {
      verdict: MEMORY_CHALLENGE_VERDICTS.UNRESOLVED,
      explanation: 'Adjudication did not produce a result; review the evidence below.',
      citations: [],
    };
  }

  return parseChallengeAdjudication(parseChallengeResponse(raw), { allowedRecordIds: allowedRecordIds });
}

/**
 * Runs a read-only memory query or challenge review.
 *
 * Both /sm-search and /sm-challenge share this path. It gathers the memories
 * eligible for the current chat and branch, scores them with embeddings (with
 * a Jaccard fallback), and displays the shared review panel. Challenge mode
 * adds an evidence banner. Nothing here writes memory, advances extraction
 * state, or presents similarity as a truth verdict.
 *
 * @param {'query'|'challenge'} mode - Review mode.
 * @param {object|null} args - Slash command args; k and min are honoured.
 * @param {string} queryText - The query or claim text.
 * @returns {Promise<string>} Summary string for the slash command.
 */
async function executeMemoryReview(mode, args, queryText, expectedIdentity = null) {
  const reviewMode = mode === MEMORY_REVIEW_MODES.CHALLENGE
    ? MEMORY_REVIEW_MODES.CHALLENGE
    : MEMORY_REVIEW_MODES.QUERY;
  const actionLabel = reviewMode === MEMORY_REVIEW_MODES.CHALLENGE ? 'challenge' : 'search';
  const q = String(queryText || '').trim();
  if (!q) {
    toastr.warning(`Usage: /sm-${reviewMode === MEMORY_REVIEW_MODES.CHALLENGE ? 'challenge' : 'search'} <${actionLabel} text>`, 'Storyhold', {
      timeOut: 3000,
      positionClass: 'toast-bottom-right',
    });
    return '';
  }

  const reviewGeneration = expectedIdentity?.generation ?? chatLoadId;
  const reviewChatId = expectedIdentity?.chatId ?? getCurrentChatId();
  const reviewMetadata = expectedIdentity?.metadata ?? getContext().chatMetadata;
  const reviewChatUid = expectedIdentity?.chatUid ?? reviewMetadata?.[META_KEY]?.chat_uid ?? null;
  const reviewProductMode = expectedIdentity?.productMode ?? getSettings().single_extension_mode === true;
  const reviewResponder = expectedIdentity?.responder ?? currentProductResponder();
  const reviewIdentityMatches = () =>
    chatLoadId === reviewGeneration &&
    getCurrentChatId() === reviewChatId &&
    getContext().chatMetadata === reviewMetadata &&
    getContext().chatMetadata?.[META_KEY]?.chat_uid === reviewChatUid &&
    getSettings().single_extension_mode === reviewProductMode &&
    currentProductResponder() === reviewResponder &&
    (!expectedIdentity?.token || memoryReviewOwner?.token === expectedIdentity.token);
  const reviewStillCurrent = () =>
    reviewIdentityMatches() &&
    getSettings().enabled !== false &&
    !isFreshStart() &&
    !isCurrentLineageQuarantined();

  if (expectedIdentity && !reviewIdentityMatches()) {
    return 'Memory review cancelled because the active chat changed.';
  }

  let allMems;
  if (getSettings().single_extension_mode) {
    const productSettings = getSettings();
    const context = getContext();
    const root = context.chatMetadata?.[META_KEY] ?? {};
    const lineage = getCurrentLineage();
    if (productSettings.enabled === false || isFreshStart() || isCurrentLineageQuarantined() || !root.chat_uid) {
      const reason = challengeBlockReason();
      if (reviewIdentityMatches()) {
        if (reviewMode === MEMORY_REVIEW_MODES.CHALLENGE) {
          showMemoryReview(buildMemoryReview({
            mode: reviewMode,
            query: q,
            results: [],
            totalRecords: 0,
            blocked: { reason, nextStep: challengeNextStep(reason) },
          }));
        }
        publishMemoryReviewProgress({ mode: reviewMode, phase: MEMORY_REVIEW_PHASES.CANCELLED, reason });
      }
      return 'Product memory is unavailable until this chat has a stable Storyhold identity.';
    }
    const responder = reviewResponder;
    const branchUid = root.chat_uid;
    const scoped = filterRetrievalRecords(root.structured_records, {
      chatUid: root.chat_uid,
      branchUid,
      respondingCharacter: responder,
      lineage,
      allowLegacy: false,
    });
    allMems = filterProductRecords(scoped, productSettings, responder).map((record) => ({
      ...record,
      _tier: 'product',
    }));
  } else {
    const characterName = getCurrentCharacterName();
    const ltMemories = characterName
      ? loadCharacterMemories(characterName).filter((m) => !m.superseded_by)
      : [];
    const sessionMems = loadSessionMemories().filter((m) => !m.superseded_by);
    allMems = [
      ...ltMemories.map((m) => ({ ...m, _tier: 'long-term' })),
      ...sessionMems.map((m) => ({ ...m, _tier: 'session' })),
    ];
  }

  if (!reviewStillCurrent()) return 'Memory review cancelled because the active chat changed.';
  publishMemoryReviewProgress({
    mode: reviewMode,
    phase: MEMORY_REVIEW_PHASES.IN_PROGRESS,
    totalRecords: allMems.length,
  });
  await yieldToMemoryReviewUi();
  if (!reviewStillCurrent()) return 'Memory review cancelled because the active chat changed.';

  if (allMems.length === 0) {
    const emptyReview = buildMemoryReview({
      mode: reviewMode,
      query: q,
      results: [],
      totalRecords: 0,
    });
    showMemoryReview(emptyReview);
    publishMemoryReviewProgress({
      mode: reviewMode,
      phase: MEMORY_REVIEW_PHASES.COMPLETED,
      resultCount: 0,
      challenge: emptyReview.challenge,
    });
    return `${actionLabel === 'challenge' ? 'Related evidence' : 'Results'}: 0 matches for "${q}".`;
  }

  const topK = Math.max(1, Math.min(50, Number(args?.k) || 10));
  const minScore = Math.max(0, Math.min(1, args?.min !== undefined ? Number(args.min) : 0.5));
  const qLower = q.toLowerCase();
  const memTexts = allMems.map((m) =>
    String(m.content || '')
      .toLowerCase()
      .trim(),
  );
  let vectorMap;
  try {
    vectorMap = await getEmbeddingBatch([qLower, ...memTexts], { queryTexts: [qLower] });
  } catch (error) {
    if (reviewStillCurrent()) {
      publishMemoryReviewProgress({ mode: reviewMode, phase: MEMORY_REVIEW_PHASES.FAILED });
      toastr.error('Memory review failed. No memory was changed.', 'Storyhold', {
        timeOut: 5000,
        positionClass: 'toast-bottom-right',
      });
    }
    console.warn('[Storyhold] Memory review failed:', error);
    return 'Memory review failed. No memory was changed.';
  }
  if (!reviewStillCurrent()) return 'Memory review cancelled because the active chat changed.';
  if (
    reviewProductMode &&
    (getSettings().enabled === false || isFreshStart() || isCurrentLineageQuarantined())
  ) {
    const reason = challengeBlockReason();
    if (reviewMode === MEMORY_REVIEW_MODES.CHALLENGE) {
      showMemoryReview(buildMemoryReview({
        mode: reviewMode,
        query: q,
        results: [],
        totalRecords: 0,
        blocked: { reason, nextStep: challengeNextStep(reason) },
      }));
    }
    publishMemoryReviewProgress({ mode: reviewMode, phase: MEMORY_REVIEW_PHASES.CANCELLED, reason });
    return 'Memory review cancelled because Product Memory is unavailable for this chat.';
  }
  const queryVec = vectorMap.get(qLower) ?? null;

  const scored = allMems
    .map((mem, i) => {
      const memText = memTexts[i];
      const memVec = vectorMap.get(memText) ?? null;
      const score =
        queryVec && memVec
          ? cosineSimilarity(queryVec, memVec)
          : jaccardSimilarity(qLower, memText);
      return { mem, score };
    })
    .filter(({ score }) => score >= minScore);

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);

  let adjudication = null;
  if (reviewMode === MEMORY_REVIEW_MODES.CHALLENGE && top.length > 0) {
    adjudication = await runChallengeAdjudication(q, top);
    if (!reviewStillCurrent()) return 'Memory review cancelled because the active chat changed.';
  }

  const review = buildMemoryReview({
    mode: reviewMode,
    query: q,
    results: top,
    totalRecords: allMems.length,
    adjudication,
  });
  showMemoryReview(review);
  const verdictLabel = adjudication
    ? { supported: 'Supported', contradicted: 'Contradicted', unresolved: 'Unresolved' }[adjudication.verdict] ?? 'Unresolved'
    : review.challenge?.label;
  publishMemoryReviewProgress({
    mode: reviewMode,
    phase: MEMORY_REVIEW_PHASES.COMPLETED,
    resultCount: top.length,
    challenge: verdictLabel ? { label: verdictLabel } : null,
  });
  return `${actionLabel === 'challenge' ? 'Related evidence' : 'Results'}: ${top.length} match${top.length === 1 ? '' : 'es'} for "${q}".`;
}

/**
 * Starts one review request with visible acknowledgement and request ownership.
 * A zero-delay yield lets the acknowledgement render before the progress state.
 */
async function runMemoryReview(mode, args, queryText) {
  const reviewMode = mode === MEMORY_REVIEW_MODES.CHALLENGE
    ? MEMORY_REVIEW_MODES.CHALLENGE
    : MEMORY_REVIEW_MODES.QUERY;
  const q = String(queryText || '').trim();
  if (!q) return executeMemoryReview(reviewMode, args, queryText);

  const currentContext = {
    generation: chatLoadId,
    chatId: getCurrentChatId(),
    metadata: getContext().chatMetadata,
    chatUid: getContext().chatMetadata?.[META_KEY]?.chat_uid ?? null,
    productMode: getSettings().single_extension_mode === true,
    responder: currentProductResponder(),
  };
  const existing = memoryReviewOwner;
  if (
    existing &&
    existing.generation === currentContext.generation &&
    existing.chatId === currentContext.chatId &&
    existing.metadata === currentContext.metadata &&
    existing.chatUid === currentContext.chatUid &&
    existing.productMode === currentContext.productMode &&
    existing.responder === currentContext.responder
  ) {
    return 'Memory review already in progress. Please wait for the current result.';
  }

  const owner = { ...currentContext, token: Symbol('memory-review-owner') };
  memoryReviewOwner = owner;
  publishMemoryReviewProgress({
    mode: reviewMode,
    phase: MEMORY_REVIEW_PHASES.ACKNOWLEDGED,
  });
  await yieldToMemoryReviewUi();

  try {
    return await executeMemoryReview(reviewMode, args, q, owner);
  } finally {
    if (memoryReviewOwner === owner) {
      memoryReviewOwner = null;
      // The executor may return early (cancelled by chat change, unavailable
      // product memory, or a failed identity match) before publishing a
      // terminal state. Never leave the console stuck busy: publish a terminal
      // state so the controls restore.
      const status = document.getElementById('sm_review_status');
      const phase = status?.dataset?.phase ?? null;
      if (phase === 'acknowledged' || phase === 'in-progress') {
        setMemoryReviewStatus(
          memoryReviewProgress({ mode: reviewMode, phase: MEMORY_REVIEW_PHASES.CANCELLED }),
        );
      }
    }
  }
}

jQuery(async function () {
  loadSettings();
  registerSmartMemoryMacros();

  const html = await renderExtensionTemplateAsync('third-party/Storyhold', 'settings', {
    defaultSettings,
  });
  $('#extensions_settings').append(html);

  bindSettingsUI({
    get lineageState() {
      return getCurrentLineage();
    },
    get lineageQuarantined() {
      return isCurrentLineageQuarantined();
    },
    get extractionRunning() {
      return extractionRunning;
    },
    get productOperationRunning() {
      return productOperationGate.isRunning();
    },
    get productOperationRunningForCurrentChat() {
      return productOperationGate.isRunning(chatLoadId);
    },
    get chatGeneration() {
      return chatLoadId;
    },
    get productControlRunning() {
      return productControl.isHeld();
    },
    reserveProductControl,
    releaseProductControl,
    invalidateProductControl,
    claimCompactionOwnership,
    releaseCompactionOwnership,
    claimExtractionOwnership,
    releaseExtractionOwnership,
    get compactionRunning() {
      return compactionRunning;
    },
    get consolidationRunning() {
      return consolidationRunning;
    },
    set consolidationRunning(v) {
      consolidationRunning = v;
    },
    get catchUpCancelled() {
      return catchUpCancelled;
    },
    set catchUpCancelled(v) {
      catchUpCancelled = v;
    },
    get sceneMessageBuffer() {
      return sceneMessageBuffer;
    },
    set sceneMessageBuffer(v) {
      sceneMessageBuffer = v;
    },
    get sceneBufferLastIndex() {
      return sceneBufferLastIndex;
    },
    set sceneBufferLastIndex(v) {
      sceneBufferLastIndex = v;
    },
    get selectedGroupCharacter() {
      return selectedGroupCharacter;
    },
    set selectedGroupCharacter(v) {
      selectedGroupCharacter = v;
    },
    clearAllInjections,
    clearProductViews,
    onChatChanged,
    auditRenameNamespaces: auditCurrentChatNamespaces,
    relinkRenameNamespace: relinkCurrentNamespace,
    archiveRenameNamespace: archiveCurrentNamespace,
    listCharacterChatMemory: listCurrentCharacterChatMemory,
    nukeCharacterChatMemory: nukeCurrentCharacterChatMemory,
    nukeAllCharacterChatMemory: nukeAllCurrentCharacterChatMemory,
    emptyCharacterRollbackArchive: emptyCurrentCharacterRollbackArchive,
    unlinkManualMemory: unlinkCurrentManualMemory,
    scanDuplicateMemories,
    applyDuplicateRemoval,
    scanProductDuplicateMemories,
    applyProductDuplicateRemoval,
    runMemoryReview,
    getSelectedCharacterName,
    getStableExtractionWindowWithFallback,
    runProductCatchUp: runSingleExtensionCatchUp,
    getProductExplorerModel: currentProductExplorerModel,
    createProductRecord: createCurrentProductRecord,
    editProductRecord: editCurrentProductRecord,
    retireProductRecord: retireCurrentProductRecord,
    restoreProductRecord: restoreCurrentProductRecord,
    deleteProductRecord: deleteCurrentProductRecord,
    setTimelineOverride: setCurrentTimelineOverride,
    clearTimelineOverride: clearCurrentTimelineOverride,
    refreshProductTimeline: refreshCurrentProductTimeline,
  });
  initTooltips();
  initTypePickers();
  updateTokenDisplay();

  // makeLast ensures Storyhold processes the message after all other
  // extensions have had their turn with it.
  eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
  eventSource.on(event_types.CHAT_LOADED, onChatChanged);
  // Dismiss the recap overlay when a message is sent or when generation starts.
  // MESSAGE_SENT handles the case where the overlay is already visible when the
  // message arrives. GENERATION_STARTED covers the race condition where the
  // message arrives while the recap model call is still running (overlay not yet
  // created), then the overlay appears after MESSAGE_SENT fired. Restricted to
  // 'normal' type only - 'quiet' is Storyhold's own background extraction,
  // and other types (e.g. expression classification) are extension background
  // calls that should not dismiss the overlay.
  eventSource.on(event_types.MESSAGE_SENT, () => {
    $('#sm_recap_overlay').remove();
    // If a recap is still generating when the message is sent, suppress the
    // popup - showing it after the response arrives would be confusing.
    if (recapRunningForChat !== null) recapSuppressed = true;
  });
  eventSource.on(event_types.GENERATION_STARTED, (type) => {
    // Only track normal generations - quiet generations are background calls
    // from other extensions (e.g. auto-summary) and do not produce the
    // CHARACTER_MESSAGE_RENDERED events this flag is designed to suppress.
    // Setting the flag for quiet types causes extraction to be silently
    // skipped when another extension fires a quiet generation between
    // MESSAGE_RECEIVED and CHARACTER_MESSAGE_RENDERED.
    if (type === 'normal') {
      generationInProgress = true;
      $('#sm_recap_overlay').remove();
    }
  });
  eventSource.on(event_types.MESSAGE_RECEIVED, () => {
    generationInProgress = false;
  });
  // Allow external extensions to dismiss the recap overlay programmatically
  // (e.g. Discord Connector can dispatch this when the user sends a command
  // remotely and the blocking modal is preventing it from responding).
  $(document).on('smart_memory:dismiss_recap', () => {
    $('#sm_recap_overlay').remove();
  });
  // Profile B: auto-regenerate canon when the user manually resolves an arc
  // and a summary was successfully generated for it.
  $(document).on('smart_memory:arc_resolved_with_summary', async (e, characterName, groupId) => {
    const settings = getSettings();
    const charName = groupId ? selectedGroupCharacter : characterName;
    if (
      settings.single_extension_mode ||
      settings.enabled === false ||
      settings.canon_enabled !== true ||
      settings.arcs_enabled !== true ||
      !charName ||
      isFreshStart() ||
      getHardwareProfile() !== 'b'
    ) return;

    const operation = captureLegacyOperation(charName);
    if (!operation) return;
    await generateCanon(charName, operation.stillCurrent)
      .then(() => {
        if (operation.stillCurrent()) injectCanon(charName);
      })
      .catch((err) => console.error('[SmartMemory] Auto-canon after manual resolve error:', err));
  });
  eventSource.on(event_types.GROUP_WRAPPER_STARTED, onGroupWrapperStarted);
  eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onGroupMemberDrafted);
  eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onGroupWrapperFinished);
  eventSource.on(event_types.GROUP_UPDATED, onGroupUpdated);

  // Warn when the user creates a checkpoint or branch without read-only mode
  // active. Long-term memories will continue forming in the current chat and
  // will not roll back if they later switch to the checkpoint/branch.
  $(document).on('click', '.mes_create_bookmark, .mes_create_branch', () => {
    if (!isFreshStart()) {
      toastr.warning(
        'Storyhold is still active. Enable read-only mode first to keep this session consequence-free.',
        'Storyhold',
        { timeOut: 7000, positionClass: 'toast-bottom-right' },
      );
    }
  });

  // Re-inject the legacy compatibility tiers for the current chat after a
  // swipe/delete branch event in compatibility (non-Product) mode. Mirrors the
  // compatibility chat-load sequence but is bound to a caller-supplied
  // currentness predicate that covers generation, chat identity, enabled
  // state, Fresh Start, and lineage quarantine, rechecked before and after
  // every await so stale or cross-chat work fails closed.
  async function reinjectCompatibilityTiers({ stillCurrent, respondingCharacter }) {
    const characterName = respondingCharacter || getCurrentCharacterName();
    if (!stillCurrent() || !characterName) return;
    const summary = loadAndInjectSummary();
    updateShortTermUI(summary);
    injectCanon(characterName);
    if (!stillCurrent()) return;
    await injectMemories(characterName, false, () => !stillCurrent());
    if (!stillCurrent()) return;
    injectRelationshipHistory(characterName);
    loadAndInjectEpistemicKnowledge(characterName, characterName);
    loadAndInjectStateLedger();
    await injectSessionMemories(false, () => !stillCurrent());
    if (!stillCurrent()) return;
    injectSceneHistory();
    injectArcs();
    injectProfiles(characterName);
    loadAndInjectRepair();
    updateLongTermUI(characterName);
    updateRelationshipHistoryUI(characterName);
    updateEpistemicUI(characterName);
    updateSessionUI();
    updateScenesUI();
    updateArcsUI();
    updateCanonUI(characterName);
    updateProfilesUI(loadProfiles(characterName));
    maybeInjectUnified();
    updateTokenDisplay();
  }

  // When the user swipes, immediately abort any in-flight Ollama or
  // OpenAI-compat memory generation. Without this, the swipe generation request
  // queues behind the memory model on the same Ollama instance and ST aborts it
  // before the memory model finishes, reverting the swipe counter. The aborted
  // memory operation returns an empty response and is skipped cleanly - it will
  // retry on the next accepted message.
  eventSource.on(event_types.MESSAGE_SWIPED, () => {
    ++chatLoadId;
    invalidateProductControl();
    clearAllInjections();
    clearProductViews();
    setCurrentLineage(null);
    $(document).trigger('smart_memory:rebuild_cancelled');
    $(document).trigger('smart_memory:lineage_changed');
    $('#sm_cancel_catch_up').hide().prop('disabled', false);
    $('#sm_catch_up, #sm_rescan_chat').show();
    abortCurrentMemoryGeneration();
    const branchGeneration = chatLoadId;
    const branchChatId = getCurrentChatId();
    const branchMetadata = getContext().chatMetadata;
    const branchChatUid = branchMetadata?.[META_KEY]?.chat_uid ?? null;
    const branchCharacterNames = getContext().groupId
      ? getCurrentGroupCharacterNames(getContext())
      : [getCurrentCharacterName()].filter(Boolean);
    detectAndPruneInFileBranch(branchCharacterNames, {
      shouldAbort: () =>
        chatLoadId !== branchGeneration ||
        getCurrentChatId() !== branchChatId ||
        getContext().chatMetadata !== branchMetadata ||
        getContext().chatMetadata?.[META_KEY]?.chat_uid !== branchChatUid,
      isControlBusy: () => productControl.isHeld(),
      expectedChatId: branchChatId,
      expectedChatUid: branchChatUid,
      expectedMetadata: branchMetadata,
      allowUnclassifiedPrune: true,
    })
      .then(async () => {
        if (
          chatLoadId !== branchGeneration ||
          getSettings().enabled === false ||
          getCurrentLineage() !== null
        ) return;
        const activeMeta = getContext().chatMetadata?.[META_KEY] ?? {};
        const reclassified = classifyIndependentChatTree({
          chatId: getCurrentChatId(),
          chatUid: activeMeta.chat_uid ?? null,
          legacyChatIds: activeMeta.chat_aliases ?? [],
          chat: getContext().chat,
        });
        setCurrentLineage(reclassified);
        $(document).trigger('smart_memory:lineage_changed');
        if (reclassified.quarantined || chatLoadId !== branchGeneration || isFreshStart()) return;
        const responder = selectedGroupCharacter || getCurrentCharacterName();
        if (getSettings().single_extension_mode) {
          maybeInjectUnified({ respondingCharacter: responder });
          refreshProductViews(null, responder);
        } else {
          await reinjectCompatibilityTiers({
            stillCurrent: () =>
              chatLoadId === branchGeneration &&
              getCurrentChatId() === branchChatId &&
              getContext().chatMetadata === branchMetadata &&
              getContext().chatMetadata?.[META_KEY]?.chat_uid === branchChatUid &&
              getSettings().enabled !== false &&
              !isFreshStart() &&
              !isCurrentLineageQuarantined(),
            respondingCharacter: responder,
          });
        }
      })
      .catch((error) => console.error('[Storyhold] Swipe branch pruning failed:', error));
  });

  // When a message is deleted, trim the scene buffer to only messages that
  // still exist in the chat. Without this, a deleted message would remain in
  // the buffer and be included in the next scene summary.
  eventSource.on(event_types.MESSAGE_DELETED, () => {
    ++chatLoadId;
    invalidateProductControl();
    clearAllInjections();
    clearProductViews();
    setCurrentLineage(null);
    $(document).trigger('smart_memory:rebuild_cancelled');
    $(document).trigger('smart_memory:lineage_changed');
    const context = getContext();
    lastKnownChatLength = context.chat?.length ?? 0;
    const chatSet = new Set(context.chat);
    sceneMessageBuffer = sceneMessageBuffer.filter((m) => chatSet.has(m));
    sceneBufferLastIndex = Math.min(sceneBufferLastIndex, context.chat.length - 1);
    const branchGeneration = chatLoadId;
    const branchChatId = getCurrentChatId();
    const branchMetadata = getContext().chatMetadata;
    const branchChatUid = branchMetadata?.[META_KEY]?.chat_uid ?? null;
    const branchCharacterNames = getContext().groupId
      ? getCurrentGroupCharacterNames(getContext())
      : [getCurrentCharacterName()].filter(Boolean);
    detectAndPruneInFileBranch(branchCharacterNames, {
      shouldAbort: () =>
        chatLoadId !== branchGeneration ||
        getCurrentChatId() !== branchChatId ||
        getContext().chatMetadata !== branchMetadata ||
        getContext().chatMetadata?.[META_KEY]?.chat_uid !== branchChatUid,
      isControlBusy: () => productControl.isHeld(),
      expectedChatId: branchChatId,
      expectedChatUid: branchChatUid,
      expectedMetadata: branchMetadata,
      allowUnclassifiedPrune: true,
    })
      .then(async () => {
        if (
          chatLoadId !== branchGeneration ||
          getSettings().enabled === false ||
          getCurrentLineage() !== null
        ) return;
        const activeMeta = getContext().chatMetadata?.[META_KEY] ?? {};
        const reclassified = classifyIndependentChatTree({
          chatId: getCurrentChatId(),
          chatUid: activeMeta.chat_uid ?? null,
          legacyChatIds: activeMeta.chat_aliases ?? [],
          chat: getContext().chat,
        });
        setCurrentLineage(reclassified);
        $(document).trigger('smart_memory:lineage_changed');
        if (reclassified.quarantined || chatLoadId !== branchGeneration || isFreshStart()) return;
        const responder = selectedGroupCharacter || getCurrentCharacterName();
        if (getSettings().single_extension_mode) {
          maybeInjectUnified({ respondingCharacter: responder });
          refreshProductViews(null, responder);
        } else {
          await reinjectCompatibilityTiers({
            stillCurrent: () =>
              chatLoadId === branchGeneration &&
              getCurrentChatId() === branchChatId &&
              getContext().chatMetadata === branchMetadata &&
              getContext().chatMetadata?.[META_KEY]?.chat_uid === branchChatUid &&
              getSettings().enabled !== false &&
              !isFreshStart() &&
              !isCurrentLineageQuarantined(),
            respondingCharacter: responder,
          });
        }
      })
      .catch((error) => console.error('[Storyhold] Deleted-message branch pruning failed:', error));
  });

  onChatChanged();

  // ---- Slash commands -----------------------------------------------------

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-check',
      callback: async () => {
        if (getSettings().single_extension_mode) {
          if (getSettings().enabled === false) return 'Storyhold is disabled.';
          if (isCurrentLineageQuarantined()) return 'Product memory is unavailable until this chat has a stable Storyhold identity.';
          return 'Product Memory continuity checks use the canonical product pipeline.';
        }
        if (isCurrentLineageQuarantined()) return 'Memory is unavailable until this chat has a stable Storyhold identity.';
        const characterName = getCurrentCharacterName();
        if (!characterName) return 'No character active.';
        const contradictions = await checkContinuity(characterName);
        if (contradictions.length === 0) {
          toastr.info('No contradictions found.', 'Storyhold', {
            timeOut: 4000,
            positionClass: 'toast-bottom-right',
          });
          return 'No contradictions found.';
        }
        const message = contradictions.map((c, i) => `${i + 1}. ${c}`).join('\n');
        toastr.warning(
          `${contradictions.length} contradiction${contradictions.length === 1 ? '' : 's'} found. Check the Storyhold panel for details.`,
          'Storyhold',
          { timeOut: 8000, positionClass: 'toast-bottom-right' },
        );
        return message;
      },
      helpString:
        'Checks the last AI response for contradictions against established facts and memories.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-summarize',
      callback: async () => {
        if (getSettings().single_extension_mode) {
          if (getSettings().enabled === false) return 'Storyhold is disabled.';
          if (productOperationGate.isRunning(chatLoadId)) return 'Product memory operation already running.';
          const outcome = await runSingleExtensionCatchUp();
          if (outcome.skipped) return 'Product memory is read-only or has no stable chat identity yet.';
          return `Product catch-up processed ${outcome.windows} window${outcome.windows === 1 ? '' : 's'}.`;
        }
        const operation = captureLegacyOperation();
        if (!operation) return 'Summary unavailable while Storyhold is disabled, read-only, or has no stable chat identity yet.';
        if (compactionOwner) return 'Compaction already running.';
        const compactionToken = claimCompactionOwnership();
        setStatusMessage('Extracting short-term memories...');
        try {
          const summary = await runCompaction({ abortCheck: operation.stillCurrent });
          if (!operation.stillCurrent()) return 'Summary cancelled because the active chat changed.';
          if (summary) {
            injectSummary(summary);
            updateShortTermUI(summary);
            setStatusMessage('Summary updated.');
            toastr.success('Short-term summary updated.', 'Storyhold', {
              timeOut: 4000,
              positionClass: 'toast-bottom-right',
            });
            return summary;
          }
          toastr.info('Nothing to summarize yet.', 'Storyhold', {
            timeOut: 4000,
            positionClass: 'toast-bottom-right',
          });
          return 'Nothing to summarize yet.';
        } finally {
          releaseCompactionOwnership(compactionToken);
        }
      },
      helpString: 'Forces Storyhold to generate or update the short-term context summary now.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-extract',
      callback: async () => {
        if (getSettings().single_extension_mode) {
          if (getSettings().enabled === false) return 'Storyhold is disabled.';
          if (productOperationGate.isRunning(chatLoadId)) return 'Product memory operation already running.';
          const outcome = await runSingleExtensionCatchUp();
          if (outcome.skipped) return 'Product memory is read-only or has no stable chat identity yet.';
          return `Product extraction processed ${outcome.windows} window${outcome.windows === 1 ? '' : 's'}.`;
        }
        const operation = captureLegacyOperation();
        if (!operation) return 'Extraction unavailable while Storyhold is disabled, read-only, or has no stable chat identity yet.';
        if (extractionRunning) return 'Extraction already running.';
        const characterName = operation.characterName;
        if (!characterName) return 'No character active.';
        const manualExtractionToken = claimExtractionOwnership();
        setStatusMessage(`Extracting memories for ${characterName}...`);
        try {
          const context = getContext();
          const recentLongTerm = getStableExtractionWindowWithFallback(context.chat, 20);
          const recentSession = getStableExtractionWindowWithFallback(context.chat, 40);
          const recentArcs = getStableExtractionWindowWithFallback(context.chat, 100);
          if (!isFreshStart()) {
            await extractAndStoreMemories(
              characterName,
              recentLongTerm,
              setStatusMessage,
              operation.stillCurrent,
            );
            if (!operation.stillCurrent()) return 'Extraction cancelled because the active chat changed.';
            await extractArcs(recentArcs, characterName, operation.stillCurrent);
            if (!operation.stillCurrent()) return 'Extraction cancelled because the active chat changed.';
            await extractSessionMemories(recentSession, operation.stillCurrent);
            if (!operation.stillCurrent()) return 'Extraction cancelled because the active chat changed.';
          }
          await injectMemories(characterName, false, operation.stillCurrent);
          if (!operation.stillCurrent()) return 'Extraction cancelled because the active chat changed.';
          injectRelationshipHistory(characterName);
          await injectSessionMemories(false, operation.stillCurrent);
          if (!operation.stillCurrent()) return 'Extraction cancelled because the active chat changed.';
          injectArcs();
          updateLongTermUI(characterName);
          updateRelationshipHistoryUI(characterName);
          updateSessionUI();
          updateArcsUI();
          if (!operation.stillCurrent()) return 'Extraction cancelled because the active chat changed.';
          saveSettingsDebounced();
          setStatusMessage('Extraction complete.');
          toastr.success('Memory extraction complete.', 'Storyhold', {
            timeOut: 4000,
            positionClass: 'toast-bottom-right',
          });
          return 'Memory extraction complete.';
        } finally {
          releaseExtractionOwnership(manualExtractionToken);
        }
      },
      helpString:
        'Forces Storyhold to extract long-term memories, session details, and story arcs from the current chat now.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-recap',
      callback: async () => {
        const recapGeneration = chatLoadId;
        const recapChatId = getCurrentChatId();
        const recapMetadata = getContext().chatMetadata;
        const recapChatUid = recapMetadata?.[META_KEY]?.chat_uid ?? null;
        const recapProductMode = getSettings().single_extension_mode === true;
        const recapStillCurrent = () =>
          chatLoadId === recapGeneration &&
          getCurrentChatId() === recapChatId &&
          getContext().chatMetadata === recapMetadata &&
          getContext().chatMetadata?.[META_KEY]?.chat_uid === recapChatUid &&
          getSettings().single_extension_mode === recapProductMode;
        if (
          getSettings().enabled === false ||
          isFreshStart() ||
          isCurrentLineageQuarantined()
        ) {
          return 'Recap unavailable while Storyhold is disabled, read-only, or has no stable chat identity yet.';
        }
        const recap = await generateRecap();
        if (!recapStillCurrent()) return 'Recap cancelled because the active chat changed.';
        if (
          getSettings().enabled === false ||
          isFreshStart() ||
          isCurrentLineageQuarantined()
        ) {
          return 'Recap cancelled because it is no longer available for this chat.';
        }
        if (!recap) {
          toastr.error('Recap generation failed.', 'Storyhold', {
            timeOut: 4000,
            positionClass: 'toast-bottom-right',
          });
          return 'Recap generation failed.';
        }
        displayRecap(recap);
        setStatusMessage('Recap displayed.');
        return recap;
      },
      helpString:
        'Generates a "Previously on..." recap of the current chat and displays it as a popup.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-search',
      callback: async (args, query) => runMemoryReview('query', args, query),
      namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
          name: 'k',
          description: 'number of results to return (default 10, max 50)',
          typeList: [ARGUMENT_TYPE.NUMBER],
          isRequired: false,
          defaultValue: '10',
        }),
        SlashCommandNamedArgument.fromProps({
          name: 'min',
          description: 'minimum similarity score to include a result (default 0.5, range 0-1)',
          typeList: [ARGUMENT_TYPE.NUMBER],
          isRequired: false,
          defaultValue: '0.5',
        }),
      ],
      unnamedArgumentList: [new SlashCommandArgument('search query', [ARGUMENT_TYPE.STRING], true)],
      helpString:
        'Searches active Storyhold memories for this chat by semantic similarity. Read-only: displays matching records with type, provenance, and score; nothing is modified. Optional: k sets result count (default 10, max 50); min sets the minimum similarity threshold to filter weak matches (default 0.5, range 0-1).',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  SlashCommandParser.addCommandObject(
    SlashCommand.fromProps({
      name: 'sm-challenge',
      callback: async (args, claim) => runMemoryReview('challenge', args, claim),
      namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
          name: 'k',
          description: 'number of results to return (default 10, max 50)',
          typeList: [ARGUMENT_TYPE.NUMBER],
          isRequired: false,
          defaultValue: '10',
        }),
        SlashCommandNamedArgument.fromProps({
          name: 'min',
          description: 'minimum similarity score to include a result (default 0.5, range 0-1)',
          typeList: [ARGUMENT_TYPE.NUMBER],
          isRequired: false,
          defaultValue: '0.5',
        }),
      ],
      unnamedArgumentList: [new SlashCommandArgument('claim to check', [ARGUMENT_TYPE.STRING], true)],
      helpString:
        'Challenges a player claim against Storyhold memories for this chat. Read-only: displays related records and an evidence banner. Similarity is never treated as a truth verdict and no memory is modified. Optional: k and min behave like /sm-search.',
      returns: ARGUMENT_TYPE.STRING,
    }),
  );

  smLog('[SmartMemory] Loaded.');
});
