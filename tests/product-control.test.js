import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedProductControl } from '../product-control.js';

test('Product control reservations are owned and overlap-safe', () => {
  const control = createOwnedProductControl();
  const first = control.reserve({ generation: 1, chatId: 'chat-a' });

  assert.ok(first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(control.reserve({ generation: 1, chatId: 'chat-a' }), null);
  assert.equal(control.isHeld(), true);
  assert.equal(control.release({}), false);
  assert.equal(control.isHeld(), true);
  assert.equal(control.release(first), true);
  assert.equal(control.isHeld(), false);
});

test('invalidating a Product control prevents stale cleanup from releasing a newer owner', () => {
  const control = createOwnedProductControl();
  const stale = control.reserve({ generation: 1, chatId: 'old' });
  control.invalidate();
  const current = control.reserve({ generation: 2, chatId: 'new' });

  assert.ok(stale);
  assert.ok(current);
  assert.notEqual(stale, current);
  assert.equal(control.release(stale), false);
  assert.equal(control.isHeld(), true);
  assert.equal(control.release(current), true);
  assert.equal(control.isHeld(), false);
});
