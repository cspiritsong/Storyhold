import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureProductOperationIdentity,
  createProductOperationGate,
} from '../product-operation.js';

test('product operation identity captures generation, chat, uid, and responder', () => {
  const identity = captureProductOperationIdentity({
    generation: 7,
    chatId: 'chat-name',
    chatUid: 'stable-chat-uid',
    responder: 'Mira',
  });

  assert.deepEqual(identity, {
    generation: 7,
    chatId: 'chat-name',
    chatUid: 'stable-chat-uid',
    responder: 'Mira',
  });
  assert.equal(Object.isFrozen(identity), true);
});

test('product operation gate shares one in-flight operation', async () => {
  const gate = createProductOperationGate();
  let calls = 0;
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const operation = async () => {
    calls++;
    await wait;
    return 'completed';
  };

  const first = gate.run(operation);
  const second = gate.run(operation);
  assert.equal(gate.isRunning(), true);
  assert.strictEqual(first, second);
  release();

  assert.equal(await first, 'completed');
  assert.equal(calls, 1);
  assert.equal(gate.isRunning(), false);
});

test('product operation gate queues a different chat key instead of sharing it', async () => {
  const gate = createProductOperationGate();
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const first = gate.run(async () => {
    calls.push('chat-a');
    await wait;
    return 'a';
  }, 'chat-a');
  const second = gate.run(async () => {
    calls.push('chat-b');
    return 'b';
  }, 'chat-b');

  assert.notStrictEqual(first, second);
  assert.equal(gate.isRunning('chat-a'), true);
  assert.equal(gate.isRunning('chat-b'), true);
  release();

  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(calls, ['chat-a', 'chat-b']);
  assert.equal(gate.isRunning(), false);
});

test('product operation gate permits a later operation after completion', async () => {
  const gate = createProductOperationGate();
  const first = await gate.run(async () => 'first', 'chat-a');
  const second = await gate.run(async () => 'second', 'chat-a');

  assert.deepEqual([first, second], ['first', 'second']);
});
