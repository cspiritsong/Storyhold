/**
 * Bounded orchestration for the product-mode historical catch-up path.
 *
 * The caller owns one-window ingest and storage. This module only sequences
 * completed windows, stops on failure/exhaustion, and supports cancellation.
 */

export async function runProductCatchUp({
  ingestOne,
  shouldAbort = () => false,
  maxWindows = 1000,
  rescan = false,
  totalWindows = null,
  totalMessages = null,
  onProgress = null,
} = {}) {
  if (typeof ingestOne !== 'function') throw new TypeError('ingestOne must be a function');
  if (!Number.isInteger(maxWindows) || maxWindows < 1) throw new RangeError('maxWindows must be positive');
  const totals =
    Number.isInteger(totalWindows) && totalWindows > 0
      ? { totalWindows, totalMessages: Number.isInteger(totalMessages) ? totalMessages : null }
      : {};

  const report = (event) => {
    if (typeof onProgress !== 'function') return;
    try {
      const result = onProgress({ ...totals, ...event });
      if (result && typeof result.then === 'function') {
        result.catch((error) => {
          console.warn('[Storyhold] Product progress callback failed:', error);
        });
      }
    } catch (error) {
      console.warn('[Storyhold] Product progress callback failed:', error);
    }
  };

  let windows = 0;
  let last = null;
  let previousWindowId = null;
  let noProgress = false;
  report({ phase: 'started', windows: 0, maxWindows, rescan });
  while (windows < maxWindows && !shouldAbort()) {
    const windowNumber = windows + 1;
    const windowRescan = rescan && windows === 0;
    let sawWindowComplete = false;
    report({ phase: 'window_start', windowNumber, windows, rescan: windowRescan });
    const result = await ingestOne({
      rescan: windowRescan,
      onProgress: (event) => {
        if (event?.phase === 'window_complete') sawWindowComplete = true;
        report({
          ...event,
          windowNumber,
          ...(event?.phase === 'window_complete' ? { windows: windows + 1 } : {}),
        });
      },
    });
    if (!result) break;
    if (
      result.status === 'completed' &&
      result.window_id != null &&
      result.window_id === previousWindowId
    ) {
      noProgress = true;
      break;
    }
    previousWindowId = result.window_id ?? null;
    last = result;
    windows++;
    if (!sawWindowComplete) {
      report({
        phase: 'window_complete',
        windowNumber,
        windows,
        windowId: result.window_id ?? null,
        status: result.status ?? null,
        recordCount: result.records?.length ?? result.record_ids?.length ?? 0,
        ...(Number.isInteger(result.coverage?.uncovered_count)
          ? { uncoveredCount: result.coverage.uncovered_count }
          : {}),
        replayed: result.replayed ?? false,
      });
    }
    if (result.status === 'cancelled' || result.cancelled === true) break;
    if (result.status !== 'completed') break;
  }
  const outcome = {
    windows,
    last,
    cancelled: shouldAbort() || last?.status === 'cancelled' || last?.cancelled === true,
    noProgress,
    exhausted: last === null || (last?.status === 'completed' && windows < maxWindows),
  };
  const terminalPhase =
    outcome.cancelled
      ? 'cancelled'
      : outcome.noProgress
        ? 'partial'
        : outcome.last && outcome.last.status !== 'completed'
        ? 'partial'
        : outcome.exhausted
          ? 'finished'
          : 'capped';
  report({ phase: terminalPhase, ...outcome });
  return outcome;
}
