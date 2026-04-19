# Phase 1: Infrastructure & Webhook Path - Context

**Gathered:** 2026-04-16
**Status:** Ready for planning
**Mode:** Auto (recommended-default picks across 7 gray areas)

<domain>
## Phase Boundary

Phase 1 delivers the **end-to-end network path** (Sipgate → FreeSWITCH → OpenAI SIP, plus OpenAI webhook → Caddy → forwarder → WG → Director Bridge stub) WITHOUT any call business logic. The bridge stub only verifies webhook signatures and logs payloads. Phase 2 owns `/accept` and tool registration.

**In scope (12 REQs):** INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-08, SIP-01..07.

**Out of scope:** Tool definitions, sideband-WS to OpenAI, persona prompt, idempotency keys, two-form readback, hot-path latency measurements, cost accounting, Slow-Brain wiring, any case logic.

</domain>

<decisions>
## Implementation Decisions

### Webhook Forwarder

- **D-01:** **Language: Python 3.11 + FastAPI** — lives next to existing `vs-sip-to-ai` (Python) on Hetzner. Single-language Hetzner side; Director Bridge stays TypeScript on Lenovo1. <100 LOC target.
- **D-02:** Container: new docker-compose service `vs-webhook-forwarder` in `~/nanoclaw/voice-stack/docker-compose.yml`, exposed only on `127.0.0.1:9876` (Caddy reverse-proxies; never directly exposed).
- **D-03:** Forwarder responsibility: receive POST from Caddy, validate `OpenAI-Signature` header with `openai.webhooks.unwrap()` (Python SDK ≥1.51), POST raw body + signature header to `http://10.0.0.2:4401/webhook` over WG, return 200 OK. NO business logic.
- **D-04:** Failure modes: WG-unreachable → return 502 to Caddy → OpenAI retries per its policy. Bad signature → 401, log to stdout, do NOT forward.

### Director Bridge Stub

- **D-05:** **Language: TypeScript + Fastify v5** (matches Core ecosystem per STACK research).
- **D-06:** Location: new dir `~/nanoclaw/voice-bridge/` (sibling to `voice-container/`, not nested).
- **D-07:** **Phase 1 scope only**: `/health` endpoint (returns green if WG-reachable + signature secret loaded), `/webhook` endpoint (re-verifies signature defensively, logs raw payload as JSONL, returns 200), heartbeat goroutine (pings WG peer every 1s, logs ALERT on >2s no-reply). Does NOT call OpenAI `/accept` — that's Phase 2.
- **D-08:** Listens on `0.0.0.0:4401` bound to WG interface only (`bind=10.0.0.2:4401`).
- **D-09:** systemd: `~/.config/systemd/user/voice-bridge.service` with `Restart=on-failure`, `RestartSec=2s`. Loaded via `systemctl --user enable --now voice-bridge`. Logs to journald (queryable via `journalctl --user -u voice-bridge`).
- **D-10:** Logging: JSONL to `~/nanoclaw/voice-container/runs/bridge-{date}.jsonl` (matches existing voice-container/runs/ pattern); structured fields = `{ts, event, call_id?, signature_valid, latency_ms, payload_size}`.

### Caddy on Hetzner

- **D-11:** **Include-snippet pattern**: new file `/etc/caddy/sites-enabled/voice-webhook.caddy`, plus one-time edit to main `/etc/caddy/Caddyfile` adding `import sites-enabled/*.caddy` if not present. Non-destructive to existing Caddy routes.
- **D-12:** Voice-webhook hostname: TBD by `carsten` (server-admin) — recommend `voice-webhook.<existing-domain>` (Caddy auto-TLS via Let's Encrypt). Public URL feeds OpenAI webhook config.
- **D-13:** Caddy proxies `POST /openai/webhook` → `http://127.0.0.1:9876/openai/webhook` with raw body preserved (Caddy default behavior, no transform).

### WireGuard Tunnel

- **D-14:** **MTU = 1380** on both peers (matches PITFALLS.md research recommendation; protects against PMTU-blackhole audio dropouts in production but here only metadata flows over WG).
- **D-15:** Set on Lenovo1 via `wg-quick`/wg config; on Hetzner via the existing wg config. `carsten` makes the change on Hetzner; `carsten_bot` makes the change on Lenovo1.
- **D-16:** **Heartbeat semantics**: Bridge sends HTTP `GET http://10.0.0.1:9876/__wg_canary` every 1s to the forwarder canary endpoint (RESEARCH.md §Heartbeat Implementation definitive recommendation; ICMP rejected due to subprocess overhead and failure-mode granularity loss vs. HTTP — HTTP canary on the forwarder port re-uses an already-required process and yields richer status semantics). On >2s no-reply: write JSONL ALERT + post Discord webhook to `legal-ops` channel (throttled to ≤1 per 5 min). No auto-restart, observability only.

### OpenAI Webhook Configuration

- **D-17:** Webhook URL configured in OpenAI project dashboard (proj_4tEBz3XjO4gwM5hyrvsxLM8E) → `https://voice-webhook.<domain>/openai/webhook`. Subscribe to `realtime.call.incoming`. `carsten` makes the dashboard change. Webhook secret stored in `~/nanoclaw/.env` as `OPENAI_WEBHOOK_SECRET` (managed via OneCLI vault if available).
- **D-18:** Signature verification on BOTH ends (forwarder + bridge stub) — defense in depth. Bridge re-verifies in case forwarder is bypassed via WG.

### FreeSWITCH Dialplan + Sipgate Bridge

- **D-19:** Existing `~/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml` already exists. Phase 1 replaces the bridge target with `sofia/external/sip:proj_4tEBz3XjO4gwM5hyrvsxLM8E@sip.api.openai.com;transport=tls` (per voice-channel-spec briefing.md from 2026-04-15). Backup current dialplan before changing.
- **D-20:** Verify codec negotiation: PCMU (G.711µ) only on Sipgate leg; OpenAI accepts PCMU. Reject PCMA/G.722.
- **D-21:** RTP port range 60000–60100/UDP; verify Hetzner firewall allows.
- **D-22:** BYE handling: existing FreeSWITCH dialplan should already handle clean teardown; verify both legs release within 2s via `fs_cli -x "show channels"` after BYE.

### Coordination Split (carsten vs carsten_bot)

- **D-23:** **`carsten` (server-admin) tasks** (Hetzner only):
  - Caddy config edit + `systemctl reload caddy`
  - OpenAI dashboard webhook URL + secret extraction → write into `~/nanoclaw/.env`
  - WireGuard MTU on Hetzner peer
  - Confirm RTP port range open in Hetzner firewall
- **D-24:** **`carsten_bot` (NanoClaw) tasks** (Lenovo1 + Hetzner code):
  - Forwarder code (`vs-webhook-forwarder/main.py`)
  - Bridge stub code (`voice-bridge/src/index.ts`)
  - systemd unit on Lenovo1
  - WireGuard MTU on Lenovo1 peer
  - FreeSWITCH dialplan edit (commit + deploy via voice-stack docker-compose)
  - Test fixture script

### Test Fixtures

- **D-25:** Synthetic webhook test: Python script that crafts a `realtime.call.incoming` payload, signs it with the test webhook secret, POSTs to Caddy public URL. Pass = bridge stub logs entry within 2s with `signature_valid: true`.
- **D-26:** Live integration: 3 consecutive real test calls from Carsten's mobile → Sipgate CLI. Pass criteria: (a) FreeSWITCH bridges within 500ms, (b) webhook arrives at Bridge stub within 2s, (c) `BYE` releases both legs within 2s.
- **D-27:** Test results captured in `~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/test-results.md`.

### Claude's Discretion

- Exact Python deps version pins in forwarder `requirements.txt` (pick latest stable as of 2026-04)
- TypeScript scaffold (vitest config, tsconfig) — match nanoclaw Core conventions
- Discord webhook channel name for ALERT — pick `legal-ops` if exists, else `voice-ops`
- JSONL field ordering inside log entries
- Forwarder shutdown signal handling (SIGTERM cleanup)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase-Level Spec

- `voice-channel-spec/PRD.md` §7a AC-04, AC-05, AC-07, AC-08 — Tools-set-once, instructions-only mid-call, Bridge as dedicated service, WG-only
- `voice-channel-spec/REQUIREMENTS.md` INFRA-01..04, INFRA-08, SIP-01..07
- `voice-channel-spec/ARCHITECTURE-DECISION.md` — bound architecture
- `voice-channel-spec/briefing.md` (2026-04-15) — sample dialplan bridge syntax
- `voice-channel-spec/decisions/2026-04-15-sideband-ws-spike.md` — webhook secret + signature behavior verified

### Research

- `.planning/research/STACK.md` — TS/Fastify for Bridge, Python/FastAPI for forwarder, OpenAI Webhooks SDK
- `.planning/research/ARCHITECTURE.md` — split-stack topology, webhook forwarder pattern, ESL placement
- `.planning/research/PITFALLS.md` — WG MTU pitfall (item #11), signature verification dedup pitfall (#15)

### Existing Code (read before modifying)

- `~/nanoclaw/voice-stack/docker-compose.yml` — add forwarder service here
- `~/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml` — modify bridge target
- `~/nanoclaw/voice-container/runs/` — JSONL logging pattern reference
- `~/nanoclaw/src/` — TS conventions for new voice-bridge/

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`vs-sip-to-ai` Python container** — model for forwarder docker service shape (Dockerfile, docker-compose entry, healthcheck)
- **FreeSWITCH overlay dialplan structure** — additions go to `conf/overlay/dialplan/public/` (already mounted in docker-compose)
- **Existing systemd unit `nanoclaw.service`** — model for `voice-bridge.service` (user-scope, Restart=on-failure)
- **Existing Discord webhook plumbing** — for ALERT path
- **OneCLI** — for `OPENAI_WEBHOOK_SECRET` injection

### Established Patterns

- `~/nanoclaw/.env` for secrets, OneCLI fronts injection
- `voice-container/runs/*.jsonl` for structured turn/event logs
- `vitest` for TypeScript tests

### Integration Points

- Caddy: include-snippet (non-destructive)
- docker-compose: append new service in `voice-stack/docker-compose.yml`
- systemd: `~/.config/systemd/user/voice-bridge.service` on Lenovo1
- FreeSWITCH: existing dialplan file edited in place (with backup)

</code_context>

<specifics>
## Specific Ideas

- Bridge stub `/health` returns 200 with JSON `{wg_ok: bool, secret_loaded: bool, uptime_s: number}` — easy to curl from carsten's terminal for manual check
- Heartbeat ALERT cadence: throttled to max 1 alert per 5min to avoid Discord spam during a tunnel flap
- Test calls in D-26 should be done at three different times of day to catch carrier-codec drift

</specifics>

<deferred>
## Deferred Ideas

- **Multi-region failover** for webhook arrival — single Hetzner host is single-point-of-failure; defer until Phase 4 cost/observability
- **Bridge stub /metrics endpoint** (Prometheus format) — Phase 4 observability
- **OpenAI webhook replay protection** beyond signature verification — defer to Phase 2 when full pipeline exists

### Reviewed Todos (not folded)

None reviewed.

</deferred>

---

*Phase: 01-infrastructure-webhook-path*
*Context gathered: 2026-04-16 (auto-mode)*
*Last updated: 2026-04-16 (D-16 amended per checker BLOCKER #1: HTTP canary on 9876 made primary; ICMP fallback removed)*
