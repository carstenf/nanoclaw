# Architecture Research — NanoClaw Voice Split-Stack (Hetzner + Lenovo1)

**Domain:** Split-stack real-time voice agent — SIP gateway + native S2S endpoint on public host, Director Bridge + business logic on private host, WireGuard between.
**Researched:** 2026-04-16
**Confidence:** HIGH (all critical claims backed by approved spec documents, Sideband-WS spike evidence, Spike E latency evidence, and OpenAI official SIP docs verified 2026-04-16)
**Scope:** Architecture dimension for the "Split voice agent architecture" milestone. The topology was decided in E1-1a (see `voice-channel-spec/ARCHITECTURE-DECISION.md`); this document answers *where* each component lives, *how* data flows, and *in what order* to build, within the constraints AC-01..AC-08.

---

## Standard Architecture

### System Overview

Two physical hosts, one WireGuard tunnel, three trust zones. Hot-Path audio never traverses WireGuard; only control/tool-call traffic does.

```
                    ┌──────────────────────────────────────────────────────┐
                    │                   PSTN / CARRIER ZONE                │
                    │                                                      │
                    │      Sipgate (+49 308 687 022 345)                   │
                    │      REGISTER account 8702234e5@sipgate.de           │
                    └──────────────────────────┬───────────────────────────┘
                                        SIP+RTP │ public internet (TLS/SRTP)
                                               ▼
  ┌───────────────────────────────────────────────────────────────────────────────┐
  │ HETZNER PYTHON1  (128.140.104.236)   — "edge / carrier-adjacent zone"         │
  │ user: voice_bot                                                               │
  │ scope: SIP signalling + media proxy + OpenAI SIP bridge. NO business logic.   │
  │                                                                               │
  │  ┌─────────────────────────┐      ┌─────────────────────────────────────┐     │
  │  │ vs-freeswitch           │      │ vs-webhook-forwarder (NEW, small)   │     │
  │  │ (Docker, existing)      │      │ fastapi on 127.0.0.1:4402           │     │
  │  │ :5060 UDP/TCP SIP       │      │ behind Caddy (443 voice subdomain)  │     │
  │  │ :60000-60100 RTP        │      │                                     │     │
  │  │                         │      │ receives POST realtime.call.incoming│     │
  │  │ REGISTER→Sipgate        │      │ verifies OpenAI webhook signature   │     │
  │  │ dialplan:               │      │ forwards JSON to Director Bridge    │     │
  │  │  inbound  → openai-sip  │      │ over WG (10.0.0.2:4401/hook)        │     │
  │  │  outbound → openai-sip  │      │ awaits 200 OK, echoes to OpenAI     │     │
  │  │ bridges to:             │      └──────────────────┬──────────────────┘     │
  │  │  sip:proj_4tEBz3X…@     │                         │                        │
  │  │  sip.api.openai.com;tls │                         │                        │
  │  └─────────┬───────────────┘                         │                        │
  │            │ RTP G.711 PCMU (media)                  │                        │
  │            │ direct; no proxy on Lenovo1             │                        │
  │            ▼                                         │                        │
  │  ┌─────────────────────────────────────────┐         │                        │
  │  │ OpenAI SIP endpoint                      │◄───────┘ (webhook origin)       │
  │  │ sip.api.openai.com:5061 TLS              │                                 │
  │  │ hosts gpt-realtime-mini S2S session      │                                 │
  │  │ assigns call_id (rtc_u0_...)             │                                 │
  │  │ emits "realtime.call.incoming" webhook   │                                 │
  │  └──────────────────────┬──────────────────┘                                 │
  │                         │                                                     │
  └─────────────────────────┼─────────────────────────────────────────────────────┘
                            │ WireGuard 10.0.0.1 ↔ 10.0.0.2 (AC-08)
                            │   ─ POST /v1/realtime/calls/{call_id}/accept
                            │   ─ WSS sideband  wss://api.openai.com/v1/realtime?call_id=X
                            │   (Director Bridge opens WS from Lenovo1 outbound; public TLS)
                            ▼
  ┌───────────────────────────────────────────────────────────────────────────────┐
  │ LENOVO1   (WireGuard 10.0.0.2)        — "application / data zone"             │
  │ user: carsten_bot                                                             │
  │ scope: all business logic, memory, persona, Core tools, async reasoning.      │
  │                                                                               │
  │  ┌─────────────────────────────┐    ┌─────────────────────────────────────┐   │
  │  │ Director Bridge  (NEW)      │    │ NanoClaw Core (existing)            │   │
  │  │ single long-running service │    │ :4400 main, MCP tool servers        │   │
  │  │ systemd --user, port 4401   │    │ Gmail, Discord, Calendar, Hindsight │   │
  │  │                             │◄──►│ CLAUDE.md memory, groups/           │   │
  │  │ ┌──── per-call workers ───┐ │    │                                     │   │
  │  │ │ CallSession(call_id)   │ │    │ exposes MCP over stdio / http       │   │
  │  │ │  - WS to OpenAI         │ │    └─────────────────────────────────────┘   │
  │  │ │  - tool-call router     │ │                                              │
  │  │ │  - transcript buffer    │ │    ┌─────────────────────────────────────┐   │
  │  │ │  - cost accumulator     │ │    │ Slow-Brain worker (async)           │   │
  │  │ │  - turn-log JSONL       │ │───►│ Claude Sonnet background process    │   │
  │  │ │  - state: SQLite row    │ │    │ reads transcript queue, pushes      │   │
  │  │ └─────────────────────────┘ │    │ session.update instructions        │   │
  │  │                             │    │ NEVER in hot-path (AC-02)           │   │
  │  │ HTTP /hook   (webhook in)   │    └─────────────────────────────────────┘   │
  │  │ HTTP /invoke (chat debug)   │                                              │
  │  │ HTTP /calls  (observability)│    ┌─────────────────────────────────────┐   │
  │  │                             │    │ state.db (SQLite)                   │   │
  │  │ tool surface: MCP-style     │    │ tables: calls, turns, tool_calls,   │   │
  │  │ declaration; same tools     │    │ costs, transcripts (TEXT, not audio)│   │
  │  │ callable by Claude Chat     │    │ retention: per case-type policy     │   │
  │  │ for debugging (AC-07)       │    └─────────────────────────────────────┘   │
  │  └─────────────────────────────┘                                              │
  │                                                                               │
  └───────────────────────────────────────────────────────────────────────────────┘
```

**Critical boundary:** RTP media (audio) flows Sipgate ↔ FreeSWITCH ↔ OpenAI SIP endpoint **only**. It never enters WireGuard, never reaches Lenovo1. This is non-negotiable for latency (AC-01 P50 ≤900ms) and §201 StGB no-audio-persistence (AC-08 consequence: audio cannot land on a disk we control).

### Component Responsibilities

| Component | Host | Responsibility | Must NOT do | AC/REQ tags |
|-----------|------|----------------|-------------|-------------|
| **Sipgate account** | carrier | PSTN DID, REGISTER target, CLI presentation | — | REQ-SIP-01/02 |
| **FreeSWITCH (`vs-freeswitch`)** | Hetzner | SIP signalling, REGISTER→Sipgate, codec negotiation (G.711 PCMU only), dialplan routing Sipgate↔OpenAI-SIP, media relay, BYE propagation | No business logic, no tool calls, no LLM calls, no transcript processing | AC-01, AC-08, REQ-SIP-01..09, REQ-INFRA-01/04 |
| **Webhook forwarder (`vs-webhook-forwarder`)** *(new, tiny)* | Hetzner | Receive OpenAI `realtime.call.incoming` at public TLS endpoint, verify signature, relay JSON over WG to Director Bridge, return 200 OK | Never accept the call itself; never call `/accept` (that's Director Bridge's job so tools are declared from the same process that serves them) | AC-04, AC-08 |
| **OpenAI SIP endpoint** | OpenAI SaaS | Host `gpt-realtime-mini` S2S session, assign `call_id`, emit webhook, expose sideband WS | — | AC-01, AC-02, AC-05 |
| **Director Bridge** *(new, primary deliverable)* | Lenovo1 | (1) Consume forwarded webhook, (2) POST `/v1/realtime/calls/{call_id}/accept` with full session config **including tools list** (AC-04), (3) Open sideband WS, (4) Route function-call events to Core MCP tools, (5) Push `instructions`-only `session.update` mid-call, (6) Stream transcript to Slow-Brain worker, (7) Accumulate cost, (8) Write turn-timing JSONL, (9) Write session summary at BYE | Block hot-path (AC-02); change tools mid-call (AC-04); send anything but `instructions` on sideband mid-call (AC-05); directly answer domain questions without tool-call (AC-06) | AC-04, AC-05, AC-06, AC-07, REQ-DIR-01..09, REQ-INFRA-02/11/12, REQ-TOOLS-01..08 |
| **Core MCP tool servers** | Lenovo1 | `check_calendar`, `create_calendar_entry`, `get_practice_profile`, `get_contract`, `search_competitors`, `send_discord_message`, `search_hotels`, `schedule_retry` — all existing or thin wrappers on existing MCPs | Any voice-specific logic | REQ-TOOLS-01..08 |
| **Slow-Brain worker (Claude Sonnet async)** | Lenovo1 | Background: read transcript stream, decide if `instructions` update needed, push via Director Bridge, write memory, produce post-call summary | Be in hot-path (AC-02) | AC-02, REQ-DIR-06/07 |
| **state.db (SQLite)** | Lenovo1 | Authoritative per-call state: `call_id → case_type, started_at, ended_at, tool_invocations[], cost_eur, transcript_ref`. Turn-timing JSONL under `~/nanoclaw/voice-container/runs/turns-{call_id}.jsonl` | Store audio (REQ-INFRA-10) | REQ-INFRA-05/10 |
| **Caddy (existing)** | Hetzner | TLS termination for `voice-webhook.<domain>`; reverse-proxy to `vs-webhook-forwarder:4402` | — | infra reuse |
| **WireGuard tunnel** | both | Only path for control/tool traffic Hetzner↔Lenovo1 | Carry media audio (cost/latency) | AC-08, REQ-INFRA-03 |

### Why webhook-forwarder on Hetzner (not on Lenovo1)

**Confidence: HIGH** — verified against OpenAI official docs 2026-04-16.

OpenAI posts `realtime.call.incoming` to a **public HTTPS URL** configured in the project's webhook settings. The receiver must sign-verify and respond 200 quickly. Two placement options were considered:

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **A. Webhook hits Hetzner Caddy → forwarder → WG → Director Bridge** | Webhook URL stays on public Hetzner IP (Caddy already configured for TLS + OAuth ingress). No need to expose Lenovo1 publicly. Sip-adjacent failure domain: if Hetzner is down, both SIP and webhook fail together (cleaner mental model). Reuses carrier-zone trust boundary. | Extra hop (~5ms over WG). Must maintain tiny forwarder service on Hetzner. | **Chosen** |
| B. Webhook hits Lenovo1 directly (port-forward via Hetzner, or dynamic DNS) | One less service. | Breaks §0 "Lenovo1 internal only" principle from MASTER.md. Requires new inbound rule. Mixes trust zones. | Rejected |

The forwarder must be minimal (≤100 LOC Python+FastAPI) because it lives under `voice_bot` scope which is tightly whitelisted (see MASTER.md §2). It does **not** accept the call — it just relays the JSON so that the Director Bridge, which owns the tool definitions, is the one that calls `/v1/realtime/calls/{call_id}/accept` (AC-04: the accept-call payload is where tools are set, and tools live with Core on Lenovo1).

### Session-state ownership

**Authoritative state lives on Lenovo1 in `state.db` (SQLite), owned by the Director Bridge process.**

Rationale:
- Hetzner components are stateless bridges; they must be restartable at any time without losing calls (FreeSWITCH restart drops calls, but FreeSWITCH restart is an operational incident, not a state-loss event).
- All business-meaningful state (case_type, tool history, cost) is derived from Core-side actions; keeping it with Core is natural.
- SQLite single-writer fits the "single long-running Director Bridge process" shape (see below).
- Chat-Claude debug access (AC-07) needs to read state — same host, same SQLite file.

Per-call in-memory state lives in a `CallSession` object keyed by `call_id`. It is persisted to SQLite on every state transition (accept, first turn, each tool-call, BYE). On Director Bridge crash-recovery, active calls cannot be resumed (OpenAI sideband WS is process-local), but post-mortem analysis is complete.

### Process shape for the Director Bridge

**Decision: single long-running asyncio process with per-call coroutine workers.**

| Shape | Pros | Cons | Verdict |
|-------|------|------|---------|
| **Process-per-call (fork/spawn)** | Strong crash isolation: one bad tool invocation can't kill other calls. Easier to reason about memory leaks. | 100–300 MB Python RSS × N calls blows the 16 GB Lenovo1 budget fast. Tool-server connections must be reopened per process. Startup cost (~500 ms) hurts the 1500 ms sideband-WS-connect budget (REQ-DIR-01). Chat-debug interface must discover running processes (unix socket, zeroconf, …). | Rejected |
| **Single process, coroutine-per-call** | Shared MCP-tool connections. Shared SQLite writer. Startup cost paid once. Chat-debug = one HTTP endpoint. Natural fit for Python `asyncio` + `websockets` + `httpx`. | One uncaught exception in a coroutine could crash the process → all concurrent calls drop. Mitigation: each coroutine wrapped in `try/except BaseException` with CRITICAL log + SIP BYE injection; systemd `Restart=on-failure` covers hard crashes. | **Chosen** |
| Hybrid: main + per-call thread | Threads don't help in Python for I/O-bound workloads; asyncio is already concurrent. | Adds GIL complexity without benefit. | Rejected |

The expected concurrent-call ceiling is **1** (single user, personal use). The process-per-call tax is unjustified at that scale. If concurrency grows (e.g., Case 1 parallel hotel calls in v2), we re-evaluate — the coroutine interface makes a later migration to a worker-pool model mechanical.

### Fault-isolation model

This is the load-bearing "what breaks what" table. Each row is a failure; each column is a component. "OK" = continues serving; "DEG" = degraded; "DOWN" = call drops.

| Failure | Sipgate | FreeSWITCH | OpenAI SIP | WG tunnel | Dir Bridge | Core MCP | Slow-Brain | User-visible effect |
|---------|---------|------------|------------|-----------|------------|----------|------------|---------------------|
| Sipgate outage | DOWN | OK-idle | OK | OK | OK | OK | OK | No new calls. Existing call: already no media, BYE fires. |
| FreeSWITCH crash | OK | DOWN | OK-idle | OK | OK | OK | OK | All calls drop. Restart = 30s. No persistence impact. |
| OpenAI SIP outage | OK | OK | DOWN | OK | OK-idle | OK | OK | No bridge succeeds; FreeSWITCH returns 503 (REQ-SIP-07). |
| **WG drops 5s mid-call** | OK | **OK (media flows direct!)** | **OK (media flows direct!)** | DOWN | DEG | OK | OK | **Hot-Path unaffected** — user hears no glitch. Tool-calls queue in Director Bridge; if WG restored <3000ms, tool-cycle budget (REQ-DIR-05) still met. If >3000ms, bridge returns graceful error → bot says "Das kann ich gerade leider nicht nachsehen" (REQ-DIR-05). CRITICAL alert logged (REQ-INFRA-11). |
| Director Bridge crash | OK | OK | OK | OK | DOWN | OK | OK | Active call becomes a "free-running" OpenAI session with no tool access and no new instructions. User still gets real-time chat but tools return errors. systemd restarts DB within 5s; new calls OK; crashed call never recovers (WS session is process-local). Acceptable tradeoff vs. process-per-call memory cost. |
| Core MCP tool hangs >3s | OK | OK | OK | OK | DEG | DEG | OK | Director Bridge enforces 3000ms timeout per REQ-DIR-05; returns graceful error to OpenAI; bot fallback speech. Tool server marked unhealthy (next call skips/warns). |
| Slow-Brain (Claude) hangs | OK | OK | OK | OK | OK | OK | DEG | **Zero hot-path impact** (AC-02). Instructions stay at whatever was last pushed; summary delayed. |
| Lenovo1 reboot | OK | OK | OK | OK-later | DOWN | DOWN | DOWN | Active call runs to completion audio-only with no tool access; future calls blocked until Lenovo1 back. |

**Key insight — WireGuard failure is survivable because media bypasses WG.** The decision to bridge FreeSWITCH directly to `sip.api.openai.com` (REQ-SIP-03) rather than proxying audio through Lenovo1 is what makes this survivable. Historical Director-Pattern Option a/b (MITM SIP through Lenovo1) would have made WG-failure = call-drop. Option c (chosen, documented in `decisions/2026-04-13-voice-v6-findings-director-pattern.md`) trades away some observability of the audio path for fault-isolation.

---

## Recommended Project Structure

Lives in existing `nanoclaw` repo on Lenovo1 as a sibling to the existing TypeScript core, written in Python (asyncio fits OpenAI WS + MCP client better; Core stays TypeScript).

```
~/nanoclaw/
├── src/                               # existing TypeScript NanoClaw Core (unchanged)
├── voice-container/                   # existing spike dir (legacy, keep for benchmarks)
├── voice-director-bridge/             # NEW — Python service on Lenovo1
│   ├── pyproject.toml
│   ├── README.md
│   ├── src/director_bridge/
│   │   ├── __main__.py                # systemd entrypoint, asyncio event loop
│   │   ├── config.py                  # env loading, WG peer addrs, OpenAI key (OneCLI)
│   │   ├── app.py                     # FastAPI: /hook, /invoke, /calls, /health
│   │   ├── webhook.py                 # verify OpenAI sig, parse realtime.call.incoming
│   │   ├── call_session.py            # CallSession — per-call coroutine worker
│   │   ├── accept.py                  # POST /v1/realtime/calls/{id}/accept (tools set HERE, AC-04)
│   │   ├── sideband.py                # WS client — receive events, send instructions (AC-05)
│   │   ├── tools/
│   │   │   ├── registry.py            # declarative tool schema (single source for accept+invoke)
│   │   │   ├── calendar.py            # REQ-TOOLS-01/02
│   │   │   ├── contract.py            # REQ-TOOLS-03
│   │   │   ├── competitors.py         # REQ-TOOLS-04
│   │   │   ├── practice.py            # REQ-TOOLS-05
│   │   │   ├── discord.py             # REQ-TOOLS-06
│   │   │   ├── hotels.py              # REQ-TOOLS-07
│   │   │   └── retry.py               # REQ-TOOLS-08
│   │   ├── mcp_client.py              # thin client to existing Core MCP servers
│   │   ├── slow_brain.py              # async Claude worker — transcript queue, instructions push
│   │   ├── persona/
│   │   │   ├── base.md                # directive anti-hallucination prompt (AC-06)
│   │   │   ├── case_6.md              # Carsten direct channel
│   │   │   ├── case_2.md              # restaurant outbound
│   │   │   └── …
│   │   ├── cost.py                    # per-call/day/month caps (REQ-INFRA-06..09)
│   │   ├── state.py                   # SQLite schema + repo (state.db)
│   │   ├── turnlog.py                 # JSONL turn-timing writer (REQ-INFRA-05)
│   │   └── observability.py           # structured logging, /metrics
│   └── tests/
│       ├── test_webhook_signature.py
│       ├── test_tool_registry.py
│       ├── test_call_session_lifecycle.py
│       ├── test_fault_wg_drop.py
│       └── test_cost_caps.py
├── voice-webhook-forwarder/           # NEW — minimal FastAPI on Hetzner voice_bot
│   ├── Dockerfile                     # lives in voice-stack/ on Hetzner, not Lenovo1
│   ├── main.py                        # <100 LOC: verify sig, POST to WG peer, return 200
│   └── README.md                      # deploy instructions via SSH to voice_bot@hetzner
└── systemd/
    └── nanoclaw-director-bridge.service  # User service under carsten_bot
```

### Structure Rationale

- **`voice-director-bridge/`** is a sibling of `src/` (Core) to enforce AC-07 + REQ-INFRA-12: Core is TypeScript, Bridge is Python, shared code would be a red flag. The process boundary is the business-logic separation boundary.
- **`tools/registry.py` is the single source of truth** for tool schemas. Both `accept.py` (the session.accept call) and `app.py` (the `/invoke` Chat-Claude debug endpoint from AC-07) read from it. This is the mechanism that makes AC-07 true by construction — Chat-Claude invoking a tool goes through the exact same Python function as a realtime function-call.
- **`persona/*.md` as files** not strings: Slow-Brain and the accept-call both reload them per call; Carsten edits prompts via `git` not via deploy.
- **`voice-webhook-forwarder/` is physically in the nanoclaw repo but deploys to Hetzner** via scripts/apply-voice-stack or equivalent — single-source of truth, even though it runs under `voice_bot`.
- **`turnlog.py` writes to `~/nanoclaw/voice-container/runs/turns-*.jsonl`** — reuses existing path convention from E1-1a spike for continuity of the latency-measurement tooling.

---

## Architectural Patterns

### Pattern 1: Tools-at-Accept-Time, Instructions-Mid-Call (AC-04 + AC-05)

**What:** The POST to `/v1/realtime/calls/{call_id}/accept` is the **only** moment where `tools: [...]` can be set. After that, the sideband WS may push `session.update` with `instructions` changes, but the `tools` field must be omitted or unchanged. Sending a `session.update` with a new tools list mid-call reproducibly kills the audio output delta stream (Sideband-WS spike T5, 2026-04-15: 0 audio deltas in 15 s window).

**When to use:** Always. There is no escape hatch for "just this one call needs a special tool".

**Trade-offs:**
- Pro: Stable audio pipeline; matches OpenAI's design intent for realtime sessions.
- Con: Tool set is case-type-bound. We must know case type (Case 2 vs. Case 4 vs. Case 6) **before calling `/accept`**. That's why case-type detection happens in the webhook path, before accept, from SIP From-header CLI + destination number.

**Example:**
```python
# director_bridge/accept.py
async def accept_call(call_id: str, case_type: CaseType) -> None:
    tools_schema = tool_registry.for_case(case_type)   # picks 4-7 tools, max 15 (AC-006)
    persona = load_persona(case_type)                  # directive prompt (AC-06)
    payload = {
        "type": "realtime",
        "model": "gpt-realtime-mini",
        "instructions": persona,
        "tools": tools_schema,                         # ONCE. NEVER AGAIN.
        "tool_choice": "auto",                         # AC-004 from E1-1a
        "input_audio_format": "g711_ulaw",
        "output_audio_format": "g711_ulaw",
        "turn_detection": {"type": "server_vad"},
        "voice": "alloy",
    }
    await httpx.post(f"{OPENAI}/v1/realtime/calls/{call_id}/accept",
                     json=payload, headers=AUTH, timeout=2.0)
```

### Pattern 2: Webhook-Relay Not Webhook-Handle (on Hetzner)

**What:** Hetzner receives the webhook purely to keep it inside the public trust zone; it does not make decisions. It verifies the signature (security), forwards over WG to Lenovo1, and echoes whatever Lenovo1 returns (usually 200).

**When to use:** Whenever an external service must post to a public URL but the business logic lives private.

**Trade-offs:**
- Pro: Clean trust-zone separation; Lenovo1 stays unreachable from public internet.
- Con: Extra latency (~5 ms WG RTT). Since OpenAI's webhook timeout is ~10 s, irrelevant.

**Example:**
```python
# voice-webhook-forwarder/main.py (runs on Hetzner as voice_bot)
@app.post("/openai/webhook")
async def relay(req: Request):
    body = await req.body()
    verify_openai_signature(req.headers, body)  # security: reject if bad
    async with httpx.AsyncClient(timeout=5.0) as c:
        r = await c.post("http://10.0.0.2:4401/hook",
                         content=body, headers={"content-type": "application/json"})
    return Response(status_code=r.status_code, content=r.content)
```

### Pattern 3: Single-Source Tool Registry (AC-07 by construction)

**What:** Every tool is declared once, as a Python function with a JSON-schema-decorated signature. Three consumers read from that one registry:
1. `accept.py` serialises to OpenAI's `tools: [...]` schema.
2. `app.py /invoke` exposes as MCP-compatible HTTP endpoint for Chat-Claude debugging.
3. Callsession's function-call dispatcher looks up by name.

**When to use:** Any system where the same tool must be callable by multiple clients (e.g. realtime model + chat model).

**Trade-offs:**
- Pro: AC-07 satisfied without duplication; a tool bug manifests identically in both paths, making it discoverable from Chat.
- Con: Requires adopting a Python decorator/schema convention; engineers must not bypass registry.

### Pattern 4: Hot-Path Bypass Bus for Slow-Brain

**What:** Slow-Brain reads transcripts from an `asyncio.Queue` that the CallSession writes to non-blockingly. Slow-Brain produces `session.update` instructions and writes them back to a second queue; CallSession drains the second queue at turn boundaries only (never mid-utterance).

**When to use:** Any architecture where an expensive reasoner must observe+influence a low-latency stream without blocking it.

**Trade-offs:**
- Pro: AC-02 satisfied by construction — the hot-path never `await`s on Slow-Brain.
- Con: Slow-Brain's influence is always one-turn-delayed. Acceptable per Sideband-WS spike Runde 2 evidence.

### Pattern 5: Cost-Cap as Pre-Call Gate

**What:** Before calling `/accept`, Director Bridge queries the cost ledger (`state.db costs` table). If monthly cap hit, reject the call with SIP 503 via a callback to FreeSWITCH (or don't accept, which makes OpenAI BYE the leg within its own timeout). Per-call cap enforced mid-call: accumulator runs, hits 80% → push filler-style polite wrap-up instruction; hits 100% → emit `response.cancel` + `session.close`.

**When to use:** Any per-call paid external service.

**Trade-offs:**
- Pro: Deterministic enforcement; no surprise bills.
- Con: Cost accumulation is approximate until OpenAI's usage webhook settles hours later.

---

## Data Flow

Three critical paths. Each annotated with latency budgets from REQ-VOICE/REQ-DIR.

### Flow 1 — INBOUND call (Case 4, whitelist-matched, or Case 6, Carsten's CLI)

```
T=0     Carsten's phone dials +49 308 687 022 345
        │ PSTN
        ▼
        Sipgate SBC
        │ SIP INVITE over internet (TLS)
        ▼
T≈50ms  FreeSWITCH on Hetzner receives INVITE
        │ dialplan matches → detect From-header CLI
        │ (Carsten's CLI → mark Case 6; whitelist match → Case 4; else 603 decline per REQ-C4-02)
        │ originate outbound leg: INVITE to sip:proj_…@sip.api.openai.com;transport=tls
        │ (no WG traversal — direct to OpenAI)
        ▼
T≈120ms OpenAI SIP endpoint accepts 200 OK
        │ assigns call_id = rtc_u0_<hex>
        │ FreeSWITCH bridges the two legs; RTP begins flowing Sipgate↔OpenAI
        │ (still no WG traversal)
        │
        │ In parallel, OpenAI fires webhook:
        ▼
T≈150ms HTTPS POST realtime.call.incoming → Caddy Hetzner → vs-webhook-forwarder
        │ signature verified
        │ forwarded over WG to http://10.0.0.2:4401/hook   [FIRST WG hop]
        ▼
T≈160ms Director Bridge receives hook
        │ parses SIP headers from payload (From, To, Diversion)
        │ classifies case (Case 6 vs 4 vs reject)
        │ CallSession(call_id) instantiated
        │ selects tools + persona for case type
        │ loads pre-call context (calendar snapshot, contract, profile) via Core MCP
        │ (pre-fetch = AC-005 of ARCHITECTURE-DECISION; eliminates ~80% mid-call tool-calls)
        ▼
T≈700ms POST /v1/realtime/calls/{call_id}/accept with tools + persona + context  [WG out]
        │ (must be <1500ms from hook per REQ-DIR-01; budget 800ms consumed)
        ▼
T≈900ms OpenAI begins session; bot speaks greeting ("Ja, Carsten?" for Case 6)
        │ greeting arrives at Carsten's phone via RTP
        │
        │ In parallel: Director Bridge opens sideband WS:
        ▼
T≈1100ms wss://api.openai.com/v1/realtime?call_id={id} connected from Lenovo1  [outbound TLS, not WG — OpenAI is on public internet]
         │ begins receiving event stream (input_audio_buffer.speech_*, response.*)
         │ Director Bridge starts streaming transcripts to Slow-Brain queue
         │
         │ Conversation proceeds, turn by turn:
         ▼

Per-turn flow (repeating):
  T0    counterpart stops speaking → input_audio_buffer.speech_stopped event
        │ arrives at Director Bridge via WS (not latency-critical)
  ─── latency-critical window opens ───
  T1    OpenAI emits response.output_audio.delta (first audio byte)
        │ goes straight back via OpenAI SIP → FreeSWITCH → Sipgate → Carsten
        │ T1-T0 must be ≤900ms P50 (REQ-VOICE-02) — Spike E measured 635ms
  ─── latency-critical window closes ───

  If turn triggers function_call:
    Tc0  response.function_call_arguments.done event  [WS in]
         │ Director Bridge dispatches to tool registry
    Tc1  tool function runs, calls Core MCP over WG  [WG out+in]
         │ response prepared
    Tc2  Director Bridge sends conversation.item.create (role=function_call_output)  [WS out]
         │ + response.create to trigger next turn
         │ Tc2-Tc0 ≤3000ms (REQ-DIR-04); Spike E measured 1598ms
  End per-turn.

On BYE (T=BYE):
  Sipgate sends BYE → FreeSWITCH → propagates to OpenAI SIP leg
  │ OpenAI closes session; WS disconnects; Director Bridge CallSession worker exits gracefully
  │ Cost finalised, session summary written to Core via Discord-MCP
  │ (REQ-DIR-07: ≤10s after BYE)
  ▼
  Audio buffers in FreeSWITCH + OpenAI: cleared (REQ-INFRA-10)
```

### Flow 2 — OUTBOUND call (Cases 1/2/3, Carsten-triggered)

Identical to Flow 1 from OpenAI-webhook-onward. The differences are upstream:

```
T=-∞   Carsten (via Core, e.g. "NanoClaw, book me a table at Tantris Friday 8pm")
       Core scheduler produces an outbound-call task with target phone, case_type, goal_json
       │
       ▼
T=0    Core → Director Bridge: POST /outbound {case_type, target_phone, goal_json}
       │ Director Bridge validates cost caps (REQ-INFRA-06..09)
       │ pre-fetches Core context (address, calendar snapshot, preferences)
       ▼
T≈50ms Director Bridge → FreeSWITCH via ESL (over WG): originate <sip:target> <openai-endpoint>
       │ FreeSWITCH dials Sipgate outbound leg first (REQ-SIP-02)
       │ When answered, bridges to OpenAI SIP leg
       │
       │ From here on: OpenAI fires realtime.call.incoming with call_id
       │ → Flow 1 from T≈150ms onward
```

**Note on outbound triggering mechanism:** FreeSWITCH ESL (Event Socket Library) is the standard way to tell FreeSWITCH to place a call. ESL lives on FreeSWITCH port 8021; Director Bridge connects from Lenovo1 over WG. Alternative: generate a dialplan call-file and drop it in `/var/spool/freeswitch/` — less flexible.

### Flow 3 — CASE 6 NanoClaw-INITIATED OUTBOUND (MVP target)

This is the **shortest end-to-end path** and the MVP milestone target. It exercises every component without the complexity of counterpart-facing cases.

```
T=0    Something in NanoClaw Core (e.g. a reminder: "you wanted to know about
       Hamburg hotel rates at 6pm") → emits event → Director Bridge /outbound
       { case_type: "case_6b", target_phone: "+49170...", goal_json: {topic: "..."} }
       │
       ▼
T≈50ms Director Bridge: place outbound-call via FreeSWITCH ESL
       │ FreeSWITCH dials Carsten's mobile via Sipgate
       │ When Carsten answers, bridges to OpenAI-SIP leg
       ▼
       OpenAI → realtime.call.incoming webhook → WG → Director Bridge
       │ case_type already known (outbound), tools = Case-6 full Core access
       │ persona instructs: "You are NanoClaw. The target is Carsten. Identify
       │   yourself immediately: 'Hi Carsten, kurz wegen dem Hamburg-Hotel...'" (REQ-C6-04)
       │
       ▼
       /accept with Case-6 tool set (full: calendar, contract, discord, memory-read/write,
       hindsight, search, plus confirm-action tool for verbindliche Aktionen per REQ-C6-03)
       ▼
       Conversation. On verbindliche Aktion:
         bot: "Ich buche also Hotel X für 180€ am Freitag — bestätigst du?"
         Carsten: "ja"
         → function_call confirm_action({action_id: "..."}) → Director Bridge
         → only NOW does the real booking tool fire. (Explicit-confirm gate for MOE-6.)
       ▼
       Carsten: "danke, tschüss" → BYE → teardown
```

**Why Case 6 is MVP:**
1. No counterpart — §201 StGB disclosure issues don't apply (Carsten is the counterpart).
2. No Bot-thematisation risk — Carsten knows it's a bot by definition.
3. All Core tools available — exercises the full tool-registry path.
4. Cost is low — short turns, Carsten-aware.
5. Failures are debuggable — Carsten is both user and tester.
6. Full architecture is exercised: SIP inbound+outbound, webhook, accept, tools, sideband, Slow-Brain, cost-cap, turn-log.
7. Matches ConOps §4a.3 Stufe 2 ordering (after MVC Case 2 Core infra, but Case 6 is architecturally simpler — this research recommends swapping to Case 6 first, because Case 2's Core infra X5/X6/X8 is decoupled from the voice split-stack question that this milestone is actually about).

**Recommendation to roadmap:** Build order should be Case 6 → Case 2 → Case 3 → Case 4 → Case 1, rather than the ConOps §4a.3 "Case 2 = MVC, Case 6 Stufe 2" order. Case 6 first finishes the voice architecture; Case 2 first would block on Core-adaptation work (X1–X8) that has nothing to do with the voice split-stack.

---

## Build Order Implications

Each phase unlocks the next. Target: first real PSTN-to-Carsten call (Case 6b) by end of Phase 3.

| Phase | Deliverable | Unblocks testing of | Can test without |
|-------|-------------|---------------------|------------------|
| **0. Pre-work (infra)** | OpenAI webhook URL configured; voice-webhook-forwarder deployed on Hetzner under voice_bot; Caddy subdomain for voice-webhook.*; WG peer confirmed 10.0.0.1↔10.0.0.2; OpenAI ZDR mode activated (AC-08 ConOps side) | Nothing | — |
| **1. Webhook path + stub Bridge** | Director Bridge skeleton on Lenovo1: /hook endpoint; signature verify; log payload; return 200; systemd service running | Webhook arrives end-to-end; measure WG hop latency; verify signature scheme; log inbound payloads from test calls. Director Bridge stub does NOT accept the call — FreeSWITCH still declines or OpenAI times out. | Any call flow |
| **2. Accept + minimal tools** | Director Bridge calls /accept with a directive persona (AC-06) and **one** tool: `send_discord_message`. Case 6 persona only. | **First end-to-end Case 6b call possible.** Carsten calls his number, gets a bot greeting, says "send a Discord message to me saying it works", bot calls tool, Carsten sees Discord message. This is the MVP gate. | Tool variety, Slow-Brain, cost caps |
| **3. Sideband WS + Slow-Brain** | Director Bridge opens sideband WS; logs all events; async Claude Sonnet worker reads transcripts (no writing back yet, just observation); turn-timing JSONL logged to `runs/turns-*.jsonl` | Measure P50/P95 against MOS-1; verify AC-05 instructions-only push; verify AC-04 tools-never-change | Case 6a inbound, outbound cases |
| **4. Outbound + ESL trigger** | Director Bridge exposes /outbound HTTP; connects to FreeSWITCH ESL over WG; places Case 6b outbound call to Carsten. Confirm-action gate tool implemented. | REQ-C6-04/05; MOE-6 confirm-gate pathway | Case 2/3/4 |
| **5. Core MCP integration (calendar+contract)** | calendar.py, contract.py, practice.py tools wired to existing Core MCP servers over WG | Case 3 (medical appointment), Case 2 (restaurant with calendar) | Case 4 live-search, Case 1 multi-call |
| **6. Case 6 inbound full loop** | Case 6a: Carsten calls in, full Core access, memory read/write, verbindliche-Aktion confirm-gate. MOE-6 gate test. | Declare Case 6 complete. Roadmap-trigger for Case 2. | |
| **7. Cost caps + observability** | Per-call/day/month caps; 80% soft-warning; P50 drift alert; monthly audio-file audit cron | Can run in production without cost risk | |
| **8. Case 2 (restaurant)** | Outbound-only; specific persona; retry-scheduler tool | MOE-1 baseline | |
| **9. Case 3, Case 4, Case 1** | In that order per ConOps. Case 4 adds takeover hotword → SIP REFER to Carsten's mobile | Full v1 scope | |

### Case 6 MVP slice (explicit)

Phase 0 + 1 + 2 is the minimum to prove the split-stack architecture works:

1. **Gate test:** Carsten dials his Sipgate number from his mobile.
2. Sipgate → FreeSWITCH → OpenAI SIP bridge succeeds.
3. OpenAI webhook fires → Hetzner forwarder → WG → Director Bridge.
4. Director Bridge calls /accept with Case-6 persona + `send_discord_message` tool.
5. Bot greets "Ja, Carsten?" within 2s (REQ-C6-01).
6. Carsten says "schick mir 'hallo' auf Discord".
7. Bot calls tool; Director Bridge forwards to Discord MCP; tool returns ok.
8. Bot confirms "erledigt"; Carsten hangs up.
9. Director Bridge writes session summary via Discord-MCP within 10s.
10. Turn-timing JSONL shows P50 < 900ms.
11. `find ~/nanoclaw ~/.cache /tmp -name "*.wav" -o -name "*.mp3"` returns zero results.

This gate is **Phase-3-exit** in this research's recommended roadmap.

---

## Scaling Considerations

NanoClaw Voice is single-user by design. Scaling discussion is about robustness under single-user load + future-proofing, not multi-tenant throughput.

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 concurrent call (default, always) | Current design is sufficient. SQLite single-writer OK. |
| 2-3 concurrent calls (Case 1 multi-hotel) | Coroutine model scales naturally. Watch memory: each CallSession holds transcripts (~200 kB/min). SQLite still fine. |
| 5+ concurrent calls (hypothetical) | Split CallSession state to Redis; add connection pooling for MCP clients; keep single Director Bridge process but grow worker coroutines. |
| Multi-user (out of scope) | Would require re-spec per PRD §6. Architecturally: per-user persona registry, per-user cost ledger, per-user SIP identity. |

### Scaling Priorities

1. **First bottleneck: Director Bridge coroutine exceptions cascade.** Mitigation: exhaustive `try/except BaseException` per CallSession; systemd auto-restart; readiness probe before accepting /outbound.
2. **Second bottleneck: SQLite write contention under parallel calls.** Mitigation: WAL mode, batched writes per turn boundary not per event.
3. **Third bottleneck: Core MCP tool latency spike.** Mitigation: per-tool timeout (3000 ms REQ-DIR-05); circuit-breaker per MCP server; fallback-apology response.

---

## Anti-Patterns

### Anti-Pattern 1: Proxying RTP audio through Lenovo1

**What people do:** "Let's terminate the SIP/RTP on Lenovo1 so Director Bridge can see the audio for debug/transcript correctness." Shows up as early design idea: Hetzner FreeSWITCH → WG → Lenovo1 sip-to-ai → WebSocket to OpenAI.
**Why it's wrong:**
- Doubles codec hops: transcoding on Lenovo1 adds 20-60ms/frame jitter.
- Makes WG a hot-path dependency: 5s WG drop = call drop (REQ-INFRA-11 impossible to satisfy).
- Pipes audio through a box we control = §201 StGB exposure (audio could be captured).
- Was explicitly considered and rejected in `decisions/2026-04-13-voice-v6-findings-director-pattern.md` Option a/b.
**Do this instead:** FreeSWITCH bridges directly to `sip.api.openai.com`. Lenovo1 sees events and transcripts via sideband WS, never raw audio.

### Anti-Pattern 2: Updating tools mid-call

**What people do:** "Oh, this call turned out to be more complex than expected, let me add a tool via `session.update`."
**Why it's wrong:** Reproduces the Sideband-WS Spike T5 bug — 0 audio-delta events for the rest of the call. AC-04 hard constraint.
**Do this instead:** Accept with a case-type-specific superset of likely-needed tools (max 15 per AC-006). If a call truly needs something else, BYE and place a new outbound (rare; Case 1 Phase B multi-call architecture).

### Anti-Pattern 3: Putting business logic in FreeSWITCH dialplan

**What people do:** Use FreeSWITCH Lua/XML dialplan to decide case type, look up whitelist, format greetings. "It's easy and FreeSWITCH is already there."
**Why it's wrong:** Violates REQ-INFRA-12 (no business logic in voice stack). Dialplan code on Hetzner runs under `voice_bot`, outside `carsten_bot` audit; changes require SSH+redeploy instead of git-push. Mixing trust zones.
**Do this instead:** FreeSWITCH dialplan ONLY routes (condition: from-domain=sipgate → bridge to openai; from anywhere else → reject). All case-type decisions happen in Director Bridge after webhook.

### Anti-Pattern 4: Synchronous Claude call from hot-path

**What people do:** "For this specific decision we really need Claude's reasoning; let's await Claude before emitting response." Usually introduced as "temporary" for a difficult case.
**Why it's wrong:** AC-02. Spike B/C measured P50 1.5–3.9 s. User perceives dead air; Bot-thematisation rate explodes.
**Do this instead:** Slow-Brain is strictly async queue-driven. If an architectural decision really needs Claude mid-turn, the bot says filler ("einen Moment...") and Slow-Brain pushes a follow-up instruction via session.update.

### Anti-Pattern 5: Deriving call state from transcript

**What people do:** Parse the transcript to decide "was confirmation given?" or "was a commitment made?"
**Why it's wrong:** Transcripts have STT errors; German confirmation words ("ja"/"nee"/"klar"/"mhm") vary; misinterpretation = MOE-6 violation.
**Do this instead:** Explicit confirm-action tool (REQ-C6-03). Bot must call `confirm_action(action_id)` before a booking/commitment; the tool returns success only if the structured arguments exactly match the earlier proposal.

### Anti-Pattern 6: Single webhook URL for multiple call_ids with no demux

**What people do:** Treat each `realtime.call.incoming` as independent; no per-call state in webhook handler.
**Why it's wrong:** Forwarder on Hetzner **must be stateless** (it's just a relay), but Director Bridge must demux on `call_id`. A naive implementation that overwrites a global "current call" fails Case 1 multi-hotel-parallel.
**Do this instead:** CallSession keyed by `call_id` from the first webhook event; all subsequent events (sideband) route by `call_id`.

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| **Sipgate** | SIP REGISTER from FreeSWITCH; inbound INVITEs arrive; outbound INVITEs via ESL-triggered dialplan | AGB-bound (private use); credentials in `vars-override.xml` rendered from template; never log passwords |
| **OpenAI Realtime SIP** | (a) FreeSWITCH bridges to `sip:proj_<id>@sip.api.openai.com;transport=tls` — no API key in SIP leg (project ID authenticates). (b) Webhook HTTPS POST to public URL. (c) POST `/v1/realtime/calls/{id}/accept` with Bearer API key. (d) Sideband WSS with Bearer API key. | API key via OneCLI (MASTER.md + nanoclaw CLAUDE.md). ZDR mode must be enabled at project level for AC-08/§201. |
| **OpenAI Claude API (Anthropic)** | Async Slow-Brain only; POST /v1/messages streaming | Separate API key; cost accounted separately but counts toward €25/mo cap |
| **Sipgate webhooks (optional)** | Not in scope v1 — call-events arrive via SIP signalling | — |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| **Sipgate ↔ FreeSWITCH** | SIP over TLS, RTP over UDP (not SRTP Sipgate-side) | G.711 PCMU only (REQ-SIP-04) |
| **FreeSWITCH ↔ OpenAI SIP** | SIP over TLS (transport=tls), SRTP | No WG involvement; public internet routing |
| **Webhook forwarder ↔ Director Bridge** | HTTP over WG; 10.0.0.1 → 10.0.0.2:4401 | Signature already verified upstream; Director Bridge treats body as trusted |
| **Director Bridge ↔ OpenAI REST** | HTTPS public internet from Lenovo1 | WG not involved (OpenAI isn't on it) |
| **Director Bridge ↔ OpenAI sideband WS** | WSS public internet from Lenovo1 | Outbound from Lenovo1 through Hetzner NAT / whatever outbound Lenovo1 has |
| **Director Bridge ↔ Core MCP servers** | MCP stdio (same user, same host) or HTTP-MCP on localhost | No WG — both on Lenovo1. Tool timeout 3000ms (REQ-DIR-05) |
| **Director Bridge ↔ Slow-Brain worker** | `asyncio.Queue` in-process | Non-blocking write; bounded queue drops oldest on overflow (hot-path protection) |
| **Director Bridge ↔ FreeSWITCH ESL (outbound)** | TCP over WG; 10.0.0.2 → 10.0.0.1:8021 | For `originate` commands to trigger outbound calls. Auth via ESL password from env. |
| **Director Bridge ↔ state.db** | SQLite WAL, same process | Single writer |
| **Chat-Claude ↔ Director Bridge** | HTTP POST to /invoke (MCP-over-HTTP) | AC-07 debug path; same tool registry; no special auth (on Lenovo1 local only, behind OneCLI gateway) |

---

## Special Topics

### Case 4 Takeover Hotword → SIP REFER

Question from milestone: *which component initiates the REFER?*

**Recommendation: Director Bridge detects the hotword via transcript event, calls a `transfer_call(target_e164)` tool, which in turn sends ESL message to FreeSWITCH instructing a SIP REFER to the target (Carsten's mobile).** FreeSWITCH handles the REFER protocol details. Carsten's phone rings, he picks up, FreeSWITCH re-INVITEs the counterpart to the new leg, then BYE's the bot leg.

Why not OpenAI's side: OpenAI Realtime SIP today does not expose a REFER-out primitive. Transfer must be initiated by the originating SIP party (FreeSWITCH, our side).

Why not FreeSWITCH DTMF-hook: Carsten would need to press a key, not say a hotword. Voice-triggered hotword requires transcript observation, which lives in Director Bridge.

### ZDR Mode Verification

Question from milestone: *session-level flag or project-level? Who verifies?*

**Evidence from OpenAI docs (verified 2026-04-16): Zero Data Retention is set at the project/org level, not per-session.** Director Bridge cannot toggle per-call. The constraint on our side is:
1. Operational setup task (Phase 0): Carsten activates ZDR in OpenAI dashboard for project `proj_4tEBz3XjO4gwM5hyrvsxLM8E`.
2. Verification in Director Bridge `/health`: on startup, query project settings via OpenAI management API (if exposed) and assert ZDR=on; fail to start if not.
3. Runtime check: no "storage" field references in session config; no `conversation.item.retrieve` calls expected.
4. Monthly audit (REQ-QUAL-04): filesystem scan + assertion ZDR still on at project level.

If OpenAI has no management API to verify project-level ZDR programmatically, escalate as OpenQuestion to Carsten — manual monthly verification required.

### Observability Surface

Per-call JSONL at `~/nanoclaw/voice-container/runs/turns-{call_id}.jsonl` (REQ-INFRA-05):
```jsonl
{"call_id":"rtc_…","turn":1,"t0_vad_end":1712345.123,"t2_first_token":1712345.456,"t4_first_audio":1712345.789,"tool_call":null,"cost_cents":0.3}
{"call_id":"rtc_…","turn":2,"t0_vad_end":…,"t2_first_token":…,"t4_first_audio":…,"tool_call":{"name":"check_calendar","latency_ms":820},"cost_cents":0.5}
```

Aggregated `~/nanoclaw/voice-container/runs/calls.sqlite` (joined with state.db costs table) feeds monthly reports. `GET /metrics` on Director Bridge exports Prometheus format (optional in v1).

Cost accumulator placement: **Director Bridge in-process** during call (immediate 80%/100% decisions); flushed to state.db at turn boundaries; reconciled against OpenAI usage API nightly.

---

## Confidence Assessment per Claim

| Claim | Confidence | Evidence |
|-------|-----------|----------|
| OpenAI webhook flow (realtime.call.incoming → /accept → WS) | HIGH | OpenAI official docs verified 2026-04-16 + Sideband-WS spike events observed 2026-04-15 |
| Tools-only-at-accept constraint | HIGH | Sideband-WS spike T5 reproduced audio break; captured as AC-04 |
| Instructions-via-sideband works | HIGH | Spike T3 measured 183ms round-trip; AC-05 |
| Media stays Hetzner↔OpenAI (doesn't need Lenovo1) | HIGH | REQ-SIP-03 explicit; ARCHITECTURE-DECISION Option c chosen |
| WG failure survivability | HIGH | Follows directly from media not traversing WG |
| Single-process coroutine shape | MEDIUM | Standard Python asyncio pattern; scale <3 concurrent calls makes process-per-call overkill |
| Webhook forwarder on Hetzner not Lenovo1 | HIGH | Required by MASTER.md §0/§5 (Lenovo1 is internal); verified trust-zone rule |
| ESL as outbound trigger mechanism | MEDIUM | Standard FreeSWITCH pattern; not spike-verified in this project yet |
| Case 6 as MVP ordering | HIGH | Follows from component coverage analysis; ConOps §4a.3 Stufe 2 agrees |
| Claude never in hot-path | HIGH | AC-02 from ARCHITECTURE-DECISION; Spike B/C evidence |
| ZDR is project-level | MEDIUM | OpenAI docs; management-API verification path untested |

---

## Sources

- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/ARCHITECTURE-DECISION.md` — Spike E winner, AC-001..009
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/REQUIREMENTS.md` — REQ-SIP, REQ-VOICE, REQ-DIR, REQ-TOOLS, REQ-INFRA, REQ-DISC, REQ-QUAL
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/CONOPS.md` §4a, §5 Scenes 1/2/3/4/6, §11.3 Fahrplan
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/PRD.md` §7a Architecture Constraints AC-01..AC-08
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/spike/sideband-ws/results-1776282583.json` — Sideband-WS spike measurements
- `/home/carsten_bot/nanoclaw-state/decisions/2026-04-13-voice-v6-findings-director-pattern.md` — Director-Pattern Option a/b/c rationale
- `/opt/server-docs/MASTER.md` §0/§1/§2/§5 — server identification, user scopes, Hetzner/Lenovo1 roles
- OpenAI Realtime SIP docs (verified 2026-04-16): https://platform.openai.com/docs/guides/realtime-sip
- OpenAI Realtime Calls API reference: https://platform.openai.com/docs/api-reference/realtime-calls
- OpenAI Webhooks reference: https://platform.openai.com/docs/api-reference/webhook-events
- OpenAI Server-side controls guide: https://platform.openai.com/docs/guides/realtime-server-controls

---
*Architecture research for: NanoClaw Voice split-stack architecture (milestone: implement topology decided in E1-1a)*
*Researched: 2026-04-16*
