---
name: add-voice-channel
description: Add the voice channel (Pattern-B) to NanoClaw v2 — connects this NanoClaw to a separately-running mcp-voice-channel stack (FreeSWITCH + OpenAI Realtime SIP bridge + voice-mcp). Per-call sessions, TTS-shaped agent replies, parallel Discord fanout. Voice-stack must already be deployed.
---

# Add Voice Channel (v2 / Pattern-B)

Connects NanoClaw v2 to an **already-running** voice-stack
(`mcp-voice-channel` — FreeSWITCH + OpenAI Realtime SIP bridge + voice-mcp).
NanoClaw acts as MCP client to voice-mcp's MCP server: long-poll
`voice_wait_for_question`, dispatch each question into a per-call session,
reply with `voice_post_answer` (TTS-readable plain text). The same reply is
fanned out in parallel to the agent group's Discord destination via the
existing Discord adapter — voice-mcp does not need its own Discord token.

Trunk surface: `src/channels/voice.ts` (~330 LoC + tests). No patches into
existing files; the adapter is fully self-contained on the registry pattern
established by `/add-discord`.

This skill assumes the voice-stack is **already deployed**. See
[`carstenf/mcp-voice-channel`](https://github.com/carstenf/mcp-voice-channel)
`pattern-b` branch. If it isn't running, stop and talk to the operator who
owns the voice-stack host.

## Phase 1: Pre-flight

### 1.1 Verify voice-mcp reachability

The voice-stack publishes an MCP server on TCP port 3150. Replace
`<VOICE_MCP_URL>` and `<VOICE_MCP_BEARER>` with the values from the
voice-stack's `.env`.

```bash
VOICE_MCP_URL="http://10.0.0.1:3150/"   # WireGuard or localhost depending on layout
VOICE_MCP_BEARER="<bearer from voice-stack/.env>"

curl -fsS -X POST "$VOICE_MCP_URL" \
  -H "Authorization: Bearer $VOICE_MCP_BEARER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json,text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | head -c 200
```

Expected: a tools list including `voice_wait_for_question` and
`voice_post_answer`. If the request hangs, check WireGuard / firewall;
if 401, the bearer is wrong.

### 1.2 Confirm an agent group exists

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, name, folder FROM agent_groups"
```

You need at least one. `setup-voice.ts` defaults to the agent group with
folder `dm-with-carsten` if present, otherwise the lex-first agent group.
Pass `--agent-group=<id>` to override.

## Phase 2: Configure environment

Append to NanoClaw's `.env`:

```
VOICE_MCP_URL=http://10.0.0.1:3150/
VOICE_MCP_BEARER=<bearer>
```

The adapter reads both via `readEnvFile` plus `process.env`; either form
works. If `data/env/env` is mounted into the container, also sync it:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 3: Wire the voice messaging_group

```bash
# Default: wire to dm-with-carsten with unknown_sender_policy='request_approval'.
pnpm exec tsx scripts/setup-voice.ts

# Or override:
pnpm exec tsx scripts/setup-voice.ts --agent-group=ag-1234567890-abcdef --policy=public
```

This is idempotent — running it twice is a no-op aside from policy
re-sync. It creates:

- A `messaging_groups` row: `channel_type='voice'`, `platform_id='default'`,
  `name='voice'`.
- A `messaging_group_agents` wiring with `engage_mode='pattern'`,
  `engage_pattern='.'` (every voice message engages — voice has no
  `@mention` semantic), `session_mode='per-thread'` (each call_id becomes
  its own session, isolated DBs and container).
- An `agent_destinations` row (auto-created by `createMessagingGroupAgent`)
  so the agent can also send to the voice destination by name.

## Phase 4: Restart and verify

```bash
# Linux (systemd user)
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Confirm the adapter started and connected to voice-mcp:

```bash
journalctl --user -u nanoclaw --since "1 minute ago" | grep -E "voice_(adapter_|mcp_client_)"
# Expect: voice_mcp_client_connected with the URL from your .env.
# If you see voice_adapter_disabled, .env wasn't picked up — check working dir.
```

## Phase 5: Smoke-test

Trigger a synthetic voice question from the voice-stack host (or from
NanoClaw directly via WireGuard):

```bash
curl -sS -X POST "$VOICE_MCP_URL" \
  -H "Authorization: Bearer $VOICE_MCP_BEARER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json,text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"voice_triggers_init","arguments":{"call_id":"smoke-1","case_type":"case_6b","call_direction":"inbound","counterpart_label":"smoke","lang":"de"}}}' \
  | head -c 200
```

Then watch the host log:

```bash
journalctl --user -u nanoclaw -f | grep -E "voice_(request_received|post_answer_sent|discord_fanout_)"
```

When you place a real test call (Sipgate → FreeSWITCH → voice-mcp), expect
this log sequence per turn:

1. `voice_request_received call_id=... length=...`
2. (container processes the turn — see formatter `<voice-format>` block)
3. `voice_post_answer_sent ok=true length=...`
4. `voice_discord_fanout_sent` (or `voice_discord_fanout_no_target` if no
   Discord wiring is on the same agent_group)

The Discord channel of the voice-wired agent group should receive the
same text as a normal message in parallel.

## Whitelist management

With `unknown_sender_policy='request_approval'` (the default), the first
call from an unknown caller-id triggers an Approve / Deny card to the
agent group's owner / admin via DM. Click Allow → caller is added to
`agent_group_members` → next call is silent-passthrough.

Manual list management via `ncl`:

```bash
ncl members list --agent-group=<voice-agent-group-id>
ncl members add voice:+491234567890 <voice-agent-group-id>
ncl members remove voice:+491234567890 <voice-agent-group-id>
```

The container can run the same `ncl` commands when you ask the agent in
chat ("Andy, füge +49… zur Voice-Whitelist hinzu") — the container ships
with the ncl CLI bound to the session's central-DB transport.

## Tear down

```bash
# Drop the wiring (idempotent — leaves the agent group untouched):
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM messaging_group_agents WHERE messaging_group_id='mg-voice'"
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM messaging_groups WHERE id='mg-voice'"

# Remove env vars:
sed -i '/^VOICE_MCP_URL=/d; /^VOICE_MCP_BEARER=/d' .env

# Restart:
systemctl --user restart nanoclaw
```

The `src/channels/voice.ts` file can stay — without `VOICE_MCP_URL` it
auto-disables (`voice_adapter_disabled` log line at startup).

## Architecture

```
voice-bridge ←→ voice-mcp (voice-stack host, MCP server on :3150)
                  │
                  │  long-poll voice_wait_for_question
                  ▼
                NanoClaw voice adapter (this skill)
                  │
                  │  per-call inbound.db write → wake container
                  ▼
                Agent (Andy) processes — sees <voice-format> hint
                  │
                  │  reply written to outbound.db
                  ▼
                Voice adapter deliver():
                  ├── voice_post_answer → TTS to caller
                  └── parallel: Discord deliveryAdapter.deliver()
                                → Discord channel of same agent group
```

Voice-mcp owns: persona render, retry queue, call lifecycle.
NanoClaw owns: ask_core inversion (voice → Andy), Discord fanout.
