import test from 'node:test';
import assert from 'node:assert/strict';
import { admitStructuredRecords } from '../admission-policy.js';
import { analyzeMessageCoverage, windowEvidenceText } from '../grounding.js';
import { narrativeText } from '../runtime-pipeline.js';
import { buildIngestWindow } from '../projections.js';
import { createIngestQueue } from '../ingest-queue.js';
import { buildStructuredExtractionPrompt, normalizeStructuredRecords } from '../structured-records.js';

// Concept absorbed from community summarizer workflows (deterministic, no API
// calls): candidates must share lexical evidence with the source window, model
// citations must stay inside the window, and every completed window reports
// which input messages the derived memory failed to cover.

const sourceText = 'Mira takes the silver key from the shrine. The temple door remains sealed.';

const candidate = (overrides = {}) => ({
  id: overrides.id ?? 'record',
  kind: overrides.kind ?? 'fact',
  content: overrides.content ?? 'Mira takes the silver key.',
  confidence: overrides.confidence ?? 0.9,
  ...overrides,
});

test('grounding gate rejects candidates with no lexical evidence in the window', () => {
  const result = admitStructuredRecords([
    candidate({ id: 'grounded', content: 'Mira takes the silver key.' }),
    candidate({ id: 'fabricated', content: 'The avatar of the Forgotten Forge awakens beneath Miraven.' }),
    candidate({ id: 'short-ack', content: 'Yes.' }),
  ], { sourceText });

  assert.deepEqual(result.accepted.map((record) => record.id).sort(), ['grounded', 'short-ack']);
  assert.deepEqual(
    result.rejected.map((item) => [item.record.id, item.reason]),
    [['fabricated', 'ungrounded']],
  );
  assert.equal(result.stats.rejected_by_reason.ungrounded, 1);
});

test('grounding and citation gates stay off when no evidence window is supplied', () => {
  const result = admitStructuredRecords([
    candidate({ id: 'fabricated', content: 'The avatar of the Forgotten Forge awakens beneath Miraven.' }),
  ]);

  assert.deepEqual(result.accepted.map((record) => record.id), ['fabricated']);
  assert.deepEqual(result.rejected, []);
});

const windowFor = (overrides = {}) => buildIngestWindow({
  chatUid: 'chat-uid-a',
  branchUid: 'branch-uid-a',
  messages: [
    { mesId: 101, name: 'Badi', is_user: true, mes: sourceText },
  ],
  sourceRange: { kind: 'mesId', start: 101, end: 101 },
  ...overrides,
});

test('citation gate rejects wholly out-of-window provenance unless inherited', () => {
  const inheritedRecord = candidate({
    id: 'stored',
    provenance: { source_messages: [90] },
  });
  const result = admitStructuredRecords([
    candidate({ id: 'inherited-cite', content: 'The temple door remains sealed.', provenance: { source_messages: [90] } }),
    candidate({ id: 'ghost-cite', content: 'Mira takes the silver key.', provenance: { source_messages: [999] } }),
    candidate({ id: 'mixed-cite', content: 'The shrine holds the silver key.', provenance: { source_messages: [101, 999] } }),
  ], {
    sourceText,
    existingRecords: [inheritedRecord],
    citationRange: { kind: 'mesId', start: 101, end: 101 },
  });

  const accepted = result.accepted.map((record) => record.id).sort();
  assert.deepEqual(accepted, ['inherited-cite', 'mixed-cite']);
  assert.deepEqual(
    result.rejected.map((item) => [item.record.id, item.reason]),
    [['ghost-cite', 'ungrounded-citation']],
  );
  const inherited = result.accepted.find((record) => record.id === 'inherited-cite');
  assert.deepEqual(inherited.provenance.citation_unverified, [90]);
  const mixed = result.accepted.find((record) => record.id === 'mixed-cite');
  assert.deepEqual(mixed.provenance.citation_unverified, [999]);
});

test('citation gate ignores index-scale ranges and defaulted provenance', () => {
  const indexed = candidate({
    id: 'idx',
    content: 'Mira takes the silver key.',
    source_range: { kind: 'index', start: 0, end: 3 },
    provenance: { source_messages: [7] },
  });
  const defaulted = candidate({
    id: 'dflt',
    content: 'The temple door remains sealed.',
    source_range: { kind: 'mesId', start: 101, end: 101 },
    provenance: {},
  });
  const result = admitStructuredRecords([indexed, defaulted], { sourceText });

  assert.deepEqual(result.accepted.map((record) => record.id).sort(), ['dflt', 'idx']);
});

test('nested pair citations are understood and flattened', () => {
  const result = admitStructuredRecords([
    candidate({
      id: 'pair',
      content: 'Mira takes the silver key.',
      source_range: { kind: 'mesId', start: 101, end: 102 },
      provenance: { source_messages: [[101, 102]] },
    }),
  ], { sourceText });

  assert.deepEqual(result.accepted.map((record) => record.id), ['pair']);
  assert.equal(result.accepted[0].provenance.citation_unverified, undefined);
});

test('window evidence text skips system and empty messages', () => {
  const window = windowFor({
    messages: [
      { mesId: 101, name: 'Badi', is_user: true, mes: 'Mira takes the key.' },
      { mesId: 102, is_system: true, mes: '<div>System notice</div>' },
      { mesId: 103, name: 'Mira', mes: '   ' },
    ],
  });
  assert.equal(windowEvidenceText(window), 'Mira takes the key.');
});

test('normalizeStructuredRecords grounds candidates against the window transcript', () => {
  const window = windowFor();
  const records = normalizeStructuredRecords({
    facts: [
      { content: 'The temple door remains sealed.' },
      { content: 'The avatar of the Forgotten Forge awakens beneath Miraven.' },
    ],
  }, window);

  assert.deepEqual(records.map((record) => record.content), ['The temple door remains sealed.']);
});

test('extraction prompt asks for in-window source message citations', () => {
  const prompt = buildStructuredExtractionPrompt({ chatText: sourceText });

  assert.match(prompt, /source_messages/);
  assert.match(prompt, /only cite message ids from the current passage/i);
});

test('message coverage finds input messages the derived memory never mentions', () => {
  const messages = [
    { mesId: 1, name: 'Badi', is_user: true, mes: 'Mira takes the silver key from the shrine.' },
    { mesId: 2, name: 'Mira', is_user: false, mes: 'The temple door remains sealed and the runes stay dark.' },
    { mesId: 3, name: 'Badi', is_user: true, mes: 'Yes.' },
    { mesId: 4, name: 'Kael', is_user: false, mes: 'Kael lights a torch and hums an old sea shanty.' },
    { mesId: 5, is_system: true, mes: 'This system message should never count.' },
  ];
  const records = [
    { content: 'Mira takes the silver key.' },
    { content: 'The sealed temple door does not respond to the runes.' },
  ];

  const report = analyzeMessageCoverage(messages, records);

  assert.equal(report.checked, 3);
  assert.equal(report.covered, 2);
  assert.equal(report.uncovered_count, 1);
  assert.deepEqual(report.uncovered.map((entry) => entry.mesId), [4]);
  assert.ok(report.uncovered[0].preview.includes('shanty'));
});

test('coverage is stable across runs and tolerant of empty inputs', () => {
  const messages = [{ mesId: 1, mes: 'Kael lights a torch.' }];
  const first = analyzeMessageCoverage(messages, []);
  const second = analyzeMessageCoverage(messages, []);

  assert.deepEqual(first, second);
  assert.equal(first.checked, 1);
  assert.equal(first.uncovered_count, 1);
  assert.deepEqual(analyzeMessageCoverage([], []), { checked: 0, covered: 0, uncovered_count: 0, uncovered: [] });
});

test('ingest queue attaches a coverage report to completed window state', async () => {
  const stored = new Map();
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: {
      structured: async () => [
        { id: 'fact-a', kind: 'fact', content: 'Mira takes the silver key from the shrine.' },
      ],
    },
  });
  const window = buildIngestWindow({
    chatUid: 'chat-uid-a',
    messages: [
      { mesId: 101, name: 'Badi', is_user: true, mes: 'Mira takes the silver key from the shrine.' },
      { mesId: 102, name: 'Kael', is_user: false, mes: 'Kael lights a torch and hums an old sea shanty outside.' },
    ],
    sourceRange: { kind: 'mesId', start: 101, end: 102 },
  });

  const result = await queue.ingest(window);

  assert.equal(result.status, 'completed');
  assert.ok(result.coverage);
  assert.equal(result.coverage.uncovered_count, 1);
  assert.deepEqual(result.coverage.uncovered.map((entry) => entry.mesId), [102]);
  const persisted = stored.get(window.window_id);
  assert.equal(persisted.coverage.uncovered_count, 1);
});

test('window-complete progress surfaces the uncovered message count', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf("case 'window_complete':");
  const end = source.indexOf("case 'finished':", start);
  assert.ok(start >= 0 && end > start, 'window_complete branch exists in progress messages');
  const block = source.slice(start, end);
  assert.match(block, /uncoveredCount/);
  assert.match(block, /not yet covered/);
});

test('model-call text hygiene strips markup noise without touching stored text', async () => {
  const { cleanMessageText } = await import('../grounding.js');

  assert.equal(cleanMessageText('Mira takes the <br>silver key.</p>'), 'Mira takes the silver key.');
  assert.equal(cleanMessageText('Line one\n<div class="note">Line two</div>'), 'Line one\nLine two');
  assert.equal(
    cleanMessageText('Answer.\n```js\nconst x = 1;\n```\nMore.'),
    'Answer.\nMore.',
  );
  assert.equal(
    cleanMessageText('<thinking>internal reasoning here</thinking>Visible text.'),
    'Visible text.',
  );
  assert.equal(cleanMessageText('   '), '');
  assert.equal(cleanMessageText(null), '');
  // Plain text passes through untouched.
  assert.equal(cleanMessageText('Mira takes the silver key.'), 'Mira takes the silver key.');
});

test('narrative and extraction prompt text is cleaned before reaching the model', () => {
  const dirty = {
    mesId: 101, name: 'Mira', is_user: false,
    mes: '<div>The <b>temple door</b> remains sealed.</div>',
  };
  assert.equal(narrativeText({ messages: [dirty] }), 'Assistant: The temple door remains sealed.');

  const prompt = buildStructuredExtractionPrompt({
    chatText: windowEvidenceText({ messages: [dirty] }),
  });
  assert.ok(prompt.includes('The temple door remains sealed.'));
  assert.ok(!prompt.includes('<div>'));
  assert.ok(!prompt.includes('<b>'));
});

test('window evidence text is cleaned for grounding checks', () => {
  const window = windowFor({
    messages: [
      { mesId: 101, name: 'Badi', is_user: true, mes: 'Mira takes the <em>silver key</em> from the shrine.' },
    ],
  });
  assert.equal(windowEvidenceText(window), 'Mira takes the silver key from the shrine.');
});

test('quarantined windows record no coverage report', async () => {
  const stored = new Map();
  const queue = createIngestQueue({
    load: (id) => stored.get(id),
    save: (id, state) => stored.set(id, structuredClone(state)),
    projectors: { structured: async () => [] },
  });
  const window = windowFor({ lineage: { quarantined: true } });

  const result = await queue.ingest(window);

  assert.equal(result.status, 'quarantined');
  assert.equal(result.coverage, undefined);
});
