---
name: add-phone-calls
description: Add outbound phone call capability to NanoClaw. Andy dispatches a voice AI agent that conducts full conversations via Twilio ConversationRelay + ElevenLabs TTS, with automatic language detection and switching. Sends a summary when done.
---

# Add Phone Calls

This skill sets up outbound phone calls via **Twilio ConversationRelay**. Andy detects call intent, dispatches a voice AI agent (GPT-4o) to conduct the conversation, auto-detects and switches language mid-call, and sends you a summary when done.

## Prerequisites

- Twilio account (console.twilio.com)
- OpenAI API key (GPT-4o for voice conversations — same key used by Hindsight)
- Public HTTPS URL with WebSocket support (Caddy recommended)

## Phase 1: Twilio setup

1. Create a Twilio account at console.twilio.com
2. Get your **Account SID** (starts with `AC`) and **Auth Token** from the dashboard
3. Buy a phone number: Phone Numbers → Buy a Number → choose one with Voice capability
4. For trial accounts: verify the numbers you want to call under Phone Numbers → Verified Caller IDs

## Phase 2: Install dependencies

```bash
npm install twilio openai express ws
npm install --save-dev @types/express @types/ws
```

## Phase 3: Configure .env

Add to `.env`:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
VOICE_PUBLIC_URL=https://your-domain.com/twilio
VOICE_SERVER_PORT=4401
```

`VOICE_PUBLIC_URL` must be publicly reachable by Twilio (HTTPS). The voice server listens on `VOICE_SERVER_PORT`.

## Phase 4: Add routing

Add `/twilio/` to your reverse proxy pointing to `localhost:3600`.

**Caddy** (recommended — handles WebSocket automatically):
```
handle /twilio/* {
    reverse_proxy localhost:3600
}
```

**nginx** (requires WebSocket headers):
```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

location /twilio/ {
    proxy_pass http://localhost:3600/twilio/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
}
```

## Phase 5: Update group CLAUDE.md files

Add to each group's `CLAUDE.md` under "What You Can Do":

```
- **Outbound calls** — Use the `make_call` tool whenever Carsten wants to reach someone by phone.
  A separate voice AI handles the call — you just dispatch it with the number and goal. Examples:
  - "Call my dentist at +4989123456 and book Tuesday 3pm" → call immediately
  - "Call me again" → find the number in conversation history, then call
  - "Can you call the hotel?" → ask for the number, then call
  Never say you cannot make calls. You can. Use the tool.
```

## Phase 6: Build and restart

```bash
npm run build
./container/build.sh
systemctl --user restart nanoclaw  # Linux
```

## Phase 7: Verify

Check logs for:
```
Voice server started (ConversationRelay)  port: 3600
```

Then test: send `call +1xxxxxxxxxx and say hello` to Andy.

## TTS Voice

Uses **ElevenLabs Sarah** via Twilio ConversationRelay (billed through Twilio — no ElevenLabs API key needed in code).

Voice format: `{voiceId}-{model}-{speed}_{stability}_{similarity}`
Default: `EXAVITQu4vr4xnSDxMaL-flash_v2_5-1.0_0.8_0.8`

Set `ELEVENLABS_VOICE_ID` in `.env` to override. Browse voices at elevenlabs.io.

**Note:** `language: 'multi'` (Twilio's multilingual beta) may not be available on all accounts. Use `language: 'de-DE'` with server-side language switching instead (see below).

## Language Switching

The voice server automatically detects the language of the other person's speech and sends a `{type: "language"}` WebSocket message to Twilio before responding. Supports: German, Italian, English, French, Spanish.

Andy's LLM system prompt also instructs it to respond in the same language as the other person.

## How it works

- **Call dispatch:** Andy uses the `make_call` MCP tool. The tool description makes clear it is dispatching an external voice agent (not Claude itself making a call), which avoids Claude's training-based refusal.
- **ConversationRelay:** Twilio opens a WebSocket to your server. GPT-4o streams responses token-by-token for low latency.
- **Language detection:** Regex-based heuristics on incoming speech detect language changes and trigger mid-call TTS/STT switching.
- **Summary:** Sent back to your chat when the call ends or Andy says `[END_CALL]`.

## Troubleshooting

- **Call connects but drops after 5 seconds** — TwiML error, likely unsupported ElevenLabs setting. Check `language` param — use `de-DE` not `multi` unless your account has beta access.
- **Call connects but silent** — WebSocket not reaching server; check proxy WebSocket headers and routing
- **Andy says "I can't make calls"** — Rebuild container after updating MCP tool description; clear sessions: `DELETE FROM sessions` in messages.db
- **Number with spaces not dialing** — spaces are stripped automatically in the tool; format `+49 170 xxx` works
