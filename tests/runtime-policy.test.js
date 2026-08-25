import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProductMode,
  shouldInjectDirectRepair,
  shouldRunProductIngest,
  enabledProductKinds,
  filterProductRecords,
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
    ['fact', 'state', 'epistemic', 'session'],
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
