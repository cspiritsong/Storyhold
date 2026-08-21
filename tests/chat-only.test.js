import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('Smart-Memory exposes one chat-only memory scope', async () => {
  const [scopeSource, settingsSource, html] = await Promise.all([
    readFile(resolve(root, 'scope.js'), 'utf8'),
    readFile(resolve(root, 'settings.js'), 'utf8'),
    readFile(resolve(root, 'settings.html'), 'utf8'),
  ]);

  assert.match(scopeSource, /export function getMemoryScope\(\)\s*\{\s*return MEMORY_SCOPE_CHAT;/);
  assert.match(scopeSource, /const chatId = getChatScopeId\(\);\s+if \(chatId == null\) return null;/);
  assert.match(settingsSource, /memory_scope: MEMORY_SCOPE_CHAT/);
  assert.match(settingsSource, /current\.memory_scope = MEMORY_SCOPE_CHAT/);
  assert.doesNotMatch(html, /value="character"/);
  assert.doesNotMatch(html, /sm_fresh_start_button/);
  assert.match(html, /Clear Chat Memory/);
});

test('chat memory reset is the only destructive memory action', async () => {
  const [html, settingsSource] = await Promise.all([
    readFile(resolve(root, 'settings.html'), 'utf8'),
    readFile(resolve(root, 'settings.js'), 'utf8'),
  ]);

  assert.match(html, /id="sm_clear_chat_context"/);
  assert.match(settingsSource, /WILL SURVIVE: the raw chat transcript, the character card, and other chats/);
  assert.doesNotMatch(html, /Wipe Character Memory/);
  assert.doesNotMatch(html, /Fresh Start/);
});
