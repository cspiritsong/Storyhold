import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isProductMode,
  shouldInjectDirectRepair,
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
