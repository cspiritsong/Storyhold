import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProductMode,
  shouldInjectDirectRepair,
  shouldRunProductIngest,
  enabledProductKinds,
  filterProductRecords,
  narrativeInjectionAllowed,
} from '../runtime-policy.js';

test('product mode is enabled only by the explicit product setting', () => {
  assert.equal(isProductMode({ single_extension_mode: true }), true);
  assert.equal(isProductMode({ single_extension_mode: false }), false);
  assert.equal(isProductMode({}), false);
});

test('direct continuity repair is suppressed in product mode', () => {
  assert.equal(shouldInjectDirectRepair({ single_extension_mode: true }), false);
  assert.equal(shouldInjectDirectRepair({ single_extension_mode: false }), true);
});

test('enabled product kinds match the product category toggles', () => {
  assert.deepEqual(
    enabledProductKinds({
      longterm_enabled: true,
      relationships_enabled: false,
      state_ledger_enabled: true,
      arcs_enabled: false,
      epistemic_enabled: true,
      session_enabled: true,
    }),
    ['fact', 'event', 'state', 'epistemic', 'session'],
  );
});

test('product record filtering enforces enabled categories and epistemic subject scope', () => {
  const records = [
    { id: 'fact-a', kind: 'fact' },
    { id: 'relationship-a', kind: 'relationship' },
    { id: 'mira-secret', kind: 'epistemic', subject: 'Mira', type: 'hiding' },
    { id: 'tomas-secret', kind: 'epistemic', subject: 'Tomas', type: 'hiding' },
    { id: 'unknown-type', kind: 'epistemic', subject: 'Tomas', type: 'hidden knowledge' },
  ];

  assert.deepEqual(
    filterProductRecords(records, {
      longterm_enabled: true,
      relationships_enabled: false,
      epistemic_enabled: true,
    }, 'Tomas').map((record) => record.id),
    ['fact-a', 'tomas-secret'],
  );
});

test('product record filtering honors unaware and secondhand settings', () => {
  const records = [
    { id: 'direct-fact', kind: 'fact', witnessed_by: ['Tomas'] },
    { id: 'secondhand-fact', kind: 'fact', witnessed_by: ['Mira'] },
    { id: 'unaware', kind: 'epistemic', subject: 'Tomas', type: 'unaware' },
    { id: 'knows', kind: 'epistemic', subject: 'Tomas', type: 'knows' },
  ];
  const base = {
    longterm_enabled: true,
    epistemic_enabled: true,
    epistemic_inject_unaware: false,
    epistemic_secondhand_framing: false,
  };

  assert.deepEqual(filterProductRecords(records, base, 'Tomas').map((record) => record.id), [
    'direct-fact',
    'knows',
  ]);
  assert.deepEqual(
    filterProductRecords(records, { ...base, epistemic_secondhand_framing: true }, 'Tomas')
      .map((record) => record.id),
    ['direct-fact', 'secondhand-fact', 'knows'],
  );
});

test('product ingest is suppressed for fresh-start and quarantined chats', () => {
  const settings = { single_extension_mode: true };
  assert.equal(shouldRunProductIngest(settings, { freshStart: false, lineageQuarantined: false }), true);
  assert.equal(shouldRunProductIngest(settings, { freshStart: true, lineageQuarantined: false }), false);
  assert.equal(shouldRunProductIngest(settings, { freshStart: false, lineageQuarantined: true }), false);
  assert.equal(shouldRunProductIngest({ single_extension_mode: false }, {}), false);
  assert.equal(shouldRunProductIngest({ single_extension_mode: true, enabled: false }, {}), false);
  assert.equal(shouldRunProductIngest({ single_extension_mode: true }, { controlBusy: true }), false);
});

test('narrative injection allowed enforces complete advisory vs blocking marker matrix', () => {
  // absent marker allows
  assert.equal(narrativeInjectionAllowed(null), true);
  assert.equal(narrativeInjectionAllowed(undefined), true);
  assert.equal(narrativeInjectionAllowed(), true);

  // explicit blocks_injection boolean takes precedence over reason
  assert.equal(narrativeInjectionAllowed({ blocks_injection: false }), true);
  assert.equal(narrativeInjectionAllowed({ blocks_injection: true }), false);
  assert.equal(narrativeInjectionAllowed({ blocks_injection: false, reason: 'unverifiable-source' }), true);
  assert.equal(narrativeInjectionAllowed({ blocks_injection: true, reason: 'record-edited' }), false);

  // legacy markers with known advisory reasons when blocks_injection is absent
  assert.equal(narrativeInjectionAllowed({ reason: 'record-edited' }), true);
  assert.equal(narrativeInjectionAllowed({ reason: 'records-changed' }), true);
  assert.equal(narrativeInjectionAllowed({ reason: 'timeline-edited' }), true);

  // unknown reason without explicit boolean blocks
  assert.equal(narrativeInjectionAllowed({ reason: 'unverifiable-source' }), false);
  assert.equal(narrativeInjectionAllowed({ reason: 'unknown-reason' }), false);

  // malformed markers fail closed (block)
  assert.equal(narrativeInjectionAllowed('stale'), false);
  assert.equal(narrativeInjectionAllowed(123), false);
  assert.equal(narrativeInjectionAllowed(true), false);
  assert.equal(narrativeInjectionAllowed(false), false);
  assert.equal(narrativeInjectionAllowed([]), false);
  assert.equal(narrativeInjectionAllowed({}), false);
  assert.equal(narrativeInjectionAllowed({ reason: '' }), false);
  assert.equal(narrativeInjectionAllowed({ reason: 123 }), false);
  assert.equal(narrativeInjectionAllowed({ blocks_injection: 'false' }), false);
  assert.equal(narrativeInjectionAllowed({ blocks_injection: 0 }), false);
});
