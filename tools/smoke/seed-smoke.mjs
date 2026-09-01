/**
 * Seed script for the disposable Storyhold smoke environment.
 *
 * Creates a character card PNG (chara_card_v2 in the 'chara' tEXt chunk),
 * a chat JSONL with known facts + the deliberately unmentioned gargoyle
 * message, and a settings.json extension block pointing Storyhold at the
 * fake OpenAI-compatible provider.
 */

import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';


const dataRoot = process.argv[2] ?? '/tmp/st-smoke-storyhold/data/default-user';

const characterName = 'Mira Test';
const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: characterName,
    description: 'A moonlit shrine keeper testing Storyhold memory.',
    personality: 'careful, quiet',
    scenario: 'A shrine, a silver key, a sealed temple door.',
    first_mes: 'You find me beside the altar. The key has waited a long time.',
    mes_example: '',
    creator_notes: 'disposable smoke fixture',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['smoke'],
    creator: 'qualification-rig',
    character_version: '1.0',
    extensions: {},
  },
};

// ---- Character card PNG with 'chara' tEXt chunk ----
const png = new PNG({ width: 2, height: 2 });
for (let i = 0; i < png.data.length; i++) png.data[i] = 120;
const raw = PNG.sync.write(png);
// pngjs doesn't add text chunks on sync.write; append a tEXt chunk manually.
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  return Buffer.concat([len, typeBuf, data, crc32(Buffer.concat([typeBuf, data]))]);
}
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return Buffer.from([(crc ^ -1) >>> 24 & 255, (crc ^ -1) >>> 16 & 255, (crc ^ -1) >>> 8 & 255, (crc ^ -1) & 255]);
}

// Rebuild the PNG cleanly: signature + IHDR + tEXt + IDAT + IEND.
function rebuildPng(source, textJson) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  // parse IHDR and IDAT from source
  let offset = 8;
  const ihdr = source.subarray(offset, offset + 25);
  offset += 25;
  const idat = [];
  while (offset < source.length) {
    const len = source.readUInt32BE(offset);
    const type = source.toString('ascii', offset + 4, offset + 8);
    const data = source.subarray(offset + 8, offset + 8 + len);
    if (type === 'IDAT') idat.push(Buffer.from(data));
    offset += 12 + len;
  }
  const keyword = Buffer.from('chara', 'ascii');
  const textData = Buffer.concat([keyword, Buffer.from([0]), Buffer.from(Buffer.from(textJson, 'utf8').toString('base64'), 'ascii')]);
  return Buffer.concat([sig, ihdr, chunk('tEXt', textData), chunk('IDAT', Buffer.concat(idat)), chunk('IEND', Buffer.alloc(0))]);
}

const cardPng = rebuildPng(raw, JSON.stringify(card));
const charactersDir = join(dataRoot, 'characters');
mkdirSync(charactersDir, { recursive: true });
writeFileSync(join(charactersDir, 'Mira Test.png'), cardPng);
console.log('character card written');

// ---- Chat JSONL ----
const messages = [
  'Mira steps into the moonlit shrine and kneels before the altar.',
  'The old priest watches her from the doorway, saying nothing at all.',
  'Mira takes the silver key from the shrine altar.',
  'The temple door remains sealed despite every attempt at the lock.',
  'Mira trusts Kael again after he shares the map he hidden for years.',
  'The priest confesses the seals on the lower level are weakening daily.',
  'A marble gargoyle winks at nobody in particular.',
].map((mes, i) => ({
  mes,
  name: i % 2 === 0 ? 'Mira' : 'Priest',
  is_user: i % 2 === 0,
  mesId: 200 + i,
  send_date: new Date().toISOString(),
}));
// First line carries chat metadata per ST convention.
const chatMeta = { chat_metadata: { note: 'disposable smoke fixture' } };
const chatDir = join(dataRoot, 'chats', 'Mira Test');
mkdirSync(chatDir, { recursive: true });
const lines = [JSON.stringify(chatMeta), ...messages.map((m) => JSON.stringify(m))];
writeFileSync(join(chatDir, 'smoke-chat.jsonl'), lines.join('\n'));
console.log('chat jsonl written with', messages.length, 'messages');

// ---- Settings: Storyhold extension block ----
const settingsPath = join(dataRoot, 'settings.json');
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
settings.extension_settings = settings.extension_settings ?? {};
settings.extension_settings.smart_memory = {
  ...(settings.extension_settings.smart_memory ?? {}),
  source: 'openai_compatible',
  openai_compat_url: 'http://127.0.0.1:8444',
  openai_compat_model: 'fake-model',
  openai_compat_key: '',
  // Avoid the Ollama probe noise that would trip the console-error check.
  embedding_enabled: false,
};
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log('settings.json patched');
