# NanoClaw Voice

## What This Is

NanoClaw Voice is a personal AI phone agent that handles telephone tasks on behalf of its sole user, Carsten Freek. It answers and places calls using Carsten's German phone number via Sipgate, conducts natural German-language conversations with counterparts, and integrates outcomes — calendar entries, Discord summaries, structured documents — directly into Carsten's existing NanoClaw assistant. It is a thin voice channel adapter on top of the NanoClaw Core; all reasoning, memory, and business logic remain in the Core. Private use only.

## Core Value

**Carsten can delegate telephone tasks without being present for the call, with zero unauthorized commitments.** If only one thing works, it must be the safety and autonomy of Case 6 (Carsten ↔ NanoClaw hands-free voice) and the Director Bridge that cleanly routes everything through the Core without leaking business logic into the voice stack.

## Requirements

### Validated

<!-- Carried over from E1-1a spike evidence. -->

- ✓ Native speech-to-speech Hot-Path reaches P50 635ms (Spike E, 2026-04-15)
- ✓ Sideband WebSocket per call_id is bidirectional (Sideband-WS-Spike PASS, 2026-04-15 20:00)
- ✓ Function-call-output injection works without hallucination when prompt is directive (Sideband-WS Runde 2)
- ✓ FreeSWITCH ↔ Sipgate REGISTER path stable (V8 Etappe A/C PASS)
- ✓ ZDR mode available on OpenAI Realtime for §201 compliance
- ✓ **LEGAL-01..04 — Pre-Production Legal Gate** (Phase 0 closed pre-existing 2026-04-16; ZDR active, lawyer stance clarified, audit + persona invariants in place)

### Active

<!-- v1 Must-haves from PRD §4 — Case 6 first, Director Bridge is architectural spine. -->

- [ ] SIP inbound/outbound via Sipgate + FreeSWITCH (REQ-SIP-01..09)
- [ ] Real-time voice conversation with P50 ≤900ms (REQ-VOICE-01..09)
- [ ] Case 6 — Carsten ↔ NanoClaw voice channel (REQ-C6-01..05)
- [ ] Director Bridge — sideband-WS service on Lenovo1, tool routing to Core (REQ-DIR-01..09)
- [ ] Calendar integration — check availability, create entries with travel buffers (REQ-TOOLS-01..02)
- [ ] No-audio-persistence + legal compliance (REQ-INFRA-10, REQ-DISC-01..04)
- [ ] Directional persona prompt — prohibits memory-based domain answers (REQ-DIR-09)
- [ ] Unauthorized-commitment prevention (REQ-C4-07, REQ-C1-08/09, REQ-C6-03)
- [ ] Operational cost caps + monitoring (REQ-INFRA-05..09, REQ-QUAL-03..04)
- [ ] Case 2 — Restaurant reservation outbound (REQ-C2-01..06)
- [ ] Case 3 — Medical/hair appointment outbound (REQ-C3-01..07)
- [ ] Case 4 — Inbound negotiation (REQ-C4-01..11)

### Out of Scope

- **Case 5 Smart Voicemail** — deferred until after Cases 2/3/4/6 stable in production
- **Unconditional inbound forwarding (Variante 4-B)** — only whitelisted inbound accepted (Variante 4-C); everything else → Sipgate voicemail
- **Credit card data via voice** — hard constraint (MOE-6); all card handling stays in online booking
- **Audio recording/persistence** — §201 StGB mitigation; RAM-only processing, released within 5s of session end
- **Commercial use or calls on behalf of third parties** — DSGVO Haushaltsausnahme boundary
- **Multi-user access** — single user by design
- **Outbound calls without Carsten trigger** — every outbound has explicit authorization per call
- **Case 1 Hotel booking v1** — multi-phase campaign deferred to Could (v2+)
- **Pipecat or similar orchestration frameworks** — Spike F measured ~5455ms median (8.6× slower than native S2S); hard architectural exclusion (AC-03)
- **STT+LLM+TTS serial pipeline** — Spike B measured 1533ms P50; architecturally excluded (AC-01)

## Context

**Product context:**
- Successor to the sip-to-ai / voice-container V10 gate work (Apr 2026)
- E0 ConOps and E1 Requirements already signed off by Carsten Freek (2026-04-14 / 2026-04-15)
- E1-1a spike matrix (candidates B/C/E/F) ran 2026-04-15; gpt-realtime-mini won
- Sideband-WS spike (OQ-01) resolved 2026-04-15 20:00: bidirectional control channel works, but mid-call tool updates break audio — hard constraint captured in AC-04
- PRD §7a defines 8 binding Architecture Constraints (AC-01..AC-08)

**Technical environment:**
- Hetzner Python1 (128.140.104.236) runs FreeSWITCH + sip-to-ai in Docker (`vs-freeswitch`, `vs-sip-to-ai`)
- Lenovo1 (WireGuard 10.0.0.2) runs NanoClaw Core under `carsten_bot`; Director Bridge deploys here as new service
- All Hetzner↔Lenovo1 traffic traverses WireGuard tunnel only
- Sipgate account `8702234e5@sipgate.de`, CLI `+49 30 8687022345`
- OpenAI project `proj_4tEBz3XjO4gwM5hyrvsxLM8E` with SIP key in `~/nanoclaw/.env` as `OPENAI_SIP_API_KEY`
- Existing NanoClaw Core exposes Gmail, Discord, Google Calendar via MCP tools already

**Operator trio:**
- Carsten (Chat) — decisions, briefings
- `carsten_bot` (Claude Code on Lenovo1) — NanoClaw build and voice ops
- `carsten` (Claude Code, server-admin) — OS/infra layer on Hetzner

**State-repo contract:**
- All briefings, decisions, open points live in `~/nanoclaw-state/` (separate from code repo)
- GSD `.planning/` lives in `~/nanoclaw-state/` root, committed via `sg claudestate`

## Constraints

- **Legal — §201 StGB:** No persistent audio anywhere. RAM-only; released within 5s of session end. Monthly filesystem audit. Non-negotiable.
- **Legal — DSGVO Haushaltsausnahme:** Private personal use only; any expansion to commercial scope triggers re-spec.
- **Legal — Passive Disclosure:** System does not volunteer AI status but answers truthfully on direct "bot?" question. Must never impersonate a named human.
- **Safety — MOE-6 Zero Tolerance:** Zero unauthorized commitments since go-live. One violation = critical incident.
- **Performance — Hot-Path Latency:** P50 ≤900ms, P95 ≤1500ms (VAD-end → TTS-first-byte, rolling 30-day). Evidence: Spike E 635ms P50.
- **Performance — Barge-in:** Current TTS cancelled within 200ms of counterpart VAD.
- **Architecture — Native S2S only:** No STT+LLM+TTS serial pipeline. No Pipecat. Hot-Path uses gpt-realtime-mini. (AC-01, AC-02, AC-03)
- **Architecture — Tool definitions immutable mid-call:** Set at `realtime.calls.accept()`; never updated via `session.update` (Sideband-WS bug, AC-04). Only `instructions` may be updated mid-call (AC-05).
- **Architecture — Claude never in hot-path:** Claude Sonnet runs only as async background director (AC-02 from ARCHITECTURE-DECISION).
- **Architecture — Directional persona prompt required:** Prompt must prohibit the bot from providing domain data (slots, contract terms) from memory and mandate tool invocation (AC-06).
- **Architecture — Director Bridge as dedicated service:** MCP-tool-server pattern on Lenovo1; spec-compliant StreamableHTTP on port 3201 is the production Bridge↔Core channel. Chat-Claude and iOS Claude consume the same canonical endpoint via Caddy+OAuth (AC-07). Phase 4.5 consolidated the earlier REST facade on port 3200 into deprecation.
- **Infra — WireGuard only:** All Hetzner↔Lenovo1 traffic via tunnel; no cleartext on public IPs (AC-08).
- **Cost — Hard caps:** €1/call, €3/day, €25/month. Soft-warning at 80%. Monthly cap suspends channel until manual reset.
- **Operational — Isolation:** Voice stack contains no business logic. All Core access via Director Bridge only. `inbound` and `outbound` paths never edited together (Carsten feedback rule).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| `gpt-realtime-mini` as Hot-Path model | Only Spike E candidate to pass MOS-1 and MOS-2 simultaneously (635ms P50, ~3€/mo) | ✓ Validated — ARCHITECTURE-DECISION.md 2026-04-15 |
| Claude Sonnet as async background director (never hot-path) | Spike B/C: any synchronous Claude = P50 >1500ms | ✓ Validated — Spike B/C FAIL evidence |
| Tools set once at call-accept; never mid-call | Sideband-WS T5 reproduced 0-audio-delta bug when tools changed mid-call | ✓ Validated — Sideband-WS Spike 2026-04-15 20:00 |
| Directional persona prompt required | Runde 1 (weak prompt) hallucinated; Runde 2 (directive) tool-called reliably | ✓ Validated — Sideband-WS Runde 1 vs 2 |
| FreeSWITCH on Hetzner (stay), Director Bridge on Lenovo1 (new) | LiveKit/Pipecat Sipgate-inkompatibel; bestehender Stack funktioniert | ✓ Validated — 2026-04-12 LiveKit FAIL + 2026-04-15 Assessment |
| OpenAI ZDR mode activated | §201 StGB no-audio-persistence requirement | — Pending activation |
| Case 6 first, Cases 2/3 next, Case 4 before Case 1 | Case 6 = simplest architecturally (MVP); Case 1 = most complex (multi-phase campaign, credit-card constraint) | — Pending execution |
| GSD .planning/ lives in state-repo root | Separates planning from code repo; fits existing `sg claudestate` workflow | ✓ Decided 2026-04-16 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-16 after initialization from voice-channel-spec/PRD.md v1.0*
