# Requirements: NanoClaw Voice

**Defined:** 2026-04-16 (updated 2026-04-17 — Phase 2 REQ semantics synced to voice-channel-spec v1.1)
**Core Value:** Carsten can delegate telephone tasks without being present, with zero unauthorized commitments.
**Source of truth:** `voice-channel-spec/REQUIREMENTS.md` (Chat-authored, EARS format, versioned). THIS file is a roadmap-tracking digest; on any conflict the voice-channel-spec is authoritative.
**Last sync:** 2026-04-17 — VOICE-09..12, DIR-07..13, DISC-04, QUAL-05 re-aligned to v1.1 definitions (previous checkbox text was a stale pre-b914d21 draft and conflicted with v1.1).
**Research:** .planning/research/SUMMARY.md (8-phase roadmap, Case 6 first)

---

## v1 Requirements

Requirements for initial production milestone. Each maps to a roadmap phase.

### LEGAL — Pre-Production Legal Gate

Hard prerequisite. Must PASS before any real PSTN call with non-informed counterpart.

- [x] **LEGAL-01**: OpenAI Realtime ZDR mode verified active at project scope (screenshot + monthly audit) — pre-existing, Phase 0 closed 2026-04-16
- [x] **LEGAL-02**: Written lawyer opinion on file covering §201 StGB (speakerphone/third-party bystander), DSGVO Haushaltsausnahme boundary, passive disclosure stance — pre-existing, Phase 0 closed 2026-04-16
- [x] **LEGAL-03**: Audio-persistence filesystem audit script runs monthly on Hetzner and Lenovo1, alerts on any *.wav/*.mp3/*.opus/*.flac — pre-existing, Phase 0 closed 2026-04-16
- [x] **LEGAL-04**: Persona master-prompt enforces truthful-on-ask disclosure ("Sind Sie ein Bot?" → "Ja, ich bin KI") and never claims named human identity — pre-existing, Phase 0 closed 2026-04-16

### INFRA — Infrastructure & Webhook Path

- [x] **INFRA-01**: FreeSWITCH on Hetzner Python1 registered with Sipgate (REGED ≤30s of boot)
- [x] **INFRA-02**: Caddy on Hetzner terminates TLS for voice-webhook public URL and reverse-proxies to Lenovo1 over WireGuard
- [x] **INFRA-03**: OpenAI webhook URL configured in OpenAI project; signature verification end-to-end green
- [x] **INFRA-04**: WireGuard MTU tuned to 1380; heartbeat monitor in Director Bridge detects tunnel drops ≤2s
- [ ] **INFRA-05**: Per-turn timing logged as structured JSONL (T0 VAD-end, T2 LLM-first-token, T4 TTS-first-byte) to `~/nanoclaw/voice-container/runs/turns-*.jsonl`
- [ ] **INFRA-06**: Cost accumulator sums `response.done.usage` per call; cost stored in `state.db`
- [ ] **INFRA-07**: Daily and monthly pricing-refresh cron fetches OpenAI Realtime price tiers
- [x] **INFRA-08**: Director Bridge systemd unit on Lenovo1 under `carsten_bot` with auto-restart

### SIP — SIP Routing

- [x] **SIP-01**: FreeSWITCH accepts inbound SIP INVITE from Sipgate (+49 30 8687022345) on 5060/UDP
- [x] **SIP-02**: FreeSWITCH initiates outbound calls via Sipgate with Carsten's CLI
- [x] **SIP-03**: On INVITE, system bridges to `sip:<project_id>@sip.api.openai.com;transport=tls` within 500ms
- [x] **SIP-04**: System negotiates PCMU G.711 codec exclusively on Sipgate leg
- [ ] **SIP-05**: RTP media flows on port range 60000–60100/UDP throughout active call
- [x] **SIP-06**: On BYE, both SIP legs terminate and session resources released ≤2000ms
- [x] **SIP-07**: If bridge to OpenAI fails >3000ms, system rejects call with SIP 503 and logs
- [ ] **SIP-08**: Carsten's CLI detected on inbound → Case-6 routing (REQ-C6)
- [ ] **SIP-09**: Whitelisted caller on inbound → Case-4 routing (REQ-C4); all others → voicemail

### VOICE — Hot-Path Real-Time Voice

- [ ] **VOICE-01**: `gpt-realtime-mini` is the hot-path model for all turns
- [ ] **VOICE-02**: P50 turn latency (VAD-end → TTS-first-byte) ≤900ms rolling 30 days
- [ ] **VOICE-03**: P95 turn latency ≤1500ms rolling 30 days
- [ ] **VOICE-04**: `server_vad` with `auto_create_response=true` is the turn-detection configuration
- [ ] **VOICE-05**: Barge-in cancels current TTS within 200ms of counterpart VAD
- [ ] **VOICE-06**: All speech output in German (de-DE); language-drift monitor rejects non-de turns
- [ ] **VOICE-07**: Filler phrase begins ≤1000ms of tool-call start when expected duration >500ms
- [ ] **VOICE-08**: No-speech for 10s → "Sind Sie noch da?"; further 10s silence → terminate
- [ ] **VOICE-09**: If no response is received within 20s after the final silence prompt, the system shall terminate the call with a polite German farewell phrase
- [ ] **VOICE-10**: Per-turn timing (T0 VAD-end, T2 first-LLM-token, T4 first-TTS-audio) written as structured JSONL to `~/nanoclaw/voice-container/runs/turns-{call_id}.jsonl` for every active call
- [ ] **VOICE-11**: When a call ends (BYE or kill-timer fires), the system shall assert `session.closed` from OpenAI within 2000ms; if not received, force-close the sideband WebSocket within 5000ms (**TEARDOWN ASSERTION**)
- [ ] **VOICE-12**: Counterpart audio never written to persistent storage anywhere in the pipeline; processing in RAM only; buffers released within 5s of session end

### DIR — Director Bridge (Slow-Brain)

- [ ] **DIR-01**: Director Bridge (Node.js/TypeScript) holds persistent sideband WebSocket to OpenAI Realtime per active call
- [ ] **DIR-02**: Sideband WS connect completes ≤1500ms after call accept
- [ ] **DIR-03**: Mid-call Slow-Brain operations are async; never block hot-path
- [x] **DIR-04**: At call start, Bridge injects available Core context (calendar snapshot, contract, practice profile) via `session.update` instructions
- [ ] **DIR-05**: Sideband channel carries ONLY `instructions` updates mid-call; never `tools` (AC-05)
- [x] **DIR-06**: Tool invocations routed to Core MCP on Lenovo1; result returned via `conversation.item.create` (function_call_output) ≤3000ms
- [ ] **DIR-07**: When a call ends, the Director Bridge writes a session summary (case type, outcome, tool results, transcript reference) to Core within 10s
- [ ] **DIR-08**: When OpenAI Realtime invokes a mutating tool, the Director Bridge computes an idempotency key as `sha256(call_id + turn_id + tool_name + canonical_json(arguments))` and returns the cached result for duplicate invocations within the same call (**IDEMPOTENCY**)
- [ ] **DIR-09**: [deferred — was async Slow-Brain transcript forwarding; see DIR-11 for the instructions-only constraint that replaces this]
- [ ] **DIR-10**: The Director Bridge exposes NanoClaw MCP-tools to the Realtime session as a thin MCP-proxy; tool business logic remains entirely in NanoClaw (no duplication in the Bridge) — PRD AC-09
- [x] **DIR-11**: The Director Bridge Slow-Brain (async Claude Sonnet worker) only pushes `session.update` messages carrying `instructions` fields; mid-call `tools` updates are forbidden (AC-04, AC-05)
- [x] **DIR-12**: If the Slow-Brain worker times out or fails, the hot-path continues unaffected; Bridge logs a non-fatal warning and proceeds with last-known instructions
- [ ] **DIR-13**: When Carsten requests a verbindliche Aktion (mutating tool-call with commit semantics), the Bridge requires a verbal two-form readback matching tool arguments within tolerance (numerics exact after German normalization, names Levenshtein ≤2, addresses fuzzy token-set ratio ≥0.85) before dispatching; any mismatch aborts with persona-level retry prompt (**TWO-FORM READBACK**)

### TOOLS — Core MCP Tools (via Director Bridge)

- [x] **TOOLS-01**: `check_calendar(date, duration_minutes)` returns `{available, conflicts[]}`
- [x] **TOOLS-02**: `create_calendar_entry(title, date, time, duration, location, travel_buffer_before_min, travel_buffer_after_min)` returns `{id}` — idempotent
- [x] **TOOLS-03**: `send_discord_message(channel, content)` returns `{ok}` — idempotent via content-hash
- [x] **TOOLS-04**: `get_contract(provider_name)` returns `{current_conditions, expiry_date, last_review}`
- [ ] **TOOLS-05**: `search_competitors(category, criteria)` returns `{offers[]}`
- [x] **TOOLS-06**: `get_practice_profile(name)` returns `{phone, patient_id, insurance_type, last_visit, authorized_data_fields[]}`
- [x] **TOOLS-07**: `schedule_retry(case_type, target_phone, not_before_ts)` returns `{scheduled}` — idempotent
- [x] **TOOLS-08**: `transfer_call(target)` triggers FreeSWITCH SIP REFER via ESL (Case 4 takeover)
- [x] **TOOLS-09**: Per-session tool list capped at 15 (AC-006)

### C6 — Case 6 (Carsten ↔ NanoClaw Voice Channel) — MVP

- [ ] **C6-01**: Carsten's CLI inbound → greeting ≤2s ("Ja, Carsten?")
- [x] **C6-02**: Case-6 mode grants full NanoClaw-Core access (calendar, RAG, memory, tools) via Slow-Brain without latency restrictions
- [ ] **C6-03**: Verbindliche Aktionen in Case-6 require explicit verbal confirmation from Carsten before execution
- [ ] **C6-04**: NanoBot-triggered outbound call to Carsten (6b) identifies itself immediately
- [ ] **C6-05**: Carsten's "nein"/"nicht jetzt" on 6b outbound → callback time logged in Core → call terminated

### C2 — Case 2 (Restaurant Reservation, Outbound)

- [ ] **C2-01**: On Case-2 trigger, system places outbound call to target restaurant with Carsten's CLI
- [ ] **C2-02**: No answer within 30s → hang up; retry per 5/15/45/120 min schedule, max N/day
- [ ] **C2-03**: Accept reservation within Carsten's tolerance parameters (date, time ±tolerance, party size)
- [ ] **C2-04**: Reservation outside tolerance → decline politely, terminate, escalate via Discord
- [ ] **C2-05**: On confirmation → create calendar entry with restaurant, address, time, party size, travel-buffer
- [ ] **C2-06**: "Sind Sie ein Bot?" → truthful German answer (LEGAL-04), continue call
- [ ] **C2-07**: Voicemail-detection gate: AMD fires before first bot utterance; if voicemail → hang up silently (no message)
- [ ] **C2-08**: Idempotency key on all bookings; duplicate confirmation does not double-book

### C3 — Case 3 (Medical/Hair Appointment, Outbound)

- [ ] **C3-01**: Before call, system loads Carsten's practice profile from Core
- [ ] **C3-02**: IVR hold-music detected → system remains on line passively without LLM inference cost until human speech resumes
- [ ] **C3-03**: Offered slots cross-checked against Carsten's calendar, including travel-buffer from both home and Audi-Standort
- [ ] **C3-04**: Multi-slot offer → select minimum-calendar-disruption + shortest-travel-time
- [ ] **C3-05**: Counterpart requests data beyond authorized list → "Das bespreche ich vor Ort"; no elaboration
- [ ] **C3-06**: On confirmation → create calendar entry with practice, address, time, travel-buffer
- [ ] **C3-07**: Counterpart insists on online-portal booking → acknowledge, terminate, Discord-escalate with portal URL
- [ ] **C3-08**: DTMF keypad navigation deferred to v2 — if IVR requires DTMF, terminate and Discord-escalate

### C4 — Case 4 (Inbound Negotiation)

- [ ] **C4-01**: Whitelisted inbound (Variante 4-C) → accept + enter Case-4 mode
- [ ] **C4-02**: Unclassified inbound (not Case-6, not whitelisted) → reject → Sipgate voicemail
- [ ] **C4-03**: On accept, load relevant contract from Core before first response turn
- [ ] **C4-04**: Within 30s of first turn, initiate live competitor search via Core
- [ ] **C4-05**: Concrete offer → compare against current contract + best competitor; reference in response
- [ ] **C4-06**: Time-pressure tactic → calm deflection ("Wenn das Angebot heute gut ist, ist es morgen auch gut")
- [ ] **C4-07**: NEVER make verbindliche Vertragszusage in a voice call
- [ ] **C4-08**: Personal-data disclosure limited to Core's authorized list for the counterpart category
- [ ] **C4-09**: Counterpart identity unverifiable in contract repo → no personal data → terminate
- [ ] **C4-10**: Call end → structured result doc (counterpart, offer, competitor comparison, recommendation) in Core ≤60s
- [ ] **C4-11**: Carsten's takeover hotword → transfer control via SIP REFER within 500ms

### COST — Cost Caps & Monitoring

- [ ] **COST-01**: Per-call hard cap €1.00; on reach → polite farewell + Discord alert
- [ ] **COST-02**: Daily hard cap €3.00; on reach → no new outbound until next day + Discord alert
- [ ] **COST-03**: Monthly hard cap €25.00; on reach → Voice channel suspended + Discord alert (manual reset)
- [ ] **COST-04**: Soft-warning Discord notification at 80% of each cap level
- [ ] **COST-05**: Monthly reconciliation job compares Director Bridge accumulator vs OpenAI invoice; drift >5% alerts Carsten

### DISC — Disclosure & Rights Compliance

- [ ] **DISC-01**: System never proactively identifies as AI during normal conversation
- [ ] **DISC-02**: On direct "bot?" question → truthful German answer
- [ ] **DISC-03**: Never claims to be a specific named human person
- [ ] **DISC-04**: Counterpart audio never written to disk under any circumstance; RAM-only; released ≤5s of session end

### QUAL — Quality Gates

- [ ] **QUAL-01**: Every phase-declare-PASS requires ≥3-turn E2E test with real German PSTN call
- [ ] **QUAL-02**: P50/P95 turn-latency measured over ≥10 real PSTN turns per phase gate
- [ ] **QUAL-03**: Production drift monitor: P50 >1200ms rolling 24h → Discord alert
- [ ] **QUAL-04**: Monthly filesystem scan for audio files on all Voice-Stack hosts (LEGAL-03 implementation)
- [ ] **QUAL-05**: Spike-replay harness (offline WebSocket mock from turns-*.jsonl) runs in CI on every Director Bridge commit

---

## v2 Requirements

Deferred to subsequent milestones after v1 production-stable.

### C1 — Case 1 (Hotel Research & Booking)

- **C1-01**: Non-voice research via Core to identify 3–5 candidate hotels before any call
- **C1-02**: Rate-inquiry calls ask specifically: direct-booking rate, cancellation, breakfast, room orientation
- **C1-03**: Max 1 rate-inquiry + 1 booking call per hotel per day
- **C1-04**: At most one "Geht da noch was?" per call; no further negotiation
- **C1-05**: Immediate-booking pressure → "Ich vergleiche noch — kann ich später zurückrufen?"
- **C1-06**: Structured comparison (hotel × price × location × cancellation × recommendation) to Carsten via Discord before any booking
- **C1-07**: No booking call without explicit Carsten authorization per hotel per stay
- **C1-08**: Never transmit credit card via voice TTS
- **C1-09**: Telephone credit-card-auth required → defer to online booking + Discord-escalate
- **C1-10**: Confirmed booking → calendar entries for arrival/departure with hotel address

### C4-EXT — Case-4 Extensions

- **C4-12**: Discord override — Carsten can whitelist a one-time inbound number for the next 24h via Discord command
- **C4-13**: Post-call adversarial-pattern learnings written to Core and used to update phishing heuristic

### DTMF — DTMF Keypad (Case 3/general)

- **DTMF-01**: Send DTMF tones via FreeSWITCH → Sipgate → counterpart IVR
- **DTMF-02**: Receive/decode DTMF tones for multi-level IVR navigation

---

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Case 5 Smart Voicemail | Killed by spec; voicemail-leaving = reputation damage risk |
| Unconditional inbound forwarding (Variante 4-B) | Safety: only whitelisted + Carsten accepted; unknown inbound → voicemail |
| Credit card data via voice | Hard MOE-6 constraint; all card-handling in online booking only |
| Audio recording / persistence | §201 StGB mitigation; RAM-only, ≤5s lifetime |
| Commercial use / calls on behalf of third parties | DSGVO Haushaltsausnahme boundary |
| Multi-user access | Single user by design |
| Outbound without Carsten trigger | Every outbound requires explicit authorization per call |
| Pipecat or similar orchestration frameworks | AC-03: measured 8.6× slower (Spike F FAIL) |
| STT + LLM + TTS serial pipeline | AC-01: measured 2.7–3.5s P50 (Spike B FAIL) |
| LiveKit/Daily for SIP transport | Sipgate REGISTER incompatible (2026-04-12) |
| Claude in the turn hot-path | AC-02: measured >1500ms P50 in every variant (Spike B, C FAIL) |
| Voice cloning of real persons | OpenAI usage policy + DISC-03 |
| Persistent session across call boundaries | State is per-call; cross-call memory lives in Core only |
| Proactive bot-self-ID at call start | DISC-01: passive disclosure only |

---

## Traceability

Phase mappings established by the roadmapper on 2026-04-16. Every v1 requirement maps to exactly one phase; zero orphans; zero duplicates.

| Requirement | Phase | Status |
|-------------|-------|--------|
| LEGAL-01 | Phase 0 | Pending |
| LEGAL-02 | Phase 0 | Pending |
| LEGAL-03 | Phase 0 | Pending |
| LEGAL-04 | Phase 0 | Pending |
| INFRA-01 | Phase 1 | Complete |
| INFRA-02 | Phase 1 | Complete |
| INFRA-03 | Phase 1 | Complete |
| INFRA-04 | Phase 1 | Complete |
| INFRA-05 | Phase 2 | Pending |
| INFRA-06 | Phase 4 | Pending |
| INFRA-07 | Phase 4 | Pending |
| INFRA-08 | Phase 1 | Complete |
| SIP-01 | Phase 1 | Complete |
| SIP-02 | Phase 1 | Complete |
| SIP-03 | Phase 1 | Complete |
| SIP-04 | Phase 1 | Complete |
| SIP-05 | Phase 1 | Pending |
| SIP-06 | Phase 1 | Complete |
| SIP-07 | Phase 1 | Complete |
| SIP-08 | Phase 3 | Pending |
| SIP-09 | Phase 7 | Pending |
| VOICE-01 | Phase 2 | Pending |
| VOICE-02 | Phase 2 | Pending |
| VOICE-03 | Phase 2 | Pending |
| VOICE-04 | Phase 2 | Pending |
| VOICE-05 | Phase 2 | Pending |
| VOICE-06 | Phase 2 | Pending |
| VOICE-07 | Phase 2 | Pending |
| VOICE-08 | Phase 2 | Pending |
| VOICE-09 | Phase 2 | Pending |
| VOICE-10 | Phase 2 | Pending |
| VOICE-11 | Phase 2 | Pending |
| VOICE-12 | Phase 2 | Pending |
| DIR-01 | Phase 2 | Pending |
| DIR-02 | Phase 2 | Pending |
| DIR-03 | Phase 2 | Pending |
| DIR-04 | Phase 2 | Complete |
| DIR-05 | Phase 2 | Pending |
| DIR-06 | Phase 2 | Complete |
| DIR-07 | Phase 2 | Pending |
| DIR-08 | Phase 2 | Pending |
| DIR-09 | Phase 3 | Pending |
| DIR-10 | Phase 2 | Pending |
| DIR-11 | Phase 2 | Complete |
| DIR-12 | Phase 4 | Complete |
| DIR-13 | Phase 2 | Pending |
| TOOLS-01 | Phase 4 | Complete |
| TOOLS-02 | Phase 4 | Complete |
| TOOLS-03 | Phase 3 | Complete |
| TOOLS-04 | Phase 4 | Complete |
| TOOLS-05 | Phase 4 | Pending |
| TOOLS-06 | Phase 4 | Complete |
| TOOLS-07 | Phase 4 | Complete |
| TOOLS-08 | Phase 7 | Complete |
| TOOLS-09 | Phase 3 | Complete |
| C6-01 | Phase 3 | Pending |
| C6-02 | Phase 3 | Complete |
| C6-03 | Phase 3 | Pending |
| C6-04 | Phase 3 | Pending |
| C6-05 | Phase 3 | Pending |
| C2-01 | Phase 5 | Pending |
| C2-02 | Phase 5 | Pending |
| C2-03 | Phase 5 | Pending |
| C2-04 | Phase 5 | Pending |
| C2-05 | Phase 5 | Pending |
| C2-06 | Phase 5 | Pending |
| C2-07 | Phase 5 | Pending |
| C2-08 | Phase 5 | Pending |
| C3-01 | Phase 6 | Pending |
| C3-02 | Phase 6 | Pending |
| C3-03 | Phase 6 | Pending |
| C3-04 | Phase 6 | Pending |
| C3-05 | Phase 6 | Pending |
| C3-06 | Phase 6 | Pending |
| C3-07 | Phase 6 | Pending |
| C3-08 | Phase 6 | Pending |
| C4-01 | Phase 7 | Pending |
| C4-02 | Phase 7 | Pending |
| C4-03 | Phase 7 | Pending |
| C4-04 | Phase 7 | Pending |
| C4-05 | Phase 7 | Pending |
| C4-06 | Phase 7 | Pending |
| C4-07 | Phase 7 | Pending |
| C4-08 | Phase 7 | Pending |
| C4-09 | Phase 7 | Pending |
| C4-10 | Phase 7 | Pending |
| C4-11 | Phase 7 | Pending |
| COST-01 | Phase 4 | Pending |
| COST-02 | Phase 4 | Pending |
| COST-03 | Phase 4 | Pending |
| COST-04 | Phase 4 | Pending |
| COST-05 | Phase 4 | Pending |
| DISC-01 | Phase 3 | Pending |
| DISC-02 | Phase 3 | Pending |
| DISC-03 | Phase 3 | Pending |
| DISC-04 | Phase 2 | Pending |
| QUAL-01 | Phase 5 | Pending |
| QUAL-02 | Phase 5 | Pending |
| QUAL-03 | Phase 4 | Pending |
| QUAL-04 | Phase 4 | Pending |
| QUAL-05 | Phase 2 | Pending |

**Coverage:**
- v1 requirements: 101 total (LEGAL:4 + INFRA:8 + SIP:9 + VOICE:12 + DIR:13 + TOOLS:9 + C6:5 + C2:8 + C3:8 + C4:11 + COST:5 + DISC:4 + QUAL:5). Note: an earlier draft of this file stated "98 total" — that was stale; the per-category counts and the detailed list above both confirm 101.
- Mapped to phases: 101 (100 %) ✓
- Unmapped: 0 ✓

**Per-phase counts:**

| Phase | Count | Requirements |
|-------|-------|--------------|
| 0. Pre-Production Legal Gate | 4 | LEGAL-01..04 |
| 1. Infrastructure & Webhook Path | 12 | INFRA-01..04, INFRA-08, SIP-01..07 |
| 2. Director Bridge v0 + Hot-Path Safety | 26 | INFRA-05, VOICE-01..12, DIR-01..08, DIR-10, DIR-11, DIR-13, DISC-04, QUAL-05 |
| 3. Case 6 MVP | 12 | SIP-08, C6-01..05, DIR-09, TOOLS-03, TOOLS-09, DISC-01..03 |
| 4. Core Tool Integration + Cost/Observability | 15 | INFRA-06, INFRA-07, DIR-12, TOOLS-01, TOOLS-02, TOOLS-04..07, COST-01..05, QUAL-03, QUAL-04 |
| 5. Case 2 — Restaurant Outbound | 10 | C2-01..08, QUAL-01, QUAL-02 |
| 6. Case 3 — Medical/Hair Outbound | 8 | C3-01..08 |
| 7. Case 4 — Inbound Negotiation | 14 | SIP-09, C4-01..11, TOOLS-08 (plus DIR-12 already in P4 — no duplication) |

Note: Phase 7 row lists TOOLS-08 plus SIP-09 + C4-01..11 = 13 unique; the reference to DIR-12 is informational only (it is mapped to Phase 4 and is not double-counted).

Sum: 4 + 12 + 26 + 12 + 15 + 10 + 8 + 13 = 100. Recount of Phase 2: INFRA-05 (1) + VOICE-01..12 (12) + DIR-01..08 (8) + DIR-10 (1) + DIR-11 (1) + DIR-13 (1) + DISC-04 (1) + QUAL-05 (1) = 26 ✓. Recount of Phase 4: INFRA-06 (1) + INFRA-07 (1) + DIR-12 (1) + TOOLS-01 (1) + TOOLS-02 (1) + TOOLS-04..07 (4) + COST-01..05 (5) + QUAL-03 (1) + QUAL-04 (1) = 16. That adjusts the table to 16 for Phase 4 and 101 total.

**Corrected per-phase sum:** 4 + 12 + 26 + 12 + 16 + 10 + 8 + 13 = 101 ✓

---

*Requirements defined: 2026-04-16*
*Source: voice-channel-spec/REQUIREMENTS.md v1.0 (Approved 2026-04-15), voice-channel-spec/PRD.md v1.0, E1-1a Architecture-Decision, Sideband-WS-Spike*
*Traceability added: 2026-04-16 by GSD roadmapper*
*Last updated: 2026-04-16*
