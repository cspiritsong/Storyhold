import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectIndexOnlyBranch,
  detectProcessedWindowChanges,
  inheritedPrefixMatchesLiveChat,
  sourceRangeMatchesLiveChat,
  detectSummaryChanges,
} from '../branch-detection.js';
import {
  detectTruncation,
  firstIndexAfterMesId,
  getMesIdWindow,
  pruneMemoriesByBranchPoint,
  pruneStateLedgerByBranchPoint,
} from '../branch-aware.js';
import { fingerprintMessages } from '../projections.js';

const messages = [
  { name: 'Badi', is_user: true, mes: 'Start.' },
  { name: 'Mira', is_user: false, mes: 'The clue.' },
  { name: 'Badi', is_user: true, mes: 'Continue.' },
];

function windowState(start, end, sourceMessages = messages.slice(start, end + 1)) {
  return {
    source_range: { kind: 'index', start, end },
    fingerprint: fingerprintMessages(sourceMessages),
  };
}

test('firstIndexAfterMesId does not skip mesId-less messages', () => {
  const chat = [{ mes: 'sparse start.' }, { mesId: 30 }, { mes: 'sparse tail.' }];
  assert.equal(firstIndexAfterMesId(chat, 20), 0);
});

test('getMesIdWindow replays from an unprovable sparse message', () => {
  const chat = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'The clue.' },
    { name: 'Badi', is_user: true, mes: 'Sparse continuation.' },
    { mesId: 30, name: 'Mira', is_user: false, mes: 'The reply.' },
  ];
  const window = getMesIdWindow(chat, 20, 2, 10);
  assert.equal(window.length, 3);
  assert.equal(window[2].mes, 'Sparse continuation.');
});

test('index-only branch detector accepts an unchanged processed window', () => {
  const result = detectIndexOnlyBranch(messages, { first: windowState(0, 2) });
  assert.deepEqual(result, { truncated: false, branchPointIndex: null });
});

test('index-only branch detector finds the first changed processed window', () => {
  const changed = [...messages];
  changed[1] = { name: 'Mira', is_user: false, mes: 'A different clue.' };
  const result = detectIndexOnlyBranch(changed, { first: windowState(0, 2) });
  assert.deepEqual(result, { truncated: true, branchPointIndex: -1 });
});

test('processed mesId windows detect deleted source messages', () => {
  const numericMessages = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'The clue.' },
    { mesId: 30, name: 'Badi', is_user: true, mes: 'Continue.' },
  ];
  const current = [numericMessages[0], numericMessages[2]];
  const result = detectProcessedWindowChanges(current, {
    first: {
      source_range: { kind: 'mesId', start: 10, end: 30 },
      fingerprint: fingerprintMessages(numericMessages),
    },
  });

  assert.deepEqual(result, { truncated: true, branchPointIndex: -1 });
});

test('processed mesId windows detect content changes after the watermark', () => {
  const numericMessages = [
    { mesId: 1, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 2, name: 'Mira', is_user: false, mes: 'The clue.' },
    { mesId: 3, name: 'Badi', is_user: true, mes: 'Continue.' },
  ];
  const changed = [...numericMessages];
  changed[2] = { ...changed[2], mes: 'A divergent continuation.' };
  const result = detectProcessedWindowChanges(changed, {
    first: {
      source_range: { kind: 'mesId', start: 0, end: 2 },
      fingerprint: fingerprintMessages(numericMessages),
    },
  });

  assert.equal(result.truncated, true);
  assert.equal(result.branchPointIndex, -1);
});

test('processed mesId windows detect sparse insertions via the persisted array endpoint', () => {
  const numericMessages = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 20, name: 'Mira', is_user: false, mes: 'The clue.' },
    { mesId: 30, name: 'Badi', is_user: true, mes: 'Continue.' },
  ];
  const current = [
    numericMessages[0],
    { name: 'Badi', is_user: true, mes: 'Imported insertion.' },
    numericMessages[1],
    numericMessages[2],
  ];
  const result = detectProcessedWindowChanges(current, {
    first: {
      source_range: { kind: 'mesId', start: 10, end: 30 },
      fingerprint: fingerprintMessages(numericMessages),
      end_index: 2,
    },
  });

  assert.deepEqual(result, { truncated: true, branchPointIndex: -1 });
});

test('processed mesId windows reject an endpoint whose mesId disagrees with the range end', () => {
  const current = [
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Start.' },
    { mesId: 11, name: 'Mira', is_user: false, mes: 'The clue.' },
    { mesId: 10, name: 'Badi', is_user: true, mes: 'Duplicated endpoint.' },
    { mesId: 12, name: 'Mira', is_user: false, mes: 'The next reply.' },
  ];
  const result = detectProcessedWindowChanges(current, {
    malformed: {
      source_range: { kind: 'mesId', start: 10, end: 11 },
      fingerprint: fingerprintMessages(current.slice(0, 3)),
      end_index: 2,
    },
  });

  assert.deepEqual(result, { truncated: true, branchPointIndex: -1 });
});

test('summary watermark detects a truncated summarized tail', () => {
  const chat = [{ mes: 'one' }, { mes: 'two' }, { mes: 'three' }];
  assert.deepEqual(
    detectSummaryChanges(chat, { summary: 'old', summaryEnd: 5 }),
    { truncated: true, branchPointIndex: -1 },
  );
});

test('summary source proof detects an edited covered range', () => {
  const original = [{ mes: 'one' }, { mes: 'two' }];
  const changed = [{ mes: 'one' }, { mes: 'changed' }];
  assert.deepEqual(
    detectSummaryChanges(changed, {
      summary: 'old',
      summaryEnd: 2,
      summary_source_message_range: [0, 1],
      summary_source_fingerprint: fingerprintMessages(original),
    }),
    { truncated: true, branchPointIndex: -1 },
  );
  assert.deepEqual(
    detectSummaryChanges(original, {
      summary: 'old',
      summaryEnd: 2,
      summary_source_message_range: [0, 1],
      summary_source_fingerprint: fingerprintMessages(original),
    }),
    { truncated: false, branchPointIndex: null },
  );
});

test('processed prefix fingerprints detect edits before an inherited boundary', () => {
  const changed = [...messages];
  changed[0] = { ...changed[0], mes: 'A changed inherited opening.' };
  const result = detectProcessedWindowChanges(changed, {}, {
    prefix_length: messages.length,
    prefix_fingerprint: fingerprintMessages(messages),
  });

  assert.deepEqual(result, { truncated: true, branchPointIndex: -1 });
});

test('index-only branch detector treats a shortened window as a branch', () => {
  const result = detectIndexOnlyBranch(messages.slice(0, 2), { first: windowState(0, 2) });
  assert.deepEqual(result, { truncated: true, branchPointIndex: -1 });
});

test('invalidated mesId window with no surviving numeric prefix returns a conservative boundary', () => {
  const current = [{ name: 'Badi', is_user: true, mes: 'Imported text.' }];
  const result = detectProcessedWindowChanges(current, {
    stale: {
      source_range: { kind: 'mesId', start: 10, end: 20 },
      fingerprint: fingerprintMessages([
        { mesId: 10, name: 'Badi', is_user: true, mes: 'Old text.' },
      ]),
    },
  });

  assert.deepEqual(result, { truncated: true, branchPointIndex: -1 });
});

test('verified inherited prefix reports a mismatch after an in-file edit', () => {
  const prefix = {
    prefix_length: 2,
    prefix_fingerprint: fingerprintMessages(messages.slice(0, 2)),
  };
  const edited = [...messages];
  edited[1] = { ...edited[1], mes: 'Edited inherited message.' };

  assert.equal(inheritedPrefixMatchesLiveChat(messages, prefix), true);
  assert.equal(inheritedPrefixMatchesLiveChat(edited, prefix), false);
});

test('processed cursor fingerprints detect edits when ingest windows are unavailable', () => {
  const edited = [...messages];
  edited[1] = { ...edited[1], mes: 'A changed processed message.' };
  const result = detectProcessedWindowChanges(
    edited,
    {},
    null,
    {
      source_range: { kind: 'index', start: 0, end: 2 },
      fingerprint: fingerprintMessages(messages),
      last_index: 2,
    },
  );

  assert.deepEqual(result, { truncated: true, branchPointIndex: -1 });
});

test('full prefix replacement has no surviving numeric branch boundary', () => {
  assert.deepEqual(detectTruncation([{ mesId: 200, mes: 'replacement' }], 100), {
    truncated: true,
    branchPointMesId: null,
  });
});

test('no numeric prefix prunes mesId-backed legacy records but keeps unknown provenance', () => {
  const memories = pruneMemoriesByBranchPoint(
    [
      { id: 'zero', source_mes_range: [0, 0] },
      { id: 'tail', source_mes_range: [10, 20] },
      { id: 'unknown' },
    ],
    null,
  );
  const ledger = pruneStateLedgerByBranchPoint(
    {
      zero: { _updated_mes_id: 0 },
      tail: { _updated_mes_id: 20 },
      unknown: { content: 'unproven' },
    },
    null,
  );

  assert.deepEqual(memories.removed.map((item) => item.id), ['zero', 'tail']);
  assert.deepEqual(memories.kept.map((item) => item.id), ['unknown']);
  assert.deepEqual(Object.keys(ledger.kept), ['unknown']);
  assert.deepEqual(ledger.removed.map((item) => item.key), ['zero', 'tail']);
});

test('branch pruning removes index-ranged and unproven legacy entries when requested', () => {
  const result = pruneMemoriesByBranchPoint(
    [
      { id: 'prefix', source_message_range: [0, 1] },
      { id: 'tail', source_message_range: [2, 4] },
      { id: 'unproven', content: 'unknown source' },
    ],
    null,
    1,
    { dropUnverifiable: true },
  );

  assert.deepEqual(result.kept.map((item) => item.id), ['prefix']);
  assert.deepEqual(result.removed.map((item) => item.id), ['tail', 'unproven']);
});

test('state ledger pruning removes index-ranged tail cards on sparse branches', () => {
  const result = pruneStateLedgerByBranchPoint(
    {
      prefix: { _source_message_range: [0, 1] },
      tail: { _source_message_range: [2, 4] },
      unproven: { content: 'unknown source' },
    },
    null,
    1,
    { dropUnverifiable: true },
  );

  assert.deepEqual(Object.keys(result.kept), ['prefix']);
  assert.deepEqual(result.removed.map((item) => item.key), ['tail', 'unproven']);
});

test('mixed mesId and index boundaries preserve valid index-ranged state cards', () => {
  const result = pruneStateLedgerByBranchPoint(
    {
      prefix: { _source_message_range: [0, 1], value: 'before branch' },
      tail: { _source_message_range: [2, 3], value: 'dead tail' },
    },
    20,
    1,
    { dropUnverifiable: true },
  );

  assert.deepEqual(Object.keys(result.kept), ['prefix']);
  assert.deepEqual(result.removed.map(({ key }) => key), ['tail']);
});

test('mesId source validation rejects inconsistent persisted endpoints', () => {
  const chat = [
    { mesId: 10, mes: 'start' },
    { mesId: 20, mes: 'middle' },
    { mesId: 30, mes: 'end' },
  ];
  const range = { kind: 'mesId', start: 10, end: 20 };
  const fingerprint = fingerprintMessages(chat.slice(0, 2));

  assert.equal(sourceRangeMatchesLiveChat(chat, range, fingerprint, 1, 1), true);
  assert.equal(sourceRangeMatchesLiveChat(chat, range, fingerprint, 2, 1), false);
  assert.equal(sourceRangeMatchesLiveChat(chat, range, fingerprint, 2, 2), false);
});
