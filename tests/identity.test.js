import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMessage, hash32 } from '../identity.js';

test('shared identity helpers preserve canonical message shape and FNV output', () => {
  const message = { mesId: 99, name: 'Mira', is_user: false, is_system: false, mes: '  Hello\r\nworld  ' };

  assert.equal(
    canonicalMessage(message),
    JSON.stringify({ name: 'Mira', is_user: false, is_system: false, mes: 'Hello world' }),
  );
  assert.equal(hash32('abc', 0x811c9dc5), '1a47e90b');
});
