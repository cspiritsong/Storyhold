import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProductState, partitionEpistemicRecords, filterEpistemicRecordsForSubject, scopeProductStatus } from '../product-status.js';

test('product status summarizes narrative, typed records, windows, and failures', () => {
  const summary = summarizeProductState({
    smartMemory: {
      narrative: {
        layers: [[{ text: 'first' }, { text: 'second' }], [{ text: 'promoted' }]],
      },
      structured_records: [
        { kind: 'fact', content: 'A fact.' },
        { kind: 'fact', content: 'Retired fact.', superseded_by: 'new-fact' },
        { kind: 'session', content: 'A revelation.' },
        { kind: 'state', content: 'Current state.' },
        { kind: 'arc', content: 'Open thread.' },
        { kind: 'epistemic', content: 'Private knowledge.' },
      ],
      ingest_windows: {
        first: { status: 'completed', failures: [] },
        second: { status: 'partial', failures: [{ projection: 'structured' }] },
        third: { status: 'quarantined', failures: [] },
      },
      product_cursor: { last_mes_id: 12 },
      product_status: { phase: 'finished' },
    },
  });

  assert.equal(summary.hasData, true);
  assert.equal(summary.narrativeLayers, 2);
  assert.equal(summary.narrativeSnippets, 3);
  assert.equal(summary.totalRecords, 6);
  assert.equal(summary.activeRecords, 5);
  assert.deepEqual(summary.recordCounts, {
    fact: 2,
    event: 0,
    relationship: 0,
    session: 1,
    state: 1,
    arc: 1,
    epistemic: 1,
  });
  assert.deepEqual(summary.activeRecordCounts, {
    fact: 1,
    event: 0,
    relationship: 0,
    session: 1,
    state: 1,
    arc: 1,
    epistemic: 1,
  });
  assert.equal(summary.windowsTotal, 3);
  assert.equal(summary.completedWindows, 1);
  assert.equal(summary.partialWindows, 1);
  assert.equal(summary.quarantinedWindows, 1);
  assert.equal(summary.failedProjections, 1);
  assert.equal(summary.cursor.last_mes_id, 12);
  assert.equal(summary.lastStatus.phase, 'finished');
});

test('epistemic product records separate spoiler types from safe perspectives', () => {
  const partition = partitionEpistemicRecords([
    { type: 'knows', content: 'Public knowledge.' },
    { type: 'suspects', content: 'A suspicion.' },
    { type: 'believes', content: 'A false belief.' },
    { type: 'hiding', content: 'A hidden secret.' },
    { type: 'hidden knowledge', content: 'An unknown epistemic secret.' },
    { type: 'HIDING', content: 'An uppercase hidden secret.' },
  ]);

  assert.deepEqual(partition.visible.map((record) => record.type), ['knows', 'suspects']);
  assert.deepEqual(partition.spoiler.map((record) => record.type), [
    'believes',
    'hiding',
    'hidden knowledge',
    'HIDING',
  ]);
});

test('epistemic product records can be scoped to the selected character', () => {
  const records = [
    { subject: 'Mira', type: 'knows', content: 'Mira knows the route.' },
    { subject: 'Tomas', type: 'knows', content: 'Tomas knows the password.' },
  ];

  assert.deepEqual(
    filterEpistemicRecordsForSubject(records, 'mira').map((record) => record.subject),
    ['Mira'],
  );
  assert.deepEqual(filterEpistemicRecordsForSubject(records, null), []);
});

test('product status scope drops foreign windows, cursor, and status', () => {
  const scoped = scopeProductStatus({
    chat_uid: 'chat-a',
    branch_uid: 'branch-a',
    ingest_windows: {
      current: { chat_uid: 'chat-a', branch_uid: 'branch-a', status: 'completed' },
      foreign: { chat_uid: 'chat-b', branch_uid: 'branch-a', status: 'completed' },
      sibling: { chat_uid: 'chat-a', branch_uid: 'branch-b', status: 'completed' },
    },
    product_cursor: { chat_uid: 'chat-b', branch_uid: 'branch-a', last_index: 99 },
    product_status: { chat_uid: 'chat-b', branch_uid: 'branch-a', phase: 'finished' },
  }, { chatUid: 'chat-a', branchUid: 'branch-a' });

  assert.deepEqual(Object.keys(scoped.ingest_windows), ['current']);
  assert.equal(scoped.product_cursor, null);
  assert.equal(scoped.product_status, null);
});

test('empty metadata reports no product data without throwing', () => {
  const summary = summarizeProductState({});
  assert.equal(summary.hasData, false);
  assert.equal(summary.totalRecords, 0);
  assert.equal(summary.narrativeText, '');
  assert.equal(summary.windowsTotal, 0);
});
