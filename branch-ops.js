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
 * Branch operations: orchestrates detection and pruning of in-file branch
 * points (regenerates / swipes / edits that truncate the timeline).
 *
 * Pure detection and pruning math lives in branch-aware.js; this module wires
 * it to SillyTavern storage (long-term per-character stores via scope.js,
 * session memories and the state ledger in chatMetadata).
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { getCurrentChatId, saveSettingsDebounced } from '../../../../script.js';
import { META_KEY, MODULE_NAME } from './constants.js';
import { pruneIngestWindowsAtBranch } from './ingest-queue.js';
import { smLog } from './logging.js';
import { pruneNarrativeAtBranch } from './narrative-chain.js';
import { pruneStructuredRecordsAtBranch } from './structured-records.js';
import { detectProcessedWindowChanges, detectSummaryChanges, inheritedPrefixMatchesLiveChat } from './branch-detection.js';
import {
  getCurrentLineage,
  isCurrentLineageQuarantined,
  setCurrentLineage,
} from './lineage-runtime.js';
import { LINEAGE_STATUS } from './lineage.js';
import { fingerprintMessages } from './projections.js';
import {
  loadCharacterMemories,
  loadRelationshipHistory,
  saveCharacterMemories,
} from './longterm.js';
import { loadSessionMemories, saveSessionMemories } from './session.js';
import { loadStateLedger, saveStateLedger } from './state-ledger.js';
import { loadSceneHistory, saveSceneHistory } from './scenes.js';
import { loadArcs, loadArcSummaries, saveArcs, saveArcSummaries } from './arcs.js';
import { clearCanon, loadCanon } from './canon.js';
import { clearEpistemicKnowledge, loadEpistemicKnowledge } from './epistemic.js';
import { clearProfiles, loadProfiles } from './profiles.js';
import { clearRelationshipHistory } from './longterm.js';
import { clearAllMacroContent } from './macros.js';
import { clearIndividualPromptSlots, clearUnifiedSlot } from './unified-inject.js';
import {
  chatHasRealMesIds,
  detectTruncation,
  firstIndexAfterMesId,
  pruneMemoriesByBranchPoint,
  pruneStateLedgerByBranchPoint,
  updateLegacySourceProof,
} from './branch-aware.js';

/**
 * Detects whether the current chat has been truncated at an in-file branch
 * point (regenerate, swipe, or edit that discarded the tail) and, when so,
 * prunes every stored tier that was sourced from the discarded timeline.
 *
 * Also rolls the extraction watermarks (mesId and legacy index cutoff) back
 * to the branch point so the next extraction pass picks up only the divergent
 * tail instead of replaying the whole chat.
 *
 * Safe to call on every chat load and at the start of each extraction pass -
 * it is a fast no-op when no truncation is detected.
 *
 * @param {string|string[]|null} characterName - Active character(s) for
 *        long-term pruning (scope-aware through saveCharacterMemories). An
 *        array is used for group chats so every responder's namespace is pruned.
 * @returns {Promise<number|null>} The branch point mesId, or null when no
 *          truncation was detected or the metadata is not ready.
 */
export async function detectAndPruneInFileBranch(
  characterName,
  {
    shouldAbort = () => false,
    isControlBusy = () => false,
    expectedChatId = undefined,
    expectedChatUid = undefined,
    expectedMetadata = undefined,
    allowUnclassifiedPrune = false,
  } = {},
) {
  const context = getContext();
  const initialMetadata = context.chatMetadata;
  const initialChat = context.chat;
  const initialChatFingerprint = fingerprintMessages(initialChat ?? []);
  const meta = context.chatMetadata?.[META_KEY];
  const characterNames = (Array.isArray(characterName) ? characterName : [characterName])
    .map((name) => (name == null ? null : String(name).trim()))
    .filter(Boolean)
    .filter((name, index, values) => values.indexOf(name) === index);
  const isBlocked = () =>
    shouldAbort() ||
    isControlBusy() ||
    context.chatMetadata !== initialMetadata ||
    context.chat !== initialChat ||
    fingerprintMessages(context.chat ?? []) !== initialChatFingerprint ||
    (expectedChatId !== undefined && getCurrentChatId() !== expectedChatId) ||
    (expectedChatUid !== undefined && context.chatMetadata?.[META_KEY]?.chat_uid !== expectedChatUid) ||
    (expectedMetadata !== undefined && context.chatMetadata !== expectedMetadata) ||
    !extension_settings[MODULE_NAME] ||
    extension_settings[MODULE_NAME].enabled === false ||
    (context.chatMetadata?.[META_KEY]?.freshStart === true && !allowUnclassifiedPrune) ||
    !allowUnclassifiedPrune && isCurrentLineageQuarantined();
  if (isBlocked() || !meta) return null;

  const chat = context.chat ?? [];
  const watermark =
    meta.product_cursor?.last_mes_id ??
    meta.lastExtractMesId ??
    (meta.narrative?.watermark?.source_range?.kind === 'mesId'
      ? meta.narrative.watermark.source_range.end
      : null);
  const mesDetection =
    watermark != null && chatHasRealMesIds(chat)
      ? detectTruncation(chat, watermark)
      : { truncated: false, branchPointMesId: null };
  const cursorIndex = meta.product_cursor?.last_index;
  const legacyCursor = meta.lastExtractSourceRange
    ? {
        source_range: meta.lastExtractSourceRange,
        fingerprint: meta.lastExtractFingerprint,
        last_index: meta.lastExtractEndIndex,
        end_index: meta.lastExtractEndIndex,
      }
    : null;
  const legacyCursorNeedsInitialization =
    !meta.product_cursor &&
    Number.isInteger(meta.lastExtractMesId) &&
    !meta.lastExtractSourceRange &&
    meta.lastExtractProofInitialized !== true;
  let processedDetection = detectProcessedWindowChanges(
    chat,
    meta.ingest_windows,
    meta.lineage,
    meta.product_cursor ?? legacyCursor,
  );
  if (
    legacyCursorNeedsInitialization &&
    !mesDetection.truncated &&
    !processedDetection.truncated
  ) {
    processedDetection = { truncated: true, branchPointIndex: -1 };
  }
  const inheritedPrefixInvalidated =
    meta.lineage?.status === LINEAGE_STATUS.VERIFIED_PREFIX &&
    !inheritedPrefixMatchesLiveChat(chat, meta.lineage);
  const summaryDetection = detectSummaryChanges(chat, meta);
  const indexCursorTruncated =
    !processedDetection.truncated &&
    Number.isInteger(cursorIndex) &&
    cursorIndex >= chat.length;
  if (
    !mesDetection.truncated &&
    !processedDetection.truncated &&
    !indexCursorTruncated &&
    !summaryDetection.truncated
  ) return null;
  if (isBlocked()) return null;

  let branchPoint = mesDetection.truncated ? mesDetection.branchPointMesId : null;
  let branchPointIndex = mesDetection.truncated
    ? chat.findLastIndex(
        (message) => typeof message?.mesId === 'number' && message.mesId === branchPoint,
      )
    : null;
  if (processedDetection.truncated || indexCursorTruncated) {
    const indexPoint = processedDetection.truncated
      ? processedDetection.branchPointIndex
      : Math.max(-1, chat.length - 1);
    if (branchPointIndex === null || indexPoint < branchPointIndex) {
      branchPointIndex = indexPoint;
      branchPoint = chat
        .slice(0, indexPoint + 1)
        .map((message) => (typeof message?.mesId === 'number' ? message.mesId : null))
        .filter((mesId) => mesId !== null)
        .reduce((max, mesId) => Math.max(max, mesId), null);
    }
  }
  if (summaryDetection.truncated) {
    const summaryPoint = summaryDetection.branchPointIndex;
    if (branchPointIndex === null || summaryPoint < branchPointIndex) {
      branchPointIndex = summaryPoint;
      branchPoint = chat
        .slice(0, summaryPoint + 1)
        .map((message) => (typeof message?.mesId === 'number' ? message.mesId : null))
        .filter((mesId) => mesId !== null)
        .reduce((max, mesId) => Math.max(max, mesId), null);
    }
  }
  if (isBlocked()) return null;

  const counts = {
    longterm: 0,
    session: 0,
    ledger: 0,
    narrative: 0,
    structured: 0,
    ingest_windows: 0,
    scenes: 0,
    arcs: 0,
    arc_summaries: 0,
    relationships: 0,
    summary: 0,
    canon: 0,
    epistemic: 0,
    profiles: 0,
  };

  // Invalidate every live prompt representation before any async cleanup so
  // the discarded branch cannot remain injectable while storage is pruned.
  clearIndividualPromptSlots();
  clearUnifiedSlot();
  clearAllMacroContent();
  delete meta.product_status;
  meta.lastInjectionRefresh = 0;

  // Long-term memories for the active character (routed to the per-chat
  // provenance, using either the numeric branch point or the verified array
  // boundary when the chat is sparse.
  if (characterNames.length > 0 && (Number.isInteger(branchPoint) || Number.isInteger(branchPointIndex))) {
    for (const name of characterNames) {
      if (isBlocked()) return null;
      const { kept, removed } = pruneMemoriesByBranchPoint(
        loadCharacterMemories(name),
        branchPoint,
        branchPointIndex,
      );
      if (removed.length > 0) {
        if (isBlocked()) return null;
        saveCharacterMemories(name, kept);
        counts.longterm += removed.length;
      }
    }
  }

  // Session memories (chat-scoped).
  if (Number.isInteger(branchPoint) || Number.isInteger(branchPointIndex)) {
    if (isBlocked()) return null;
    const { kept, removed } = pruneMemoriesByBranchPoint(
      loadSessionMemories(),
      branchPoint,
      branchPointIndex,
      { dropUnverifiable: true },
    );
    if (removed.length > 0) {
      if (isBlocked()) return null;
      await saveSessionMemories(kept, isBlocked);
      counts.session = removed.length;
    }
  }

  // State ledger cards stamped from the discarded timeline.
  if (Number.isInteger(branchPoint) || Number.isInteger(branchPointIndex)) {
    if (isBlocked()) return null;
    const { kept, removed } = pruneStateLedgerByBranchPoint(
      loadStateLedger(),
      branchPoint,
      branchPointIndex,
      { dropUnverifiable: true },
    );
    if (removed.length > 0) {
      if (isBlocked()) return null;
      await saveStateLedger(kept, isBlocked);
      counts.ledger = removed.length;
    }
  }

  // Embedded recursive narrative chain (product mode). Its provenance is
  // stricter than legacy tiers: only mesId-backed snippets are retained.
  if (meta.narrative) {
    if (isBlocked()) return null;
    const result = pruneNarrativeAtBranch(meta.narrative, {
      branchPointMesId: branchPoint,
      branchPointIndex,
      requireMesIds: false,
    });
    if (result.changed) {
      meta.narrative = result.state;
      counts.narrative = result.removed;
    }
  }

  if (Array.isArray(meta.structured_records)) {
    if (isBlocked()) return null;
    const result = pruneStructuredRecordsAtBranch(meta.structured_records, {
      branchPointMesId: branchPoint,
      branchPointIndex,
    });
    if (result.changed) {
      meta.structured_records = result.kept;
      counts.structured = result.removed.length;
    }
  }

  if (meta.ingest_windows && typeof meta.ingest_windows === 'object' && !Array.isArray(meta.ingest_windows)) {
    if (isBlocked()) return null;
    const result = pruneIngestWindowsAtBranch(meta.ingest_windows, {
      branchPointMesId: branchPoint,
      branchPointIndex,
    });
    if (result.changed) {
      meta.ingest_windows = result.windows;
      counts.ingest_windows = result.removed.length;
    }
  }

  // Legacy chat-local tiers. Scene history and story arcs carry mesId
  // provenance and are pruned exactly like the memory tiers (skipped for an
  // index-only branch, matching long-term/session). Arc summaries, the
  // short-term summary, canon, epistemic entries, and profiles carry no
  // provable source range, so a detected branch clears them rather than
  // risking discarded-branch content reaching a later prompt injection.
  if (Number.isInteger(branchPoint) || Number.isInteger(branchPointIndex)) {
    if (isBlocked()) return null;
    const scenePrune = pruneMemoriesByBranchPoint(
      loadSceneHistory(),
      branchPoint,
      branchPointIndex,
      { dropUnverifiable: true },
    );
    if (scenePrune.removed.length > 0) {
      if (isBlocked()) return null;
      await saveSceneHistory(scenePrune.kept, isBlocked);
      counts.scenes = scenePrune.removed.length;
    }
    if (isBlocked()) return null;
    const arcPrune = pruneMemoriesByBranchPoint(
      loadArcs(),
      branchPoint,
      branchPointIndex,
      { dropUnverifiable: true },
    );
    if (arcPrune.removed.length > 0) {
      if (isBlocked()) return null;
      await saveArcs(arcPrune.kept, isBlocked);
      counts.arcs = arcPrune.removed.length;
    }
  }

  if (isBlocked()) return null;
  const arcSummaries = loadArcSummaries();
  if (arcSummaries.length > 0) {
    if (isBlocked()) return null;
    await saveArcSummaries([], isBlocked);
    counts.arc_summaries = arcSummaries.length;
  }

  if (
    meta.summary ||
    meta.summaryEnd !== undefined ||
    meta.summaryUpdated !== undefined ||
    meta.summary_source_chat_id !== undefined ||
    meta.summary_source_chat_uid !== undefined ||
    meta.summary_source_message_range !== undefined ||
    meta.summary_source_fingerprint !== undefined ||
    meta.summary_source_mes_range !== undefined ||
    meta.summary_lineage_epoch !== undefined
  ) {
    if (isBlocked()) return null;
    delete meta.summary;
    delete meta.summaryEnd;
    delete meta.summaryUpdated;
    delete meta.summary_source_chat_id;
    delete meta.summary_source_chat_uid;
    delete meta.summary_source_message_range;
    delete meta.summary_source_fingerprint;
    delete meta.summary_source_mes_range;
    delete meta.summary_lineage_epoch;
    counts.summary = 1;
  }

  for (const name of characterNames) {
    if (isBlocked()) return null;
    const relationshipHistory = loadRelationshipHistory(name);
    if (Object.keys(relationshipHistory).length > 0) {
      if (isBlocked()) return null;
      clearRelationshipHistory(name);
      counts.relationships += Object.keys(relationshipHistory).length;
    }
    if (loadCanon(name)) {
      clearCanon(name);
      counts.canon += 1;
    }
    const epistemicEntries = loadEpistemicKnowledge(name);
    if (epistemicEntries.length > 0) {
      clearEpistemicKnowledge(name);
      counts.epistemic += epistemicEntries.length;
    }
    if (loadProfiles(name)) {
      if (isBlocked()) return null;
      await clearProfiles(name, isBlocked);
      counts.profiles += 1;
    }
  }

  // Roll both watermarks back to the branch point so the next pass starts
  // from the first divergent message instead of replaying history.
  if (isBlocked()) return null;
  if (inheritedPrefixInvalidated) {
    meta.lineage = {
      ...meta.lineage,
      status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
      quarantined: true,
      invalidation_reason: 'inherited-prefix-changed',
    };
    const runtimeLineage = getCurrentLineage();
    if (runtimeLineage) {
      setCurrentLineage({
        ...runtimeLineage,
        status: LINEAGE_STATUS.UNVERIFIED_BRANCH,
        quarantined: true,
        reason: 'inherited-prefix-changed',
      });
    }
  }
  if (isBlocked()) return null;
  delete meta.lastExtractSourceRange;
  delete meta.lastExtractFingerprint;
  delete meta.lastExtractEndIndex;
  meta.lastExtractMesId = branchPoint;
  const firstNew = Number.isInteger(branchPoint)
    ? firstIndexAfterMesId(chat, branchPoint)
    : Number.isInteger(branchPointIndex)
      ? branchPointIndex + 1
      : 0;
  meta.lastExtractCutoff = firstNew >= 0 ? firstNew : chat.length;
  if (firstNew > 0) updateLegacySourceProof(meta, chat, firstNew);
  if (legacyCursorNeedsInitialization) meta.lastExtractProofInitialized = true;
  if (meta.product_cursor) {
    meta.product_cursor = {
      ...meta.product_cursor,
      window_id: null,
      fingerprint: null,
      source_range: null,
      end_index: null,
      last_mes_id: branchPoint,
      last_index: firstNew >= 0 ? firstNew - 1 : chat.length - 1,
    };
  }
  if (isBlocked()) return null;
  await context.saveMetadata();
  saveSettingsDebounced();

  const total =
    counts.longterm +
    counts.session +
    counts.ledger +
    counts.narrative +
    counts.structured +
    counts.ingest_windows +
    counts.scenes +
    counts.arcs +
    counts.arc_summaries +
    counts.relationships +
    counts.summary +
    counts.canon +
    counts.epistemic +
    counts.profiles;
  const branchLabel = Number.isInteger(branchPoint)
    ? `message ${branchPoint}`
    : `array index ${branchPointIndex}`;
  if (typeof toastr !== 'undefined') {
    toastr.info(
      `In-chat branch detected - memory rolled back to ${branchLabel} ` +
      `(${total} items pruned: ${counts.longterm} long-term, ${counts.session} session, ${counts.ledger} state, ${counts.narrative} narrative, ${counts.structured} structured, ${counts.ingest_windows} queue, ${counts.scenes} scenes, ${counts.arcs} arcs, ${counts.arc_summaries} arc summaries, ${counts.summary} summary, ${counts.canon} canon, ${counts.epistemic} epistemic, ${counts.profiles} profiles, ${counts.relationships} relationships).`,
      'Storyhold',
      { timeOut: 7000, positionClass: 'toast-bottom-right' },
    );
  }
  smLog(
    `[SmartMemory] In-file branch detected at ${branchLabel}; pruned ${JSON.stringify(counts)}.`,
  );

  return branchPoint;
}
