---
name: Voice channel (Pattern-B) — v2 wiring + smoke-test gotchas
description: How NanoClaw v2's voice channel is wired, what the senderIdentity contract is, and the FreeSWITCH thread-leak that can mask a working stack as "no dial tone".
type: project
originSessionId: 42225b54-a6e6-49b8-b7b6-f5c6242c89ad
---
The voice channel ships in v2 trunk (commit `a1d5b4b` + `e14edf9`). It's a normal v2 channel adapter — `channelType='voice'`, `supportsThreads=true`, registered via `src/channels/voice.ts`. One messaging_group `mg-voice` (channel_type='voice', platform_id='default'); per-call sessions live as `session_mode='per-thread'` with `thread_id=call_id`.

**Why:** This is the v2 port of `carstenf/nanoclaw-voice-channel` `pattern-b`. Original repo targets v1's IPC-file model + GroupQueue + main-group abstractions — none of which exist in v2. The v2 surface is ~330 LoC (one file + tests) instead of v1's 4-file patch set.

**How to apply:**

- Setup helper at `scripts/setup-voice.ts` (idempotent). Skill: `/add-voice-channel` (lives in `carstenf/nanoclaw-voice-channel` branch `pattern-b`, **rewritten for v2 on 2026-05-10 in commit `03e98d0`** — older versions describe v1 IPC-envelope wiring that's obsolete).
- Whitelist via `unknown_sender_policy='request_approval'` *almost* works — the gotcha below.
- Reply fan-out: voice answer goes via `voice_post_answer` to TTS, AND in parallel via the live deliveryAdapter to whichever Discord wiring shares the same agent_group. No Discord token needed in voice-stack.

**Two-connection wiring (added 2026-05-10):** Voice now has two connections to voice-mcp HTTP at `10.0.0.1:3150`:

1. **Inbound (host-side, Pattern-B HTTP long-poll)** — `src/channels/voice.ts` (~330 LoC) long-polls `voice_wait_for_question`, dispatches each question into a per-call session, replies via `voice_post_answer`. This was the v2 trunk-only wiring up through 2026-05-10.
2. **Outbound + tools (per-container stdio MCP shim)** — added 2026-05-10. Voice-mcp got a `server-stdio.ts` entrypoint (`mcp-voice-channel` commit `e63788a`) — pure MCP proxy using `Client + StreamableHTTPClientTransport` to the same HTTP endpoint, exposed as `StdioServerTransport` to Claude Agent SDK. Andy's `container.json` wires it as `mcpServers.voice-mcp` with `command: 'node', args: ['/workspace/extra/voice-mcp/dist/server-stdio.js']`. Andy gets all 19 voice tools via `mcp__voice-mcp__*`. Three skills `voice-outbound` + `voice-personas` (canonical: `mcp-voice-channel/andy-skills/`) + `voice-channel` (NanoClaw-specific inbound awareness, in `nanoclaw-voice-channel/container/skills/`) get copied into NanoClaw's `container/skills/`.

**Stdio shim deployment on Lenovo1:** The shim binary lives at `/home/carsten_bot/voice-mcp-app/` (MVP, ~27MB: `dist/server-stdio.js` + minimal `node_modules` with just `@modelcontextprotocol/sdk`). Production-target is `/home/voice-mcp/app/` owned by a dedicated `voice-mcp` system user (parallel to `hindsight-mcp` per MASTER.md user-table convention) — needs sudo, deferred. Mount-allowlist entry + Andy's container.json `additionalMounts` + `mcpServers` already wired.

**Why both connections:** Inbound and outbound are conceptually separate: inbound is a host-level routing concern (one connection per NanoClaw process, demuxes calls into per-thread sessions), outbound is a per-agent-tool concern (one connection per Andy container, exposes voice tools as MCP). One unified connection per container would conflate the two — the host-level adapter does message routing the agent shouldn't see, and per-container long-poll for inbound would multiply listeners. The architecture-conform answer (verified 2026-05-10) is the dual-connection pattern.

**The senderIdentity gotcha (architectural limit):** Pattern-B's `voice_wait_for_question` returns only `{call_id, topic, request}` — no caller-CLI / phone number. My adapter sets `senderIdentity = "voice:<call_id>"`, which is unique per call. Consequence: `unknown_sender_policy='request_approval'` triggers an approval card on every single call (not on every new caller). For a private install where the operator owns the SIP number, set policy to `public`. To support real "whitelist by phone number" we'd need to extend voice-mcp to emit B-Number in `voice_wait_for_question`'s payload — that's a separate project on the `mcp-voice-channel` side.

**The dial-tone red herring:** When `vs-freeswitch` on Hetzner runs into PID exhaustion (~9000+ threads in the container), `[CRIT] switch_core_session.c Thread Failure!` makes outbound Originate to OpenAI Realtime fail → `503 Service Unavailable` → Sipgate plays no ring tone. This looks identical to "voice channel broken" but is a freeswitch-side leak. Diagnose via `docker stats vs-freeswitch` (look for >1000 PIDs) and `docker logs vs-freeswitch | grep "Thread Failure"`. Fix is `docker restart vs-freeswitch` from `voice_bot@Hetzner`. Voice-stack is `voice_bot` scope per MASTER.md.

**Smoke test command** (against running voice-mcp, full round-trip ~4s):

```
URL=$(grep "^VOICE_MCP_URL=" .env | cut -d= -f2)
BEARER=$(grep "^VOICE_MCP_BEARER=" .env | cut -d= -f2)
curl -sS -X POST "$URL" -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" -H "Accept: application/json,text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"voice_ask_core","arguments":{"call_id":"smoke-1","topic":"andy","request":"<question>"}}}' \
  --max-time 90
```

Expected response shape: `{"ok":true,"result":{"voice_short":"...","discord_long":null,"source":"andy"}}`. Logs to grep: `voice_request_received`, `voice_post_answer_sent`, `voice_discord_fanout_sent`.
