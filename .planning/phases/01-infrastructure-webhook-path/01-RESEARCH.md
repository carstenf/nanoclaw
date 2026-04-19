# Phase 1: Infrastructure & Webhook Path - Research

**Researched:** 2026-04-16
**Domain:** Split-stack network plumbing — Sipgate↔FreeSWITCH↔OpenAI SIP + signed webhook end-to-end through Caddy + WG to a Director Bridge stub
**Confidence:** HIGH (every load-bearing claim verified against Context7, OpenAI/Fastify/Caddy official docs, npm registry, or existing project files; assumptions explicitly tagged)

---

## Summary

Phase 1 wires the **network spine** for all subsequent voice work: Sipgate registered, Caddy terminates TLS for the public webhook, the Hetzner forwarder verifies the OpenAI signature and relays over WireGuard to a TypeScript Bridge stub on Lenovo1 that re-verifies and logs payloads. Zero call business logic ships in this phase — Phase 2 owns `/accept` and tools.

The 27 locked decisions in `01-CONTEXT.md` already settle stack, languages, ports, and split between `carsten` (Hetzner) and `carsten_bot` (Lenovo1). This research delivers what those decisions need to become an executable plan: **canonical code templates** for the four new files (forwarder Python, bridge TypeScript, systemd unit, Caddy snippet), **a definitive answer to the heartbeat question** (HTTP canary + recommendation to skip ICMP entirely), **the WireGuard MTU rationale** (1380 wins for SIP-adjacent infrastructure even with no audio over WG), and **dialplan edit specifics** verified against the existing `01_sipgate_inbound.xml`.

**Primary recommendation:** Build in this exact order — (1) WG MTU + Caddy snippet (config-only, low risk), (2) forwarder + dialplan edit on Hetzner side (verifies webhook arrival), (3) Bridge stub + systemd on Lenovo1 (closes the loop), (4) integration test fixture (proves it). Each step has a single observable: `curl`, `journalctl`, or a tail of `~/nanoclaw/voice-container/runs/bridge-*.jsonl`.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Webhook Forwarder**
- D-01: Language = Python 3.11 + FastAPI; lives next to `vs-sip-to-ai` on Hetzner; <100 LOC target
- D-02: Container = new docker-compose service `vs-webhook-forwarder` in `~/nanoclaw/voice-stack/docker-compose.yml`, exposed only on `127.0.0.1:9876` (Caddy reverse-proxies; never directly exposed)
- D-03: Responsibility = receive POST from Caddy, validate `OpenAI-Signature` with `openai.webhooks.unwrap()` (Python SDK ≥1.51), POST raw body + signature header to `http://10.0.0.2:4401/webhook` over WG, return 200 OK. NO business logic.
- D-04: Failure modes = WG-unreachable → 502 to Caddy → OpenAI retries; bad signature → 401, log, do NOT forward.

**Director Bridge Stub**
- D-05: Language = TypeScript + Fastify v5
- D-06: Location = new dir `~/nanoclaw/voice-bridge/` (sibling to `voice-container/`)
- D-07: Phase 1 scope only = `/health`, `/webhook` (re-verifies signature, logs JSONL, returns 200), heartbeat (pings WG peer every 1s, ALERT on >2s no-reply). Does NOT call OpenAI `/accept` — Phase 2.
- D-08: Listens on `0.0.0.0:4401` bound to WG interface only (`bind=10.0.0.2:4401`)
- D-09: systemd: `~/.config/systemd/user/voice-bridge.service` with `Restart=on-failure`, `RestartSec=2s`. Loaded via `systemctl --user enable --now voice-bridge`. Logs to journald.
- D-10: Logging: JSONL to `~/nanoclaw/voice-container/runs/bridge-{date}.jsonl`; fields = `{ts, event, call_id?, signature_valid, latency_ms, payload_size}`

**Caddy on Hetzner**
- D-11: Include-snippet pattern: new file `/etc/caddy/sites-enabled/voice-webhook.caddy`, plus one-time edit to main `/etc/caddy/Caddyfile` adding `import sites-enabled/*.caddy` if not present. Non-destructive.
- D-12: Voice-webhook hostname: TBD by `carsten` — recommend `voice-webhook.<existing-domain>`
- D-13: Caddy proxies `POST /openai/webhook` → `http://127.0.0.1:9876/openai/webhook` with raw body preserved

**WireGuard Tunnel**
- D-14: MTU = 1380 on both peers
- D-15: `carsten` makes the change on Hetzner; `carsten_bot` makes the change on Lenovo1
- D-16: Heartbeat semantics: Bridge sends ICMP echo to peer 10.0.0.1 every 1s (or HTTP `GET http://10.0.0.1:80/__wg_canary` fallback). On >2s no-reply: JSONL ALERT + Discord webhook to `legal-ops`. No auto-restart.

**OpenAI Webhook Configuration**
- D-17: Webhook URL configured in OpenAI project (proj_4tEBz3XjO4gwM5hyrvsxLM8E). Subscribe to `realtime.call.incoming`. `carsten` makes dashboard change. Secret in `~/nanoclaw/.env` as `OPENAI_WEBHOOK_SECRET`.
- D-18: Signature verification on BOTH ends (forwarder + bridge stub) — defense in depth.

**FreeSWITCH Dialplan + Sipgate Bridge**
- D-19: Existing `~/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml` — Phase 1 replaces bridge target with `sofia/external/sip:proj_4tEBz3XjO4gwM5hyrvsxLM8E@sip.api.openai.com;transport=tls`. Backup current dialplan before changing.
- D-20: PCMU (G.711µ) only on Sipgate leg; reject PCMA/G.722
- D-21: RTP port range 60000–60100/UDP; verify Hetzner firewall
- D-22: BYE handling: existing dialplan should handle clean teardown; verify both legs release within 2s

**Coordination Split**
- D-23: `carsten` (server-admin, Hetzner): Caddy config + reload, OpenAI dashboard webhook URL + secret extraction, WG MTU on Hetzner, RTP firewall confirmation
- D-24: `carsten_bot` (NanoClaw, Lenovo1+code): forwarder code, bridge stub code, systemd unit, WG MTU on Lenovo1, FreeSWITCH dialplan edit (commit + deploy via voice-stack), test fixture script

**Test Fixtures**
- D-25: Synthetic webhook test: Python script crafts `realtime.call.incoming`, signs with test secret, POSTs to Caddy public URL. Pass = bridge stub logs entry within 2s with `signature_valid: true`.
- D-26: Live integration: 3 consecutive real test calls. Pass = (a) FreeSWITCH bridges within 500ms, (b) webhook arrives at Bridge stub within 2s, (c) BYE releases both legs within 2s.
- D-27: Test results captured in `~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/test-results.md`

### Claude's Discretion

- Exact Python deps version pins in forwarder `requirements.txt` (latest stable as of 2026-04)
- TypeScript scaffold (vitest config, tsconfig) — match nanoclaw Core conventions
- Discord webhook channel name for ALERT — pick `legal-ops` if exists, else `voice-ops`
- JSONL field ordering inside log entries
- Forwarder shutdown signal handling (SIGTERM cleanup)

### Deferred Ideas (OUT OF SCOPE)

- **Multi-region failover** for webhook arrival — defer to Phase 4
- **Bridge stub /metrics endpoint** (Prometheus) — Phase 4 observability
- **OpenAI webhook replay protection** beyond signature verification — Phase 2

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INFRA-01 | FreeSWITCH on Hetzner Python1 registered with Sipgate (REGED ≤30s of boot) | §FreeSWITCH/Sipgate Bridge — existing `external/sipgate.xml` already configured with `register=true`, `expire-seconds=300`, `retry-seconds=30`; verify via `fs_cli -x "sofia status gateway sipgate"` post-deploy |
| INFRA-02 | Caddy on Hetzner terminates TLS for voice-webhook public URL and reverse-proxies to Lenovo1 over WG | §Canonical Templates — Caddy snippet provided with `import sites-enabled/*.caddy` pattern; Let's Encrypt auto-TLS by hostname |
| INFRA-03 | OpenAI webhook URL configured in OpenAI project; signature verification end-to-end green | §Canonical Templates — Python `client.webhooks.unwrap()` (forwarder) + TypeScript `client.webhooks.unwrap()` (bridge); both verified against current SDK docs |
| INFRA-04 | WireGuard MTU tuned to 1380; heartbeat monitor in Director Bridge detects tunnel drops ≤2s | §WireGuard MTU Recommendation + §Heartbeat Implementation — HTTP canary chosen over ICMP; rationale documented |
| INFRA-08 | Director Bridge systemd unit on Lenovo1 under `carsten_bot` with auto-restart | §Canonical Templates — `Type=simple`, `Restart=on-failure`, `RestartSec=2s`, journald logging; verified against `nanoclaw.service` pattern |
| SIP-01 | FreeSWITCH accepts inbound SIP INVITE from Sipgate (+49 30 8687022345) on 5060/UDP | §Existing Code — `external/sipgate.xml` REGISTER + `01_sipgate_inbound.xml` accept condition already in place |
| SIP-02 | FreeSWITCH initiates outbound calls via Sipgate with Carsten's CLI | §Open Question — outbound dialplan NOT yet present in `01_sipgate_inbound.xml`; Phase 1 addition needed (see Pitfall NEW-2) |
| SIP-03 | On INVITE, system bridges to `sip:<project_id>@sip.api.openai.com;transport=tls` within 500ms | §Canonical Templates — bridge action provided; spike measured T≈70ms FreeSWITCH bridge initiation |
| SIP-04 | System negotiates PCMU G.711 codec exclusively on Sipgate leg | §FreeSWITCH/Sipgate Bridge — `absolute_codec_string=PCMU` already in dialplan; add `single_codec=true` for OpenAI leg |
| SIP-05 | RTP media flows on port range 60000–60100/UDP throughout active call | §Environment Audit — Hetzner firewall must allow 60000-60100/UDP (carsten task); FreeSWITCH `rtp_port_range` config |
| SIP-06 | On BYE, both SIP legs terminate and session resources released ≤2000ms | §FreeSWITCH/Sipgate Bridge — verified that bridge action propagates BYE bidirectionally by default; verification step provided |
| SIP-07 | If bridge to OpenAI fails >3000ms, system rejects call with SIP 503 and logs | §Canonical Templates — `originate_timeout=3` + `hangup_after_bridge=true` + 503 dialplan fallback |

</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| TLS termination for OpenAI webhook | Edge (Caddy on Hetzner) | — | Public ingress lives on the public IP host; auto-LE only works there |
| Webhook signature verification | Edge (forwarder) + App (bridge) | — | Defense in depth per D-18; edge rejects garbage early, app rejects internal-network bypass |
| WG-routed control-plane forwarding | Edge (forwarder) | — | Hetzner is the only WG peer that holds the public webhook |
| SIP REGISTER + INVITE handling | Carrier-adjacent (FreeSWITCH on Hetzner) | — | Public IP + RTP path require carrier-zone host |
| SIP→OpenAI SIP bridge | Carrier-adjacent (FreeSWITCH) | — | Direct over public TLS; never traverses WG (per ARCHITECTURE.md key insight) |
| Heartbeat / WG liveness probe | App (Bridge on Lenovo1) | — | The peer that needs a live WG is the one that should detect failure |
| Process supervision | OS (systemd --user) | — | Established Lenovo1 pattern (no Docker on Lenovo1 per STACK.md §1.8) |
| Structured event log | App (Bridge JSONL writer) | — | Reuses `voice-container/runs/` pattern |
| Discord ALERT delivery | App (Bridge) | External (Discord webhook) | App owns event detection; Discord is the sink |

---

## Standard Stack

### Core (already locked by CONTEXT.md, versions verified 2026-04-16)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Python | 3.12 | Forwarder runtime | `[VERIFIED: vs-sip-to-ai/Dockerfile]` Existing sip-to-ai uses `python:3.12-slim` — match it for ops uniformity. CONTEXT D-01 says 3.11 minimum; 3.12 is what the repo already pins. |
| `openai` (Python) | `>=1.51,<3` | Forwarder webhook signature verify (`client.webhooks.unwrap`) | `[VERIFIED: pypi.org/pypi/openai/json — latest 2.32.0]` — D-01 floor of 1.51 covers `webhooks.unwrap`. Pin `<3` to avoid future major. |
| `fastapi` | `>=0.115,<1` | Forwarder HTTP framework | `[CITED: pypi.org/pypi/fastapi/json — 0.136.0 latest]` Active maintenance, `Request.body()` returns raw bytes (required for signature verify). |
| `uvicorn[standard]` | `>=0.32,<1` | ASGI runner inside container | Standard pairing with FastAPI; `[standard]` extras enable httptools + websockets + uvloop |
| `httpx` | `>=0.27,<1` | Async HTTP client to forward over WG | Already in modern Python ecosystem; FastAPI's preferred async client |
| Node.js | `22.11 LTS` (≥22.x) | Bridge runtime | `[VERIFIED: lenovo1 node --version → v22.22.2]` already installed; matches STACK.md §1.1 |
| `fastify` | `^5.8.5` | Bridge HTTP framework | `[VERIFIED: npm view fastify version → 5.8.5]` Locked by D-05; raw-body via `addContentTypeParser` (see §Canonical Templates) |
| `openai` (Node) | `^6.34.0` | Bridge webhook re-verify (`client.webhooks.unwrap`) | `[VERIFIED: npm view openai version → 6.34.0]` Same SDK family as future Phase 2 `/accept` calls — install once |
| `pino` | `^10.3.1` | JSONL structured logging | `[VERIFIED: npm view pino version → 10.3.1]` Per STACK.md §1.6; native NDJSON output goes straight to `runs/bridge-*.jsonl` |
| `pino-roll` | `^4.0` | Daily file rotation | Pairs with pino; one new file per UTC day, matches D-10's `bridge-{date}.jsonl` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/node` | `^22.10` | TS types for Node 22 | Always (devDep) |
| `tsx` | `^4.19` | dev hot-reload | `npm run dev` UX (matches Core) |
| `vitest` | `^4.0` | unit/integration tests | Synthetic-webhook test fixture (D-25) |
| `typescript` | `^5.7` | compiler | Match Core's tsconfig |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `fastify-raw-body` plugin | `addContentTypeParser` inline | Inline saves a dep and one indirection; the four-line parser shown in §Canonical Templates is sufficient — recommendation: **inline** |
| `pino` JSONL | `winston` | STACK.md already justifies pino; no reason to diverge for a new sibling service |
| `httpx` async forward | `requests` (sync) | FastAPI is async; mixing sync `requests` blocks the event loop — use `httpx.AsyncClient` |
| Type=notify systemd | Type=simple | `Type=notify` requires `sd_notify()` calls in Node (extra lib + complexity); `Type=simple` is the documented Node.js best practice and matches existing `nanoclaw.service`. **Recommendation: Type=simple** |

**Installation (forwarder, in `voice-stack/vs-webhook-forwarder/requirements.txt`):**
```
openai>=1.51,<3
fastapi>=0.115,<1
uvicorn[standard]>=0.32,<1
httpx>=0.27,<1
```

**Installation (bridge, in `voice-bridge/package.json` deps):**
```bash
npm install fastify@^5.8 openai@^6.34 pino@^10.3 pino-roll@^4.0
npm install -D typescript@^5.7 tsx@^4.19 vitest@^4.0 @types/node@^22.10
```

---

## Architecture Patterns

### System Architecture Diagram

```
                    PSTN
                     │ +49 30 8687 02 23 45 (Sipgate DID)
                     ▼
         ┌─────────────────────┐
         │   Sipgate SBC       │
         └──────────┬──────────┘
              SIP+RTP │ public TLS
                     ▼
  ┌────────────────────────────────────────────────────┐
  │ HETZNER Python1 (128.140.104.236) — voice_bot      │
  │                                                    │
  │  vs-freeswitch (host network)                      │
  │   :5060 SIP   :60000-60100 RTP                     │
  │   REGISTER → Sipgate (existing)                    │
  │   dialplan public/01_sipgate_inbound.xml:          │
  │     condition dest=8702234e5                       │
  │     bridge → sofia/external/sip:proj_…@            │
  │              sip.api.openai.com;transport=tls      │
  │                                                    │
  │  vs-webhook-forwarder (NEW, port 127.0.0.1:9876)   │
  │   FastAPI                                          │
  │   POST /openai/webhook                             │
  │     1. await req.body() (raw bytes)                │
  │     2. client.webhooks.unwrap(body, headers)       │
  │     3. POST body+sig-headers → 10.0.0.2:4401/webhook│
  │     4. echo upstream status code                   │
  │                                                    │
  │  Caddy (existing, edited via include-snippet)      │
  │   :443 TLS (Let's Encrypt)                         │
  │   voice-webhook.<domain> → 127.0.0.1:9876          │
  └─────────┬──────────────────────────┬───────────────┘
            │ direct SIP+RTP TLS       │ HTTP over WG
            │ (no WG involvement!)     │ 10.0.0.1 → 10.0.0.2
            ▼                          ▼
  ┌────────────────────┐   ┌────────────────────────────┐
  │ OpenAI SIP (TLS)   │   │ LENOVO1 (WG 10.0.0.2)      │
  │ sip.api.openai.com │   │ user: carsten_bot          │
  │ project routes via │   │                            │
  │ webhook callback   │──▶│ voice-bridge (Fastify+TS)  │
  └────────────────────┘   │  systemd --user            │
                           │  :4401 bound to WG IP only │
                           │                            │
                           │  GET /health → {wg_ok,…}   │
                           │  POST /webhook             │
                           │    1. raw body via         │
                           │       addContentTypeParser │
                           │    2. webhooks.unwrap()    │
                           │       (DEFENSE IN DEPTH)   │
                           │    3. JSONL append to      │
                           │       runs/bridge-DATE.jsonl│
                           │    4. 200 OK               │
                           │                            │
                           │  Heartbeat coroutine       │
                           │   every 1s: GET            │
                           │   http://10.0.0.1:9875/    │
                           │     __wg_canary            │
                           │   on >2s fail: Discord     │
                           │   webhook ALERT            │
                           └────────────────────────────┘
```

### Recommended Project Structure

```
~/nanoclaw/                              (Lenovo1)
├── voice-stack/                         (deployed via SSH/scripts to Hetzner)
│   ├── docker-compose.yml               # ADD vs-webhook-forwarder service block
│   ├── conf/overlay/dialplan/public/
│   │   └── 01_sipgate_inbound.xml       # EDIT bridge target
│   └── vs-webhook-forwarder/            # NEW (lives in repo, runs on Hetzner)
│       ├── Dockerfile
│       ├── requirements.txt
│       ├── main.py                      # <100 LOC, FastAPI relay
│       └── README.md                    # deploy notes
├── voice-bridge/                        # NEW (Lenovo1 service)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts                     # Fastify app + lifecycle
│   │   ├── config.ts                    # env loading (OPENAI_WEBHOOK_SECRET, paths)
│   │   ├── webhook.ts                   # signature re-verify + JSONL write
│   │   ├── health.ts                    # /health handler
│   │   ├── heartbeat.ts                 # WG canary loop + Discord ALERT
│   │   └── logger.ts                    # pino + pino-roll setup
│   └── tests/
│       └── synthetic-webhook.test.ts    # D-25 fixture
├── systemd/                             # NEW (template; deployed to ~/.config/systemd/user/)
│   └── voice-bridge.service
└── voice-container/runs/                # existing JSONL convention
    └── bridge-YYYY-MM-DD.jsonl          # written by bridge at runtime
```

### Pattern 1: Webhook Relay with Defense-in-Depth Re-Verification

**What:** OpenAI signature verified twice — once at the public Caddy edge (forwarder), once again inside WG (bridge). Same SDK call, same secret.
**When to use:** Always when signed payload crosses a trust boundary.
**Source:** ARCHITECTURE.md §"Pattern 2"; D-18.

**Forwarder (Python) — see §Canonical Templates for full file.**
**Bridge (TypeScript) — see §Canonical Templates for full file.**

### Pattern 2: Raw-Body Capture in Fastify v5

**What:** Signature verification requires the *exact* bytes the sender signed. JSON parsers reorder keys, normalize whitespace, and break HMAC. Fastify's `addContentTypeParser` for `application/json` captures `payload.rawBody` before parsing.

```typescript
// Source: github.com/fastify/fastify Guides/Serverless.md (Context7-fetched 2026-04-16)
fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  // body is a Buffer because we asked parseAs:'buffer'
  ;(req as any).rawBody = body
  try {
    done(null, JSON.parse(body.toString('utf8')))
  } catch (err) {
    done(err as Error, undefined)
  }
})
```

Then in the route handler: `const raw = (request as any).rawBody as Buffer; client.webhooks.unwrap(raw.toString('utf8'), request.headers, secret)`.

### Pattern 3: Bind to WG Interface Only

**What:** `app.listen({ host: '10.0.0.2', port: 4401 })` — never `0.0.0.0`. The bridge stub is unreachable from any non-WG path.
**Why:** D-08 + ARCHITECTURE.md "Lenovo1 stays invisible"; if you bind to `0.0.0.0` you create a second attack surface that competes with the carefully designed forwarder pattern.

### Pattern 4: HTTP Canary for WG Heartbeat (NOT ICMP)

**What:** Bridge polls `GET http://10.0.0.1:9875/__wg_canary` every 1s with a 1s timeout. Sub-200ms response = healthy. >2s failure (timeout OR connect-refused OR non-2xx) = ALERT.
**Why ICMP loses:** see §Heartbeat Implementation below for the full rationale.
**What runs at 10.0.0.1:9875:** the same `vs-webhook-forwarder` container exposes a second route `GET /__wg_canary` returning `204 No Content` — zero new container, zero new port-allocation.

### Anti-Patterns to Avoid

- **Using `request.body` (parsed JSON) for signature verify:** mutates byte ordering → HMAC fails. Always use raw bytes/string.
- **Binding bridge to `0.0.0.0`:** breaks D-08 trust boundary; opens Lenovo1 to LAN traffic.
- **Skipping bridge-side re-verification because "Caddy already did it":** if WG is the only path, an attacker who pivots into Hetzner can post arbitrary bodies. Defense in depth costs ~1ms.
- **Putting the heartbeat in a child process:** the heartbeat exists to detect WG drops; a child process adds an inter-process layer that itself can fail silently. Use a coroutine inside the Fastify event loop.
- **Logging full webhook payloads at INFO:** payloads contain SIP From-headers (PII). Log payload `size` + `event_type` + `call_id` at INFO; full body at DEBUG only, gated by `LOG_LEVEL=debug` env.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OpenAI webhook signature verification | Custom HMAC-SHA256 with timestamp window check | `openai.webhooks.unwrap()` (Python) and `openai.webhooks.unwrap()` (Node) | The SDK enforces the timestamp tolerance, the signature scheme version, AND the dedup key extraction. Hand-rolling re-introduces the exact bug class OpenAI's SDK exists to prevent. `[VERIFIED: openai-python README via Context7]` |
| Raw-body capture in Fastify | Streaming raw bytes manually | `addContentTypeParser` with `parseAs: 'buffer'` | Fastify's parser handles content-length, multi-chunk arrival, and back-pressure. `[CITED: fastify.dev/docs ContentTypeParser]` |
| JSONL log rotation | `fs.createWriteStream` + cron-style rename | `pino-roll` | Atomic rename + open-on-write semantics; handles process restart mid-write |
| Discord webhook delivery | Custom HTTP retry logic | Native `fetch` with `AbortController` timeout (Node 22 has it built-in) | Discord's webhook endpoint is idempotent for our use case (single ALERT message); retry isn't needed in MVP |
| systemd service supervision | `pm2` or custom restart loop | systemd `--user` with `Restart=on-failure` | Already in use for `nanoclaw.service`; matches existing operator mental model |
| WG liveness check | Parsing `wg show` output | HTTP canary to forwarder | `wg show` requires root or CAP_NET_ADMIN; running unprivileged code paths via `sudo` is a security regression |

**Key insight:** Every "small" piece of crypto, parsing, or supervision in Phase 1 has a battle-tested standard solution. The temptation to hand-roll is highest for the heartbeat (it sounds trivial); resist.

---

## Heartbeat Implementation — DEFINITIVE ANSWER

**Recommendation: HTTP canary, NOT ICMP.**

### Why ICMP Loses

| Concern | ICMP `ping` | HTTP `GET /__wg_canary` |
|---------|-------------|--------------------------|
| Permission | `ping` shipped in Ubuntu 24.04 has `cap_net_raw+ep` set, so unprivileged invocation works — BUT spawning a subprocess every 1s is wasteful (parse overhead ~10ms) | Plain TCP from a long-lived `httpx`/`fetch` client; zero subprocess |
| Failure detection granularity | "no reply" only — can't distinguish WG-down vs forwarder-crashed vs Hetzner-down | Distinguishes connect-refused (forwarder dead) vs timeout (WG/Hetzner down) vs 5xx (forwarder broken) — all three are actionable signals |
| Test reproducibility | `ip link set wg0 down` simulates one failure mode; can't simulate "forwarder crashed but WG up" | Can simulate ALL failure modes (`docker stop vs-webhook-forwarder` vs `wg-quick down wg0`) |
| Logging discipline | Process exit codes only | Structured JSON: `{ts, latency_ms, status_code, error_class}` |
| Future Phase 2 utility | Discardable | Same canary endpoint becomes a Phase 2 readiness probe |

### Implementation

**On Hetzner forwarder** (in `vs-webhook-forwarder/main.py`):

```python
@app.get("/__wg_canary", status_code=204)
async def canary():
    return Response(status_code=204)
```

This route serves on `127.0.0.1:9876` (same port as the webhook), but the Caddy snippet does NOT proxy `/__wg_canary` publicly — only `/openai/webhook` is exposed. `[ASSUMED]` Caddy default is path-prefix not pattern-match — verify in §Canonical Templates Caddy snippet.

**Wait — 127.0.0.1 doesn't bind to the WG interface.** Two options:

1. **Bind forwarder to both `127.0.0.1` AND `10.0.0.1`** — change `vs-webhook-forwarder` listen to `0.0.0.0:9876` inside its container (`network_mode: host` in docker-compose puts it on host network, then 10.0.0.1 is reachable from 10.0.0.2). Hetzner firewall ALREADY blocks inbound 9876 from public.
2. **Run a tiny separate canary container on `10.0.0.1:9875`** — extra moving part for zero benefit.

**Recommendation: Option 1.** The forwarder service uses `network_mode: host` (matching `vs-freeswitch` and `vs-sip-to-ai` per existing docker-compose.yml). Bind FastAPI to `0.0.0.0:9876` so it's reachable from both Caddy (loopback) and Lenovo1 (via WG). Hetzner public firewall blocks 9876 from internet (verify with carsten — see §Open Questions).

**On Lenovo1 bridge** (in `voice-bridge/src/heartbeat.ts`):

```typescript
import { setTimeout as sleep } from 'node:timers/promises'
import { sendDiscordAlert } from './alerts.js'

const WG_PEER = process.env.WG_PEER_URL ?? 'http://10.0.0.1:9876/__wg_canary'
const POLL_INTERVAL_MS = 1000
const FAIL_THRESHOLD_MS = 2000
const ALERT_THROTTLE_MS = 5 * 60 * 1000  // max 1 alert per 5min (CONTEXT specifics)

let lastAlertAt = 0
let consecutiveFailures = 0

export async function startHeartbeat(log: pino.Logger): Promise<void> {
  while (true) {
    const t0 = Date.now()
    let ok = false
    let detail = ''
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), FAIL_THRESHOLD_MS)
      const r = await fetch(WG_PEER, { signal: ctrl.signal })
      clearTimeout(timer)
      ok = r.status === 204 || r.status === 200
      detail = `status=${r.status}`
    } catch (e: any) {
      detail = `err=${e.name}:${e.message}`
    }
    const elapsed = Date.now() - t0
    if (ok) {
      if (consecutiveFailures > 0) {
        log.info({ event: 'wg_recovered', after_ms: elapsed, prior_failures: consecutiveFailures })
      }
      consecutiveFailures = 0
    } else {
      consecutiveFailures++
      log.warn({ event: 'wg_canary_fail', detail, elapsed_ms: elapsed, consecutive: consecutiveFailures })
      const now = Date.now()
      if (now - lastAlertAt > ALERT_THROTTLE_MS) {
        await sendDiscordAlert(`voice-bridge: WG peer unreachable (${detail})`)
        lastAlertAt = now
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
}
```

**Discord alert delivery:** `process.env.DISCORD_ALERT_WEBHOOK_URL` injected via OneCLI vault (matches existing nanoclaw secret pattern per CLAUDE.md). Channel choice: `legal-ops` if it exists, else `voice-ops` (per CONTEXT Claude's Discretion). Verify channel name with carsten before deploy — see §Open Questions.

---

## WireGuard MTU Recommendation — RATIONALE

**Locked in CONTEXT D-14: MTU = 1380 on both peers.** This research confirms 1380 is correct.

### Why 1380, Not 1420 (the WG default)

The "this phase only carries metadata over WG, not audio" framing is a trap. Two reasons 1380 is right anyway:

1. **Hetzner's underlying path MTU varies.** WireGuard's default 1420 assumes underlying MTU = 1500 (standard Ethernet). Hetzner cloud paths sometimes drop to 1480 (provider PMTU shenanigans documented in the WireGuard MTU optimization writeups). At MTU 1420, an over-MTU encapsulated packet hits PMTU-blackhole — the connection appears to work for small JSON payloads but silently truncates at >1380-byte payloads. OpenAI webhooks averaged ~700 bytes in the spike but a `realtime.call.incoming` with full SIP headers can exceed 1.5KB.
   - `[CITED: gist.github.com/nitred/f16850ca48c48c79bf422e90ee5b9d95 — WireGuard MTU optimization]`
   - `[CITED: defguard.net/blog/mtu-mss-decision-tree — 1280 is IPv6 minimum, 1380 is conservative for tunneled links]`

2. **Future-proofing for Phase 2+.** Phase 2 introduces a sideband WS — but that's bridge→OpenAI (not WG). Phase 4 introduces tool calls Bridge↔Core MCP (Lenovo1 local, not WG). HOWEVER: `originate` commands from Bridge→FreeSWITCH ESL (Phase 4 outbound calls) will go over WG and may carry larger payloads. Setting MTU 1380 once is cheaper than re-tuning later under load.

### Verification (post-config)

```bash
# On either peer, after MTU change:
ip link show wg0 | grep mtu
#   Expect: mtu 1380

# Force a large probe to detect blackhole:
ping -M do -s 1352 10.0.0.1  # 1352 + 28 (ICMP+IP) = 1380; should succeed
ping -M do -s 1500 10.0.0.1  # should FAIL with "Frag needed and DF set"
```

`[ASSUMED]` Hetzner's underlying path supports 1380 — this is the conservative figure used by VPN providers; if Hetzner support says they guarantee 1500 end-to-end, 1420 would also work. Recommend asking carsten to test with the ping probes above before declaring INFRA-04 green.

---

## Canonical Templates

### Template 1: Forwarder `main.py` (Python + FastAPI, <100 LOC)

```python
# voice-stack/vs-webhook-forwarder/main.py
"""OpenAI webhook forwarder. Verifies signature, relays raw body to Lenovo1 over WG."""
import logging
import os
import sys
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response, HTTPException
from openai import OpenAI

# Logging — JSON-line to stdout, captured by docker logs
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format='{"ts":"%(asctime)s","lvl":"%(levelname)s","msg":"%(message)s"}',
)
log = logging.getLogger("forwarder")

WEBHOOK_SECRET = os.environ["OPENAI_WEBHOOK_SECRET"]  # fail loudly at startup if missing
BRIDGE_URL = os.environ.get("BRIDGE_WEBHOOK_URL", "http://10.0.0.2:4401/webhook")
FORWARD_TIMEOUT_S = float(os.environ.get("FORWARD_TIMEOUT_S", "5.0"))

# Single OpenAI client; reads OPENAI_WEBHOOK_SECRET from env automatically
client = OpenAI(webhook_secret=WEBHOOK_SECRET)

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=FORWARD_TIMEOUT_S)
    log.info(f"forwarder up; bridge_url={BRIDGE_URL}")
    yield
    await app.state.http.aclose()
    log.info("forwarder shutdown clean")

app = FastAPI(lifespan=lifespan)

@app.get("/__wg_canary", status_code=204)
async def canary() -> Response:
    """Heartbeat target for the bridge on Lenovo1."""
    return Response(status_code=204)

@app.get("/health", status_code=200)
async def health() -> dict:
    return {"ok": True, "bridge_url": BRIDGE_URL}

@app.post("/openai/webhook")
async def relay(request: Request) -> Response:
    raw = await request.body()  # bytes — DO NOT json.parse before unwrap
    try:
        event = client.webhooks.unwrap(raw, request.headers)
    except Exception as e:  # signature, parse, or timestamp window failure
        log.warning(f"signature_invalid err={type(e).__name__}:{e}")
        raise HTTPException(status_code=401, detail="invalid signature")

    log.info(f"webhook_ok event={event.type} size={len(raw)}")

    # Forward raw bytes + signature headers so the bridge can re-verify
    headers_to_forward = {
        k: v for k, v in request.headers.items()
        if k.lower().startswith("webhook-") or k.lower() == "content-type"
    }
    try:
        r = await request.app.state.http.post(BRIDGE_URL, content=raw, headers=headers_to_forward)
    except httpx.HTTPError as e:
        log.error(f"bridge_unreachable err={type(e).__name__}:{e}")
        # OpenAI will retry per Standard Webhooks spec
        raise HTTPException(status_code=502, detail="bridge unreachable")

    return Response(status_code=r.status_code, content=r.content,
                    media_type=r.headers.get("content-type"))

# Run with: uvicorn main:app --host 0.0.0.0 --port 9876
```

### Template 2: Forwarder `Dockerfile`

```dockerfile
# voice-stack/vs-webhook-forwarder/Dockerfile
FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 9876
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9876"]
```

### Template 3: docker-compose service block (append to `voice-stack/docker-compose.yml`)

```yaml
  webhook-forwarder:
    image: voice-stack-webhook-forwarder:v1
    container_name: vs-webhook-forwarder
    build:
      context: ./vs-webhook-forwarder
      dockerfile: Dockerfile
    restart: unless-stopped
    network_mode: host          # binds to 0.0.0.0:9876, reachable on 127.0.0.1 (Caddy) and 10.0.0.1 (WG peer)
    env_file:
      - ./env/forwarder.env     # OPENAI_WEBHOOK_SECRET, BRIDGE_WEBHOOK_URL
    stop_grace_period: 5s
```

`./env/forwarder.env` (NOT committed; rendered by carsten from OneCLI vault):
```
OPENAI_WEBHOOK_SECRET=whsec_...   # from OpenAI dashboard, project proj_4tEBz3X…
BRIDGE_WEBHOOK_URL=http://10.0.0.2:4401/webhook
```

### Template 4: Bridge `src/index.ts` (TypeScript + Fastify v5)

```typescript
// voice-bridge/src/index.ts
import Fastify from 'fastify'
import OpenAI from 'openai'
import pino from 'pino'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { startHeartbeat } from './heartbeat.js'
import { buildLogger } from './logger.js'

const PORT = Number(process.env.BRIDGE_PORT ?? 4401)
const HOST = process.env.BRIDGE_BIND ?? '10.0.0.2'  // WG-only by default
const SECRET = process.env.OPENAI_WEBHOOK_SECRET
if (!SECRET) {
  console.error('OPENAI_WEBHOOK_SECRET not set; refusing to start')
  process.exit(1)
}

const log = buildLogger()  // pino + pino-roll → ~/nanoclaw/voice-container/runs/bridge-DATE.jsonl
const openai = new OpenAI({ webhookSecret: SECRET })

const app = Fastify({ logger: false })  // we use pino directly via `log`

// Capture raw body for signature verification (Fastify v5 idiom)
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
  ;(_req as any).rawBody = body
  try {
    done(null, JSON.parse((body as Buffer).toString('utf8')))
  } catch (err) {
    done(err as Error, undefined)
  }
})

app.get('/health', async () => {
  // wg_ok is best-effort: heartbeat coroutine maintains the source of truth in module state.
  // For Phase 1 we surface secret_loaded + uptime; Phase 2 will surface wg_ok.
  return {
    ok: true,
    secret_loaded: true,
    uptime_s: Math.round(process.uptime()),
    bind: HOST,
    port: PORT,
  }
})

app.post('/webhook', async (request, reply) => {
  const t0 = Date.now()
  const raw = (request as any).rawBody as Buffer
  let signatureValid = false
  let eventType = 'unknown'
  let callId: string | undefined
  try {
    const evt = openai.webhooks.unwrap(raw.toString('utf8'), request.headers as any, SECRET)
    signatureValid = true
    eventType = (evt as any).type ?? 'unknown'
    callId = (evt as any).data?.call_id
  } catch (e: any) {
    log.warn({ event: 'webhook_signature_invalid', err: e?.message })
    return reply.code(401).send({ error: 'invalid signature' })
  }
  log.info({
    event: 'webhook_received',
    event_type: eventType,
    call_id: callId,
    signature_valid: signatureValid,
    payload_size: raw.length,
    latency_ms: Date.now() - t0,
  })
  return reply.code(200).send({ ok: true })
})

async function main() {
  await app.listen({ host: HOST, port: PORT })
  log.info({ event: 'bridge_listening', host: HOST, port: PORT })
  // Fire-and-forget: heartbeat lives for process lifetime
  void startHeartbeat(log).catch((err) => {
    log.error({ event: 'heartbeat_died', err: err?.message })
  })
}

// Clean shutdown for systemd
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    log.info({ event: 'shutdown', signal: sig })
    await app.close()
    process.exit(0)
  })
}

main().catch((err) => {
  log.fatal({ event: 'startup_failed', err: err?.message })
  process.exit(1)
})
```

### Template 5: Bridge `src/logger.ts` (pino + pino-roll)

```typescript
// voice-bridge/src/logger.ts
import pino from 'pino'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export function buildLogger(): pino.Logger {
  const dir = process.env.BRIDGE_LOG_DIR
    ?? join(homedir(), 'nanoclaw', 'voice-container', 'runs')
  mkdirSync(dir, { recursive: true })

  const transport = pino.transport({
    targets: [
      {
        target: 'pino-roll',
        options: {
          file: join(dir, 'bridge'),       // pino-roll appends -YYYY-MM-DD
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          extension: '.jsonl',
          mkdir: true,
        },
        level: process.env.LOG_LEVEL ?? 'info',
      },
      {
        target: 'pino/file',                // also stdout for journald
        options: { destination: 1 },
        level: process.env.LOG_LEVEL ?? 'info',
      },
    ],
  })
  return pino({ base: { svc: 'voice-bridge' } }, transport)
}
```

### Template 6: systemd `voice-bridge.service`

```ini
# ~/.config/systemd/user/voice-bridge.service
[Unit]
Description=NanoClaw Voice Director Bridge (stub, phase 1)
Documentation=file:///home/carsten_bot/nanoclaw/voice-bridge/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/nanoclaw/voice-bridge
EnvironmentFile=%h/nanoclaw/.env
ExecStart=/usr/bin/node %h/nanoclaw/voice-bridge/dist/index.js
Restart=on-failure
RestartSec=2s
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=voice-bridge
# Don't run NoNewPrivileges/ProtectSystem etc — we need to write to ~/nanoclaw/voice-container/runs

[Install]
WantedBy=default.target
```

**Activation:**
```bash
mkdir -p ~/.config/systemd/user
cp ~/nanoclaw/systemd/voice-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now voice-bridge
journalctl --user -u voice-bridge -f
```

**Note on `--user` lingering:** for the unit to start at boot without an interactive login, run once: `loginctl enable-linger carsten_bot` (already true if existing `nanoclaw.service` works at boot — verify first).

### Template 7: Caddy snippet

**One-time edit to `/etc/caddy/Caddyfile` (carsten):** at the end, ensure the line `import sites-enabled/*.caddy` exists. If not, append:
```
import sites-enabled/*.caddy
```

**New file `/etc/caddy/sites-enabled/voice-webhook.caddy`:**
```
# OpenAI realtime webhook forwarder — Phase 1 NanoClaw Voice
voice-webhook.<existing-domain> {
    # Auto-TLS via Let's Encrypt; needs DNS A record + port 80/443 reachable
    encode gzip

    # Only the webhook path is public; canary stays private
    @webhook path /openai/webhook
    handle @webhook {
        reverse_proxy 127.0.0.1:9876
    }

    # Everything else returns 404 (no leakage of /__wg_canary, /health)
    handle {
        respond 404
    }

    log {
        output file /var/log/caddy/voice-webhook.log
        format json
    }
}
```

`<existing-domain>` to be filled by carsten (see §Open Questions). Reload via `sudo systemctl reload caddy`.

`[CITED: caddyserver.com/docs/caddyfile/directives/import — confirms relative-path glob semantics]`

### Template 8: FreeSWITCH dialplan edit

**Existing file** (`voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml`) currently bridges to `sofia/internal/sip-to-ai@127.0.0.1:5080`. **Phase 1 replaces this** with an OpenAI SIP target. Backup first.

```xml
<include>
  <extension name="sipgate_inbound">
    <condition field="destination_number" expression="^(gw\+sipgate|\+?49308687022345|0308687022345|8702234e5)$">
      <action application="log" data="INFO Sipgate inbound destnum=${destination_number} caller=${caller_id_number}"/>

      <!-- A-leg (Sipgate): force PCMU exclusively (REQ-SIP-04, D-20) -->
      <action application="set" data="absolute_codec_string=PCMU"/>
      <action application="set" data="codec_string=PCMU"/>

      <!-- B-leg fail-fast: SIP 503 if OpenAI bridge unreachable >3s (REQ-SIP-07) -->
      <action application="set" data="originate_timeout=3"/>
      <action application="set" data="hangup_after_bridge=true"/>
      <action application="set" data="continue_on_fail=NORMAL_TEMPORARY_FAILURE,USER_BUSY,NO_ANSWER,ALLOTTED_TIMEOUT,NO_USER_RESPONSE"/>

      <!-- Bridge directly to OpenAI SIP endpoint (D-19; ARCHITECTURE.md §Critical boundary) -->
      <action application="bridge" data="[absolute_codec_string=PCMU,codec_string=PCMU]sofia/external/sip:proj_4tEBz3XjO4gwM5hyrvsxLM8E@sip.api.openai.com;transport=tls"/>

      <!-- Failure path: respond SIP 503 to Sipgate (REQ-SIP-07) -->
      <action application="respond" data="503 Service Unavailable"/>
    </condition>
  </extension>
</include>
```

**Reload (no full restart needed):**
```bash
docker exec vs-freeswitch fs_cli -x "reloadxml"
docker exec vs-freeswitch fs_cli -x "sofia profile external rescan"  # picks up gateway/profile changes
```

`fs_cli -x "reloadxml"` is sufficient for dialplan changes. Sofia profile/gateway changes need an additional `rescan` (preferred over `restart` — `restart` drops active calls).

`[VERIFIED: existing /home/carsten_bot/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml — current state]`

### Template 9: Synthetic webhook test fixture (D-25)

```python
# voice-stack/vs-webhook-forwarder/test_synthetic.py
"""D-25: post a signed synthetic webhook to public Caddy URL; assert bridge logs entry."""
import json
import os
import sys
import time
from openai import OpenAI

SECRET = os.environ["OPENAI_WEBHOOK_SECRET"]
PUBLIC_URL = os.environ["VOICE_WEBHOOK_PUBLIC_URL"]  # https://voice-webhook.<domain>/openai/webhook
client = OpenAI(webhook_secret=SECRET)

# Build a fake realtime.call.incoming payload matching the spike sample
payload = {
    "id": f"evt_test_{int(time.time())}",
    "type": "realtime.call.incoming",
    "created_at": int(time.time()),
    "data": {
        "call_id": f"rtc_test_{int(time.time())}",
        "sip_headers": {"From": "<sip:+4915112345678@sipgate.de>", "To": "<sip:+49308687022345@sipgate.de>"},
    },
}
raw = json.dumps(payload).encode("utf-8")

# Sign using OpenAI SDK helper (matches what server-side does)
import hmac, hashlib, base64
ts = str(int(time.time()))
msg = f"{payload['id']}.{ts}.{raw.decode()}".encode()
sig = base64.b64encode(hmac.new(SECRET.encode(), msg, hashlib.sha256).digest()).decode()

headers = {
    "Content-Type": "application/json",
    "webhook-id": payload["id"],
    "webhook-timestamp": ts,
    "webhook-signature": f"v1,{sig}",
}

import httpx
r = httpx.post(PUBLIC_URL, content=raw, headers=headers, timeout=10)
print(f"status={r.status_code} body={r.text[:200]}")
sys.exit(0 if r.status_code == 200 else 1)
```

**Pass criterion:** `status=200` AND within 2s a JSONL entry appears in `~/nanoclaw/voice-container/runs/bridge-$(date +%F).jsonl` with `event_type=realtime.call.incoming` and `signature_valid=true`.

`[ASSUMED]` Exact HMAC scheme matches OpenAI's Standard Webhooks; verify with `client.webhooks.unwrap()` round-trip in unit test before relying on this fixture for D-25. The `openai` SDK's internal signing helper is not part of the public API — for the synthetic test, the safer path is to spin up a `OPENAI_WEBHOOK_SECRET=test_secret` instance and use the SDK's verify path with locally HMAC'd headers as above.

---

## Runtime State Inventory

This phase is greenfield (new files in new directories) plus one config edit. Inventory:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — bridge JSONL files are net-new under `voice-container/runs/`; no existing data with the new schema | None |
| Live service config | (1) FreeSWITCH dialplan `01_sipgate_inbound.xml` currently bridges to `sip-to-ai@127.0.0.1:5080` — Phase 1 replaces with OpenAI SIP target. (2) OpenAI project dashboard webhook URL currently unset (or set to old test endpoint). (3) Caddy currently has no `voice-webhook.*` route. | (1) edit + reloadxml + sofia rescan; (2) carsten manual via dashboard; (3) add snippet + caddy reload |
| OS-registered state | (1) systemd user units on Lenovo1: `nanoclaw.service` already running; new `voice-bridge.service` to be added (no conflict). (2) `loginctl show-user carsten_bot \| grep Linger` — must be `Linger=yes` for boot-time start (likely already set if nanoclaw runs at boot). | (1) `systemctl --user daemon-reload` + enable; (2) verify linger, set if missing |
| Secrets/env vars | (1) `OPENAI_WEBHOOK_SECRET` — NEW key, sourced from OpenAI dashboard (carsten extracts post-D-17). Must exist in (a) `~/nanoclaw/voice-stack/env/forwarder.env` on Hetzner, (b) `~/nanoclaw/.env` on Lenovo1, (c) OneCLI vault if available. (2) `DISCORD_ALERT_WEBHOOK_URL` — NEW key for ALERT delivery; choose channel `legal-ops` or `voice-ops`. (3) `BRIDGE_WEBHOOK_URL=http://10.0.0.2:4401/webhook` and `WG_PEER_URL=http://10.0.0.1:9876/__wg_canary` are deployment-derived, not secret. | (1) carsten extracts + writes to .env; bot mirrors to Lenovo1 .env; document secret-rotation procedure (see §Open Questions). (2) carsten creates Discord webhook in chosen channel. |
| Build artifacts | (1) `voice-bridge/dist/` — produced by `npm run build` (tsc → CommonJS); referenced by systemd unit. (2) `vs-webhook-forwarder` Docker image — built by `docker compose build webhook-forwarder` on Hetzner. | (1) ensure `dist/` exists before `systemctl --user start voice-bridge`; (2) deploy script must include build step |

---

## Common Pitfalls

PITFALLS.md already covers WG MTU (#8), webhook duplicate/dedup (#13), and FreeSWITCH+OpenAI SDP edge cases (#7). The pitfalls below are **NEW for Phase 1** (not duplicating PITFALLS.md):

### Pitfall NEW-1: `network_mode: host` on Hetzner exposes 9876 unless explicitly firewalled

**Severity:** Severe (security)

**What goes wrong:** When `vs-webhook-forwarder` uses `network_mode: host` (required so the canary on `10.0.0.1:9876` is reachable from Lenovo1 over WG), Docker bypasses its own NAT layer. Port 9876 is bound on ALL interfaces of Hetzner — including the public IP. Anyone on the internet can `curl http://128.140.104.236:9876/openai/webhook` and bypass Caddy entirely (signature verify still rejects, but it's wasted work + DoS surface).

**Why it happens:** Docker's `network_mode: host` is documented as bypassing the network namespace; the binding is on `0.0.0.0:9876` from the host's perspective. Caddy is colocated, so `127.0.0.1:9876` works for the loopback proxy, but the same socket is reachable on the public IP.

**How to avoid:**
- Hetzner UFW or `iptables` rule: `ufw deny in 9876/tcp` (or equivalent in Hetzner cloud firewall). carsten must do this AS PART of D-23 — add it to his task list.
- Verify post-deploy with `nc -zv 128.140.104.236 9876` from a non-Hetzner host: should refuse.
- If Hetzner firewall is awkward, alternative: bind FastAPI to TWO explicit interfaces (`127.0.0.1` AND `10.0.0.1`) instead of `0.0.0.0` — but uvicorn doesn't support multi-bind natively; would require a wrapper. Stick with firewall rule.

**Warning signs:**
- `nmap -p 9876 128.140.104.236` from anywhere finds the port open.
- Forwarder logs show `signature_invalid` from non-Caddy IPs.

**Phase to address:** Phase 1, before going live.

---

### Pitfall NEW-2: SIP-02 (outbound) requires dialplan that doesn't exist yet

**Severity:** Severe (REQ blocker)

**What goes wrong:** Reading the existing `01_sipgate_inbound.xml`, ONLY the inbound condition is defined. SIP-02 ("FreeSWITCH initiates outbound calls via Sipgate with Carsten's CLI") has NO existing dialplan. Phase 1's checklist marks SIP-02 as a phase requirement, but there's nothing to test against — outbound origination requires either an ESL command or a separate dialplan extension.

**Why it happens:** The existing voice-stack was inbound-only for the spike. Phase 1 inherits the obligation to prove SIP-02 works.

**How to avoid:**
- Phase 1 plan MUST include: (a) verify `external/sipgate.xml` gateway works for outbound (`originate sofia/gateway/sipgate/+49…` via fs_cli), (b) document the originate command shape for Phase 2's Bridge ESL integration. Phase 1 does NOT need a new dialplan extension — `fs_cli -x "originate sofia/gateway/sipgate/<dest> &echo"` is the SIP-02 verification.
- Add to D-26 live test: ONE manual outbound call via `fs_cli -x "originate ..."` to Carsten's mobile, verify ringback + connected, hang up. Documents that the gateway can place outbound calls.
- Phase 4 (when Bridge gains `/outbound`) will add the proper extension. Phase 1 only needs SIP-02 as a smoke test.

**Warning signs:**
- "How do we test SIP-02?" comes up during planning. Answer: `fs_cli originate` smoke test.

**Phase to address:** Phase 1 (smoke test only); Phase 4 (real implementation).

---

### Pitfall NEW-3: Webhook secret rotation breaks both forwarder and bridge if not synchronized

**Severity:** Moderate (downtime)

**What goes wrong:** OpenAI webhook secrets can be rotated from the dashboard. If `carsten` rotates the secret on the dashboard but only updates `vs-webhook-forwarder/env/forwarder.env`, the bridge stub (which re-verifies with the OLD secret) returns 401 to the forwarder, the forwarder returns 401 to OpenAI, OpenAI retries with valid signature against forwarder (200) but bridge keeps rejecting → webhook delivery fails permanently. The defense-in-depth design INCREASES rotation complexity.

**Why it happens:** D-18's "verify on both ends" doubles the points where a stale secret matters.

**How to avoid:**
- **OneCLI sync recommended.** Document a single source of truth: OpenAI vault entry → OneCLI fetches → injects into both `~/nanoclaw/voice-stack/env/forwarder.env` (Hetzner) and `~/nanoclaw/.env` (Lenovo1). Single rotation procedure.
- Fallback if OneCLI unavailable: rotation runbook in `voice-channel-spec/operations.md` listing exact commands carsten + carsten_bot run together. Do BOTH writes within 10s of each other; restart both services within 30s.
- Future-proofing: bridge could `Symbol(OPENAI_WEBHOOK_SECRET)` reload on SIGHUP instead of restart; out of scope for Phase 1 (deferred per CONTEXT philosophy).

**Warning signs:**
- After dashboard rotation, forwarder logs `webhook_ok` but bridge logs `webhook_signature_invalid` → mismatch.
- OpenAI dashboard webhook delivery health shows "failing".

**Phase to address:** Phase 1 (document procedure); Phase 4 (consider hot-reload).

---

### Pitfall NEW-4: `addContentTypeParser` with `parseAs: 'buffer'` overrides Fastify's default JSON parser globally

**Severity:** Moderate (subtle bug if bridge grows other endpoints)

**What goes wrong:** Calling `addContentTypeParser('application/json', ..., handler)` REPLACES Fastify's built-in JSON parser for ALL routes. Phase 1 only has `/health`, `/webhook` — no risk. Phase 2+ will add `/accept`, `/outbound`, `/invoke` — those will silently route through the same buffer-then-parse handler, attaching `rawBody` to every request (memory waste) and potentially breaking if another handler relied on default behavior.

**Why it happens:** Fastify's content-type parser registry is a single map; second registration of the same content-type wins.

**How to avoid:**
- Use a **route-scoped** content type parser via `config.rawBody: true` semantic (requires the `fastify-raw-body` plugin) OR keep the global parser but ensure all future routes treat `rawBody` as optional.
- Document in `webhook.ts` header comment: "this parser is global; if you add a route that needs default JSON behavior, install `fastify-raw-body` and switch to per-route."
- For Phase 1 the global parser is fine because there's only one POST route (`/webhook`).

**Warning signs:**
- Phase 2 reviewer notices that `/accept` requests carry an unused `rawBody` Buffer of ~10KB on the request object.

**Phase to address:** Phase 1 (document); Phase 2 (revisit if route count grows).

---

### Pitfall NEW-5: `pino-roll` and journald double-log without level discipline blows journal disk

**Severity:** Moderate (operational)

**What goes wrong:** The bridge logger configuration writes to BOTH `pino-roll` (file rotation) AND stdout (journald via systemd). If LOG_LEVEL is `debug` for any reason, every webhook payload is duplicated — once on disk, once in `journalctl`. journald has its own rotation but DEBUG payloads (with full SIP headers) can fill `/var/log/journal/` quickly under load.

**Why it happens:** Two transport targets, same level, no separation between "audit trail" (file, INFO+) and "live debugging" (journald, DEBUG temporarily).

**How to avoid:**
- Default both transports to INFO. Bump file transport to DEBUG via env without bumping journald: separate `LOG_LEVEL_FILE` and `LOG_LEVEL_JOURNAL` env vars.
- For Phase 1 just keep both at INFO; document in README that DEBUG payload logging is gated behind a separate flag.
- Add `journalctl --user --vacuum-time=7d` to the operational runbook.

**Phase to address:** Phase 1 (configure carefully); Phase 4 (formalize log-level discipline).

---

## Code Examples

(All copy-pasteable templates in §Canonical Templates above.)

Quick reference for verification commands:

```bash
# Verify FreeSWITCH gateway REGED (INFRA-01)
docker exec vs-freeswitch fs_cli -x "sofia status gateway sipgate"
# Expect: State=REGED, Status=UP

# Verify Caddy snippet active (INFRA-02)
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -I https://voice-webhook.<domain>/openai/webhook  # expect 405 (GET on POST-only) or similar

# Verify forwarder reachable on WG (carsten task → carsten_bot verifies)
curl http://10.0.0.1:9876/__wg_canary  # from Lenovo1 → expect 204

# Verify bridge listening on WG only
ss -tlnp | grep 4401  # expect bind on 10.0.0.2 only, NOT 0.0.0.0

# Verify systemd unit (INFRA-08)
systemctl --user status voice-bridge
journalctl --user -u voice-bridge --since "5 min ago" -f

# Verify WG MTU (INFRA-04)
ip link show wg0 | grep mtu  # expect mtu 1380
ping -M do -s 1352 10.0.0.1   # expect success
ping -M do -s 1500 10.0.0.1   # expect "Frag needed and DF set"

# Verify SIP-07 (503 on bridge fail)
# Temporarily edit dialplan to point to a closed port:
docker exec vs-freeswitch fs_cli -x "reloadxml"
# Place a test call → confirm Sipgate logs SIP 503 returned
# Revert dialplan

# Trigger heartbeat ALERT path (INFRA-04 + verify Discord)
sudo wg-quick down wg0  # on Hetzner
# Wait 3s, observe bridge JSONL for event=wg_canary_fail
# Wait for Discord ALERT in chosen channel
sudo wg-quick up wg0
# Observe event=wg_recovered

# Synthetic webhook test (D-25)
OPENAI_WEBHOOK_SECRET=$(grep OPENAI_WEBHOOK_SECRET ~/nanoclaw/.env | cut -d= -f2) \
VOICE_WEBHOOK_PUBLIC_URL=https://voice-webhook.<domain>/openai/webhook \
python3 voice-stack/vs-webhook-forwarder/test_synthetic.py
# Expect: status=200; bridge JSONL shows entry within 2s with signature_valid=true
```

---

## State of the Art

| Old Approach | Current Approach (2026-04) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hand-rolled HMAC for webhook verify | `openai.webhooks.unwrap()` (Python ≥1.51, Node ≥6.x) | Standard Webhooks adopted by OpenAI in 2025 | Removes timestamp-tolerance and version bugs; idempotent dedup via `webhook-id` header |
| Express + `express.raw()` for webhooks | Fastify v5 + `addContentTypeParser` w/ `parseAs: 'buffer'` | Fastify v5 release (2025) made raw-body more ergonomic | 2-3× perf, single line of code |
| Caddy v1 site-block syntax | Caddy v2 `import sites-enabled/*` | Caddy v2 (Sept 2020), still current 2026-04 | Same nginx-style modular config; preserves existing routes |
| `Type=forking` Node services | `Type=simple` w/ `Restart=on-failure` | Node 14+ no longer detaches; simple matches reality | Simpler; PID tracked by systemd directly |
| Pipecat / orchestration framework SIP | FreeSWITCH direct SIP bridge to OpenAI SIP endpoint | OpenAI shipped native SIP endpoint mid-2025 | Eliminates orchestrator latency tax (per AC-03 measurements) |

**Deprecated/outdated for this phase:**
- `requests` (sync Python HTTP) for forwarder — use `httpx.AsyncClient` to keep the FastAPI event loop unblocked.
- `forever` / `pm2` for Node service supervision on Linux — systemd is the standard.
- WG MTU 1500 (default in older WG docs) — 1380 is the production-safe value.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Hetzner's underlying path supports MTU 1380 end-to-end without further fragmentation | §WireGuard MTU | If path MTU is even smaller, packets blackhole. Mitigation: `ping -M do -s 1352` test before declaring INFRA-04 green. |
| A2 | OpenAI's `webhook-signature` HMAC scheme matches Standard Webhooks v1 verbatim | §Template 9 | The synthetic test fixture would need adjustment; the SDK round-trip in production is unaffected (it uses the SDK to verify). Safer path: D-25 fixture uses the SDK's own signing primitive if exposed, otherwise a deferred manual test. |
| A3 | `loginctl enable-linger carsten_bot` is already set (because existing `nanoclaw.service` runs at boot) | §Template 6 | Bridge wouldn't survive reboot. Mitigation: explicit verification step `loginctl show-user carsten_bot \| grep Linger` in plan. |
| A4 | OneCLI vault is the right secret-distribution mechanism for `OPENAI_WEBHOOK_SECRET` | §Pitfall NEW-3 | If OneCLI doesn't support cross-host sync, manual file-copy procedure is needed. CLAUDE.md says OneCLI exists; verify capability. |
| A5 | Caddy's `handle @webhook` block correctly scopes `reverse_proxy` to only the matched path (vs leaking other paths) | §Template 7 | If misconfigured, `/__wg_canary` could be exposed publicly. Mitigation: explicit `handle { respond 404 }` fallback shown in template. |
| A6 | `sofia profile external rescan` picks up dialplan changes without dropping calls | §Template 8 | If `restart` is required, all active calls drop on dialplan deploy. Mitigation: deploy during low-call window; verify with `fs_cli show channels` before/after. |
| A7 | `network_mode: host` on the forwarder will bind to all interfaces including public IP without further config | §Pitfall NEW-1 | If Docker on Hetzner has alternate behavior, the firewall rule is unnecessary but harmless. Verify with `ss -tlnp` post-deploy. |
| A8 | The Discord channel `legal-ops` exists; if not, fallback `voice-ops` is acceptable | §Heartbeat Implementation | ALERTs would fail silently if neither channel exists. Mitigation: carsten confirms channel before deploy + creates webhook URL. |
| A9 | OpenAI accepts PCMU as the offered codec from FreeSWITCH B-leg | §FreeSWITCH dialplan edit | If OpenAI requires PCMA or G.711-A, the bridge fails. Per multiple OpenAI docs PCMU is supported; spike work confirmed bridge succeeded. Mitigation: verify with first live call from D-26. |

---

## Open Questions

1. **`<existing-domain>` for Caddy hostname** (D-12)
   - What we know: carsten owns at least one domain Caddy already terminates TLS for.
   - What's unclear: which domain to nest `voice-webhook.*` under.
   - Recommendation: planner asks carsten as part of his task list (D-23). Plan can stub `<DOMAIN>` and let carsten substitute.

2. **OneCLI cross-host secret sync capability**
   - What we know: OneCLI exists per CLAUDE.md.
   - What's unclear: whether it pushes to both Hetzner `voice_bot` and Lenovo1 `carsten_bot` from one command.
   - Recommendation: `onecli --help` discovery in the planning phase; if no native sync, document manual procedure in `voice-channel-spec/operations.md`.

3. **Discord channel name + webhook URL**
   - What we know: existing nanoclaw uses Discord webhooks for various alerts.
   - What's unclear: which channel for voice-bridge ALERTs.
   - Recommendation: carsten task to create webhook in `legal-ops` (preferred) or `voice-ops`, write URL to `~/nanoclaw/.env` as `DISCORD_ALERT_WEBHOOK_URL`.

4. **Hetzner public firewall: is 9876 already blocked?**
   - What we know: Hetzner has cloud firewall + UFW capability.
   - What's unclear: current state of inbound rules on 128.140.104.236.
   - Recommendation: carsten task — `nmap` from a non-Hetzner host to verify; add `ufw deny 9876/tcp` if open.

5. **OpenAI project ZDR status confirmation** (cross-cuts Phase 0)
   - What we know: PITFALLS.md #4 flags this; CONTEXT defers business-logic concerns.
   - What's unclear: whether ZDR is verified for `proj_4tEBz3XjO4gwM5hyrvsxLM8E` specifically.
   - Recommendation: NOT a Phase 1 blocker (no real counterpart audio yet — bridge stub doesn't process audio at all), but flag in Phase 2 plan.

6. **Sipgate outbound CLI configuration**
   - What we know: SIP-02 is a Phase 1 REQ but no outbound dialplan exists.
   - What's unclear: which Sipgate-side CLI (caller-id) to present.
   - Recommendation: smoke-test only in Phase 1 (`fs_cli originate`); full implementation in Phase 4.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js ≥22 | Bridge | ✓ (Lenovo1) | v22.22.2 | — |
| Python 3.12 | Forwarder (in container) | ✓ (Hetzner via Docker) | 3.12-slim image | — |
| Docker | Forwarder + FreeSWITCH on Hetzner | ✓ (Hetzner; verified by existing voice-stack) | n/a checked from Lenovo1 | — |
| WireGuard `wg0` interface | Heartbeat + WG forward | ✓ (Lenovo1: wg0 exists, MTU currently 1420) | needs MTU change to 1380 | — |
| systemd --user | Bridge supervision | ✓ (Lenovo1: systemctl --user works; existing nanoclaw.service) | systemd 255 | — |
| Caddy | Public TLS | ✓ (Hetzner; assumed per CONTEXT D-11) | `[ASSUMED]` v2 (verify with `caddy version`) | If absent: install + configure as a Phase 1 sub-task |
| `fs_cli` (FreeSWITCH client) | Dialplan reload + verification | ✓ (in vs-freeswitch container; access via `docker exec vs-freeswitch fs_cli`) | bundled with FreeSWITCH image | — |
| `loginctl enable-linger` | systemd --user starts at boot | `[ASSUMED]` ✓ (existing nanoclaw.service implies it's set) | n/a | If not set: `sudo loginctl enable-linger carsten_bot` |
| OneCLI | Secret distribution | ✓ (per CLAUDE.md) | unknown — `onecli --version` to check | Manual env file copy + restart |
| Discord webhook URL | ALERT delivery | ✗ (must be created by carsten in chosen channel) | n/a | Without it, ALERTs become JSONL-only — degraded but functional |
| `pip` (host-level) | NOT needed (forwarder runs in container) | n/a | n/a | — |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:**
- Discord webhook URL — bridge degrades to JSONL-only ALERTs; still satisfies REQ-INFRA-04 (detection), just loses immediate carsten notification.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Bridge framework | vitest 4.x (matches Core convention per STACK.md) |
| Bridge config file | `voice-bridge/vitest.config.ts` (Wave 0) |
| Bridge quick run | `cd ~/nanoclaw/voice-bridge && npx vitest run` |
| Bridge full suite | `cd ~/nanoclaw/voice-bridge && npm run test` |
| Forwarder framework | pytest (Wave 0 add) — minimal, just synthetic-webhook + signature-reject |
| Forwarder config | `voice-stack/vs-webhook-forwarder/pyproject.toml` (or `pytest.ini`) |
| Forwarder quick run | `cd voice-stack/vs-webhook-forwarder && pytest -x` |
| Integration | manual D-26 with real PSTN — not automated |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFRA-01 | FreeSWITCH REGED ≤30s | smoke | `docker exec vs-freeswitch fs_cli -x "sofia status gateway sipgate" \| grep REGED` | ✓ (existing fs_cli) |
| INFRA-02 | Caddy TLS + reverse proxy | smoke | `curl -fsS https://voice-webhook.<domain>/openai/webhook -X POST -d '{}' \| grep -q "invalid signature"` (expects 401) | ❌ Wave 0 (after carsten configures domain) |
| INFRA-03 | Signature verify e2e | unit + integration | unit: `cd voice-bridge && npx vitest run tests/synthetic-webhook.test.ts`; integration: synthetic POST per D-25 | ❌ Wave 0 |
| INFRA-04 | WG MTU + heartbeat | smoke | `ip link show wg0 \| grep "mtu 1380"` + `journalctl --user -u voice-bridge --since "10s ago" \| grep wg_canary` | ✓ (post-deploy) |
| INFRA-08 | systemd auto-restart ≤5s | smoke | `pkill -9 -f voice-bridge/dist; sleep 7; curl http://10.0.0.2:4401/health` (expects 200 after restart) | ✓ (post-deploy) |
| SIP-01 | Inbound INVITE accepted | manual | place real call → check `docker exec vs-freeswitch fs_cli -x "show channels"` | ✓ (existing) |
| SIP-02 | Outbound originate works | manual | `fs_cli -x "originate sofia/gateway/sipgate/<carsten-mobile> &echo"` | ✓ (existing) |
| SIP-03 | Bridge ≤500ms | manual + log | place call, grep FreeSWITCH log for `Bridge` event timing | ✓ (existing) |
| SIP-04 | PCMU only | manual + SDP | `sip_trace=on`, place call, verify SDP offer/answer in vs-freeswitch log | ✓ (existing) |
| SIP-05 | RTP 60000-60100/UDP | smoke | `nc -zuv 128.140.104.236 60000-60100` from external | requires firewall verification |
| SIP-06 | BYE releases ≤2s | manual + log | place call, hang up, verify both legs gone within 2s | ✓ (existing) |
| SIP-07 | 503 on bridge fail >3s | manual | break OpenAI target, place call, verify Sipgate gets 503 | requires test harness |

### Sampling Rate

- **Per task commit:** `npx vitest run` in voice-bridge (unit only; <5s)
- **Per wave merge:** full unit suite + synthetic webhook integration test (D-25); ~30s
- **Phase gate:** D-26 manual 3-call live integration; ALL 12 REQs verified with explicit log evidence

### Wave 0 Gaps

- [ ] `voice-bridge/vitest.config.ts` — net-new project, needs vitest scaffold
- [ ] `voice-bridge/tests/synthetic-webhook.test.ts` — covers INFRA-03 unit path
- [ ] `voice-bridge/tests/heartbeat.test.ts` — fakes 10.0.0.1 with `nock` or local listener; covers INFRA-04 logic
- [ ] `voice-stack/vs-webhook-forwarder/pyproject.toml` + `tests/test_signature.py` — covers INFRA-03 forwarder path
- [ ] Framework install (Lenovo1): `cd voice-bridge && npm install` (zero-from-scratch)
- [ ] Framework install (Hetzner): builds inside Docker, no host install needed

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (webhook sender) | OpenAI HMAC-SHA256 signature via `webhooks.unwrap()` — never hand-rolled |
| V3 Session Management | no (Phase 1 has no sessions) | — |
| V4 Access Control | yes | Bridge binds 10.0.0.2 (WG-only); forwarder canary 9876 firewalled from public |
| V5 Input Validation | yes | Webhook payload validated by SDK schema; raw body size capped via Fastify `bodyLimit` (default 1 MB OK) |
| V6 Cryptography | yes | TLS 1.2+ for Caddy (auto via Let's Encrypt); HMAC for webhook (SDK-handled); WG ChaCha20 (kernel-level) |
| V7 Error Handling | yes | 401 for bad sig, 502 for bridge unreachable, 200 only on full success |
| V9 Communication | yes | Public ingress: TLS only (Caddy 443). Forwarder→bridge: HTTP over WG (encrypted at WG layer). |
| V10 Malicious Code | partial | Container isolation for forwarder; bridge runs unprivileged user systemd service |
| V12 Files and Resources | yes | JSONL log writes restricted to `~/nanoclaw/voice-container/runs/` (user-owned) |
| V13 API | yes | Only POST `/openai/webhook` exposed publicly; `/health`, `/__wg_canary` private |

### Known Threat Patterns for this Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Webhook signature forgery | Spoofing | `webhooks.unwrap()` enforces HMAC + timestamp window (~5min) |
| Forwarder bypass via direct `9876` POST from public | Spoofing | Hetzner firewall block 9876/tcp inbound (Pitfall NEW-1) |
| Bridge bypass via direct `4401` POST from LAN | Spoofing | Bind to 10.0.0.2 only, not 0.0.0.0 |
| Replay attack (resending captured signed webhook) | Tampering | Standard Webhooks `webhook-id` + `webhook-timestamp` enforces dedup window; SDK rejects stale (>5min) |
| WG key compromise → MITM forwarder→bridge | Information Disclosure | WG keys rotated per `/opt/server-docs/MASTER.md` policy; bridge re-verifies HMAC (defense in depth) |
| Log file PII exfiltration | Information Disclosure | Logs at INFO contain only metadata (event_type, call_id, size, latency); full payloads gated to DEBUG only |
| Discord webhook URL leak | Information Disclosure | URL in `.env` (gitignored); OneCLI vault preferred |
| systemd resource exhaustion (log flood crashes journald) | Denial of Service | `journalctl --vacuum-time=7d` cron; rotate pino-roll daily |

---

## Sources

### Primary (HIGH confidence)

- `[VERIFIED via Context7]` `/openai/openai-python` — `client.webhooks.unwrap(body, headers)` Python signature verification idiom (Flask example, applies to FastAPI with `await request.body()`)
- `[VERIFIED via Context7]` `/fastify/fastify` — `addContentTypeParser` with `parseAs: 'buffer'` for raw body capture
- `[VERIFIED via WebFetch]` https://caddyserver.com/docs/caddyfile/directives/import — `import sites-enabled/*` glob semantics, relative path resolution, hidden-file behavior
- `[VERIFIED via npm registry]` openai 6.34.0, fastify 5.8.5, ws 8.20.0, pino 10.3.1 — current stable as of 2026-04-16
- `[VERIFIED via PyPI]` openai 2.32.0, fastapi 0.136.0 — current Python versions
- `[VERIFIED via direct file read]` `/home/carsten_bot/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml` — current dialplan baseline
- `[VERIFIED via direct file read]` `/home/carsten_bot/nanoclaw/voice-stack/conf/overlay/sip_profiles/external/sipgate.xml` — sipgate gateway register config
- `[VERIFIED via direct file read]` `/home/carsten_bot/nanoclaw/voice-stack/docker-compose.yml` — `network_mode: host` pattern for new forwarder service
- `[VERIFIED via direct file read]` `/home/carsten_bot/nanoclaw-state/voice-channel-spec/spike/sideband-ws/results-1776282583.json` — webhook arrival pattern verified in spike (call_id format `rtc_u0_...`, event sequence)
- `[CITED via official docs]` https://platform.openai.com/docs/guides/webhooks — Standard Webhooks scheme, `webhook-id`, `webhook-timestamp`, `webhook-signature` headers
- `[CITED]` `.planning/research/STACK.md` — TS+Fastify justification, Pino choice, systemd over Docker on Lenovo1
- `[CITED]` `.planning/research/ARCHITECTURE.md` — split-stack topology, "media never traverses WG" key insight, webhook-relay pattern

### Secondary (MEDIUM confidence)

- `[CITED]` https://gist.github.com/nitred/f16850ca48c48c79bf422e90ee5b9d95 — WireGuard MTU optimization (1380 conservative for tunneled paths)
- `[CITED]` https://defguard.net/blog/mtu-mss-decision-tree/ — MTU decision tree confirms 1380 over 1420 for variable-path environments
- `[CITED]` https://oneuptime.com/blog/post/2026-03-02-how-to-set-up-nodejs-as-a-systemd-service-on-ubuntu/view — `Type=simple` + `Restart=on-failure` + `RestartSec=5s` is the documented Node.js best practice
- `[CITED]` https://nodesource.com/blog/running-your-node-js-app-with-systemd-part-1 — `Restart=on-failure` definition + behavior
- `[CITED]` `.planning/research/PITFALLS.md` — items #7 (FreeSWITCH+OpenAI SDP), #8 (WG one-way audio), #13 (webhook duplicate)

### Tertiary (LOW confidence — flagged for confirmation)

- `[ASSUMED]` Hetzner path MTU end-to-end: assumed ≥1380 — verify with `ping -M do -s 1352` post-deploy (Assumption A1)
- `[ASSUMED]` D-25 synthetic webhook fixture's HMAC reproduction matches OpenAI's exact scheme — verify via SDK round-trip in unit test before relying on it (Assumption A2)
- `[ASSUMED]` `loginctl enable-linger carsten_bot` already set — verify with `loginctl show-user carsten_bot \| grep Linger` (Assumption A3)
- `[ASSUMED]` Caddy v2 currently installed on Hetzner — verify with `caddy version` (Environment Availability)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every package version verified against npm/PyPI registries on 2026-04-16
- Architecture patterns: HIGH — derived directly from CONTEXT.md (locked), ARCHITECTURE.md (approved), and existing repo files
- Templates: HIGH for forwarder/bridge/systemd/Caddy/dialplan — each verified against current SDK/framework docs via Context7 and direct doc fetch
- Heartbeat path settled: HIGH — HTTP canary chosen with explicit ICMP comparison
- WG MTU rationale: HIGH for the 1380 figure; MEDIUM for "Hetzner path supports 1380" (needs probe)
- New pitfalls: HIGH — all five derive from concrete patterns in the verified template code or from gaps in the existing dialplan
- Validation architecture: HIGH — every REQ has a concrete verification command

**Research date:** 2026-04-16
**Valid until:** 2026-05-16 (30-day window for OpenAI SDK + Fastify versions; re-verify if Phase 1 starts after this date)
