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
 * Branch-aware message tracking (pure helpers - no SillyTavern runtime deps).
 *
 * SillyTavern messages carry a stable `mesId` serial number that is preserved
 * when a branch copies history into a new chat file and is re-issued (higher
 * numbers) for regenerated tails inside the same file. Smart Memory used to
 * track extraction progress purely by array index, which breaks the moment a
 * chat is truncated or branched:
 *
 *   - A regenerate/swipe truncates the array at the branch point and appends
 *     new messages with NEW (higher) mesIds, so the old watermark mesId
 *     disappears from the chat even though the array keeps growing.
 *   - Array-index cutoffs then point at the wrong messages or past the end.
 *
 * This module provides the pure logic for tracking a `lastExtractMesId`
 * watermark, detecting in-file truncation (a branch point), and computing
 * which stored items were sourced from the discarded tail so callers can
 * prune them. All functions here are deterministic and free of ST imports so
 * the regression harness can unit-test them directly.
 */

import { fingerprintMessages } from './projections.js';

/** Persists a fingerprinted proof of the processed legacy chat prefix. */
export function updateLegacySourceProof(meta, chat, cutoffExclusive) {
  if (!meta || !Array.isArray(chat) || !Number.isInteger(cutoffExclusive) || cutoffExclusive <= 0) {
    return;
  }
  const processed = chat.slice(0, cutoffExclusive);
  const numericIds = processed.map((message) => message?.mesId);
  const allNumeric =
    processed.length > 0 && numericIds.every((mesId) => typeof mesId === 'number');
  meta.lastExtractSourceRange = allNumeric
    ? { kind: 'mesId', start: Math.min(...numericIds), end: Math.max(...numericIds) }
    : { kind: 'index', start: 0, end: cutoffExclusive - 1 };
  meta.lastExtractFingerprint = fingerprintMessages(processed);
  meta.lastExtractEndIndex = cutoffExclusive - 1;
}

/**
 * Returns the stable mesId of a message, or a fallback value when the message
 * has none (e.g. imported chats). SillyTavern always assigns numeric mesIds to
 * generated messages; only imported/legacy messages may lack them.
 *
 * @param {Object} msg - ST message object.
 * @param {number} fallback - Value to return when no numeric mesId exists.
 * @returns {number}
 */
export function getMessageMesId(msg, fallback = 0) {
  if (msg && typeof msg.mesId === 'number') return msg.mesId;
  if (msg && typeof msg.mesId === 'string' && msg.mesId !== '') {
    const parsed = parseInt(msg.mesId, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

/**
 * True when at least one message in the chat carries a real numeric mesId.
 * Truncation detection and mesId watermarks are only meaningful when real
 * mesIds exist; chats without them keep the legacy index-based behavior.
 *
 * @param {Array} chat - ST chat array.
 * @returns {boolean}
 */
export function chatHasRealMesIds(chat) {
  return Array.isArray(chat) && chat.some((m) => typeof m?.mesId === 'number');
}

/**
 * Returns the set of mesIds present in the chat array (real mesIds only;
 * fallbacks are never used for detection).
 *
 * @param {Array} chat - ST chat array.
 * @returns {Set<number>}
 */
export function chatMesIdSet(chat) {
  const ids = new Set();
  if (!Array.isArray(chat)) return ids;
  for (const m of chat) {
    if (typeof m?.mesId === 'number') ids.add(m.mesId);
  }
  return ids;
}

/**
 * Returns the highest mesId in the chat array, or 0 when empty.
 *
 * @param {Array} chat - ST chat array.
 * @returns {number}
 */
export function chatMaxMesId(chat) {
  let max = 0;
  if (!Array.isArray(chat)) return max;
  for (const m of chat) {
    if (typeof m?.mesId === 'number' && m.mesId > max) max = m.mesId;
  }
  return max;
}

/**
 * Detects whether the current chat array has been truncated at a branch point
 * relative to the stored extraction watermark.
 *
 * Rule: the watermark mesId must still exist in the chat. ST regenerations
 * issue NEW mesIds for the divergent tail (the counter keeps rising), so after
 * an in-file branch the old watermark mesId disappears even though the array
 * keeps growing. A plain "max < watermark" test cannot see that.
 *
 * The branch point is the highest surviving mesId below the watermark - the
 * last message that still exists from the pre-branch timeline. Everything
 * stored with a source range beyond it came from the discarded tail.
 *
 * Conservative by design: message deletions that leave the watermark message
 * intact never trigger; the only false positive is deleting exactly the
 * watermark message, which prunes at most memories sourced from that message.
 *
 * @param {Array} chat - Current ST chat array.
 * @param {number|null} watermarkMesId - Stored lastExtractMesId, or null.
 * @returns {{ truncated: boolean, branchPointMesId: number|null }}
 */
export function detectTruncation(chat, watermarkMesId) {
  if (watermarkMesId == null) return { truncated: false, branchPointMesId: null };
  if (!Array.isArray(chat) || chat.length === 0)
    return { truncated: false, branchPointMesId: null };
  if (!chatHasRealMesIds(chat)) return { truncated: false, branchPointMesId: null };

  const ids = chatMesIdSet(chat);
  if (ids.has(watermarkMesId)) return { truncated: false, branchPointMesId: null };

  let branchPoint = null;
  for (const id of ids) {
    if (id < watermarkMesId && (branchPoint === null || id > branchPoint)) branchPoint = id;
  }
  return { truncated: true, branchPointMesId: branchPoint };
}

/**
 * Returns the index of the first message whose mesId is strictly greater than
 * the given mesId, or -1 when no such message exists.
 *
 * @param {Array} chat - ST chat array.
 * @param {number} mesId - Exclusive lower bound.
 * @returns {number}
 */
export function firstIndexAfterMesId(chat, mesId) {
  if (!Array.isArray(chat)) return -1;
  let earliestUnprovable = -1;
  let firstRealAfter = -1;
  for (let i = 0; i < chat.length; i++) {
    const real = typeof chat[i]?.mesId === 'number' ? chat[i].mesId : null;
    if (real === null) {
      if (earliestUnprovable === -1) earliestUnprovable = i;
    } else if (real > mesId) {
      firstRealAfter = i;
      break;
    }
  }
  if (firstRealAfter === -1) return earliestUnprovable;
  if (earliestUnprovable !== -1 && earliestUnprovable < firstRealAfter) return earliestUnprovable;
  return firstRealAfter;
}

/**
 * Smart extraction window driven by the mesId watermark instead of an array
 * index. Mirrors the legacy getSmartExtractionWindow semantics so the two are
 * drop-in equivalent when the watermark is null.
 *
 * @param {Array} chat - Full chat array from SillyTavern context.
 * @param {number|null} watermarkMesId - Highest mesId already processed, or null.
 * @param {number} extractEvery - Current extraction interval setting.
 * @param {number} maxWindow - Hard cap on window size.
 * @returns {Array} Stable message slice.
 */
export function getMesIdWindow(chat, watermarkMesId, extractEvery, maxWindow) {
  if (!Array.isArray(chat) || chat.length === 0) return [];

  const last = chat[chat.length - 1];
  const cutoff = last && !last.is_user && !last.is_system ? chat.length - 1 : chat.length;
  if (cutoff <= 0) return [];

  let start;
  if (watermarkMesId == null) {
    start = Math.max(0, cutoff - maxWindow);
  } else {
    const newStart = firstIndexAfterMesId(chat.slice(0, cutoff), watermarkMesId);
    // Nothing past the watermark (e.g. a swipe re-render without new content):
    // return an empty window so the caller skips extraction instead of
    // re-processing already-seen context.
    if (newStart === -1) return [];
    const minContextStart = cutoff - extractEvery * 2;
    start = Math.max(Math.min(newStart, minContextStart), cutoff - maxWindow, 0);
  }
  return chat.slice(start, cutoff);
}

/**
 * Returns the mesId of the last real message at or before the given exclusive
 * cutoff index - i.e. the watermark the next pass should record. Only real
 * numeric mesIds qualify; returns null when none exist in range.
 *
 * @param {Array} chat - Full chat array from SillyTavern context.
 * @param {number} cutoffIndex - Exclusive end index of the processed range.
 * @returns {number|null}
 */
export function watermarkFromChat(chat, cutoffIndex) {
  if (!Array.isArray(chat) || chat.length === 0) return null;
  const end = Math.min(cutoffIndex ?? chat.length, chat.length);
  for (let i = end - 1; i >= 0; i--) {
    const msg = chat[i];
    if (msg && !msg.is_system && typeof msg.mesId === 'number') return msg.mesId;
  }
  return null;
}

/**
 * Filters a memory array (long-term or session shape) down to items sourced
 * at or before the branch point, returning the survivors and the pruned items.
 *
 * A memory is pruned when it carries a real `source_mes_range` whose END
 * exceeds the branch point - it was extracted from the discarded timeline.
 * Memories without a range (pre-fork data, mesId-less chats) are always kept:
 * pruning without provenance is never safe.
 *
 * Supersession links are repaired: a kept memory that was retired by a
 * pruned memory becomes active again (its superseded_by / valid_to are
 * cleared), because its replacement no longer exists in this timeline.
 *
 * @param {Array} memories - Memory objects with id/superseded_by/supersedes/source_mes_range.
 * @param {number} branchPointMesId - Highest surviving mesId of the kept timeline.
 * @returns {{ kept: Array, removed: Array }}
 */
export function pruneMemoriesByBranchPoint(
  memories,
  branchPointMesId,
  branchPointIndex = null,
  { dropUnverifiable = false } = {},
) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return { kept: Array.isArray(memories) ? memories : [], removed: [] };
  }

  const removedIds = new Set();
  const kept = [];
  const removed = [];

  for (const mem of memories) {
    const ranges = [];
    const mesRange = mem?.source_mes_range;
    if (Array.isArray(mesRange) && mesRange.length >= 2) {
      ranges.push({ kind: 'mesId', start: mesRange[0], end: mesRange[1] });
    }
    for (const source of [mem?.source_message_range, mem?._source_message_range]) {
      if (Array.isArray(source) && source.length >= 2) {
        ranges.push({ kind: 'index', start: source[0], end: source[1] });
      }
    }
    if (Array.isArray(mem?.source_messages)) {
      for (const source of mem.source_messages) {
        if (Array.isArray(source) && source.length >= 2) {
          ranges.push({ kind: 'index', start: source[0], end: source[1] });
        }
      }
    }
    if (mem?.source_range && typeof mem.source_range === 'object') ranges.push(mem.source_range);
    const hasUsableRange = ranges.some(
      (range) =>
        ['mesId', 'index'].includes(range?.kind) &&
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.end >= range.start,
    );
    const beyond = ranges.some((range) =>
      range.kind === 'mesId'
        ? Number.isInteger(range.end) &&
          (branchPointMesId == null || range.end > branchPointMesId)
        : range.kind === 'index' &&
          Number.isInteger(branchPointIndex) &&
          range.end > branchPointIndex,
    );
    if (beyond || (dropUnverifiable && !hasUsableRange)) {
      if (mem?.id) removedIds.add(mem.id);
      removed.push(mem);
    } else {
      kept.push(mem);
    }
  }

  if (removedIds.size === 0) return { kept: memories, removed: [] };

  for (const mem of kept) {
    if (mem.superseded_by && removedIds.has(mem.superseded_by)) {
      delete mem.superseded_by;
      delete mem.valid_to;
    }
  }

  return { kept, removed };
}

/**
 * Filters the state ledger map down to cards whose last update is inside the
 * surviving branch. Both numeric mesId and array-index source ranges are
 * supported because SillyTavern branches may contain no mesId values.
 *
 * @param {Object} ledger - state_ledger map: `name|type` -> card fields.
 * @param {number|null} branchPointMesId - Highest surviving mesId, when known.
 * @param {number|null} branchPointIndex - Highest surviving array index, when known.
 * @param {Object} options
 * @param {boolean} [options.dropUnverifiable=false] - Remove cards without
 *   provenance usable for the selected branch boundary.
 * @returns {{ kept: Object, removed: Array<{key: string, card: Object}> }}
 */
export function pruneStateLedgerByBranchPoint(
  ledger,
  branchPointMesId,
  branchPointIndex = null,
  { dropUnverifiable = false } = {},
) {
  const kept = {};
  const removed = [];
  for (const [key, card] of Object.entries(ledger ?? {})) {
    const mesRanges = [];
    const indexRanges = [];
    const collect = (value, target) => {
      if (Array.isArray(value) && value.length >= 2) {
        const [start, end] = value;
        if (Number.isInteger(start) && Number.isInteger(end) && end >= start) {
          target.push([start, end]);
        }
      }
    };
    for (const value of [card?._source_mes_range, card?.source_mes_range]) {
      collect(value, mesRanges);
    }
    for (const value of [
      card?._source_message_range,
      card?.source_message_range,
      card?.scope?._source_message_range,
      card?.scope?.source_message_range,
      card?.provenance?._source_message_range,
      card?.provenance?.source_message_range,
    ]) {
      collect(value, indexRanges);
    }
    const updatedMesId = Number.isInteger(card?._updated_mes_id) ? card._updated_mes_id : null;
    const hasMesProof = mesRanges.length > 0 || updatedMesId !== null;
    const hasIndexProof = indexRanges.length > 0;
    const numericBoundary = Number.isInteger(branchPointMesId);
    const indexBoundary = Number.isInteger(branchPointIndex);
    const relevantProof =
      (numericBoundary && hasMesProof) ||
      (indexBoundary && hasIndexProof) ||
      (!numericBoundary && !indexBoundary && hasMesProof);
    const beyondMes =
      numericBoundary &&
      ((updatedMesId !== null && updatedMesId > branchPointMesId) ||
        mesRanges.some(([, end]) => end > branchPointMesId));
    const beyondIndex = indexBoundary && indexRanges.some(([, end]) => end > branchPointIndex);
    // With no numeric boundary, the historical behavior treated any numeric
    // update watermark as belonging to an unproven/discarded numeric tail.
    const unboundedNumericUpdate = !numericBoundary && !indexBoundary && updatedMesId !== null;
    if (beyondMes || beyondIndex || unboundedNumericUpdate || (dropUnverifiable && !relevantProof)) {
      removed.push({ key, card });
    } else {
      kept[key] = card;
    }
  }
  return { kept, removed };
}
