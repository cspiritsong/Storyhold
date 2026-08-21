/**
 * Smart Memory - SillyTavern Extension
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

import { getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { META_KEY } from './constants.js';
import { pruneIngestWindowsAtBranch } from './ingest-queue.js';
import { smLog } from './logging.js';
import { pruneNarrativeAtBranch } from './narrative-chain.js';
import { pruneStructuredRecordsAtBranch } from './structured-records.js';
import { loadCharacterMemories, saveCharacterMemories } from './longterm.js';
import { loadSessionMemories, saveSessionMemories } from './session.js';
import { loadStateLedger, saveStateLedger } from './state-ledger.js';
import {
  chatHasRealMesIds,
  detectTruncation,
  firstIndexAfterMesId,
  pruneMemoriesByBranchPoint,
  pruneStateLedgerByBranchPoint,
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
 * @param {string|null} characterName - Active character for long-term pruning
 *        (scope-aware through saveCharacterMemories). Null in group chats
 *        prunes session + ledger only.
 * @returns {Promise<number|null>} The branch point mesId, or null when no
 *          truncation was detected or the metadata is not ready.
 */
export async function detectAndPruneInFileBranch(characterName) {
  const context = getContext();
  const meta = context.chatMetadata?.[META_KEY];
  if (!meta) return null;

  const watermark =
    meta.product_cursor?.last_mes_id ??
    meta.lastExtractMesId ??
    (meta.narrative?.watermark?.source_range?.kind === 'mesId'
      ? meta.narrative.watermark.source_range.end
      : null);
  if (watermark == null) return null;

  const chat = context.chat ?? [];
  if (!chatHasRealMesIds(chat)) return null;

  const detection = detectTruncation(chat, watermark);
  if (!detection.truncated) return null;

  const branchPoint = detection.branchPointMesId;
  const counts = {
    longterm: 0,
    session: 0,
    ledger: 0,
    narrative: 0,
    structured: 0,
    ingest_windows: 0,
  };

  // Long-term memories for the active character (routed to the per-chat
  // container when memory scope is Per chat).
  if (characterName) {
    const { kept, removed } = pruneMemoriesByBranchPoint(
      loadCharacterMemories(characterName),
      branchPoint,
    );
    if (removed.length > 0) {
      saveCharacterMemories(characterName, kept);
      counts.longterm = removed.length;
    }
  }

  // Session memories (chat-scoped).
  {
    const { kept, removed } = pruneMemoriesByBranchPoint(loadSessionMemories(), branchPoint);
    if (removed.length > 0) {
      await saveSessionMemories(kept);
      counts.session = removed.length;
    }
  }

  // State ledger cards stamped from the discarded timeline.
  {
    const { kept, removed } = pruneStateLedgerByBranchPoint(loadStateLedger(), branchPoint);
    if (removed.length > 0) {
      await saveStateLedger(kept);
      counts.ledger = removed.length;
    }
  }

  // Embedded recursive narrative chain (product mode). Its provenance is
  // stricter than legacy tiers: only mesId-backed snippets are retained.
  if (meta.narrative) {
    const result = pruneNarrativeAtBranch(meta.narrative, {
      branchPointMesId: branchPoint,
      requireMesIds: true,
    });
    if (result.changed) {
      meta.narrative = result.state;
      counts.narrative = result.removed;
    }
  }

  if (Array.isArray(meta.structured_records)) {
    const result = pruneStructuredRecordsAtBranch(meta.structured_records, {
      branchPointMesId: branchPoint,
    });
    if (result.changed) {
      meta.structured_records = result.kept;
      counts.structured = result.removed.length;
    }
  }

  if (meta.ingest_windows && typeof meta.ingest_windows === 'object' && !Array.isArray(meta.ingest_windows)) {
    const result = pruneIngestWindowsAtBranch(meta.ingest_windows, {
      branchPointMesId: branchPoint,
    });
    if (result.changed) {
      meta.ingest_windows = result.windows;
      counts.ingest_windows = result.removed.length;
    }
  }

  // Roll both watermarks back to the branch point so the next pass starts
  // from the first divergent message instead of replaying history.
  meta.lastExtractMesId = branchPoint;
  const firstNew = firstIndexAfterMesId(chat, branchPoint);
  meta.lastExtractCutoff = firstNew >= 0 ? firstNew : chat.length;
  if (meta.product_cursor) {
    meta.product_cursor = {
      ...meta.product_cursor,
      window_id: null,
      fingerprint: null,
      last_mes_id: branchPoint,
      last_index: firstNew >= 0 ? firstNew - 1 : chat.length - 1,
    };
  }
  context.saveMetadata();
  saveSettingsDebounced();

  const total =
    counts.longterm +
    counts.session +
    counts.ledger +
    counts.narrative +
    counts.structured +
    counts.ingest_windows;
  if (typeof toastr !== 'undefined') {
    toastr.info(
      `In-chat branch detected - memory rolled back to message ${branchPoint} ` +
        `(${total} items pruned: ${counts.longterm} long-term, ${counts.session} session, ${counts.ledger} state, ${counts.narrative} narrative, ${counts.structured} structured, ${counts.ingest_windows} queue).`,
      'Smart Memory',
      { timeOut: 7000, positionClass: 'toast-bottom-right' },
    );
  }
  smLog(
    `[SmartMemory] In-file branch detected at mesId ${branchPoint}; pruned ${JSON.stringify(counts)}.`,
  );

  return branchPoint;
}
