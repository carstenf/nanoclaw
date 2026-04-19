# Project Research Summary

**Project:** NanoClaw Voice — Personal AI phone agent (DE, private use)
**Domain:** Real-time German-language voice agent, native S2S Hot-Path + async Slow-Brain director, split-stack SIP (Hetzner) + business logic (Lenovo1), strict §201 StGB / MOE-6 zero-tolerance regime
**Researched:** 2026-04-16
**Confidence:** HIGH for stack/architecture/pitfalls; MEDIUM-HIGH for features; MEDIUM for legal framing (lawyer opinion pending)

---

## Executive Summary

NanoClaw Voice is a **single-user personal phone agent** built on a **native speech-to-speech Hot-Path** (OpenAI `gpt-realtime-mini`) with an **asynchronous Slow-Brain director** (Claude) running strictly out-of-band. The architecture is a split-stack: Sipgate ↔ FreeSWITCH on Hetzner bridges directly to OpenAI's SIP endpoint (audio never touches Lenovo1 or the WireGuard tunnel), while the Director Bridge on Lenovo1 accepts the call via webhook and drives the session through a sideband WebSocket — tool routing, persona/instructions updates, cost accounting, transcript observation. The E1-1a spike matrix already validated the hot-path (P50 635ms, well inside the ≤900ms budget) and the sideband control channel; what remains is to industrialise the Director Bridge and layer cases on top in dependency order.

The **recommended implementation language for the Director Bridge is Node.js/TypeScript** (see conflict resolution below). Stack: Fastify 5 for the webhook, raw `ws` + `@openai/agents` types for the sideband hot path, `@modelcontextprotocol/sdk` in dual-transport (stdio for Core + Streamable HTTP for Chat-Claude debugging per AC-07), `pino` JSONL for turn-timing, `better-sqlite3` for the cost ledger and call metadata, systemd user service under `carsten_bot`. **Python stays only where it already lives** — the existing `voice-sip-to-ai` container on Hetzner — plus a tiny (<100 LOC) Python+FastAPI webhook forwarder on Hetzner that relays the OpenAI webhook from the public Caddy endpoint over WireGuard into the Bridge.

The **key risks are legal, not technical**: §201 StGB exposure when counterparts use speakerphone, and unverified OpenAI ZDR enrollment (ZDR is not self-service; it requires an account-level negotiation and has no programmatic verification endpoint). Both are hard gates that block the first real outbound call. On the engineering side, the load-bearing decisions that must ship with v0 are **idempotency keys on every mutating tool** (MOE-6 catastrophic if missed — duplicate bookings from model retries) and **two-form readback of all number/time values** on verbindliche Aktionen (German numeral confusion "siebzehn" vs "siebzig" on PCMU narrowband silently creates wrong appointments). Building Case 6 first — Carsten↔NanoClaw, no counterpart — exercises the full architecture without the legal and counterpart-credibility surfaces, and is the cleanest MVP gate.

---

## Conflict Resolution — Director Bridge Implementation Language

STACK.md and ARCHITECTURE.md disagreed on the Director Bridge language. STACK.md prescribed **Node.js/TypeScript** with high-confidence evidence: verified current package versions (`@openai/agents@^0.8.3`, `@modelcontextprotocol/sdk@^1.29`, `fastify@^5.8`), deliberate rationale citing NanoClaw Core's TS/Node ecosystem alignment (Core is TS, MCPs are TS, `onecli` is TS, channel skills are TS), and explicit rejection of Python with arguments-evaluated reasoning. ARCHITECTURE.md used Python/asyncio pseudocode throughout but **gave no justification for the language choice** — the architecture document's focus was topology, not runtime selection.

**Resolution: Node.js/TypeScript is the chosen Director Bridge language.** The architecture research's component boundaries, data flows, fault-isolation model, and control patterns (tools-at-accept + instructions-mid-call, webhook-relay-not-handle, single-source tool registry, hot-path bypass bus for Slow-Brain, cost-cap as pre-call gate) are language-agnostic and translate 1:1 from the architecture's Python examples to TypeScript. Python's only foothold stays the existing `voice-sip-to-ai` container on Hetzner (unchanged) plus a <100-LOC FastAPI webhook-forwarder sidecar on Hetzner that never touches business logic.

---

## Key Findings

### Recommended Stack

Full detail in `.planning/research/STACK.md`. Node.js ≥22 LTS + TypeScript 5.7. Fastify 5 webhook (first-class raw-body for HMAC verify). Raw `ws` + `@openai/agents` types for the sideband channel (SDK types for correctness, raw transport for sub-3s tool-cycle budget). MCP SDK 1.29 in dual-transport — stdio to Core, Streamable HTTP for Chat-Claude debugging, same tool handlers behind both (AC-07 by construction). `pino` 10 for JSONL turn logs, custom cost module (no lib covers Realtime pricing correctly as of 2026-04 — compute from `response.done.usage`), `better-sqlite3` 12 for call metadata + cost ledger, systemd user unit under `carsten_bot`. No Docker on Lenovo1; Docker stays on Hetzner for FreeSWITCH + sip-to-ai.

**Core technologies:**
- **Node.js 22 LTS + TypeScript 5.7** — matches NanoClaw Core, single runtime across the stack
- **Fastify 5 + `openai.webhooks.unwrap`** — raw-body HMAC verification without Express-raw-body friction
- **`@openai/agents@^0.8.3` types + raw `ws@^8.20`** — session config via `buildInitialConfig()`, raw transport for sideband hot path
- **`@modelcontextprotocol/sdk@^1.29` (stdio + Streamable HTTP)** — one tool implementation, two transports (Core + Chat-Claude)
- **`@anthropic-ai/claude-agent-sdk` async** — Slow-Brain director strictly out-of-band (AC-02)
- **`pino` + `pino-roll` + `better-sqlite3`** — JSONL turn logs, cost ledger, audit markers
- **systemd user service + Caddy reverse-proxy** — bare-metal on Lenovo1; public webhook terminates at Caddy on Hetzner, proxies over WG to Bridge

### Expected Features

Full detail in `.planning/research/FEATURES.md`. Feature calculus framed for personal-assistant context (counterpart-credibility MOE-2 ≤15% bot-thematization + autonomy MOE-6 zero unauthorized commitments), not commercial contact-center.

**Must have (table stakes — without these the cases fail):**
- Sub-1s turn latency (validated 635ms P50), barge-in <200ms, filler phrases on tool-call >500ms
- Voicemail/AMD detection with **silent hang-up** (not message-leaving — commercial anti-feature for private use)
- IVR DTMF support + IVR hold-music passive listening (critical for Case 3 cost control)
- Silence timeout with prompt + polite German farewell on every termination path
- CLI-based inbound routing (Carsten → C6, whitelist → C4, else → Sipgate voicemail)
- Calendar read+write with travel-time buffer, Discord push for summaries, post-call structured summary to Core within 60s
- ZDR mode + RAM-only audio + monthly filesystem audit (§201 enforcement by architecture)
- Truthful "bin Bot" on direct ask, generic AI voice (no cloning), no real-person impersonation
- Per-call/day/month cost cap with hard-kill termination
- Directional persona prompt (prohibits memory-based domain answers, AC-06)

**Should have (differentiators that exploit personal-assistant context):**
- Pre-loaded per-call context (calendar, contracts, profiles) injected at call accept
- Two-brain Hot+Slow architecture (sub-1s hot path while Claude reasons async)
- Live competitor research mid-call for Case 4 negotiation defense
- Carsten-takeover hotword → SIP REFER for Case 4 (no commercial product offers this)
- Proactive callback pattern (Case 6b — bot calls Carsten when decision needed)
- Tolerance-window autonomous decisions (Case 2: "Freitag 20 Uhr ±60 min, Tisch egal")
- Travel-time-aware slot selection with multi-origin (Case 3)
- Authorized-disclosure schema per counterpart (privacy-by-design)
- Phishing/identity-mismatch detection against Core contract repo (Case 4)

**Defer (v2+):**
- Case 1 Hotel booking (multi-call campaign orchestrator, credit-card-via-voice prohibition)
- Case 5 Smart voicemail (persona-conflict with C4, requires re-spec)
- Eager EOT detection (Deepgram Flux pattern) — latency optimisation, non-critical
- Parallel multi-call campaigns (Sipgate AGB + reputation risk)

### Architecture Approach

Full detail in `.planning/research/ARCHITECTURE.md`. Two hosts, one WireGuard tunnel, three trust zones. **Critical property: RTP media never traverses WireGuard** — Sipgate ↔ FreeSWITCH ↔ OpenAI SIP is direct on public internet, meaning a WireGuard drop degrades tool-calls but does not break audio. Single long-running Director Bridge process with per-call worker tasks (single-user, concurrent-call ceiling effectively 1). Authoritative state lives in SQLite on Lenovo1.

**Major components:**
1. **FreeSWITCH (Hetzner)** — SIP signalling, REGISTER→Sipgate, G.711 PCMU negotiation, dialplan bridging to `sip.api.openai.com`. No business logic.
2. **Webhook forwarder (Hetzner, <100 LOC Python+FastAPI)** — receives OpenAI `realtime.call.incoming` at Caddy public endpoint, verifies signature, relays JSON over WG to Director Bridge. Stateless relay, never accepts the call itself.
3. **Director Bridge (Lenovo1, NEW — primary deliverable, TypeScript)** — consumes forwarded webhook, POSTs `/accept` with full session config including tools list (AC-04 tools-at-accept-only), opens sideband WS, routes function-calls to Core MCP tools, pushes `instructions`-only `session.update` mid-call (AC-05), streams transcripts to Slow-Brain queue, accumulates cost, writes turn-timing JSONL + session summary.
4. **Core MCP tool servers (Lenovo1)** — existing Core exposes calendar, Discord, contracts, etc. Director Bridge calls these over MCP stdio.
5. **Slow-Brain worker (Lenovo1, async)** — Claude Sonnet background process drains transcript queue, decides on `instructions` updates, produces post-call summaries. **Never in hot-path** (AC-02).
6. **state.db (SQLite on Lenovo1)** — calls, turns, tool_calls, costs, transcripts (text only, never audio).

Key load-bearing architectural patterns: **Tools-at-accept + instructions-mid-call** (mid-call tool updates break audio for 15s — reproduced bug, AC-04 hard); **single-source tool registry** (same handler serves both realtime function-calls and Chat-Claude debug invokes, AC-07 by construction); **hot-path bypass queue for Slow-Brain** (AC-02 by construction — hot-path never awaits Claude); **cost-cap as pre-call gate + real-time session-level accumulator**.

### Critical Pitfalls

Full detail in `.planning/research/PITFALLS.md`. All six critical pitfalls are new ground beyond what the spikes already mitigated.

1. **Speculative / duplicate mutating tool calls** — Realtime protocol is not idempotent; model can re-emit `create_calendar_entry` after barge-in/filler/cancel. Prevention: **idempotency_key on every mutating tool** generated at Director as `(call_id, turn_id, tool_name, argument_hash)`, enforced in Core wrapper, never in voice code. Mark mutating tools `idempotent=false` and ban from speculative pre-fetch. **MUST ship with v0.**
2. **Function-call hallucination** — model emits non-existent tool names, malformed arguments, or narrates tool internals ("status=ok"). Prevention: Director validates every call against schema + allowlist, rejects unknown names with synthetic `tool_error` + recovery guidance, persona ban on verbalizing tool names/IDs, spoken-confirmation vs tool-args diff check before commit.
3. **German numeral/time misrecognition on PCMU narrowband** — "siebzehn"/"siebzig", "siebten"/"siebzehnten" confusion; bot confidently repeats the wrong value and creates the wrong appointment. Prevention: **two-form readback on every verbindliche Aktion** ("Am Dienstag, dem siebzehnten Mai — das ist der 17.5. — um 17 Uhr, also fünf Uhr nachmittags. Korrekt?"). Digit-by-digit for phone numbers. Post-call transcript↔tool-args diff. **MUST ship with v0.**
4. **OpenAI ZDR audit gap** — ZDR is not self-service, not programmatically verifiable, and silently resets on project changes. No runtime signal that retention is actually off. Prevention: archived confirmation email + pinned dashboard screenshot under `legal-evidence/openai-zdr/`, monthly cron with hash compare, fail CI if unverified >30 days. Make ZDR status a gate in the monthly filesystem audit.
5. **Speakerphone / third-party §201 StGB extension** — counterpart puts call on speakerphone, bystander is captured. German case law treats unnoticed speakerphone capture as §201 violation even for RAM-only processing. Prevention: **written legal opinion** from German telecoms lawyer (HÄRTING / LUTZ|ABEL) before first real outbound, persona-level reactive disconnect on speakerphone cue phrases ("stell mal auf Lauthörer", "ist jemand mit?"), post-call voice-clustering redaction.
6. **Warm-keepalive + IVR hold + voicemail = silent cost runaway** — voicemail loops, hold-music triggering inference every 5-15s, forgotten WebSocket sessions. Prevention: first-turn voicemail-phrase gate with silent hang-up, hold-music auto-mute (response-unaware chatter detector), hard session-teardown assertion (`session.closed` within 2s of BYE or force-close at 5s), session-level cost cap not just call-level.

Severe pitfalls also flagged: FreeSWITCH↔OpenAI SIP reINVITE edge cases, WireGuard MTU/flap one-way audio (set MTU=1380 both ends, add heartbeat), DTMF has no native Realtime support (defer Case 3 IVR DTMF to v2 unless blocking), barge-in false positives on cough/mhm (raise VAD threshold to 0.55-0.60 + 700ms silence_duration + 250ms min-utterance gate), cross-channel consistency drift (two-phase commit pattern), language drift mid-call (persona pin + translate-at-Director for tool results).

---

## Implications for Roadmap

Build order is **case-ordered per ConOps §4a.3 with Case 6 first** (architecturally simplest, exercises full stack, no counterpart → no §201/MOE-2 risk), then Cases 2, 3, 4. **Case 1 (Hotel) stays deferred to v2+.** Before any case ships, two non-negotiable gates precede: a **pre-production legal gate** (ZDR confirmation + lawyer opinion on speakerphone §201) and a **Director Bridge v0** that ships the two load-bearing safety decisions (idempotency keys + two-form readback).

### Phase 0: Pre-Production Legal Gate (HARD PREREQUISITE)

**Rationale:** §201 StGB and ZDR exposure are criminal-liability risks that block the first real counterpart call. These cannot be retrofitted after launch.
**Delivers:**
- Archived OpenAI ZDR confirmation email under `legal-evidence/openai-zdr/` + pinned dashboard screenshot
- Written legal opinion from a German telecoms/AI-voice lawyer (HÄRTING or LUTZ|ABEL) on whether private-use RAM-only AI voice processing is covered by DSGVO Haushaltsausnahme when counterpart has a speakerphone bystander
- Monthly `zdr_verify` cron + filesystem audit tied together
- Art. 50 applicability plausibility check (spec's private-use-exemption interpretation)
**Avoids:** Pitfalls 4 (ZDR audit gap) and 5 (speakerphone §201 extension)
**Research flag:** Minimal — this is ops + legal, not technical research. Legal opinion itself is external.

### Phase 1: Infrastructure + Webhook Path (stub Bridge)

**Rationale:** Prove the full network path end-to-end before any call logic. Decouple infrastructure bring-up (Caddy subdomain, WG peer, systemd service skeleton, OpenAI webhook URL config) from business logic.
**Delivers:**
- Caddy public endpoint on Hetzner, WG reverse-proxy to Lenovo1 :8787
- Webhook forwarder on Hetzner under `voice_bot` (<100 LOC Python+FastAPI)
- Director Bridge skeleton on Lenovo1: Fastify `/hook` endpoint, signature verify via `openai.webhooks.unwrap`, log payload, return 200
- systemd user service under `carsten_bot` with structured logging
- WireGuard MTU pinned to 1380 both ends; heartbeat instrumented
**Verification:** Test call → webhook arrives end-to-end through Caddy→WG→Bridge, signature verifies, payload logged.
**Uses:** Fastify 5, `openai@^6.34`, `pino`, systemd (all from STACK.md)
**Avoids:** Pitfalls 8 (WG MTU/flap) and 13 (webhook duplicate/sig)
**Research flag:** LOW — patterns are well-documented; skip research-phase.

### Phase 2: Director Bridge v0 (safety baseline + Case 6b minimal)

**Rationale:** Ship the two load-bearing safety primitives (idempotency keys on mutating tools, two-form readback on numeric/time values) before any tool that could cause MOE-6 damage. First end-to-end voice turn happens here — the Case 6b MVP gate.
**Delivers:**
- Tool registry (single-source) with `idempotent: bool` flag per tool; Director synthesises idempotency_key as `(call_id, turn_id, tool_name, arg_hash)`
- Schema validator + tool-name allowlist; reject unknown function-calls with synthetic `tool_error`
- Case 6b persona prompt with directional anti-hallucination + two-form readback directive
- `/accept` call with Case 6 persona and `send_discord_message` + `confirm_action` tools (2 of 15 slots)
- Sideband WS client logging all events; `response.done.usage` → cost accumulator
- Turn-timing JSONL written to `~/nanoclaw/voice-container/runs/turns-{call_id}.jsonl`
- Session-teardown assertion (`session.closed` within 2s of BYE; kill-timer at 5s)
- Spoken-confirmation vs tool-args diff check before commit (two-phase commit)
**Verification — Case 6b MVP gate:**
1. Carsten dials his own number. Bot greets "Ja, Carsten?" within 2s.
2. Carsten says "schick mir 'hallo' auf Discord". Bot calls tool, Carsten sees Discord message.
3. Bot confirms; Carsten hangs up. Session summary pushed within 10s.
4. Turn-timing JSONL shows P50 < 900ms.
5. `find ~/nanoclaw ~/.cache /tmp -name "*.wav" -o -name "*.mp3"` returns zero.
6. Duplicate tool-call injection test: Core rejects second with idempotency error.
**Uses:** `@openai/agents` types, raw `ws`, `@modelcontextprotocol/sdk` stdio, `better-sqlite3`, `pino`
**Avoids:** Pitfalls 1, 2, 3, 6 (teardown), 11 (two-phase commit)
**Research flag:** MEDIUM — tool-registry dual-transport pattern (MCP stdio + Streamable HTTP) and idempotency_key propagation into Core wrappers may need brief `/gsd-research-phase`. Schema/allowlist patterns are well-documented.

### Phase 3: Slow-Brain Wiring + Outbound Trigger

**Rationale:** Enable Case 6b proactive pattern (NanoClaw calls Carsten when a Core event fires) and complete the AC-02 async-Claude loop. Outbound via FreeSWITCH ESL over WG.
**Delivers:**
- Slow-Brain worker (separate event-loop tick): transcript queue drain → Claude → `instructions`-only `session.update` back through sideband
- `/outbound` HTTP endpoint on Director Bridge; ESL client to FreeSWITCH
- Case 6b outbound persona + brief identification preamble ("Hi Carsten, kurz wegen …")
- Hot-path bypass queue with bounded size; drop-oldest on overflow
**Verification:** Core event triggers outbound; Carsten's phone rings; bot identifies within 2s (REQ-C6-04); Claude pushes an instructions update mid-call without breaking audio.
**Uses:** `@anthropic-ai/claude-agent-sdk`, FreeSWITCH ESL
**Avoids:** AC-02 violation, Pitfall 14 (graceful 429 handling)
**Research flag:** MEDIUM — ESL outbound-call originate pattern not spike-verified in this project; brief research during planning recommended.

### Phase 4: Core MCP Tool Integration + Observability v0

**Rationale:** Wire the Case 6 full-access tool set (calendar, contracts, memory, hindsight) and ship the observability that makes Case 2-onwards diagnosable.
**Delivers:**
- Calendar tools with travel-buffer logic (REQ-TOOLS-01/02)
- Contract repo + Discord + memory-read/write tools wired over MCP stdio
- Chat-Claude debug path via Streamable HTTP transport on the same tool handlers (AC-07 verification)
- Real-time cost accumulator per session from `response.done.usage`; hard-cap at 80%/100% per REQ-INFRA-06..09
- `/metrics` Prometheus endpoint (prom-client) with latency histograms, cost counters, MOE-6 canary
- Monthly reconciliation job (calendar-entry ↔ transcript ↔ Discord summary) + nightly OpenAI usage reconciliation
- Lingering-session monitor + kill-timer
**Verification:** Case 6 full loop — Carsten dials in, asks for calendar query, confirms booking, bot writes calendar entry with travel buffer + Discord summary; reconciliation job passes 3-way cross-check.
**Uses:** `@modelcontextprotocol/sdk` Streamable HTTP, `prom-client`, `better-sqlite3` reconciliation queries
**Avoids:** Pitfalls 11 (cross-channel drift) and 16 (billing drift)
**Research flag:** LOW — patterns all covered in research. Skip research-phase.

### Phase 5: Case 2 — Restaurant Outbound

**Rationale:** First counterpart-facing case. Case 6 validated the full architecture; Case 2 is the simplest external case and the gate for Cases 3/4.
**Delivers:**
- Restaurant address book + per-case tolerance window config (Carsten pre-configures "Freitag 20 Uhr ±60 min, 2 Personen")
- Case 2 persona ("möchte gern reservieren", friendly customer, name-not-volunteered)
- Retry scheduler with backoff (5/15/45/120 min, max N/day) + per-target-per-day cap
- **First-turn voicemail-phrase gate** with silent hang-up (never leave a message)
- VAD calibration: threshold 0.55-0.60, silence_duration 700ms, min-utterance 250ms gate
- Restaurant-outcome Discord escalation when offer outside tolerance
**Verification:** Real outbound to a restaurant (post-legal-gate). Bot reserves a table within tolerance; Carsten gets Discord summary + calendar entry within 60s. Voicemail test: bot hits voicemail, silent hang-up, no tokens burned.
**Uses:** Retry scheduler from Core; all tool infrastructure already live
**Avoids:** Pitfalls 6 (voicemail loop) and 10 (barge-in storm)
**Research flag:** MEDIUM — German AMD phrase corpus and VAD calibration against live Sipgate calls may warrant `/gsd-research-phase`.

### Phase 6: Case 3 — Medical/Hair Appointment Outbound

**Rationale:** Medical privacy + IVR navigation + multi-origin travel-time — the hardest outbound case. Builds on Case 2 retry/AMD infrastructure.
**Delivers:**
- Practice/salon profile schema + patient data per practice
- Medical disclosure authorization schema (per-appointment scope; "das bespreche ich vor Ort" default)
- Google Maps travel-time tool with multi-origin (home + Audi-Standort)
- Travel-time-aware slot-selection logic in Director
- IVR hold-music passive listening (auto-mute on response-unaware chatter) — first major unknown-unknown
- **Case 3 DTMF decision point:** defer to v2 unless practice-IVR testing shows it's a hard blocker (strong recommendation: defer)
- Extended silence timer (15s Case 3/4, elderly/contemplative counterpart friendly)
**Verification:** Real medical call (post-legal-gate). Bot navigates to MFA (or politely abandons at DTMF IVR with Discord escalation), negotiates slot against calendar+travel-time, two-form readback of date/time, calendar entry created with both travel buffers.
**Uses:** Google Maps API (new integration), IVR detection patterns
**Avoids:** Pitfalls 6 (hold-music cost) and 15 (silence-prompt rude)
**Research flag:** HIGH — IVR hold-music implementation is the most underspecified area in research (LOW-MEDIUM confidence). Dedicated `/gsd-research-phase` recommended. Google Maps multi-origin API quotas also need research.

### Phase 7: Case 4 — Inbound Negotiation

**Rationale:** The only inbound case. Highest-risk persona (phishing surface, verbal-contract exploitation, counterpart probing). Requires whitelist routing, contract repo, and Carsten-takeover hotword.
**Delivers:**
- Whitelist inbound routing in FreeSWITCH dialplan (Telekom, Vodafone, major insurers — list TBD in Q-Sprint)
- Contract repository in Core with current conditions + history
- Live competitor web-search tool (~30s budget within call)
- Phishing/identity-mismatch heuristic (counterpart claim vs contract repo)
- Authorized-disclosure list per counterpart category
- Calm-pressure-response phrase bank ("Wenn das Angebot heute gut ist, ist es morgen auch gut")
- **Carsten takeover hotword** → Director calls `transfer_call(target)` tool → FreeSWITCH SIP REFER to Carsten's mobile
- Structured negotiation-result document writer
- 60-min session-expiry graceful wrap-up (OpenAI hard limit)
**Verification:** Simulated inbound with mock-Telekom script; phishing-mismatch test; hotword takeover round-trip; MOE-6 gate test with explicit probing for unauthorized commitment patterns.
**Uses:** FreeSWITCH SIP REFER, web-search MCP tool, contract-repo schema
**Avoids:** Anti-features around aggressive negotiation; Pitfall 20 (60-min session boundary)
**Research flag:** MEDIUM — SIP REFER target (Carsten's mobile vs dedicated Sipgate extension) needs Q-Sprint decision. Phishing heuristics may benefit from `/gsd-research-phase` on adversarial patterns.

### Deferred: Case 1 — Hotel (v2+)

Multi-phase campaign orchestrator, web research for hotel candidates, comparison-table rendering, sequential-only call enforcement, explicit no-credit-card-via-voice enforcement. **Stays deferred per spec.** Re-evaluate after Cases 2/3/4/6 have 1+ months of production data.

### Phase Ordering Rationale

- **Dependency order is legal → infrastructure → safety primitives → Case 6 (no counterpart) → Case 2 (simplest counterpart) → Case 3 (hardest outbound) → Case 4 (inbound, highest-risk)**. This matches ConOps §4a.3 Stufe 2 onwards but prepends a hard legal gate.
- **Case 6 first** (architecture research's explicit recommendation) — exercises the full split-stack without §201/MOE-2 surface, Carsten is both user and debugger, Core infra X1-X8 adaptations can happen in parallel rather than blocking.
- **Idempotency + two-form readback must ship with Director Bridge v0**, not retrofitted. Retrofitting after Cases 2/3 are live = rewrite.
- **AMD + voicemail gate before Case 2** — without it, retry loops burn cost and reputation.
- **Hold-music passive listening before Case 3** — without it, practice-hold-queue kills the cost cap.
- **Whitelist + contract repo before Case 4** — inbound without whitelist exposes private callers to the negotiation persona.
- **Case 1 stays deferred** — its complexity (multi-call campaign, credit-card constraint, parallel-calls anti-pattern) is orthogonal to the voice architecture question.

### Research Flags

Phases likely needing deeper research during planning (`/gsd-research-phase`):
- **Phase 3 (Slow-Brain + Outbound):** FreeSWITCH ESL originate pattern not spike-verified.
- **Phase 5 (Case 2):** German AMD phrase corpus + VAD calibration against live Sipgate calls.
- **Phase 6 (Case 3):** IVR hold-music detection is the single most-underspecified area. Google Maps multi-origin quotas. DTMF deferral decision needs practice-IVR reconnaissance.
- **Phase 7 (Case 4):** SIP REFER target decision; adversarial-pattern / social-engineering defense research.

Phases with standard patterns (skip `/gsd-research-phase`):
- **Phase 0 (Legal Gate):** External legal opinion, no technical research.
- **Phase 1 (Infra):** Fastify + Caddy + WG + systemd all well-documented.
- **Phase 2 (Director Bridge v0):** Covered comprehensively by STACK.md + ARCHITECTURE.md + PITFALLS.md; minor MCP dual-transport caveat.
- **Phase 4 (MCP + Observability):** All patterns covered in research.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Verified against npm registry, OpenAI docs, OpenAI community measurements, existing NanoClaw Core `package.json`. Language conflict with ARCHITECTURE resolved in favor of TypeScript. |
| Features | MEDIUM-HIGH | Production voice-agent table-stakes patterns well-documented across multiple converging sources. Personal-use differentiators partly extrapolated from Mercedes/Lindy patterns (MEDIUM). Legal framing (§201, Art. 50 private-use exemption) is the spec's interpretation and needs lawyer sign-off. |
| Architecture | HIGH | Topology grounded in E1-1a spike evidence, Sideband-WS Runde 2 measurements, approved PRD §7a AC-01..AC-08, and OpenAI docs verified 2026-04-16. Language-specific examples translate 1:1 between Python and TypeScript. |
| Pitfalls | HIGH | Ten of the sixteen non-minor pitfalls are grounded in OpenAI Developer Community reports, published voice-agent post-mortems, FreeSWITCH GitHub issues, or German case law. Speakerphone §201 extension is the one item where the research is hypothesis + case-law-precedent; the lawyer opinion in Phase 0 resolves it. |

**Overall confidence:** HIGH for the recommended build order and the technical stack; MEDIUM for the two legal gating items until the lawyer opinion lands; LOW only on IVR hold-music implementation detail (flagged for Phase 6 research).

### Gaps to Address

- **Lawyer opinion on speakerphone/third-party §201 (Phase 0):** External; cannot be resolved by research alone.
- **OpenAI ZDR programmatic verification (Phase 0):** May not exist; monthly screenshot + confirmation-email archive is the fallback. Escalate if OpenAI management API does not expose project settings.
- **Hotword choice for Case 4 takeover (Phase 7):** Q-Sprint decision pending.
- **SIP REFER target for Case 4 (Phase 7):** Carsten's mobile vs dedicated Sipgate extension — needs Carsten decision.
- **OpenAI Realtime pricing monthly refresh:** No auto-updater library exists; 30-line monthly cron + Discord alert handles it as ops skill.
- **Spike fixtures for replay harness (Phase 2):** Capture 3-5 representative event sequences during first Lenovo1 smoke test, commit to `spike/fixtures/`.
- **Initial Case 4 inbound whitelist (Phase 7):** Telekom, Vodafone, major insurers list pending Q-Sprint.
- **IVR hold-music detection heuristic (Phase 6):** Research-phase item; no published pattern covers this well.

---

## Sources

See individual research files for full source lists. Aggregate primary sources:

**Primary (HIGH confidence):**
- OpenAI Realtime API with SIP, Server-side Controls, Server/Client Events references (verified 2026-04-16)
- OpenAI Realtime Prompting Guide (language drift patterns)
- `@openai/agents`, `@openai/agents-realtime`, `@modelcontextprotocol/sdk`, `fastify` npm pages (version/date verification)
- NanoClaw Core `package.json` (existing ecosystem alignment)
- `voice-channel-spec/{PRD,REQUIREMENTS,CONOPS,ARCHITECTURE-DECISION}.md` (AC-01..AC-009 load-bearing constraints)
- `voice-channel-spec/spike/sideband-ws/results-*.json` + Spike E/B/C/F measurements

**Secondary (MEDIUM-HIGH confidence):**
- Anthropic Claude Agent SDK GitHub (async patterns)
- OpenAI Developer Community threads on INVITE→webhook delay, Realtime hallucinations, 429s, ZDR
- Twilio / Deepgram / Retell / CallBotics / Hamming AI voice-agent best-practice guides (2025-2026)
- Production-failure post-mortems: Bluejay, Gladia, FutureAGI
- VAD calibration: Notch, Krisp, AssemblyAI, LiveKit, Picovoice, Speechmatics
- SIP/FreeSWITCH: signalwire docs, FreeSWITCH issues #1763 / #1937
- WireGuard VoIP: OpenWrt, Netgate, 3CX forum threads
- German legal: anwalt.org §201 StGB, HÄRTING, LUTZ|ABEL, Cross-Channel-Lawyers, BAG 23.4.2009 - 6 AZR 189/08
- EU AI Act Art. 50 official text + WilmerHale analysis
- llmock / AIMock for Realtime WS mocking

**Tertiary (LOW-MEDIUM, context only):**
- Hono vs Fastify vs Express 2025 architecture guide
- Mercedes "Hey Mercedes" proactive-assistant patterns (IEEE Spectrum)
- arXiv 2503.06416 (AI Negotiation adversarial patterns)

---

*Research completed: 2026-04-16*
*Ready for roadmap: yes*
