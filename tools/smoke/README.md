# Disposable SillyTavern browser smoke (S2 rig)

Runs Storyhold's **actual packaged payload** inside a throwaway SillyTavern
instance with a fake OpenAI-compatible provider — full UI click-through of
"Scan & Memorize This Chat" without Badi's Mac, a real provider, or any
external network. Verified 2026-09-01 against SillyTavern release `8172dcd`
(1.18.0) and the 1.16.0 payload: 15/15 checks green.

## Prerequisites (one-time)

- Node 22
- A headless Chromium with CDP. This machine keeps one in
  `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`; any
  `--headless=new --remote-debugging-port=9222` Chrome works.

## Bootstrap

```bash
# 1. Throwaway SillyTavern (never the real install)
rm -rf /tmp/st-smoke-storyhold
git clone --depth 1 --branch release https://github.com/SillyTavern/SillyTavern.git /tmp/st-smoke-storyhold
cd /tmp/st-smoke-storyhold && npm install --no-audit --no-fund

# 2. Copy the built extension payload
mkdir -p public/scripts/extensions/third-party/Storyhold
cp -r /home/badi/projects/Smart-Memory/dist/extension-payload/* public/scripts/extensions/third-party/Storyhold/

# 3. Fake provider (loopback, CORS-enabled, scripted "sloppy model")
node fake-provider.mjs 8444 &

# 4. Seed fixture card + chat + settings, then boot ST with isolated data
node seed-smoke.mjs /tmp/st-smoke-storyhold/data/default-user
node server.js --dataRoot /tmp/st-smoke-storyhold/data --port 8123 \
  --enableIPv6 false --enableIPv4 true --browserLaunchEnabled false --listen false &

# 5. Headless browser (separate terminal)
CHROME=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
$CHROME --headless=new --no-sandbox --disable-gpu --remote-debugging-port=9222 \
  --user-data-dir=/tmp/st-smoke-chrome about:blank &

# 6. Driver
WS=$(curl -s -X PUT 'http://127.0.0.1:9222/json/new?http://127.0.0.1:8123/' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["webSocketDebuggerUrl"])')
node cdp-smoke.mjs "$WS" /tmp/st-smoke-storyhold/data/default-user
```

## What it proves (the 15 checks)

- extension registers inside real ST; first-run onboarding dismissed
- fixture character + chat selectable by UI click
- Memorize Chat runs to a terminal status
- structured records persist into the chat JSONL line-1 `chat_metadata`
- grounded fact survives; fabricated fact rejected (`ungrounded`)
- ghost-citation event rejected (`ungrounded-citation`)
- mixed citation survives with `provenance.citation_unverified` stamp
- magnitude `9000` dropped while `trust(61)` survives
- coverage report persisted; unmentioned message reported uncovered
- zero console errors from the extension

## Gotchas learned (do not re-solve)

- ST 1.18 first-run onboarding popup blocks the character list until the
  "Save" button is clicked — driver handles it.
- Chat metadata lives on JSONL **line 1**; the chat list opens via the
  "Past Chats" popup (`#option_select_chat`), not a sidebar block.
- Character card PNG `chara` tEXt chunk must be **base64-encoded** JSON or
  ST silently shows "Otterly empty".
- The ingest window is **idempotent**: after changing the fake provider's
  scripted output, re-seed the chat (step 4) or the old window replays.
- Storyhold defaults `embedding_enabled: true` → the smoke seed sets it
  false so no Ollama probe noise hits the console-error check.

## Teardown

```bash
pkill -f "fake-provider.mjs 8444"; pkill -f "st-smoke-storyhold"; pkill -f "st-smoke-chrome"
rm -rf /tmp/st-smoke-storyhold /tmp/st-smoke-chrome
```
