---
phase: 05
phase_name: case-2-restaurant-reservation-outbound
status: context-captured
captured: 2026-04-20
source_of_truth:
  - .planning/REQUIREMENTS.md — C2-01..08, QUAL-01, QUAL-02 (authoritative for scope)
  - /home/carsten_bot/nanoclaw-state/voice-channel-spec/CONOPS.md — Case 2 trigger, tolerance, retry strategy (authoritative for design intent)
  - /home/carsten_bot/nanoclaw-state/voice-channel-spec/PRD.md — product-level case definition
seeds_integrated:
  - SEED-001-channel-agnostic-voice-notify.md
requirements:
  - C2-01
  - C2-02
  - C2-03
  - C2-04
  - C2-05
  - C2-06
  - C2-07
  - C2-08
  - QUAL-01
  - QUAL-02
---

# Phase 5 CONTEXT — Case 2 Restaurant Reservation Outbound

## Scope anchor

Phase 5 is **not re-scoped here**. REQUIREMENTS.md (C2-01..08 + QUAL-01/02) + voice-channel-spec/CONOPS.md + PRD.md are the authoritative sources. This CONTEXT.md captures ONLY the decisions that downstream spec artifacts leave open, plus the Phase-4.5-seeded channel-routing integration.

Researcher and Planner: read CONOPS + REQUIREMENTS first, treat this file as overlay for the open items below.

## Decisions (locked)

### D-1. AMD (voicemail detection) — delegate to research

**C2-07** requires: "AMD fires before first bot utterance; if voicemail → hang up silently (no message)."

**Decision:** Research Agent investigates 2026 best-practice for AMD in OpenAI Realtime voice stacks. Options to evaluate (not prescribed):
- (a) Server-side audio heuristic (VAD-pattern: long uninterrupted speech without natural response gaps = typical mailbox greeting).
- (b) Prompt-orchestrated detection (bot waits 2s of silence, optionally emits a single probe like "Hallo, spreche ich mit dem Restaurant?"; if transcript matches mailbox cues or no human response → hang up).
- (c) Third-party AMD service (e.g., Twilio AMD if reachable from OpenAI SIP path — unlikely given current topology).
- (d) Hybrid: audio-heuristic as first gate, transcript-cue as confirmation.

**Constraint:** must fire **before first bot utterance** (C2-07). No partial greeting is acceptable — a half-spoken "Guten Tag, hier ist..." on voicemail is a reputation leak.

**Constraint:** must work with the existing OpenAI Realtime + FreeSWITCH + rtpengine topology. Any approach requiring OpenAI protocol changes is out.

**Research deliverable:** AMD section in RESEARCH.md with recommended approach, rationale, and latency budget (must not delay live-human first-utterance by more than 500 ms).

### D-2. Retry cap = 5 per day

**C2-02** requires: "No answer within 30s → hang up; retry per 5/15/45/120 min schedule, max N/day."

**Decision:** N = 5. After 5 failed attempts in a single calendar day, the job is marked failed and escalated to Carsten (via the channel routing from D-4). A new day resets the counter (counts are per `(target_phone, calendar_date)` key).

**Scope:** applies to "no answer" (30s timeout). Also applies to **line busy** (Sipgate returns 486 Busy Here) per Carsten clarification 2026-04-20. Existing `schedule_retry(case_type, target_phone, not_before_ts)` tool (TOOLS-07, already built) is the integration point — Phase 5 adds the Case-2 caller that enqueues retries with the 5/15/45/120 min schedule and checks the daily cap before enqueueing.

### D-3. QUAL-01 PSTN test = simulated restaurant via second phone

**QUAL-01** requires: "Every phase-declare-PASS requires ≥3-turn E2E test with real German PSTN call."

**Decision:** Carsten plays the restaurant from his second phone (not a real restaurant). Test script:
- NanoBot calls target number.
- Carsten answers on second phone, role-plays restaurant staff in German.
- Bot requests reservation (≥3 turns: greeting → request → confirmation).
- Carsten confirms or declines per test scenario (happy path, tolerance-violation path, "Sind Sie ein Bot?" path, voicemail path simulated by Carsten silent + mailbox-style greeting).

**Rationale:** avoids burning real restaurant goodwill during Phase 5 shakedown; keeps spec-required "real PSTN call" (it IS real PSTN through Sipgate → second phone). Real-restaurant validation deferred to Phase-5-gate sign-off, where Carsten arranges one good-will test with a known venue.

**Test matrix deliverable (plan):** minimum 5 test scripts covering C2-01, C2-03 happy, C2-04 tolerance-violation, C2-06 bot-question, C2-07 voicemail simulation. QUAL-02 (P50/P95 latency over ≥10 turns) runs the same rig with additional conversational turns.

### D-4. Channel routing — migrate to Andy (SEED-001 integration)

**Context:** C2-04 says "escalate via Discord", C2-05 says confirmation → calendar entry. SEED-001 proposes replacing hard-coded Discord with a generic `voice_notify_user(text, urgency)` tool that returns the payload on MCP so Andy (NanoClaw core) routes it per channel-registry state + existing content-length rule.

**Decision:** Integrate SEED-001 into Phase 5 scope. Replace `voice_send_discord_message` with `voice_notify_user(text, urgency)`.

**Scope inside Phase 5:**
- Add new MCP tool `voice_notify_user({ text, urgency, call_id, turn_id })` — returns `{ ok, routed_via }` for idempotency + observability.
- Andy router rule: on `voice_notify_user` payload, route to active-WhatsApp-session if one exists, else Discord. Long-text rule (`>50 words → Discord`) from `feedback_long_text_discord.md` applied as override.
- Migrate all Phase 5 Case-2 emission sites (C2-04 escalation, C2-05 calendar-created summary) to the new tool.
- Deprecate `voice_send_discord_message` via the same deprecation-observability pattern we used for port 3200 (log `mcp_tool_voice_send_discord_message_seen` on any remaining call). Removal in follow-up phase once Case-6 post-call summaries and Phase-3 code are migrated too.

**Out of scope for Phase 5:** migrating Phase-3 / Phase-4 emission sites that already use `voice_send_discord_message`. Those stay functional but emit the deprecation log. A follow-up phase retires them.

**Urgency field values (locked):**
- `"info"` — post-call summary, confirmation, happy-path calendar entry note
- `"decision"` — needs Carsten's input (rare in Phase 5 but present for C2-04 out-of-tolerance escalation)
- `"alert"` — failure requiring action (e.g., retry cap reached per D-2, unexpected tool error)

### D-5. Tolerance semantics (reference CONOPS 2.2)

CONOPS 2.2 names: "Toleranzfenster-Config pro Reservierung (Uhrzeit, Tisch, Personenzahl, P8)".

**Decision:** Tolerance is passed per-call as structured arguments, not a saved profile. Carsten's trigger message (Discord / WhatsApp / voice in Case-6) carries:
- `restaurant_name` (string)
- `restaurant_phone` (E.164 string — Carsten supplies or NanoClaw looks up per P8 web-research in a later phase)
- `requested_date` (ISO date)
- `requested_time` (HH:MM, the ideal)
- `time_tolerance_min` (default: 30)
- `party_size` (int)
- `party_size_tolerance` (default: 0 — must match exactly)
- `notes` (optional string — "draußen", "ruhig", "Allergien: Nuss", "Anlass: Geburtstag")

Plan to ingest these as MCP tool args on `voice_start_case_2_call` (tool to be created — Planner decides name). Defaults live in `src/config.ts`.

**Claude's Discretion for Planner:** exact tool name, whether to split into `schedule_case_2_call` + `execute_case_2_call` or merge, whether restaurant-phone lookup is in-scope (CONOPS 2.1 says Restaurant-Adressbuch is "neu" — may be its own follow-up phase with Google-Maps/Web lookup; simplest Phase-5 path is Carsten supplies the phone manually).

### D-6. Trigger surface (reference CONOPS)

CONOPS says trigger can be Discord-text, voice-in-Case-6, or calendar/reminder hook.

**Decision:** Phase 5 implements Discord-text + WhatsApp-text trigger only (whichever channel Carsten uses for reservation requests). Voice-in-Case-6 trigger deferred (works through existing Case-6b `voice_request_outbound_call` infrastructure once tool args match D-5 shape — essentially free). Calendar/reminder hook deferred to a later phase (no calendar trigger infra exists yet).

**Andy handler:** parse Carsten's freeform message ("Buch mir den Italiener am Donnerstag um 19 Uhr für 4 Personen"), extract D-5 fields via Claude extraction, confirm via two-form readback (DIR-13 pattern reused), enqueue the outbound call.

### D-7. Idempotency key (C2-08)

**Decision:** `sha256(restaurant_phone + requested_date + requested_time + party_size + call_id_originating_session)` — reuses DIR-08 pattern. Key stored in DB on booking-confirmation path (C2-05). Duplicate confirmation check: if the same key has already produced a calendar entry, the second confirmation is logged + no-op'd (no double-book).

## Non-goals (explicit)

- **Restaurant-Adressbuch / phone-lookup automation** (CONOPS 2.1) — out of Phase 5. Carsten supplies phone number manually until a follow-up phase ships the adressbuch.
- **Real restaurant validation call** — deferred from QUAL-01 to Phase-5-gate sign-off (D-3 rationale).
- **Voice-in-Case-6 trigger** (talk to NanoBot during call to book a restaurant) — deferred per D-6.
- **Migration of Phase-3/4 emission sites to `voice_notify_user`** — deferred per D-4 scope.

## Open items for Research Agent

1. **AMD best-practice 2026** for OpenAI Realtime + FreeSWITCH topology (D-1) — must-deliver: recommended approach + latency budget.
2. **Tolerance negotiation conversational patterns** — when the restaurant offers 18:30 and we wanted 19:00 ± 30, how does the bot negotiate naturally within tolerance? Any prior-art German-language phone-booking scripts?
3. **Retry-scheduler integration with TOOLS-07** (`schedule_retry`) — is the existing tool fire-and-forget enough, or does Case-2 need a retry orchestrator that watches the schedule + daily-cap counter? Investigate current TOOLS-07 implementation and propose gap closure if any.

## Open items for Planner

1. Tool-surface additions: `voice_notify_user` (D-4), Case-2 trigger tool name/shape (D-5), any orchestrator tool for daily-cap gate (D-2).
2. Andy router rule integration (D-4) — update to `src/router.ts` or equivalent.
3. Test rig for D-3 simulated-restaurant scenarios — probably a test script + documented manual procedure.
4. Deprecation-observability log for `voice_send_discord_message` (D-4).
5. QUAL-02 latency-capture harness — reuse Phase 4 cost-ledger pattern or spike new?

## Decisions reference chain

All locked decisions above are captured to minimize planner questions. If Planner hits a question NOT covered here, log it as a planner-question and continue with best judgment, then carry to gsd-plan-checker for validation before execute.

**Claude's Discretion expected:** any implementation choice downstream of the decisions above (file structure, internal APIs, test framework specifics, prompt wording, schema field naming) is Claude's call unless it materially changes user-facing behavior or contradicts CONOPS/REQUIREMENTS.
