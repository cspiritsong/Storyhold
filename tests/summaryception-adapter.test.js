import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngestWindow } from '../projections.js';
import { createSummaryceptionAdapter } from '../summaryception-adapter.js';

const window = buildIngestWindow({
  chatUid: 'chat-uid-a',
  branchUid: 'branch-uid-a',
  messages: [
    { mesId: 101, name: 'Badi', is_user: true, mes: 'Mira takes the silver key.' },
    { mesId: 102, name: 'Mira', is_user: false, mes: 'I will help you open the door.' },
  ],
  sourceRange: { kind: 'mesId', start: 101, end: 102 },
});

test('Summaryception adapter records a narrative delta with shared provenance', async () => {
  const snippets = [];
  const project = createSummaryceptionAdapter({
    appendSnippet: async (snippet) => snippets.push(snippet),
  });

  const records = await project(window, {
    summarySnippet: {
      layer: 0,
      text: 'Mira takes the silver key and promises to help open the door.',
    },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'narrative_delta');
  assert.equal(records[0].owner, 'smart-memory:narrative-chain');
  assert.equal(records[0].scope.chat_uid, 'chat-uid-a');
  assert.deepEqual(records[0].source_range, { kind: 'mesId', start: 101, end: 102 });
  assert.deepEqual(snippets, [
    {
      layer: 0,
      text: 'Mira takes the silver key and promises to help open the door.',
      source_range: { kind: 'mesId', start: 101, end: 102 },
      source_chat_uid: 'chat-uid-a',
      source_branch_uid: 'branch-uid-a',
      record_id: records[0].id,
    },
  ]);
});

test('Summaryception adapter never reclassifies fact-looking text as structured memory', async () => {
  const project = createSummaryceptionAdapter();
  const records = await project(window, {
    summarySnippet: {
      text: '[fact] The silver key opens the temple door.',
      layer: 1,
    },
  });

  assert.equal(records[0].kind, 'narrative_delta');
  assert.equal(records[0].owner, 'smart-memory:narrative-chain');
  assert.notEqual(records[0].kind, 'fact');
});

test('Summaryception adapter skips an empty snippet without writing', async () => {
  let writes = 0;
  const project = createSummaryceptionAdapter({
    appendSnippet: async () => {
      writes++;
    },
  });

  assert.deepEqual(await project(window, { summarySnippet: { text: '   ' } }), []);
  assert.equal(writes, 0);
});
