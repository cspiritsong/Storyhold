/**
 * CDP driver for the disposable Storyhold smoke test.
 *
 * Launches headless Chromium, opens the disposable SillyTavern, selects the
 * seeded fixture chat, clicks "Scan & Memorize This Chat", waits for the
 * terminal status, and writes a pass/fail report.
 *
 * Usage: node cdp-smoke.mjs <ws-url> <data-root>
 */

import WebSocket from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const wsUrl = process.argv[2];
const dataRoot = process.argv[3] ?? '/tmp/st-smoke-storyhold/data/default-user';

let nextId = 1;
const pending = new Map();
const events = [];

const ws = new WebSocket(wsUrl);
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

function onMessage(raw) {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const type = msg.params.type;
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    events.push({ kind: 'console', type, text });
    if (type === 'error') console.log(`[console.error] ${text.slice(0, 300)}`);
  }
  if (msg.method === 'Log.entryAdded') {
    const { level, text } = msg.params.entry ?? {};
    events.push({ kind: 'log', level, text });
    if (level === 'error') console.log(`[log.error] ${text.slice(0, 300)}`);
  }
}

ws.on('message', onMessage);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
  }
  return result.result?.value;
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
}

async function waitFor(expression, label, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evaluate(expression)) return true;
    } catch { /* keep polling */ }
    await sleep(500);
  }
  check(`timeout waiting for ${label}`, false);
  return false;
}

try {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Page.navigate', { url: 'http://127.0.0.1:8123/' });
  await sleep(3000);

  await waitFor('document.readyState === "complete"', 'page load');
  await waitFor('typeof SillyTavern !== "undefined"', 'SillyTavern global');

  // First-run onboarding popup blocks app init until dismissed.
  const onboarding = await evaluate(`(() => {
    const save = [...document.querySelectorAll('.popup .menu_button, .popup button')].find((b) => /Save/i.test(b.textContent ?? ''));
    if (save) { save.click(); return 'dismissed'; }
    return 'none';
  })()`);
  await sleep(4000);
  await waitFor('[...document.querySelectorAll(".popup")].filter((p) => getComputedStyle(p).display !== "none").length === 0', 'onboarding dismissed', 15000);
  check('first-run onboarding dismissed', onboarding === 'dismissed' || (await evaluate('[...document.querySelectorAll(".popup")].filter((p) => getComputedStyle(p).display !== "none").length === 0')), onboarding);

  // The extension's runtime should have registered itself (module-scope
  // variables are not on window; presence of its settings panel proves it).
  check('storyhold extension loaded', await evaluate('!!document.getElementById("sm_catch_up") && !!document.querySelector("#sm_product_status_panel")'));

  // Open the fixture chat: character list click + chat selection.
  await evaluate(`(() => {
    const btn = document.getElementById('rm_button_characters');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(2000);
  const clickedChar = await evaluate(`(() => {
    const items = [...document.querySelectorAll('#rm_print_characters_block .character_select')];
    const target = items.find((el) => (el.querySelector('.ch_name')?.textContent ?? '').trim() === 'Mira Test');
    if (!target) return 'no-character';
    target.click();
    return 'clicked';
  })()`);
  check('fixture character clickable', clickedChar === 'clicked', clickedChar);
  await sleep(2500);

  // Select the smoke-chat via the Past Chats popup.
  await evaluate(`(() => {
    const btn = document.getElementById('option_select_chat');
    if (btn) { btn.click(); return 'opened'; }
    return 'no-button';
  })()`);
  await sleep(2000);
  const clickedChat = await evaluate(`(() => {
    const items = [...document.querySelectorAll('#select_chat_div .select_chat_block')];
    const target = items.find((el) => (el.querySelector('.select_chat_block_filename')?.textContent ?? '').includes('smoke-chat'));
    if (!target) return 'no-chat';
    target.click();
    return 'clicked';
  })()`);
  check('fixture chat clickable', clickedChat === 'clicked', clickedChat);
  await sleep(2500);

  // Click "Scan & Memorize This Chat" (#sm_catch_up).
  const clicked = await evaluate(`(() => {
    const btn = document.querySelector('#sm_catch_up');
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`);
  check('memorize button present and clicked', clicked === 'clicked', clicked);

  // Wait for terminal product status text.
  await waitFor(`(() => {
    const el = document.querySelector('#sm_product_status_message');
    return el && /finished|complete|cancelled|failed|incomplete/.test(el.textContent);
  })()`, 'terminal product status', 60000);
  const status = await evaluate(`document.querySelector('#sm_product_status_message')?.textContent ?? ''`);
  check('terminal status visible', /finished|complete|cancelled|incomplete/.test(status), status.slice(0, 200));

  // Wait a moment for metadata save, then read the chat file from disk.
  await sleep(2500);
  const chatPath = join(dataRoot, 'chats', 'Mira Test', 'smoke-chat.jsonl');
  check('chat file exists on disk', existsSync(chatPath));
  const raw = existsSync(chatPath) ? readFileSync(chatPath, 'utf8') : '';
  const lines = raw.split('\n').filter(Boolean);
  const first = JSON.parse(lines[0] ?? '{}');
  const metadata = first.chat_metadata ?? {};
  const sm = metadata.smartMemory ?? {};
  const records = Array.isArray(sm.structured_records) ? sm.structured_records : [];
  const ingestWindows = sm.ingest_windows ?? {};
  const windowEntries = Object.values(ingestWindows);
  const coverage = windowEntries.find((w) => w.coverage)?.coverage;

  const grounded = records.some((r) => String(r.content).includes('silver key'));
  const fabricated = records.some((r) => /forgotten forge/i.test(String(r.content)));
  const ghost = records.some((r) => /bells ring/i.test(String(r.content)));
  const trust = records.find((r) => String(r.content).includes('trust(61)'));
  const unverified = records.some((r) => Array.isArray(r.provenance?.citation_unverified));

  check('structured records persisted to chat metadata', records.length > 0, `${records.length} records`);
  check('grounded fact survived end-to-end', grounded);
  check('fabricated fact rejected end-to-end', !fabricated);
  check('ghost-citation event rejected end-to-end', !ghost);
  check('bounded magnitude survived', trust !== undefined);
  check('citation_unverified stamped', unverified);
  check('coverage persisted', coverage !== undefined && Number.isInteger(coverage.uncovered_count),
    coverage ? `uncovered=${coverage.uncovered_count}` : 'none');

  // Any extension console error = failure surface.
  const extErrors = events.filter((e) => e.type === 'error' || e.level === 'error')
    .map((e) => (e.text ?? '').slice(0, 200));
  check('no console errors from the extension', extErrors.length === 0, extErrors[0] ?? '');

  const failures = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failures.length}/${checks.length} smoke checks green`);
  process.exitCode = failures.length === 0 ? 0 : 1;
} catch (err) {
  console.error('CDP driver crashed:', err.message);
  process.exitCode = 2;
} finally {
  ws.close();
  await sleep(300);
}
