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
