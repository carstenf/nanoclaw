---
name: add-voice-channel
description: Add voice-channel client integration to NanoClaw — connects this NanoClaw to a voice-stack (FreeSWITCH + OpenAI Realtime SIP) running on the same host or via WireGuard. Voice-stack must already be deployed (see github.com/carstenf/mcp-voice-channel). Topology-agnostic — single-host or split-host.
---

# Add Voice Channel

This skill adds voice-channel support to NanoClaw — the client side of a
PSTN-bridged voice agent. The voice infrastructure itself (FreeSWITCH, OpenAI
Realtime SIP bridge, webhook forwarder) lives in a **separate** repo
([`carstenf/mcp-voice-channel`](https://github.com/carstenf/mcp-voice-channel))
and must already be deployed somewhere reachable before this skill is
applied.

## Phase 1: Pre-flight

### Check if already applied

If `src/voice-channel/orchestrator.ts` exists, the skill is already applied;
skip to Phase 4 (Configure).

### Verify voice-stack deployment

Use `AskUserQuestion` to ask:

- **Is a `mcp-voice-channel` voice-stack already deployed and reachable?**
  - "Yes, on this same host (localhost)" → topology = single-host, voice URL = `ws://localhost:3150/triggers`
  - "Yes, on a remote host via WireGuard" → topology = split-host, ask for WG peer IP (commonly `10.0.0.1`)
  - "No, not yet deployed" → STOP. Point user to `carstenf/mcp-voice-channel` README and stop the skill.

If the voice-stack hasn't been deployed yet, the skill cannot continue — the
NanoClaw client has nothing to connect to. The mcp-voice-channel repo's
`README.md` and `INSTALL.md` guide that deployment.

### Collect configuration

If voice-stack is deployed, ask:

- **Operator name** for the voice-config (e.g., "Carsten Freek")
- **Operator caller-ID number** in E.164 (e.g., "+491701234567")
- **Voice-MCP bearer token** (issued by mcp-voice-channel deploy — user gets
  it from `voice-stack/.env` `VOICE_MCP_BEARER`)
- **Voice-allowed Discord channel IDs** (comma-separated; for transcript
  delivery — set in mcp-voice-channel's allowlist)
- **Sipgate caller-line preference** if outbound calls planned
  (`SIPGATE_DEVICE_ID`, `SIPGATE_CALLER`)

## Phase 2: Apply Code Changes

### Add the voice remote and fetch

```bash
git remote add voice https://github.com/carstenf/nanoclaw-voice-channel.git
git fetch voice main
```

### Bring in voice files

The voice-channel repo is a partial-content repo (only voice-related files,
no full NanoClaw tree). Use `git merge --allow-unrelated-histories`:

```bash
git merge voice/main --allow-unrelated-histories --no-edit
```

If that merge reports conflicts on `README.md` (NanoClaw's README) or other
shared root-level files, prefer the local NanoClaw side:

```bash
git checkout --ours README.md
git rm --cached _README.md _INTEGRATION.md 2>/dev/null
git add README.md
git commit --no-edit
```

After the merge, you should have:
- `src/voice-channel/` (7 files: index, manager, protocol, wiring, orchestrator, register-tools, config)
- `src/voice-*.ts` (5 sources + 5 tests)
- `src/mcp-tools/voice-*.ts` (12 sources + 10 tests)
- `src/mcp-tools/slow-brain-session.ts` (+ test) — per-call session manager
- `src/mcp-tools/claude-client.ts` (+ test) — Anthropic API client via OneCLI
- `src/mcp-tools/skill-loader.ts` (+ test) — voice ask-core skill resolver
- `src/channels/voice-mcp.ts` — WS client to voice-mcp:3150
- `src/channels/active-session-tracker.ts` (+ test) — voice_notify_user routing
- `src/cost-ledger.ts` (+ test) — voice cost SQLite accessors
- `container/agent-runner/src/voice-request.ts`
- `systemd/voice-trace-sweep.{service,timer}` (optional)
- `INTEGRATION.md` (reference for the patches in Phase 3 — can be deleted after applying)

### Pull container voice-skills from mcp-voice-channel

The voice personas (DE/EN/IT baselines, Case-2/6b overlays) and the
outbound-call skill live with the voice-channel infrastructure
(`carstenf/mcp-voice-channel`), not in this NanoClaw-side skill — any
agent harness using voice-channel needs them, so they're the canonical
property of the voice-channel repo.

Either clone mcp-voice-channel temporarily and copy the skills directory:

```bash
git clone --depth 1 https://github.com/carstenf/mcp-voice-channel /tmp/mvc
mkdir -p container/skills
cp -r /tmp/mvc/andy-skills/voice-personas container/skills/
cp -r /tmp/mvc/andy-skills/voice-outbound container/skills/
rm -rf /tmp/mvc
```

Or, if you already have mcp-voice-channel cloned locally (e.g., because
you deployed the voice-stack from this same checkout in the single-host
case), reference its andy-skills/ directly:

```bash
mkdir -p container/skills
cp -r /path/to/mcp-voice-channel/andy-skills/voice-personas container/skills/
cp -r /path/to/mcp-voice-channel/andy-skills/voice-outbound container/skills/
```

The voice-personas skill is loaded by `voice-agent-invoker.ts` whenever
`voice_triggers_init` or `voice_triggers_transcript` fires.
voice-outbound is loaded when Andy needs to dispatch an outbound call.

### Apply integration patches to shared files

The merge above adds new files. Now apply the patches to six shared files,
each adding small hooks that delegate to the voice-channel module. Read
`INTEGRATION.md` from the merged tree for the exact diffs; the patches are
small (1-50 lines each):

1. **`src/mcp-tools/index.ts`** — import `registerVoiceTools` and call it
   inside `buildDefaultRegistry`, re-export `voiceTriggerQueue`, extend
   `RegistryDeps` with voice fields, and wire `checkMidCallMutation` into
   `ToolRegistry.invoke`.

2. **`src/index.ts`** — import `setupVoiceOrchestrator`, call it once at
   module-level passing `getRegisteredGroups`/`sendVoiceRequest`/
   `enqueueMessageCheck`, and reference `voice.X` in the runAgent callback
   (`isWakeUpTurn`, `handleResponseMarker`), in the `buildDefaultRegistry`
   call (forward voice deps), and after `startMcpServer` (`voice.startWsClient`).

3. **`src/config.ts`** — append the voice re-export block at the end of the
   file (re-exports `VOICE_DISCORD_*`, `CONTRACTS_PATH`, `SKILLS_DIR`,
   `ASK_CORE_*`, `BRIDGE_OUTBOUND_*`, `VOICE_NOTIFY_LONG_TEXT_WORD_THRESHOLD`,
   `CASE_2_*` from `voice-channel/config.js`).

4. **`src/group-queue.ts`** — add the `sendVoiceRequest(jid, callId, prompt)`
   method (~15 lines) that drops a `voice_request` IPC envelope into the
   active container's input directory. Import `buildVoiceRequestEnvelope`
   from `./voice-channel/protocol.js`.

5. **`src/db.ts`** — add the voice cost-ledger schema (3 tables:
   `voice_call_costs`, `voice_turn_costs`, `voice_price_snapshots`) to the
   `createSchema()` function. ~30 lines.

6. **`container/agent-runner/src/index.ts`** — import the three exports
   from `./voice-request.js`, add the `isVoiceRequestEnvelope` branch in
   `drainIpcInput`, replace the success-emit with the
   `takePendingVoiceRequest()` switch, and add the `ContainerVoiceResponse`
   type to the output union.

### Validate code changes

```bash
npm install
npm run build
npx vitest run
```

Build must be clean and all tests must pass before continuing. Voice-channel
brings ~16 new test files with ~70+ tests covering MCP tool handlers, the
mid-call gateway, and the orchestrator wiring.

If `npm install` reports new dependencies, that's expected — voice-channel
uses `ws` (already used by other channels) and `zod` (already a dep).

### Cleanup the skill-repo docs (optional)

The merged tree includes `INTEGRATION.md` from the skill-repo. Once Phase 3
patches are applied, that file is reference-only and can be removed:

```bash
git rm INTEGRATION.md
git commit -m "chore: remove voice-channel skill INTEGRATION.md (patches applied)"
```

## Phase 3: Configure environment

### `.env`

Append voice settings:

```bash
cat >> .env <<EOF

# Voice-channel client (added by /add-voice-channel)
VOICE_MCP_TRIGGERS_URL=ws://${VOICE_HOST}:3150/triggers
VOICE_MCP_BEARER=<bearer-from-voice-stack>
VOICE_DISCORD_ALLOWED_CHANNELS=<comma-separated-channel-ids>
ANDY_VOICE_DISCORD_CHANNEL=<long-form-discord-channel-id>
EOF
```

`${VOICE_HOST}` is `localhost` for single-host or your WG peer IP (commonly
`10.0.0.1`) for split-host.

### Operator profile

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/voice-config.json <<EOF
{
  "operator_name": "<name from Phase 1>",
  "operator_cli_number": "<+49... from Phase 1>"
}
EOF
```

This file is bind-mounted into voice-stack containers as
`/etc/nanoclaw/voice-config.json` for outbound caller-ID and operator
attribution.

### Sync to container env

```bash
mkdir -p data/env && cp .env data/env/env
```

Container reads from `data/env/env`, not `.env` directly.

## Phase 4: Build and restart

```bash
npm run build
# Linux:
systemctl --user restart nanoclaw
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Verify clean startup:

```bash
tail -30 logs/nanoclaw.log | grep -E "voice|tools.*registered"
```

Expected events (in order):

- `mcp_tool_registering` for each of the 12 voice tools
- `tools` list including `voice_on_transcript_turn`,
  `voice_send_discord_message`, `voice_finalize_call_cost`,
  `voice_get_contract`, `voice_get_practice_profile`,
  `voice_schedule_retry`, `voice_respond`, `voice_search_competitors`,
  `voice_triggers_init`, `voice_triggers_transcript`,
  `voice_set_language`, `voice_wake_up`
- `voice_mcp_client_connected` (or
  `voice_mcp_client_disabled` if env vars unset — re-check Phase 3)

If `voice_mcp_client_connected` doesn't appear and env vars are set,
inspect the log for the actual error (often: bearer token wrong, URL
unreachable, or WG tunnel down).

## Phase 5: Verify with a test call

### Synthetic webhook test (no PSTN call needed)

If `mcp-voice-channel` repo includes a synthetic-webhook script
(check `voice-stack/scripts/`), run it. It simulates a call without
actual telephony:

```bash
ssh <voice-stack-host> "cd ~/voice-stack && bash scripts/synthetic-webhook.sh"
```

Watch logs on both sides:

- voice-stack: `voice-bridge` should accept the synthetic webhook,
  open a sideband WS to OpenAI, and dispatch `voice_triggers_init`
  to NanoClaw via the WS triggers channel.
- NanoClaw: `voice_triggers_init` invocation should appear, the
  container-agent (Andy) should warm up, and a transcript reply
  should flow back via `voice_respond`.

### Real PSTN call (requires Sipgate REGISTER active)

Call the registered Sipgate number from a real phone. Bot should answer
within 1-3s and engage. Discord channel(s) configured in
`VOICE_DISCORD_ALLOWED_CHANNELS` should receive the post-call transcript
within 5-10s of hangup.

## Troubleshooting

### `voice_mcp_client_disabled`

Check `.env`: `VOICE_MCP_TRIGGERS_URL` and `VOICE_MCP_BEARER` must both be
set. Sync to container env (`cp .env data/env/env`).

### `voice_mcp_ws_connection_failed`

WireGuard tunnel down (split-host) or voice-mcp container not running
(single-host). Verify on the voice-stack host:

```bash
docker ps | grep mvc-voice-mcp
ss -tulpn | grep 3150
```

### Transcripts don't reach Discord

Check `VOICE_DISCORD_ALLOWED_CHANNELS` includes the target channel ID.
The bridge's `voice_send_discord_message` invocations are gated by this
allowlist — channels not on the list are silently dropped.

### Inbound call rings but bot doesn't answer

Sipgate REGISTER drift. From the voice-stack host:

```bash
docker restart vs-freeswitch
```

Forces FS to re-REGISTER with Sipgate.

### Tests fail after `npm install`

Run `npm install` again — npm sometimes leaves `node_modules` in a partial
state on first install of a fork repo. Verify `package-lock.json` matches
HEAD: `git diff package-lock.json` should be small or empty.

## After Setup

The voice-channel:

- Connects to voice-mcp via WebSocket (long-lived, auto-reconnect)
- Exposes 12 MCP tools the voice-bridge invokes during calls
- Pre-warms the main container at `/accept` time (voice_wake_up)
- Routes container-agent (Andy) text replies to voice via voice_respond
- Routes long-form Discord messages to the configured ANDY_VOICE_DISCORD_CHANNEL
- Sends post-call transcripts to the allowlist Discord channels
- Tracks per-call language and supports mid-call language switching
- Schedules retries via voice_schedule_retry (Case-2 outbound calls)

## Source repos

- This skill (instructions): `carstenf/nanoclaw` (`.claude/skills/add-voice-channel/`)
- Voice-channel client code (this skill imports it): `carstenf/nanoclaw-voice-channel`
- Voice-stack infrastructure (separate deploy): `carstenf/mcp-voice-channel`
