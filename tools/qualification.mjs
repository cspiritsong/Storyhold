/**
 * Storyhold headless qualification rig.
 *
 * Replays a synthetic chat through the REAL product pipeline (runtime-ingest +
 * product-runtime) with a scripted "sloppy model" so grounding gates,
 * citation containment, hygiene, bounded magnitudes, and coverage are
 * exercised without SillyTavern, a provider, or Badi's Mac.
 *
 * Usage: node tools/qualification.mjs   (exit 0 = all assertions green)
 */

/* global process */

import { buildWindowFromChat } from '../runtime-ingest.js';
import { createProductPipeline } from '../product-runtime.js';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}

// ---- Synthetic fixture chat (30 messages worth of ordinary roleplay) ----

const script = [
  'Mira steps into the moonlit shrine and kneels before the altar.',
  'The old priest watches her from the doorway, saying nothing at all.',
  '<div>Mira takes the silver key from the shrine altar.</div>',
  '“Careful,” the priest finally says, “that key has waited a long time.”',
  'Thinking about the wards, Mira slides the silver key into her pocket.',
  'Kael hums an unfamiliar sea shanty somewhere beyond the courtyard wall.',
  'The temple door remains sealed despite every attempt at the lock.',
  'Yes.',
  'Mira studies the carved runes and whispers a half-remembered prayer.',
  'Rain begins to fall through the broken roof above the inner chamber.',
  'The priest admits the temple guards abandoned their post years ago.',
  'Mira promises to return the silver key before the next full moon.',
  'Kael finally appears in the doorway carrying two steaming cups of tea.',
  'The temple bells ring once although nobody is near the bell tower.',
  'Mira notices the silver key grows warm when the bells sound.',
  'A cold draft extinguishes every candle except the one beside the altar.',
  'The priest confesses the seals on the lower level are weakening daily.',
  'Mira decides to descend at dawn while the remaining guard changes shift.',
  'Kael refuses to go below and asks Mira not to make him regret it.',
  'The silver key hums faintly as Mira holds it toward the sealed door.',
  'Mira trusts Kael again after he shares the map he hidden for years.',
  'The hidden stair reveals itself behind the fallen altar stone.',
  'Dust settles over ancient frescoes depicting the founding of Miraven.',
  'Mira sketches the frescoes quickly into her travel journal.',
  'The priest waits upstairs, praying the seals hold until her return.',
  'Below, the weakening seal pulses with a dim amber light.',
  'Mira reaches out and touches the pulsing surface of the old seal.',
  'The corridor behind her collapses into rubble without any warning sound.',
  'Kael shouts her name from somewhere far above through the stairwell.',
  'Mira steadies herself and turns back toward the amber pulse.',
];

const chat = script.map((mes, i) => ({
  mesId: 100 + i,
  name: i % 2 === 0 ? 'Mira' : (i % 3 === 0 ? 'Kael' : 'Priest'),
  is_user: i % 2 === 0,
  mes,
}));

// A message deliberately never mentioned by any scripted record.
chat.push({ mesId: 999, name: 'Narrator', is_user: false, mes: 'A marble gargoyle winks at nobody in particular.' });

// ---- The scripted sloppy model ----

function sloppyModel({ window }) {
  const first = window.source_range.start;
  return {
    facts: [
      // (a) grounded, should survive
      { content: 'Mira carries the silver key she took from the shrine altar.', source_messages: [first + 2] },
      // (b) invented, zero lexical evidence, should be rejected as ungrounded
      { content: 'The avatar of the Forgotten Forge awakens beneath the drowned citadel of Vash.' },
      // (c) heavy paraphrase near the overlap floor, calibration probe: should survive
      { content: 'Mira quietly pocketed the shimmering silver key and slipped away before dawn.' },
    ],
    events: [
      // (d) valid in-window citation
      { content: 'The temple door remains sealed despite attempts at the lock.', source_messages: [first + 6] },
      // (e) ghost citation only, should be rejected as ungrounded-citation
      { content: 'The temple bells ring once although nobody is near the bell tower.', source_messages: [88888] },
      // (f) partially ghost citation: survives, stamped citation_unverified
      { content: 'The priest confesses the seals on the lower level are weakening.', source_messages: [first + 16, 77777] },
    ],
    relationships: [
      // (g) one garbage magnitude, one valid
      { subject: 'Mira', target: 'Kael', descriptors: [{ word: 'trust', magnitude: 61 }, { word: 'fear', magnitude: 9000 }] },
    ],
    session: [
      { type: 'detail', content: 'Routine decorative description of dust settling.' },
    ],
    arcs: [
      { content: 'Mira explores the weakened seal below the moonlit shrine.', status: 'active' },
    ],
  };
}

// ---- Run ----

const metadata = {};
let capturedPrompt = '';
const pipeline = createProductPipeline({
  metadata,
  saveMetadata: async () => {},
  summarizeNarrative: async () => 'The party continues exploring the shrine.',
  extractStructured: async ({ window, prompt }) => {
    capturedPrompt = prompt;
    return sloppyModel({ window });
  },
});

const built = buildWindowFromChat({ chat, chatUid: 'qual-chat-uid', startIndex: 0, endIndex: chat.length - 1 });
const result = await pipeline.ingest(built);

const records = metadata.smartMemory?.structured_records ?? [];
const byContent = (needle) => records.find((r) => String(r.content).toLowerCase().includes(needle));
const windowState = metadata.smartMemory?.ingest_windows?.[built.window_id];

check('pipeline reaches a terminal completed status', ['completed', 'partial'].includes(result.status), `status=${result.status}`);

check('grounded fact admitted', byContent('silver key she took') !== undefined);
check('invented fact rejected (ungrounded)', byContent('forgotten forge') === undefined);
check('heavy paraphrase admitted (calibration)', byContent('quietly pocketed the shimmering') !== undefined);
check('valid in-window event admitted', byContent('remains sealed') !== undefined);
check('ghost-citation event rejected', byContent('bells ring') === undefined);
const partial = byContent('seals on the lower level are weakening');
check('mixed citation survives with unverified stamp',
  partial !== undefined && Array.isArray(partial.provenance?.citation_unverified)
  && partial.provenance.citation_unverified.includes(77777));
const rel = records.find((r) => r.kind === 'relationship');
check('garbage magnitude dropped, valid magnitude kept',
  rel !== undefined && rel.content.includes('trust(61)') && !rel.content.includes('9000'));
// Declared retention is enforced; mislabeling (decorative text as 'session')
// is not semantic judgment's job — the coverage/Explorer layers handle review.
check('self-declared session candidate admitted with session retention',
  byContent('dust settling')?.retention === 'session');
check('narrative retention candidate kept out of structured store',
  !records.some((r) => r.retention === 'narrative'));

check('coverage persisted on window state', Number.isInteger(windowState?.coverage?.uncovered_count),
  JSON.stringify(windowState?.coverage ?? null).slice(0, 160));
check('unmentioned gargoyle message is uncovered',
  (windowState?.coverage?.uncovered ?? []).some((u) => u.mesId === 999));

check('prompt hygiene: no raw HTML reached the model', !capturedPrompt.includes('<div>'));
check('prompt hygiene: visible text preserved', capturedPrompt.includes('Mira takes the silver key from the shrine altar.'));
check('window fingerprint preserved raw (recovery anchor)', typeof built.fingerprint === 'string' && built.fingerprint.length > 0);

// ---- Report ----

const failures = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}
console.log(`\n${results.length - failures.length}/${results.length} qualification checks green`);
process.exit(failures.length === 0 ? 0 : 1);
