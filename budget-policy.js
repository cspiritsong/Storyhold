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

/** Returns updated settings with manual defaults applied and auto-tune off. */
export function applyManualBudgetReset(settings = {}, budgetKeys = [], defaults = {}) {
  const next = { ...settings, auto_tune_budgets: false };
  for (const key of budgetKeys) next[key] = defaults[key];
  return next;
}

export const INJECTION_BUDGET_STEP = 50;
export const DEFAULT_TOTAL_INJECT_BUDGET = 8000;
export const MAX_TOTAL_INJECT_BUDGET = 16000;

const snapUp = (value, step = INJECTION_BUDGET_STEP) =>
  Math.max(0, Math.ceil(Number(value || 0) / step) * step);

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
