import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyManualBudget,
  applyManualBudgetReset,
  allocateBudgetWithinCap,
  normalizeTotalInjectBudget,
  sumBudgetFloors,
} from '../budget-policy.js';

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

test('minimum floors are summed only for enabled tiers', () => {
  const tiers = [
    { key: 'a', minimum: 500, enabled: true },
    { key: 'b', minimum: 400, enabled: false },
    { key: 'c', minimum: 200, enabled: true },
  ];
  assert.equal(sumBudgetFloors(tiers), 700);
});

test('current Smart Memory tier floors reserve 3750 tokens when all are enabled', () => {
  const tiers = [
    { minimum: 500 },
    { minimum: 400 },
    { minimum: 300 },
    { minimum: 700 },
    { minimum: 800 },
    { minimum: 400 },
    { minimum: 250 },
    { minimum: 200 },
    { minimum: 200 },
  ];
  assert.equal(sumBudgetFloors(tiers), 3750);
});

test('total cap is normalized upward when it cannot satisfy minimum floors', () => {
  assert.equal(normalizeTotalInjectBudget(800, 3750), 3750);
  assert.equal(normalizeTotalInjectBudget(8000, 3750), 8000);
  assert.equal(normalizeTotalInjectBudget(99999, 3750), 16000);
});

test('allocator preserves floors and spends remaining headroom on demand', () => {
  const result = allocateBudgetWithinCap(
    [
      { key: 'longterm', minimum: 500, target: 1200, enabled: true },
      { key: 'session', minimum: 400, target: 450, enabled: true },
      { key: 'disabled', minimum: 200, target: 1200, enabled: false },
    ],
    1500,
  );

  assert.deepEqual(result.allocations, { longterm: 1100, session: 400 });
  assert.equal(result.total, 1500);
  assert.equal(result.minimum_total, 900);
  assert.equal(result.unallocated, 0);
});

test('allocator never exceeds the cap after tier-step rounding', () => {
  const result = allocateBudgetWithinCap(
    [
      { key: 'a', minimum: 100, target: 999, enabled: true },
      { key: 'b', minimum: 100, target: 999, enabled: true },
      { key: 'c', minimum: 100, target: 999, enabled: true },
    ],
    500,
  );

  assert.ok(result.total <= 500);
  assert.ok(result.allocations.a >= 100);
  assert.ok(result.allocations.b >= 100);
  assert.ok(result.allocations.c >= 100);
});

test('allocator clamps an impossible cap to the minimum reserve', () => {
  const result = allocateBudgetWithinCap(
    [
      { key: 'a', minimum: 500, target: 500, enabled: true },
      { key: 'b', minimum: 400, target: 400, enabled: true },
    ],
    100,
  );

  assert.equal(result.cap, 900);
  assert.equal(result.total, 900);
  assert.deepEqual(result.allocations, { a: 500, b: 400 });
});

test('allocator respects an individual tier maximum as well as the total cap', () => {
  const result = allocateBudgetWithinCap(
    [{ key: 'a', minimum: 100, maximum: 300, target: 900, enabled: true }],
    1000,
  );

  assert.deepEqual(result.allocations, { a: 300 });
  assert.equal(result.total, 300);
  assert.equal(result.unallocated, 700);
});


