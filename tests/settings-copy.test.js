import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function visibleButtonLabels(html) {
  const labels = new Map();
  const buttonPattern = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  for (const match of html.matchAll(buttonPattern)) {
    const id = match[1].match(/\bid="([^"]+)"/i)?.[1];
    if (!id) continue;
    const label = match[2]
      .replace(/<span\s+class="sm-info"[\s\S]*?<\/span>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#10;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    labels.set(id, label);
  }
  return labels;
}

function sectionLabels(html) {
  return [...html.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi)].map((match) =>
    match[1]
      .replace(/<span\s+class="sm-info"[\s\S]*?<\/span>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/ⓘ/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

test('memory actions say exactly what they read or change', async () => {
  const html = await readFile(resolve(root, 'settings.html'), 'utf8');
  const labels = visibleButtonLabels(html);

  const expected = {
    sm_catch_up: 'Scan & Memorize This Chat',
    sm_rescan_chat: 'Scan This Chat Again',
    sm_scan_duplicates: 'Find & Remove Duplicate Memories',
    sm_clear_chat_context: 'Delete All Memory for This Chat',
    sm_rebuild_branch: "Rebuild Memory for This Branch",
    sm_extract_now: 'Scan Recent Messages for This Character',
    sm_clear_memories: "Delete This Character's Long-term Memory",
    sm_extract_session_now: 'Save Recent Chat Details',
    sm_clear_session: 'Delete Recent Details for This Chat',
    sm_extract_scenes_now: 'Save Current Scene',
    sm_clear_scenes: 'Delete Scene History',
    sm_extract_arcs_now: 'Find Open Story Threads',
    sm_clear_arcs: 'Delete Story Threads',
    sm_generate_canon: 'Create Story History',
    sm_profiles_regenerate: 'Update Character & World Summary',
    sm_add_relationship: 'Add Relationship',
    sm_clear_relationships: 'Delete All Relationships',
    sm_epistemic_add: 'Add Knowledge Entry',
    sm_epistemic_clear: 'Delete All Knowledge Entries',
    sm_recap_now: 'Show Chat Recap',
    sm_open_graph_btn: 'Show Memory Map',
    sm_check_continuity: 'Check Last Reply for Story Mistakes',
    sm_model_test_btn: 'Test Memory Model',
  };

  for (const [id, label] of Object.entries(expected)) {
    assert.equal(labels.get(id), label, `${id} should use clear plain-language copy`);
  }

  assert.match(html, /These actions affect this chat only\./);
  assert.match(html, /In a group chat, select a character to view that\s+character's memory\./);

  const actionStart = html.indexOf('<button id="sm_catch_up"');
  const actionEnd = html.indexOf('<!-- Chat memory status and read-only previews -->', actionStart);
  const actionBlock = html.slice(actionStart, actionEnd);
  assert.doesNotMatch(actionBlock, /canonical|projection|namespace|lineage|vector/i);
  assert.match(actionBlock, /whole current chat/i);
  assert.match(actionBlock, /selected character/i);
  assert.match(actionBlock, /chat text/i);
});

test('feature sections use words roleplayers can understand', async () => {
  const html = await readFile(resolve(root, 'settings.html'), 'utf8');
  const sections = sectionLabels(html);

  for (const label of [
    'Important Facts',
    'Recent Chat Details',
    'Chat Summary',
    'Scenes',
    'Open Story Threads',
    'Automatic Memory Cleanup',
    'Story History',
    'Character & World Summary',
    'Relationships',
    'What Characters Know',
    'Current Details',
    'Catch-up Recap',
    'People, Places & Things',
    'Check for Story Mistakes',
    'Setup',
  ]) {
    assert.ok(sections.includes(label), `section ${label} should be understandable`);
  }
});

test('full-chat action help explains the target and the difference between scanning and rescanning', async () => {
  const html = await readFile(resolve(root, 'settings.html'), 'utf8');
  const tooltips = [...html.matchAll(/data-tooltip="([^"]*)"/g)].map((match) => match[1]);

  assert.ok(
    tooltips.some((text) => /whole current chat/i.test(text) && /selected character/i.test(text)),
    'full-chat help should name both the chat and the selected character',
  );
  assert.ok(
    tooltips.some((text) => /whole current chat again/i.test(text) && /saved memory for this chat/i.test(text)),
    'rescan help should explain that it reads the whole chat again and changes saved memory',
  );
  assert.ok(
    tooltips.some((text) => /selected character.*long-term memories/i.test(text) && /does not scan the chat/i.test(text)),
    'duplicate help should say that it only checks stored memories',
  );
});

test('legacy product-mode messages are written for users, not implementers', async () => {
  const source = await readFile(resolve(root, 'settings.js'), 'utf8');

  assert.match(source, /This tool is not available in the current memory mode/);
  assert.match(source, /The main chat scan already handles this automatically/);
  assert.doesNotMatch(source, /is managed by the canonical Product Memory pipeline/);
});
