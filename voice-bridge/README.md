# voice-bridge

NanoClaw Voice Director Bridge — Phase 1 stub.

Fastify v5 service running on Lenovo1 (carsten_bot) that:
- Re-verifies OpenAI webhook signatures (defense-in-depth, D-18 / T-05-01)
- Logs structured JSONL audit entries to `~/nanoclaw/voice-container/runs/bridge-YYYY-MM-DD.jsonl`
- Exposes `GET /health` for operational status checks
- Runs an HTTP canary heartbeat to the Hetzner forwarder every 1s (D-16)
- Sends throttled Discord ALERTs on WG drop (≤1 per 5 min)

**Phase 1 scope:** Does NOT call OpenAI `/accept` — that is Phase 2.

---

## Run modes

```bash
# Development (hot reload via tsx)
npm run dev

# Production (compiled JS, used by systemd unit)
npm run build
node dist/index.js
```

## Required environment variables

Set in `~/nanoclaw/.env` (managed via OneCLI vault — see CLAUDE.md):

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_WEBHOOK_SECRET` | **YES** | Webhook signing secret from OpenAI dashboard. Service refuses to start if missing. |
| `DISCORD_ALERT_WEBHOOK_URL` | no | Discord incoming webhook URL for WG drop alerts. If unset, alerts degrade to JSONL-only. |
| `BRIDGE_BIND` | no | Bind address (default: `10.0.0.2` — WG-only ingress per D-08). |
| `BRIDGE_PORT` | no | Listen port (default: `4401`). |
| `WG_PEER_URL` | no | Canary endpoint URL (default: `http://10.0.0.1:9876/__wg_canary`). |
| `BRIDGE_LOG_DIR` | no | JSONL log directory (default: `~/nanoclaw/voice-container/runs/`). |

## JSONL log

Written to `~/nanoclaw/voice-container/runs/bridge-YYYY-MM-DD.jsonl` (daily rotation via pino-roll).

Fields per entry: `{ts, event, call_id?, signature_valid, latency_ms, payload_size}`

Per T-05-04: only metadata logged at INFO. Full payload at DEBUG only (gated by `LOG_LEVEL=debug`).

## systemd deployment

The unit file lives in this repo at `systemd/voice-bridge.service`. To deploy on Lenovo1:

```bash
mkdir -p ~/.config/systemd/user
cp ~/nanoclaw/voice-bridge/systemd/voice-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now voice-bridge
# Verify:
systemctl --user status voice-bridge
curl http://10.0.0.2:4401/health
```

Node path in unit file: `/home/carsten_bot/.nvm/versions/node/v22.22.2/bin/node`
If Node version changes after `nvm use`, update `ExecStart` and run `daemon-reload`.

Linger must be enabled for boot-time start (already confirmed on Lenovo1):
```bash
loginctl show-user carsten_bot | grep Linger  # expect Linger=yes
```

## Running tests

```bash
cd ~/nanoclaw/voice-bridge
npx vitest run
```

All non-skipped tests must pass. The valid-signature test is `.skip` by design — it requires an SDK round-trip with a real secret and is covered by Plan 06 integration test (per RESEARCH Assumption A2).

## Architecture references

- RESEARCH Templates 4, 5, 6 — index.ts, logger.ts, systemd unit verbatim templates
- RESEARCH Pitfall NEW-3 — webhook secret rotation procedure (both forwarder + bridge must update together)
- RESEARCH Pitfall NEW-4 — `addContentTypeParser` global override caveat (Phase 2 note)
- RESEARCH Pitfall NEW-5 — pino-roll + journald log level discipline
- D-16 amendment (CONTEXT.md) — HTTP canary on forwarder port 9876; ICMP rejected (rationale in heartbeat.ts header)
- D-08 — bind to `10.0.0.2` (WG-only); never `0.0.0.0`
- D-18 — defense-in-depth HMAC re-verify on bridge (T-05-01 mitigation)

---

## Barge-in (REQ-VOICE-05) — OpenAI Platform Guarantee

REQ-VOICE-05 requires that "barge-in cancels current TTS within 200 ms of
counterpart VAD." In this Bridge, barge-in cancellation is **not** implemented
client-side. It is delivered by the OpenAI Realtime platform whenever the
session is configured with:

```
turn_detection: {
  type: 'server_vad',
  create_response: true,
  ...
}
```

This config is set once at `/accept` via `SESSION_CONFIG` in `src/config.ts`
and passed to `openai.realtime.calls.accept()`. OpenAI's server-side VAD
detects counterpart speech and cancels ongoing TTS generation within the
platform's SLA window. See:

- PRD AC-04 (session config mandate)
- `.planning/phases/01-infrastructure-webhook-path/01-05b-SUMMARY.md`
  (sideband-ws-spike evidence: bidirectional RTP confirmed, barge-in observed
  in live PSTN test on 2026-04-16)
- OpenAI Realtime `server_vad` docs

The Bridge's obligation is limited to:

1. Setting the correct `turn_detection` config at `/accept` (enforced by
   the Phase-2 assertion on `SESSION_CONFIG` shape in `tests/accept.test.ts`).
2. NOT issuing any `response.cancel` that would interfere with platform-side
   cancellation.

Any failure of the 200 ms barge-in SLA should be escalated via an upstream
OpenAI support ticket, not patched in Bridge code.
