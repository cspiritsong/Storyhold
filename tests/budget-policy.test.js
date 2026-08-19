import test from 'node:test';
import assert from 'node:assert/strict';
import { applyManualBudget, applyManualBudgetReset } from '../budget-policy.js';

test('manual per-tier budget edit disables auto-tune and preserves other tiers', () => {
  const settings = {
    auto_tune_budgets: true,
    longterm_inject_budget: 3200,
    session_inject_budget: 3050,
    canon_inject_budget: 3050,
  };

  const result = applyManualBudget(settings, 'canon_inject_budget', 900);

  assert.equal(result.canon_inject_budget, 900);
  assert.equal(result.auto_tune_budgets, false);
  assert.equal(result.longterm_inject_budget, 3200);
  assert.equal(result.session_inject_budget, 3050);
  assert.equal(settings.auto_tune_budgets, true);
  assert.equal(settings.canon_inject_budget, 3050);
});

test('manual budget reset restores defaults and disables auto-tune', () => {
  const defaults = {
    longterm_inject_budget: 500,
    session_inject_budget: 400,
    canon_inject_budget: 800,
  };
  const result = applyManualBudgetReset(
    { auto_tune_budgets: true, longterm_inject_budget: 3200, session_inject_budget: 3050 },
    ['longterm_inject_budget', 'session_inject_budget', 'canon_inject_budget'],
    defaults,
  );

  assert.equal(result.longterm_inject_budget, 500);
  assert.equal(result.session_inject_budget, 400);
  assert.equal(result.canon_inject_budget, 800);
  assert.equal(result.auto_tune_budgets, false);
});


