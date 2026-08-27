/**
 * Pure budget policy helpers.
 *
 * The contract: manual per-tier budget edits are authoritative. Moving any
 * advanced-mode tier slider disables auto-tune so the value is not silently
 * reallocated on the next extraction pass.
 */

/** Returns updated settings with the manual tier value applied and auto-tune off. */
export function applyManualBudget(settings = {}, key, value) {
  return { ...settings, [key]: value, auto_tune_budgets: false };
}

/**
 * Memory size presets — one slider stop configures injection budget,
 * generation budget, and stored-memory counts together. Ordered left
 * (small local models) to right (frontier / absurd).
 *
 * total_inject  : global injection ceiling written to total_inject_budget.
 * generation    : generation_budget ceiling for background memory writes.
 * longtermMax / sessionMax / sceneMax / arcsMax : stored-record pool sizes.
 * minContext    : smallest model context this preset is comfortable on.
 * blurb         : plain-English one-liner shown under the slider.
 */
export const MEMORY_PRESETS = Object.freeze([
  {
    key: 'potato',
    label: 'Potato',
    total_inject: 1500,
    generation: 2048,
    longtermMax: 10,
    sessionMax: 15,
    sceneMax: 5,
    arcsMax: 5,
    minContext: 0,
    blurb: 'Tiny footprint for 16k local models. Memory stays small so the story fits.',
  },
  {
    key: 'modest',
    label: 'Modest',
    total_inject: 4000,
    generation: 4096,
    longtermMax: 15,
    sessionMax: 20,
    sceneMax: 8,
    arcsMax: 8,
    minContext: 32768,
    blurb: 'Comfortable for 32k-64k models. A solid everyday setting.',
  },
  {
    key: 'balanced',
    label: 'Balanced',
    total_inject: 8000,
    generation: 8192,
    longtermMax: 25,
    sessionMax: 30,
    sceneMax: 10,
    arcsMax: 10,
    minContext: 98304,
    blurb: 'The classic default. Right for 128k-200k models.',
  },
  {
    key: 'generous',
    label: 'Generous',
    total_inject: 16000,
    generation: 12288,
    longtermMax: 40,
    sessionMax: 50,
    sceneMax: 15,
    arcsMax: 15,
    minContext: 196608,
    blurb: 'For 200k-400k models. More memory per reply, deeper archives.',
  },
  {
    key: 'whale',
    label: 'Whale',
    total_inject: 32000,
    generation: 16384,
    longtermMax: 60,
    sessionMax: 80,
    sceneMax: 20,
    arcsMax: 20,
    minContext: 393216,
    blurb: 'Built for 1M-context models. Long campaigns with long memories.',
  },
  {
    key: 'ultra',
    label: 'Ultra',
    total_inject: 64000,
    generation: 24576,
    longtermMax: 100,
    sessionMax: 120,
    sceneMax: 30,
    arcsMax: 30,
    minContext: 1000000,
    blurb: 'For 1M+ models on flat-rate pricing. Very high per-reply token cost.',
  },
  {
    key: 'absurd',
    label: 'Absurd',
    total_inject: 128000,
    generation: 32768,
    longtermMax: 150,
    sessionMax: 200,
    sceneMax: 50,
    arcsMax: 50,
    minContext: 1000000,
    blurb: 'YOLO tier. Modern models can find facts here, but expect vaguer replies and a much bigger API bill. The story itself usually deserves this space more.',
  },
]);

export const PRESET_AUTO_MAX_INDEX = 4; // Whale; Ultra and Absurd stay opt-in.

/**
 * Returns the preset index best suited to a model context size: the largest
 * ordinary preset whose context band has been reached. Ultra and Absurd remain
 * deliberate manual choices because their cost and attention trade-offs are
 * too large to select silently. Unknown/zero context -> Balanced.
 */
export function detectPresetIndex(contextSize) {
  const ctx = Number(contextSize);
  if (!Number.isFinite(ctx) || ctx <= 0) {
    return MEMORY_PRESETS.findIndex((p) => p.key === 'balanced');
  }
  let best = 0;
  for (let i = 0; i <= PRESET_AUTO_MAX_INDEX; i++) {
    if (ctx >= MEMORY_PRESETS[i].minContext) best = i;
  }
  return best;
}

/**
 * Returns the preset index whose total_inject matches the given total, or -1
 * when the total is a custom value that no preset row produces.
 */
export function presetIndexForTotal(totalInject) {
  const total = Number(totalInject);
  return MEMORY_PRESETS.findIndex((p) => p.total_inject === total);
}

/** Applies a preset's generation budget and memory counts to a settings object. */
export function applyPresetSideSettings(settings = {}, preset) {
  if (!preset) return { ...settings };
  return {
    ...settings,
    generation_budget: preset.generation,
    longterm_max_memories: preset.longtermMax,
    session_max_memories: preset.sessionMax,
    scene_max_history: preset.sceneMax,
    arcs_max: preset.arcsMax,
  };
}

/** Returns updated settings with manual defaults applied and auto-tune off. */
export function applyManualBudgetReset(settings = {}, budgetKeys = [], defaults = {}) {
  const next = { ...settings, auto_tune_budgets: false };
  for (const key of budgetKeys) next[key] = defaults[key];
  return next;
}

export const INJECTION_BUDGET_STEP = 50;
export const DEFAULT_TOTAL_INJECT_BUDGET = 8000;
// Raised from 16000 so the preset slider can reach the 64k "Ultra" and
// 128k "Absurd" tiers for 1M-context models. Advanced per-tier sliders scale
// to 32000 each (was 4000) so the 128k preset can actually be distributed.
export const MAX_TOTAL_INJECT_BUDGET = 128000;
export const MAX_TIER_INJECT_BUDGET = 32000;

const snapUp = (value, step = INJECTION_BUDGET_STEP) =>
  Math.max(0, Math.ceil(Number(value || 0) / step) * step);

/**
 * Scales tier floors down when a small-context preset cannot fit the normal
 * defaults. Every active tier still receives a 50-token foothold, and the
 * ordinary allocator continues to protect the returned floors.
 */
export function scaleBudgetFloors(tiers = [], totalCap) {
  const active = tiers.filter((tier) => tier.enabled !== false && tier.key != null);
  const defaults = Object.fromEntries(
    active.map((tier) => [tier.key, snapUp(tier.minimum ?? tier.defaultBudget ?? 0)]),
  );
  const defaultTotal = Object.values(defaults).reduce((sum, value) => sum + value, 0);
  const cap = snapUp(totalCap);
  if (defaultTotal === 0 || cap >= defaultTotal) return defaults;

  const scale = cap / defaultTotal;
  const floors = Object.fromEntries(
    active.map((tier) => [
      tier.key,
      Math.max(INJECTION_BUDGET_STEP, Math.floor((defaults[tier.key] * scale) / INJECTION_BUDGET_STEP) * INJECTION_BUDGET_STEP),
    ]),
  );
  // Rounding can leave the floors over the requested cap. Remove whole units
  // from the largest floors until the cap is satisfiable.
  let total = Object.values(floors).reduce((sum, value) => sum + value, 0);
  while (total > cap) {
    const candidate = active
      .map((tier) => tier.key)
      .filter((key) => floors[key] > INJECTION_BUDGET_STEP)
      .sort((a, b) => floors[b] - floors[a])[0];
    if (!candidate) break;
    floors[candidate] -= INJECTION_BUDGET_STEP;
    total -= INJECTION_BUDGET_STEP;
  }
  return floors;
}

/** Returns the sum of minimum budgets for enabled tiers. */
export function sumBudgetFloors(tiers = []) {
  return tiers.reduce(
    (sum, tier) =>
      tier.enabled === false ? sum : sum + snapUp(tier.minimum ?? tier.defaultBudget ?? 0),
    0,
  );
}


/** Returns a valid total cap that can satisfy all enabled tier floors. */
export function normalizeTotalInjectBudget(
  value,
  minimumTotal = 0,
  maximum = MAX_TOTAL_INJECT_BUDGET,
) {
  const minimum = snapUp(minimumTotal);
  const max = Math.max(minimum, snapUp(maximum));
  const requested = Number(value);
  const candidate = Number.isFinite(requested)
    ? snapUp(requested)
    : DEFAULT_TOTAL_INJECT_BUDGET;
  return Math.min(max, Math.max(minimum, candidate));
}

/**
 * Allocates a total injection cap while preserving every enabled tier floor.
 * Remaining 50-token units go to the tier with the largest unmet target.
 */
export function allocateBudgetWithinCap(tiers = [], totalCap) {
  const active = tiers
    .filter((tier) => tier.enabled !== false && tier.key != null)
    .map((tier, index) => {
      const minimum = snapUp(tier.minimum ?? tier.defaultBudget ?? 0);
      const maximum = Math.max(minimum, snapUp(tier.maximum ?? Number.POSITIVE_INFINITY));
      const rawTarget = Number(tier.target);
      const target = Math.max(
        minimum,
        Math.min(maximum, snapUp(Number.isFinite(rawTarget) ? rawTarget : minimum)),
      );
      return { key: tier.key, minimum, maximum, target, allocation: minimum, index };
    });

  const minimumTotal = active.reduce((sum, tier) => sum + tier.minimum, 0);
  const cap = normalizeTotalInjectBudget(totalCap, minimumTotal);
  let available = cap - minimumTotal;

  while (available >= INJECTION_BUDGET_STEP) {
    const candidates = active
      .filter((tier) => tier.allocation < tier.target)
      .sort(
        (a, b) =>
          b.target - b.allocation - (a.target - a.allocation) || a.index - b.index,
      );
    if (candidates.length === 0) break;
    candidates[0].allocation += INJECTION_BUDGET_STEP;
    available -= INJECTION_BUDGET_STEP;
  }

  const allocations = Object.fromEntries(active.map((tier) => [tier.key, tier.allocation]));
  const total = active.reduce((sum, tier) => sum + tier.allocation, 0);
  return {
    allocations,
    total,
    cap,
    minimum_total: minimumTotal,
    unallocated: Math.max(0, cap - total),
  };
}
