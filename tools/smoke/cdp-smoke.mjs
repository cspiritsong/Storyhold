/**
 * CDP driver for the disposable Storyhold smoke test.
 *
 * Launches headless Chromium, opens the disposable SillyTavern, selects the
 * seeded fixture chat, clicks "Scan & Memorize This Chat", waits for the
 * terminal status, and writes a pass/fail report.
 *
 * Usage: node cdp-smoke.mjs <ws-url> <data-root>
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  try {
    WebSocket = createRequire('/tmp/st-smoke-storyhold/package.json')('ws');
  } catch {
    WebSocket = createRequire('/home/badi/projects/sillybunny-dev/repo/package.json')('ws');
  }
}

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
    const { level, text, url } = msg.params.entry ?? {};
    events.push({ kind: 'log', level, text, url });
    if (level === 'error') console.log(`[log.error] ${text.slice(0, 300)} (url: ${url})`);
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

  // Assert SillyTavern settings before scan
  const contextCheck = await evaluate(`(() => {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
    const oai = ctx.chatCompletionSettings ?? {};
    const ext = ctx.extensionSettings?.smart_memory ?? {};
    return {\n      mainApi: ctx.mainApi,\n      source: oai.chat_completion_source,\n      url: oai.custom_url,\n      model: oai.custom_model,\n      stream: oai.stream_openai,\n      extSource: ext.source,\n      productMode: ext.single_extension_mode,\n    };\n  })()`);
  check('main API is openai', contextCheck.mainApi === 'openai', contextCheck.mainApi);
  check('chat completion source is custom', contextCheck.source === 'custom', contextCheck.source);
  check('custom URL is loopback', contextCheck.url === 'http://127.0.0.1:8444/v1', contextCheck.url);
  check('custom model is fake-model', contextCheck.model === 'fake-model', contextCheck.model);
  check('stream is false', contextCheck.stream === false);
  check('storyhold source is main', contextCheck.extSource === 'main', contextCheck.extSource);
  check('storyhold product mode enabled', contextCheck.productMode === true);

  // Read initial raw fixture messages before scan to verify message count and checksum preservation
  const chatPath = join(dataRoot, 'chats', 'Mira Test', 'smoke-chat.jsonl');
  check('chat file exists on disk before scan', existsSync(chatPath));
  const rawBefore = existsSync(chatPath) ? readFileSync(chatPath, 'utf8') : '';
  const linesBefore = rawBefore.split('\n').filter(Boolean);
  const msgsBefore = linesBefore.slice(1);
  const msgCountBefore = msgsBefore.length;
  const msgChecksumBefore = createHash('sha256').update(msgsBefore.join('\n')).digest('hex');

  // Reset fake provider captures before scan
  try {
    await fetch('http://127.0.0.1:8444/__storyhold/reset', { method: 'POST' });
  } catch { /* empty */ }

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

  // Verify narrative source ranges recorded in chat metadata
  const narrativeSnippets = sm.narrative?.layers?.flat?.() ?? [];
  const hasNarrativeSourceRanges = narrativeSnippets.length > 0 &&
    narrativeSnippets.every((s) => s.source_range && s.source_range.start != null && s.source_range.end != null);
  check('narrative source ranges recorded in metadata', hasNarrativeSourceRanges);

  // Any extension console error = failure surface.
  const extErrors = events.filter((e) => {
    if (e.type !== 'error' && e.level !== 'error') return false;
    if (e.text?.includes('Failed to load resource') && !e.url?.includes('Storyhold') && !e.text?.includes('Storyhold')) return false;
    return true;
  }).map((e) => (e.text ?? '').slice(0, 200));
  check('no console errors from the extension', extErrors.length === 0, extErrors[0] ?? '');

  // Query captured narrative requests from the fake provider
  try {
    const res = await fetch('http://127.0.0.1:8444/__storyhold/requests?kind=narrative');
    if (res.ok) {
      const data = await res.json();
      const narrativeRequests = data.requests ?? [];
      check('exactly one narrative request captured via main route', narrativeRequests.length === 1, `${narrativeRequests.length} requests`);
      if (narrativeRequests.length > 0) {
        const nReq = narrativeRequests[0];
        check('narrative request has exactly one user message', nReq.message_count === 1 && nReq.roles[0] === 'user');
        check('narrative request contains no live-chat-only marker', nReq.hasLiveChatMarker === false);
      }
    }
  } catch (e) {
    console.warn('Could not query fake provider requests:', e.message);
  }

  // Read the actual smart_memory_unified prompt slot from SillyTavern runtime
  const unifiedSlot = await evaluate(`(() => {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
    return ctx.extensionPrompts?.smart_memory_unified?.value ?? '';
  })()`);
  check('smart_memory_unified prompt slot populated', unifiedSlot.length > 0, `${unifiedSlot.length} chars`);
  check('unified prompt contains narrative continuity', /Rowan|bridge|promise/i.test(unifiedSlot));
  check('unified prompt contains no live-chat marker', !unifiedSlot.includes('LIVE_CHAT_ONLY_MARKER'));

  // Assert individual Storyhold slots remain empty
  const foreignSlots = await evaluate(`(() => {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
    const prompts = ctx.extensionPrompts ?? {};
    return ['smart_memory_canon', 'smart_memory_short', 'smart_memory_scenes', 'smart_memory_arcs', 'smart_memory_state_ledger']
      .map((k) => ({ key: k, value: prompts[k]?.value ?? '' }))
      .filter((p) => p.value.length > 0);
  })()`);
  check('individual storyhold prompt slots remain empty', foreignSlots.length === 0, JSON.stringify(foreignSlots));
  check('exactly one Storyhold slot active', unifiedSlot.length > 0 && foreignSlots.length === 0);

  // Test advisory and blocking injection seam in live SillyTavern runtime
  await evaluate(`(async () => {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
    if (ctx.chatMetadata?.smartMemory) {
      ctx.chatMetadata.smartMemory.narrative_stale = { reason: 'record-edited', blocks_injection: false };
    }
    await ctx.eventSource?.emit(ctx.eventTypes?.MESSAGE_SWIPED);
  })()`);
  await sleep(1000);
  const advisorySlot = await evaluate(`(() => {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
    return ctx.extensionPrompts?.smart_memory_unified?.value ?? '';
  })()`);
  check('advisory stale marker preserves narrative in prompt slot', /Rowan|bridge|promise/i.test(advisorySlot));

  await evaluate(`(async () => {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
    if (ctx.chatMetadata?.smartMemory) {
      ctx.chatMetadata.smartMemory.narrative_stale = { reason: 'unknown-block', blocks_injection: true };
    }
    await ctx.eventSource?.emit(ctx.eventTypes?.MESSAGE_SWIPED);
  })()`);
  await sleep(1000);
  const blockingSlot = await evaluate(`(() => {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
    return ctx.extensionPrompts?.smart_memory_unified?.value ?? '';
  })()`);
  check('blocking stale marker withholds narrative from prompt slot', !/Rowan|bridge|promise/i.test(blockingSlot));

  // Reset narrative_stale back to clean before reload
  await evaluate(`(async () => {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
    if (ctx.chatMetadata?.smartMemory) {
      delete ctx.chatMetadata.smartMemory.narrative_stale;
    }
    await ctx.eventSource?.emit(ctx.eventTypes?.MESSAGE_SWIPED);
  })()`);
  await sleep(1000);

  // Reload page, reopen the fixture chat, and verify prompt persists from persisted metadata
  await evaluate('window.location.reload()');
  await sleep(3000);
  await waitFor('document.readyState === "complete"', 'page reload');
  await waitFor('typeof SillyTavern !== "undefined"', 'SillyTavern global');
  await sleep(3000);

  // Dismiss onboarding if shown
  await evaluate(`(() => {
    const save = [...document.querySelectorAll('.popup .menu_button, .popup button')].find((b) => /Save/i.test(b.textContent ?? ''));
    if (save) save.click();
  })()`);
  await sleep(2000);

  // Select character
  await evaluate(`(() => {
    const btn = document.getElementById('rm_button_characters');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(2000);
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('#rm_print_characters_block .character_select')];
    const target = items.find((el) => (el.querySelector('.ch_name')?.textContent ?? '').trim() === 'Mira Test');
    if (target) target.click();
    return true;
  })()`);
  await sleep(2500);

  // Open fixture chat
  await evaluate(`(() => {
    const btn = document.getElementById('option_select_chat');
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(2000);
  await evaluate(`(() => {
    const items = [...document.querySelectorAll('#select_chat_div .select_chat_block')];
    const target = items.find((el) => (el.querySelector('.select_chat_block_filename')?.textContent ?? '').includes('smoke-chat'));
    if (target) target.click();
    return true;
  })()`);
  await sleep(3000);

  const reloadedUnified = await evaluate(`(() => {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : {};
    return ctx.extensionPrompts?.smart_memory_unified?.value ?? '';
  })()`);
  check('smart_memory_unified persists after chat reload', reloadedUnified.length > 0 && /mira|key|altar|temple|shrine|seal/i.test(reloadedUnified), `${reloadedUnified.length} chars`);

  // Verify raw fixture message count and checksum preserved across scan and reload
  const rawAfter = existsSync(chatPath) ? readFileSync(chatPath, 'utf8') : '';
  const linesAfter = rawAfter.split('\n').filter(Boolean);
  const msgsAfter = linesAfter.slice(1);
  const msgCountAfter = msgsAfter.length;
  const msgChecksumAfter = createHash('sha256').update(msgsAfter.join('\n')).digest('hex');
  check('raw fixture message count preserved across scan and reload', msgCountBefore === msgCountAfter && msgCountAfter === 11, `${msgCountBefore} == ${msgCountAfter}`);
  check('raw fixture message checksum preserved across scan and reload', msgChecksumBefore === msgChecksumAfter);

  // Trigger normal reply after capture reset and require reply request contains unified envelope
  try {
    await fetch('http://127.0.0.1:8444/__storyhold/reset', { method: 'POST' });
    await evaluate(`(async () => {
      $('#api_button_openai').trigger('click');
      await new Promise(r => setTimeout(r, 1000));
      $('#send_textarea').val('What happened at the ruined bridge?').trigger('input');
      await new Promise(r => setTimeout(r, 200));
      $('#send_but').trigger('click');
    })()`);
    await sleep(4000);
    const replyRes = await fetch('http://127.0.0.1:8444/__storyhold/requests?kind=reply');
    if (replyRes.ok) {
      const replyData = await replyRes.json();
      const replyReqs = replyData.requests ?? [];
      check('normal reply request captured after reset', replyReqs.length >= 1, `${replyReqs.length} requests`);
      if (replyReqs.length > 0) {
        const replyText = JSON.stringify(replyReqs[0].messages ?? []);
        check('reply request contains unified envelope', replyText.includes('storyhold-memory-data') && /Rowan|bridge|promise/i.test(replyText));
      }
    }
  } catch (e) {
    console.warn('Reply trigger/capture failed:', e.message);
  }

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
