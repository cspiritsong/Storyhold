/**
 * Pure rescan policy helpers.
 *
 * Rescan Chat rereads the full transcript in multiple passes and adds only
 * memories that are not already recorded. Existing entries are preserved and
 * act as the duplicate baseline through the normal verification pipeline.
 */

/** Default number of passes: one discovery pass plus one catch-up pass. */
export const RESCAN_DEFAULT_PASSES = 2;

/** Clamps a requested pass count to the safe supported range. */
export function normalizeRescanPasses(passes) {
  const value = Number(passes);
  if (!Number.isFinite(value)) return RESCAN_DEFAULT_PASSES;
  return Math.min(3, Math.max(1, Math.trunc(value)));
}

/** Builds an additive-only summary from before/after tier counts. */
export function buildRescanSummary(before = {}, after = {}) {
  const delta = (a, b) => Math.max(0, Number(b ?? 0) - Number(a ?? 0));
  const longterm_added = delta(before.longterm, after.longterm);
  const session_added = delta(before.session, after.session);
  const arcs_added = delta(before.arcs, after.arcs);
  return {
    longterm_added,
    session_added,
    arcs_added,
    total_added: longterm_added + session_added + arcs_added,
  };
}
