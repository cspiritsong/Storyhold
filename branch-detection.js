import { fingerprintMessages } from './projections.js';

function orderedWindows(windows = {}, kind = null) {
  return Object.values(windows ?? {})
    .filter((state) => {
      const range = state?.source_range;
      return (
        (!kind || range?.kind === kind) &&
        (range?.kind === 'index' || range?.kind === 'mesId') &&
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.start >= 0 &&
        range.end >= range.start &&
        typeof state?.fingerprint === 'string' &&
        state.fingerprint.length > 0
      );
    })
    .sort((a, b) => a.source_range.start - b.source_range.start);
}

function currentMessagesForRange(chat, range, endIndex = null) {
  if (!Array.isArray(chat)) return [];
  if (range.kind === 'index') return chat.slice(range.start, range.end + 1);
  if (Number.isInteger(endIndex)) {
    const startIndex = chat.findIndex((message) => {
      const mesId = message?.mesId;
      return typeof mesId === 'number' && mesId === range.start;
    });
    if (startIndex < 0 || endIndex < startIndex || endIndex >= chat.length) return [];
    return chat.slice(startIndex, endIndex + 1);
  }
  return chat.filter((message) => {
    const mesId = message?.mesId;
    return typeof mesId === 'number' && mesId >= range.start && mesId <= range.end;
  });
}

function branchPointIndexForChangedRange(chat, range) {
  if (!Array.isArray(chat)) return -1;
  if (range.kind === 'index') return range.start - 1;
  const firstInRange = chat.findIndex((message) => {
    const mesId = message?.mesId;
    return typeof mesId === 'number' && mesId >= range.start && mesId <= range.end;
  });
  if (firstInRange >= 0) return firstInRange - 1;
  const firstAfterRange = chat.findIndex((message) => {
    const mesId = message?.mesId;
    return typeof mesId === 'number' && mesId > range.end;
  });
  return firstAfterRange >= 0 ? firstAfterRange - 1 : -1;
}

/** Returns whether a stored range fingerprint still matches the live chat. */
export function sourceRangeMatchesLiveChat(chat, range, fingerprint, lastIndex = null, endIndex = null) {
  if (
    !Array.isArray(chat) ||
    !range ||
    !['index', 'mesId'].includes(range.kind) ||
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    typeof fingerprint !== 'string' ||
    fingerprint.length === 0
  ) return false;
  if (
    Number.isInteger(lastIndex) &&
    Number.isInteger(endIndex) &&
    lastIndex !== endIndex
  ) return false;
  if (range.kind === 'index' && Number.isInteger(endIndex) && range.end !== endIndex) return false;
  let currentMessages;
  if (range.kind === 'mesId') {
    const startIndex = chat.findIndex((message) => message?.mesId === range.start);
    if (startIndex < 0) return false;
    const endpoint = Number.isInteger(lastIndex) ? lastIndex : endIndex;
    let resolvedEnd = endpoint;
    if (!Number.isInteger(resolvedEnd)) {
      resolvedEnd = chat.findLastIndex((message) => message?.mesId === range.end);
    }
    if (resolvedEnd < startIndex || resolvedEnd >= chat.length) return false;
    if (chat[resolvedEnd]?.mesId !== range.end) return false;
    currentMessages = chat.slice(startIndex, resolvedEnd + 1);
    const realMesIds = currentMessages
      .map((message) => message?.mesId)
      .filter((mesId) => typeof mesId === 'number');
    if (
      currentMessages.some((message) => typeof message?.mesId !== 'number') ||
      realMesIds.length === 0 ||
      Math.min(...realMesIds) !== range.start ||
      Math.max(...realMesIds) !== range.end
    ) return false;
  } else {
    currentMessages = currentMessagesForRange(chat, range, endIndex);
  }
  if (currentMessages.length === 0) return false;
  if (range.kind === 'index' && currentMessages.length !== range.end - range.start + 1) return false;
  return fingerprintMessages(currentMessages) === fingerprint;
}

/** Returns whether a stored inherited prefix still matches the live transcript. */
export function inheritedPrefixMatchesLiveChat(chat, prefix = null) {
  if (!Number.isInteger(prefix?.prefix_length) || prefix.prefix_length < 0) return false;
  if (prefix.prefix_length === 0) return true;
  if (typeof prefix.prefix_fingerprint !== 'string' || prefix.prefix_fingerprint.length === 0) {
    return false;
  }
  const currentPrefix = Array.isArray(chat) ? chat.slice(0, prefix.prefix_length) : [];
  return (
    currentPrefix.length === prefix.prefix_length &&
    fingerprintMessages(currentPrefix) === prefix.prefix_fingerprint
  );
}

/** Finds the first persisted window whose source no longer matches chat. */
export function detectProcessedWindowChanges(chat, windows = {}, prefix = null, cursor = null) {
  if (
    Number.isInteger(prefix?.prefix_length) &&
    prefix.prefix_length > 0 &&
    typeof prefix.prefix_fingerprint === 'string'
  ) {
    if (!inheritedPrefixMatchesLiveChat(chat, prefix)) {
      return { truncated: true, branchPointIndex: -1 };
    }
  }
  if (
    cursor?.source_range &&
    !sourceRangeMatchesLiveChat(
      chat,
      cursor.source_range,
      cursor.fingerprint,
      cursor.last_index,
      cursor.end_index,
    )
  ) {
    return {
      truncated: true,
      branchPointIndex: branchPointIndexForChangedRange(chat, cursor.source_range),
    };
  }
  for (const state of orderedWindows(windows)) {
    const range = state.source_range;
    if (
      !sourceRangeMatchesLiveChat(
        chat,
        range,
        state.fingerprint,
        state.last_index,
        state.end_index,
      )
    ) {
      return {
        truncated: true,
        branchPointIndex: branchPointIndexForChangedRange(chat, range),
      };
    }
  }
  return { truncated: false, branchPointIndex: null };
}

/** Returns whether a stored summary still covers the live transcript. */
export function detectSummaryChanges(chat, summaryMeta = {}) {
  if (!summaryMeta?.summary || !Array.isArray(chat)) {
    return { truncated: false, branchPointIndex: null };
  }
  const summaryEnd = summaryMeta.summaryEnd;
  if (!Number.isInteger(summaryEnd) || summaryEnd < 0) {
    return { truncated: false, branchPointIndex: null };
  }
  if (summaryEnd > chat.length) return { truncated: true, branchPointIndex: -1 };

  const indexRange = summaryMeta.summary_source_message_range;
  const summaryFingerprint = summaryMeta.summary_source_fingerprint;
  if (
    Array.isArray(indexRange) &&
    indexRange.length >= 2 &&
    Number.isInteger(indexRange[0]) &&
    Number.isInteger(indexRange[1])
  ) {
    if (
      typeof summaryFingerprint !== 'string' ||
      !sourceRangeMatchesLiveChat(
        chat,
        { kind: 'index', start: indexRange[0], end: indexRange[1] },
        summaryFingerprint,
        null,
        indexRange[1],
      )
    ) {
      return { truncated: true, branchPointIndex: Math.max(-1, indexRange[0] - 1) };
    }
  }

  const mesRange = summaryMeta.summary_source_mes_range;
  if (Array.isArray(mesRange) && mesRange.length >= 2) {
    const start = mesRange[0];
    const end = mesRange[1];
    const hasStart = chat.some((message) => message?.mesId === start);
    const hasEnd = chat.some((message) => message?.mesId === end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || !hasStart || !hasEnd) {
      return { truncated: true, branchPointIndex: -1 };
    }
    if (
      typeof summaryFingerprint !== 'string' ||
      !sourceRangeMatchesLiveChat(
        chat,
        { kind: 'mesId', start, end },
        summaryFingerprint,
      )
    ) {
      const first = chat.findIndex((message) => message?.mesId === start);
      return { truncated: true, branchPointIndex: Math.max(-1, first - 1) };
    }
  }

  return { truncated: false, branchPointIndex: null };
}

/** Finds the first processed index window whose source no longer matches chat. */
export function detectIndexOnlyBranch(chat, windows = {}) {
  return detectProcessedWindowChanges(
    chat,
    Object.fromEntries(
      orderedWindows(windows, 'index').map((state, index) => [`index-${index}`, state]),
    ),
  );
}
