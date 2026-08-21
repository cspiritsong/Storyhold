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
} = {}) {
  if (typeof ingestOne !== 'function') throw new TypeError('ingestOne must be a function');
  if (!Number.isInteger(maxWindows) || maxWindows < 1) throw new RangeError('maxWindows must be positive');

  let windows = 0;
  let last = null;
  while (windows < maxWindows && !shouldAbort()) {
    const result = await ingestOne({ rescan: rescan && windows === 0 });
    if (!result) break;
    last = result;
    windows++;
    if (result.status !== 'completed') break;
  }
  return {
    windows,
    last,
    cancelled: shouldAbort(),
    exhausted: last === null || (last?.status === 'completed' && windows < maxWindows),
  };
}
