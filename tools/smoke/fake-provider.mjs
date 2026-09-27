/**
 * Fake OpenAI-compatible provider for the disposable Storyhold smoke.
 *
 * Serves POST /v1/chat/completions on a loopback port and returns scripted
 * responses that look like a sloppy model:
 *   - structured extraction prompt -> JSON payload with grounded facts,
 *     a fabricated fact (zero transcript evidence), a ghost citation,
 *     a mixed citation, and a garbage relationship magnitude
 *   - narrative delta prompt -> compact narrative continuity delta
 *   - anything else -> normal assistant reply
 *
 * Exposes loopback inspection endpoints:
 *   POST /__storyhold/reset
 *   GET /__storyhold/requests?kind=narrative|structured|reply
 *
 * Usage: node fake-provider.mjs <port>
 */

import http from 'node:http';
import { URL } from 'node:url';

const port = Number(process.argv[2] ?? 8444);

function completion(content) {
  return {
    id: `fake-${Date.now()}`,
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

let capturedRequests = [];
let nextSeq = 1;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);

  // Loopback reset endpoint
  if (req.method === 'POST' && reqUrl.pathname === '/__storyhold/reset') {
    capturedRequests = [];
    nextSeq = 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Loopback request inspection endpoint
  if (req.method === 'GET' && reqUrl.pathname === '/__storyhold/requests') {
    const kind = reqUrl.searchParams.get('kind');
    if (!['narrative', 'structured', 'reply'].includes(kind)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid kind: expected narrative, structured, or reply' }));
      return;
    }
    const filtered = capturedRequests.filter((r) => r.classification === kind);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ requests: filtered }));
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
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch { /* empty */ }

    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const allText = messages.map((m) => String(m?.content ?? '')).join('\n');
    const lastPrompt = String(messages.at(-1)?.content ?? '');

    // Classify request
    let classification = 'reply';
    if (lastPrompt.includes('Extract only meaningful changes') || allText.includes('Extract only meaningful changes')) {
      classification = 'structured';
    } else if (
      lastPrompt.includes('narrative-state tracker') ||
      lastPrompt.includes('Role: precise narrative-state tracker') ||
      allText.includes('narrative-state tracker')
    ) {
      classification = 'narrative';
    }

    // Record bounded request metadata: max 12k/message and 32k aggregate (never persist auth header)
    let aggregateChars = 0;
    const sanitizedMessages = [];
    for (const m of messages.slice(0, 20)) {
      if (aggregateChars >= 32000) break;
      const budgetRemaining = 32000 - aggregateChars;
      const perMsgCap = Math.min(12000, budgetRemaining);
      const text = String(m.content ?? '').slice(0, perMsgCap);
      aggregateChars += text.length;
      sanitizedMessages.push({
        role: m.role,
        content: text,
      });
    }

    const record = {
      sequence_id: nextSeq++,
      timestamp: Date.now(),
      url: req.url,
      classification,
      model: parsed.model ?? null,
      stream: Boolean(parsed.stream),
      max_tokens: parsed.max_tokens ?? null,
      message_count: messages.length,
      roles: messages.map((m) => m.role),
      messages: sanitizedMessages.slice(0, 20),
      hasLiveChatMarker: allText.includes('LIVE_CHAT_ONLY_MARKER'),
      hasFoundation: allText.includes('FOUNDATION:'),
      hasCause: allText.includes('CAUSE:'),
      hasEmotionalConsequence: allText.includes('EMOTIONAL_CONSEQUENCE:'),
      hasUnresolvedTension: allText.includes('UNRESOLVED_TENSION:'),
    };

    capturedRequests.push(record);
    if (capturedRequests.length > 50) capturedRequests.shift();

    let content;
    if (classification === 'structured') {
      content = JSON.stringify(EXTRACTION_PAYLOAD);
    } else if (classification === 'narrative') {
      content = 'CAUSE: Rowan broke his promise to protect Kael. EMOTIONAL_CONSEQUENCE: Mira feels betrayed and refuses Rowan help at the bridge. UNRESOLVED_TENSION: Kael is trapped while Rowan asks for one last chance.';
    } else {
      content = 'Mira watches Rowan across the ruined bridge, holding the seal tightly in her cold hands.';
    }

    const payload = completion(content);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake provider listening on 127.0.0.1:${port}`);
});
