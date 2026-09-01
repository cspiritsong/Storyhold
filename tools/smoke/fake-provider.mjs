/**
 * Fake OpenAI-compatible provider for the disposable Storyhold smoke.
 *
 * Serves POST /v1/chat/completions on a loopback port and returns scripted
 * responses that look like a sloppy model:
 *   - structured extraction prompt -> JSON payload with grounded facts,
 *     a fabricated fact (zero transcript evidence), a ghost citation,
 *     a mixed citation, and a garbage relationship magnitude
 *   - anything else -> one-line narrative summary
 *
 * Usage: node fake-provider.mjs <port>
 */

import http from 'node:http';

const port = Number(process.argv[2] ?? 8444);

function completion(content) {
  return {
    id: 'fake-1',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

const EXTRACTION_PAYLOAD = {
  facts: [
    { content: 'Mira carries the silver key she took from the shrine altar.' },
    { content: 'The avatar of the Forgotten Forge awakens beneath the drowned citadel of Vash.' },
  ],
  events: [
    { content: 'The temple door remains sealed despite attempts at the lock.' },
    { content: 'The temple bells ring once although nobody is near the bell tower.', source_messages: [88888] },
    { content: 'The priest confesses the seals on the lower level are weakening.', source_messages: [205, 77777] },
  ],
  relationships: [
    { subject: 'Mira', target: 'Kael', descriptors: [{ word: 'trust', magnitude: 61 }, { word: 'fear', magnitude: 9000 }] },
  ],
  arcs: [
    { content: 'Mira explores the weakened seal below the moonlit shrine.', status: 'active' },
  ],
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let prompt = '';
    try {
      const parsed = JSON.parse(body);
      const last = (parsed.messages ?? []).at(-1);
      prompt = last?.content ?? '';
    } catch { /* keep empty */ }
    const isExtraction = prompt.includes('Extract only meaningful changes');
    const isNarrative = prompt.includes('narrative-state tracker');
    let content;
    if (isExtraction) {
      content = JSON.stringify(EXTRACTION_PAYLOAD);
    } else if (isNarrative) {
      content = 'Mira descends toward the weakening amber seal below the moonlit shrine.';
    } else {
      content = 'Mira looks up at the sound and waits, uncertain.';
    }
    const payload = completion(content);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake provider listening on 127.0.0.1:${port}`);
});
