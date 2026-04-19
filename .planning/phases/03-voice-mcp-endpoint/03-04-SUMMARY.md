---
phase: 03-voice-mcp-endpoint
plan: "04"
subsystem: mcp-tools/discord
tags:
  - mcp-tools
  - discord
  - voice-tools
  - case-6
dependency_graph:
  requires:
    - "03-01"
    - "03-03"
  provides:
    - voice.send_discord_message MCP tool
  affects:
    - src/mcp-tools/index.ts (buildDefaultRegistry)
    - src/config.ts (VOICE_DISCORD_* constants)
    - src/mcp-server.ts (StartMcpServerOpts.deps)
    - src/index.ts (sendDiscordMessage callback)
tech_stack:
  added: []
  patterns:
    - Callback DI for DiscordChannel reuse (zero double-gateway)
    - AbortController timeout (8s default) for Discord rate-limit protection
    - PII-free JSONL logging (no message text — only length + chunks + latency)
    - Conditional tool registration (deny-all when allowlist empty)
key_files:
  created:
    - src/mcp-tools/voice-send-discord-message.ts
    - src/mcp-tools/voice-send-discord-message.test.ts
  modified:
    - src/config.ts (VOICE_DISCORD_ALLOWED_CHANNELS Set, VOICE_DISCORD_TIMEOUT_MS)
    - src/mcp-tools/index.ts (RegistryDeps.sendDiscordMessage, conditional register)
    - src/mcp-server.ts (StartMcpServerOpts.deps pass-through)
    - src/index.ts (sendDiscordMessage callback, startMcpServer({deps}))
decisions:
  - "Conditional registration: voice.send_discord_message only appears in /health when callback present AND allowlist.size>0 — fail-safe deny-all"
  - "sendDiscordMessage callback returns {ok:true}|{ok:false,error} — no throw — handler maps to ok:false without re-throwing"
  - "AbortController via Promise.race + DOMException AbortError — same pattern as voice-check-calendar"
  - "400-status BadRequestError for allowlist-deny — not logged in JSONL (allowlist check precedes timing start)"
metrics:
  duration: "~4 minutes"
  completed_date: "2026-04-18"
  tasks_completed: 4/4
  files_created: 2
  files_modified: 4
  tests_added: 8
---

# Phase 03 Plan 04: voice.send_discord_message MCP Tool Summary

`voice.send_discord_message` MCP tool with allowlist guard, AbortController timeout, PII-free JSONL, and DI callback reusing existing DiscordChannel gateway — zero new Discord connections.

## Commits

| Hash | Message |
|------|---------|
| 22c6270 | feat(03-04): voice.send_discord_message handler + allowlist guard |
| 4cc18e8 | feat(03-04): wire sendDiscordMessage callback + conditional registry |

## What Was Built

**Handler** (`src/mcp-tools/voice-send-discord-message.ts`):
- `makeVoiceSendDiscordMessage(deps)` — zod schema (`call_id?`, `channel_id` snowflake `/^\d{17,20}$/`, `text` 1..4000 chars)
- Allowlist guard: `!deps.allowedChannels.has(channel_id)` → `BadRequestError('channel_id', 'channel_not_allowed')` → HTTP 400
- AbortController timeout: `deps.timeoutMs ?? 8000` ms via `Promise.race([sendPromise, abortPromise])`
- Output: `{ok:true, result:{delivered:true, channel_id, length, chunks}}` or `{ok:false, error}`
- JSONL `data/voice-discord.jsonl`: `discord_message_sent` on success, `discord_message_failed` on timeout/internal/discord_not_configured. Fields: ts, event, tool, call_id, channel_id, length, chunks, latency_ms, error?. **No message text.**

**Wiring** (Task 02):
- `src/config.ts`: `VOICE_DISCORD_ALLOWED_CHANNELS: Set<string>` (parsed from env CSV), `VOICE_DISCORD_TIMEOUT_MS: number`
- `src/mcp-tools/index.ts`: `RegistryDeps.sendDiscordMessage?` optional callback; registers tool only when callback present AND `VOICE_DISCORD_ALLOWED_CHANNELS.size > 0`; logs warn+skip otherwise
- `src/mcp-server.ts`: `StartMcpServerOpts.deps?.sendDiscordMessage` pass-through to `buildDefaultRegistry`
- `src/index.ts`: `sendDiscordMessage` callback built from `findChannel(channels, 'dc:'+channelId).sendMessage`; returns `{ok:false, error:'discord_not_configured'}` when channel absent

**Allowlist env** (Task 03 — pre-done by orchestrator):
- `/home/carsten_bot/nanoclaw/.env`: `VOICE_DISCORD_ALLOWED_CHANNELS=1490365616518070407` (Andy-Channel)

## Smoke Evidence

**Positive test (cross-host curl from Hetzner → Lenovo1):**
```
POST http://10.0.0.2:3200/mcp/voice.send_discord_message
{"arguments":{"call_id":"smoke-03-04","channel_id":"1490365616518070407","text":"NanoClaw 03-04 Smoke — ..."}}

Response 200:
{"ok":true,"result":{"ok":true,"result":{"delivered":true,"channel_id":"1490365616518070407","length":118,"chunks":1}}}
```

**Negative test (non-allowlisted channel):**
```
POST with channel_id: "999999999999999999"

Response 400:
{"error":"bad_request","field":"channel_id","expected":"channel_not_allowed"}
```

**JSONL tail (`data/voice-discord.jsonl`):**
```json
{"ts":"2026-04-18T07:34:12.896Z","event":"discord_message_sent","tool":"voice.send_discord_message","call_id":"smoke-03-04","channel_id":"1490365616518070407","length":118,"chunks":1,"latency_ms":373}
```

**Health endpoint confirms tool registered:**
```json
{"tools":["voice.on_transcript_turn","voice.check_calendar","voice.create_calendar_entry","voice.send_discord_message"]}
```

**Carsten-Verify (Discord message):** ACTION REQUIRED — Smoke-Message in Discord-Channel `1490365616518070407` ("general"/Andy) soll erschienen sein. Bitte im Chat bestätigen: "Ja, angekommen" oder "Nein, nicht angekommen". Wird durch Main-Orchestrator bei Chat-Checkpoint abgefragt.

## Caveats

1. **Allowlist-deny NOT in JSONL**: `BadRequestError` for `channel_not_allowed` is thrown before the timing block starts — these 400-responses never reach `appendJsonl`. Only post-allowlist failures (timeout, discord_not_configured, internal) appear in JSONL. This is intentional and documented.

2. **discord_not_configured semantics**: When Discord bot is not connected (no DISCORD_BOT_TOKEN or channel not in `channels[]`), the callback returns `{ok:false, error:'discord_not_configured'}` — the handler returns `{ok:false, error:'discord_not_configured'}` and writes a `discord_message_failed` entry to JSONL. No throw propagated to HTTP layer.

3. **Tool absent when allowlist empty**: If `VOICE_DISCORD_ALLOWED_CHANNELS` is unset or empty, `voice.send_discord_message` is NOT registered — `/health` shows tool missing, voice-bridge should detect via health-check. Fail-safe by design.

4. **chunks response**: `chunks = Math.ceil(length/2000)`. Smoke message = 118 chars → chunks=1. Discord internal splitting handled by `DiscordChannel.sendMessage`.

## Deviations from Plan

None — plan executed exactly as written. Task 03 (allowlist env) was pre-done by orchestrator.

## Test Results

- Tests before: 389 (388 passed + 1 pre-existing gmail failure)
- Tests after: 397 (396 passed + 1 pre-existing gmail failure)
- New tests added: 8 (all in voice-send-discord-message.test.ts)
- tsc: clean (0 errors)

## Next

Plan 03-05: `get_travel_time` MCP tool.

## Self-Check: PASSED

- src/mcp-tools/voice-send-discord-message.ts: FOUND
- src/mcp-tools/voice-send-discord-message.test.ts: FOUND
- commit 22c6270: FOUND
- commit 4cc18e8: FOUND
- /health tool list includes voice.send_discord_message: VERIFIED
- data/voice-discord.jsonl smoke entry: VERIFIED
