# Roadmap: NanoClaw Voice

## Overview

NanoClaw Voice builds a personal AI phone agent on top of already-validated split-stack infrastructure (FreeSWITCH on Hetzner + Lenovo1 NanoClaw Core) using OpenAI `gpt-realtime-mini` as Hot-Path and Claude Sonnet 4.6 as async Slow-Brain director. The roadmap follows a goal-backward build order derived from research: a hard **legal gate** prerequisite (§201 StGB + ZDR) blocks any real counterpart call; **Director Bridge v0** ships the load-bearing safety primitives (idempotency + two-form readback) before any mutating tool; **Case 6** (Carsten ↔ NanoClaw) is the MVP slice that exercises every architecture component without counterpart-credibility or legal exposure; then **Cases 2, 3, 4** ship in research-validated order. Case 1 (Hotel) stays deferred to v2+.

Granularity: standard (8 phases, 3-5 plans each). Eight phases cover all 101 v1 requirements with zero orphans. Phase 0 and Phase 1 can run partly in parallel (legal evidence work vs. infra bring-up) subject to `carsten` (server-admin) coordination for Caddy + OpenAI webhook-URL configuration.

## Phases

**Phase Numbering:**
- Integer phases (0-7): Planned milestone work
- Decimal phases (reserved): Urgent insertions via `/gsd-insert-phase`

- [x] **Phase 0: Pre-Production Legal Gate** - ZDR verified, lawyer opinion filed, audio-audit tooling live; HARD prerequisite for any counterpart call — **COMPLETE 2026-04-16** (pre-existing; see 00-SUMMARY.md)
- [ ] **Phase 1: Infrastructure & Webhook Path** - FreeSWITCH/Sipgate REGED, Caddy + webhook relay + stub Bridge, WG MTU tuned; signature-verified webhook arrives end-to-end
- [x] **Phase 2: Director Bridge v0 + Hot-Path Safety** - Idempotency keys, two-form readback, schema allowlist, teardown assertion, turn-timing JSONL, RAM-only audio hygiene (completed 2026-04-18)
- [x] **Phase 3: Case 6 MVP — Carsten ↔ NanoClaw voice working** - First end-to-end PSTN call, Discord tool wired, 6a inbound + 6b outbound, confirm-action gate (completed 2026-04-17)
- [x] **Phase 4: Core Tool Integration + Cost/Observability** - Calendar/contract/practice/competitor tools, real-time cost accumulator, hard caps, reconciliation jobs, filesystem audit
- [ ] **Phase 4.5: MCP Universal Consolidation** - Close architectural drift from Phase 2: migrate bridge→core from JSON-POST REST facade to true MCP-SDK StreamableHTTP client, deprecate port 3200, resolve iOS Claude-App client compat (now on production path)
- [ ] **Phase 5: Case 2 — Restaurant Reservation Outbound** - First counterpart-facing call; voicemail gate, VAD calibration, tolerance window, retry scheduler
- [ ] **Phase 6: Case 3 — Medical/Hair Appointment Outbound** - Practice profile, travel-time-aware slot selection, IVR hold-music passive listening, authorized-disclosure schema
- [ ] **Phase 7: Case 4 — Inbound Negotiation** - Whitelist inbound routing, contract repo + live competitor search, phishing heuristic, Carsten takeover hotword via SIP REFER

## Phase Details

### Phase 0: Pre-Production Legal Gate
**Goal**: Hard legal prerequisites are satisfied — OpenAI Zero Data Retention verified, German telecoms-lawyer opinion on file, §201 StGB speakerphone/third-party exposure addressed, audio-persistence audit tooling live. Blocks first outbound call to any non-informed counterpart.
**Depends on**: Nothing (first phase)
**Requirements**: LEGAL-01, LEGAL-02, LEGAL-03, LEGAL-04
**Success Criteria** (what must be TRUE):
  1. OpenAI ZDR confirmation email + pinned dashboard screenshot archived under `legal-evidence/openai-zdr/`, with SHA-256 hash committed and a monthly `zdr_verify` cron alerting if unverified >30 days
  2. Written legal opinion from a German telecoms/AI-voice lawyer (HÄRTING or LUTZ|ABEL class) covering §201 StGB speakerphone/third-party capture, DSGVO Haushaltsausnahme boundary, and passive-disclosure stance, filed under `legal-evidence/lawyer-opinion/`
  3. Monthly filesystem audit script runs on both Hetzner and Lenovo1, scanning for `*.wav`/`*.mp3`/`*.opus`/`*.flac`, and posts a pass/fail summary to Discord (verified by a seeded synthetic file that triggers the alert)
  4. Persona master-prompt contains the truthful-on-ask disclosure directive ("Sind Sie ein Bot?" → "Ja, ich bin KI") and the identity-claim prohibition, with unit tests asserting both invariants
**Plans**: TBD
**UI hint**: no
**Scope note**: Phase 0 is mostly `carsten_bot` (scripts, audit tooling, prompt language) plus one `carsten` (server-admin) sub-task to enable ZDR in the OpenAI project dashboard. Lawyer opinion is external and may block Phase 5+ even if Phase 3/4 ship.

### Phase 1: Infrastructure & Webhook Path
**Goal**: The full network path works end-to-end before any call logic ships: FreeSWITCH is REGED with Sipgate, Caddy terminates TLS for the voice-webhook public URL, a minimal Hetzner webhook forwarder relays to Lenovo1 over WireGuard, and a stub Director Bridge verifies signatures and logs payloads. Decouples infra bring-up from business logic.
**Depends on**: Nothing (can start in parallel with Phase 0)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-08, SIP-01, SIP-02, SIP-03, SIP-04, SIP-05, SIP-06, SIP-07
**Success Criteria** (what must be TRUE):
  1. FreeSWITCH on Hetzner Python1 is REGED with Sipgate within 30 s of container boot, visible in `fs_cli` registration status and confirmed via a test inbound INVITE from +49 30 8687022345 arriving on 5060/UDP
  2. A real test call (Carsten's mobile → Sipgate CLI) causes FreeSWITCH to bridge to `sip:proj_4tEBz3XjO4gwM5hyrvsxLM8E@sip.api.openai.com;transport=tls` within 500 ms, negotiates PCMU exclusively, and RTP flows on 60000–60100/UDP; `BYE` releases both legs within 2 s
  3. OpenAI `realtime.call.incoming` webhook arrives at Caddy on Hetzner, is relayed by the forwarder (`vs-webhook-forwarder`, <100 LOC Python+FastAPI) over WireGuard 10.0.0.2:4401 to the Director Bridge stub, and the stub verifies signature via `openai.webhooks.unwrap` and responds 200 OK within 2 s (verified on 3 consecutive test calls)
  4. WireGuard MTU is pinned to 1380 both ends; a heartbeat-ping from the Director Bridge detects a tunnel drop within 2 s (verified by `ip link set wg0 down` during a monitored window)
  5. Director Bridge runs as a `systemd --user` unit under `carsten_bot` on Lenovo1 with `Restart=on-failure`, survives a `kill -9`, and exposes `/health` returning green over WG
**Plans:** 6 plans across 4 waves
Plans:
- [ ] 01-01-PLAN.md — Wave 1 — WireGuard MTU 1380 both peers + Hetzner firewall block 9876/tcp (carsten + carsten_bot coordination)
- [ ] 01-02-PLAN.md — Wave 1 — Caddy include-snippet + OpenAI dashboard webhook URL + secret to .env on both hosts (carsten coordination)
- [x] 01-03-PLAN.md — Wave 2 — vs-webhook-forwarder Python/FastAPI service (Dockerfile, signature verify, WG canary endpoint, deploy)
- [x] 01-04-PLAN.md — Wave 2 — FreeSWITCH dialplan edit + reload (bridge to OpenAI SIP TLS, PCMU, 503 fallback) + outbound smoke test
- [x] 01-05-PLAN.md — Wave 3 — voice-bridge TS+Fastify v5 (defense-in-depth signature, JSONL, /health, HTTP heartbeat, systemd --user)
- [ ] 01-06-PLAN.md — Wave 4 — D-25 synthetic webhook test + D-26 3 live PSTN calls + Phase-1-exit roll-up
**UI hint**: no
**Scope note**: Heavy `carsten` (server-admin) involvement — Caddy config on Hetzner, OpenAI webhook-URL registration at the project level, WireGuard MTU tuning both ends. `carsten_bot` owns Director Bridge skeleton + systemd unit + signature verify.

### Phase 2: Director Bridge v0 + Hot-Path Safety
**Goal**: The Director Bridge owns safety primitives that every subsequent case depends on — idempotency keys on mutating tools, tool-name allowlist + schema validation, two-form readback in the persona, session-teardown assertion, turn-timing JSONL, RAM-only audio hygiene. `/accept` is called with full session config, sideband WS is opened, and hot-path latency is measurable. Nothing ships to a counterpart until every v0 safety control is green.
**Depends on**: Phase 1
**Requirements**: INFRA-05, VOICE-01, VOICE-02, VOICE-03, VOICE-04, VOICE-05, VOICE-06, VOICE-07, VOICE-08, VOICE-09, VOICE-10, VOICE-11, VOICE-12, DIR-01, DIR-02, DIR-03, DIR-04, DIR-05, DIR-06, DIR-07, DIR-08, DIR-10, DIR-11, DIR-13, DISC-04, QUAL-05
**Success Criteria** (what must be TRUE):
  1. A synthetic-fixture Case 6 test call via the offline WebSocket replay harness (built from spike E `turns-*.jsonl`) shows P50 VAD-end→TTS-first-byte ≤ 900 ms and P95 ≤ 1500 ms over ≥ 10 turns, with `gpt-realtime-mini` as the model, `server_vad` + `auto_create_response=true`, and barge-in cancelling current TTS within 200 ms of counterpart VAD
  2. Firing the same `create_calendar_entry` tool-call twice in the replay harness with identical arguments produces exactly one Core-side side effect; the second invocation returns the cached result via the idempotency-key wrapper (`call_id`+`turn_id`+`tool_name`+`argument_hash`); injecting a fabricated tool name is rejected with a synthetic `tool_error` and the hot-path continues gracefully with "Das kann ich gerade leider nicht nachsehen"
  3. A counterpart-side misrecognition test ("seventeen vs seventy" German numerals) shows the persona rendering verbindliche time/number values in two-form readback ("siebzehn Uhr, also 17 Uhr") and rejecting any tool-commit when the spoken-confirmation diff vs. tool-args is non-zero
  4. After every synthetic call ends with `BYE`, `session.closed` is observed within 2 s (kill-timer fires at 5 s if not), turn-timing JSONL is written to `~/nanoclaw/voice-container/runs/turns-{call_id}.jsonl`, and a filesystem scan of `~/nanoclaw`, `~/.cache`, `/tmp` returns zero audio files
  5. Sideband WS connects within 1500 ms of `/accept`, tools are set once at accept (15-tool cap enforced), mid-call `session.update` carries only `instructions` (never `tools`), and the spike-replay harness runs green in CI on every Bridge commit
**Plans:** 11/11 plans complete
Plans:
- [x] 02-01-PLAN.md — Wave 1 — Tool allowlist + ajv schema validation + thin MCP-proxy dispatch (D-07..10, AC-09)
- [x] 02-02-PLAN.md — Wave 1 — Idempotency wrapper: sha256 key + canonical JSON + per-call RAM Map (D-01..06)
- [x] 02-03-PLAN.md — Wave 1 — RAM-only audio hygiene: audio-guard CI + FS-recordings check + D-22 regression guard (D-20..23)
- [x] 02-04-PLAN.md — Wave 2 — Two-form readback normalize + validator (German NLP, Levenshtein, dice) + Wave-2 dep pre-install (D-11..15)
- [x] 02-05-PLAN.md — Wave 2 — Sideband WS client + Slow-Brain async worker + Phase-2 config constants (D-24..28, D-43)
- [x] 02-06-PLAN.md — Wave 3 — Turn-timing JSONL + teardown (2s/5s) + ghost-scan + PHASE2_PERSONA + logger taxonomy (D-16..19, D-37..38)
- [x] 02-07-PLAN.md — Wave 4 — /accept full wiring: tools + VAD + persona + call-router lifecycle (D-39..43)
- [x] 02-08-PLAN.md — Wave 5 — Spike-E replay harness + SC-1/SC-2/SC-5 CI gate (D-29..34)
**UI hint**: no
**Scope note**: All `carsten_bot` scope. This is the largest phase because the v0 safety envelope is load-bearing for every downstream case — splitting idempotency or readback to a later phase would make retrofit into a rewrite (per pitfall research).

### Phase 3: Case 6 MVP — Carsten ↔ NanoClaw voice working
**Goal**: The MVP slice. Carsten dials his Sipgate number, NanoBot greets "Ja, Carsten?" within 2 s, grants full Core access with confirm-action gating on verbindliche Aktionen, and hangs up cleanly with a session summary in Core within 10 s. Also covers 6b proactive outbound where NanoClaw initiates a call to Carsten. Exercises the full architecture (webhook → accept → sideband → Slow-Brain → tools → teardown) without counterpart or legal exposure.
**Depends on**: Phase 2
**Requirements**: SIP-08, C6-01, C6-02, C6-03, C6-04, C6-05, DIR-09, TOOLS-03, TOOLS-09, DISC-01, DISC-02, DISC-03
**Success Criteria** (what must be TRUE):
  1. Carsten dials his Sipgate DID from his mobile; within 2 s the bot greets "Ja, Carsten?" in German, SIP From-header CLI detection routes to Case 6 mode, and a real ≥3-turn PSTN conversation ensues with P50 ≤ 900 ms per QUAL-01/02 gates
  2. Carsten asks "schick mir 'hallo' auf Discord"; the bot emits a `send_discord_message` function-call with an idempotency key (content-hash), Carsten receives the Discord message exactly once even if the model re-emits the call, and the bot confirms "erledigt" without verbalizing the tool name or status
  3. For verbindliche Aktionen (e.g., "buch mir den Termin"), the bot MUST call `confirm_action(action_id)` with structured arguments matching the earlier proposal and MUST receive an explicit verbal "ja" from Carsten before any mutating tool fires; a denied/ambiguous response escalates to Discord and terminates
  4. Slow-Brain (Claude Sonnet async worker) drains the transcript queue and pushes at least one `instructions`-only `session.update` during a multi-turn Case 6 call without breaking audio (zero gap > 1 s), and the hot-path is never observed awaiting Claude
  5. 6b flow: a Core event triggers `/outbound` on the Director Bridge, FreeSWITCH ESL `originate` places a call to Carsten, the bot identifies itself within 2 s ("Hi Carsten, kurz wegen …"); Carsten's "nein"/"nicht jetzt" writes a callback time to Core and terminates; the bot never proactively self-identifies as AI in normal Case 6 conversation but answers truthfully on direct "bot?" question and never claims a named human identity
**Plans**: TBD
**UI hint**: no
**Scope note**: All `carsten_bot` scope. This is the Phase-3-exit gate defined in the research — real PSTN call with turn-timing P50 < 900 ms + session summary + zero audio files. After this gate, the architecture is proven end-to-end; Cases 2/3/4 become tooling + persona work.

### Phase 4: Core Tool Integration + Cost/Observability
**Goal**: The full Case 6 tool surface is wired (calendar with travel-buffer, contract, practice profile, competitor search, retry scheduler), cost is enforced in real-time per-call/day/month with hard-caps, Chat-Claude and iOS Claude consume the production MCP StreamableHTTP endpoint on port 3201 (AC-07 verified — same canonical channel the Bridge uses), reconciliation jobs detect cross-channel drift, and the monthly §201 filesystem audit runs on both hosts.
**Depends on**: Phase 3
**Requirements**: INFRA-06, INFRA-07, TOOLS-01, TOOLS-02, TOOLS-04, TOOLS-05, TOOLS-06, TOOLS-07, COST-01, COST-02, COST-03, COST-04, COST-05, QUAL-03, QUAL-04
**Success Criteria** (what must be TRUE):
  1. The full tool set (check_calendar, create_calendar_entry with travel-buffer, get_contract, search_competitors, get_practice_profile, schedule_retry) is callable both from a live Case 6 call AND from Claude Chat via the Streamable HTTP MCP transport, with identical handler code (single-source tool registry); mutating tools carry idempotency keys and return cached results on duplicate
  2. A synthetic 30-min test call accumulates `response.done.usage` token counts in real-time into `state.db`; at 80 % of the €1 per-call cap a soft-warning Discord notification fires; at 100 % the bot emits a polite farewell via `session.instructions` and hangs up; daily (€3) and monthly (€25) caps are enforced via startup SUM queries
  3. The nightly pricing-refresh cron fetches OpenAI Realtime price tiers and alerts Discord if hardcoded constants drift > 5 %; the monthly reconciliation job cross-checks Director Bridge accumulator vs. OpenAI invoice and alerts at drift > 5 %
  4. The monthly filesystem audit (LEGAL-03 implementation) runs on both Hetzner and Lenovo1 by cron, posts a JSON summary to Discord, and fails loudly on any seeded `*.wav`/`*.mp3`/`*.opus`/`*.flac` test file; a production drift monitor alerts Discord when rolling-24h P50 exceeds 1200 ms
  5. A 3-way reconciliation job (calendar-entry ↔ transcript confirmation-id ↔ Discord summary) runs nightly and alerts on any 2-of-3 inconsistency from the prior day's Case 6 calls
**Plans:** 5 plans across 5 waves
Plans:
- [x] 04-01-PLAN.md — Wave 1 — Cost ledger skeleton (state.db migration, prices.ts, accumulator.ts, voice.record_turn_cost + voice.finalize_call_cost) — INFRA-06
- [x] 04-02-PLAN.md — Wave 2 — Cost enforcement (sideband.ts response.done hook, 80% soft-warn, 100% hard-stop via instructions-only, /accept gate, voice.get_day_month_cost_sum, voice.reset_monthly_cap) + A12 fix: invokeIdempotent wrapper in dispatch.ts for mutating tools — COST-01..04
- [x] 04-03-PLAN.md — Wave 3 — TOOLS-05 voice.search_competitors (graceful not_configured fallback) + @modelcontextprotocol/sdk StreamableHTTP MCP server on port 3201 (bearer + peer-allowlist + Pitfall-8 disjoint key space) + TOOLS-01/02/04/06/07 dispatch smoke tests — TOOLS-01, TOOLS-02, TOOLS-04, TOOLS-05, TOOLS-06, TOOLS-07
- [x] 04-04-PLAN.md — Wave 4 — Cron jobs: audit-audio.sh (both hosts, QUAL-04/LEGAL-03), pricing-refresh.sh (Hetzner, INFRA-07, Pitfall 5 no-auto-update), drift-monitor.ts (QUAL-03 rolling-24h P50), recon-3way.ts (calendar↔transcript↔Discord), recon-invoice.ts (COST-05 monthly vs invoice CSV) + 6 systemd --user timer units — INFRA-07, COST-05, QUAL-03, QUAL-04
- [x] 04-05-PLAN.md — Wave 5 — Phase-gate verification: deploy systemd timers both hosts, human-verify synthetic cost-cap test, human-verify iPhone Chat-Claude StreamableHTTP, seeded §201 audit fail-loud test, full test suite + REQUIREMENTS/ROADMAP/STATE updates
**UI hint**: no
**Scope note**: All `carsten_bot` scope (Hetzner deploys under `carsten` via SSH per MASTER.md §2). Core MCP tools mostly already exist in NanoClaw Core; this phase adds the Bridge-side wiring, cost ledger, reconciliation, and StreamableHTTP transport. Pricing-refresh + §201 audit install as systemd --user timers. A12 idempotency-wrapper gap in dispatch.ts closed as part of Plan 02.

### Phase 4.5: MCP Universal Consolidation
**Goal**: Close the architectural drift surfaced on 2026-04-19/20 during Phase 4 iOS MCP debugging. The spec (ConOps + REQUIREMENTS AC-07/AC-09 + ARCHITECTURE-DECISION) requires MCP in both directions on the Bridge ↔ NanoClaw path. Phase 2 shipped a JSON-POST REST shortcut instead (`voice-bridge/src/core-mcp-client.ts` calls `POST {url}/{name}` without MCP envelope), and Phase 4 added the spec-compliant StreamableHTTP channel alongside rather than replacing. Phase 4.5 retires the REST shortcut.
**Depends on**: Phase 4
**Requirements**: AC-07, AC-09, REQ-DIR-04, REQ-DIR-10, REQ-C6B-03 (re-affirmation via production-path usage)
**Success Criteria** (what must be TRUE):
  1. `voice-bridge/src/core-mcp-client.ts` is a true MCP-SDK StreamableHTTP client (JSON-RPC 2.0 + initialize handshake + capabilities negotiation). Tool dispatch from the bridge during a live voice call uses the MCP protocol on port 3201, not the REST facade on port 3200.
  2. Session management: the bridge holds a long-lived MCP session per live call (sessionIdGenerator enabled) so the initialize handshake amortizes across many tool calls rather than paying it per call.
  3. Port 3200 REST server (`src/mcp-server.ts`) deprecated — still running during a compatibility window but no production consumer depends on it. Removal planned after N days (defined in this phase's PLAN).
  4. iOS Claude-App MCP compatibility resolved — now a production-blocker rather than a debug-channel nice-to-have. Either fixed (session-based transport, not stateless) or a signed-off decision documenting the production auth/integration path that does not require iOS.
  5. REQUIREMENTS.md AC-07 wording re-aligned so StreamableHTTP is not described as "debug only" — it is the production Bridge ↔ Core channel.
**Plans:** 5 plans across 5 waves (0-4)
Plans:
- [x] 04.5-00-PLAN.md — Wave 0 — Foundation: export 18 zod schemas from voice-*.ts + scaffold regression + bridge-client test files
- [x] 04.5-01-PLAN.md — Wave 1 — Session-based MCP StreamableHTTP server (Issue #1405 per-session McpServer) + TOOL_META for all 18 tools + D-15 regression scenarios + deploy + iOS checkpoint
- [x] 04.5-02-PLAN.md — Wave 2 — Bridge v2 MCP SDK client (CoreMcpClient class + v1-compatible callCoreTool free-function) + 6 unit tests
- [x] 04.5-03-PLAN.md — Wave 3 — Migrate 6 bridge callers to v2 + Pitfall-5 finalizer in sideband.ts + flip CORE_MCP_URL to 3201 + delete v1, rename v2 → core-mcp-client.ts + Case-6b checkpoint
- [x] 04.5-04-PLAN.md — Wave 4 — Port 3200 deprecation observability (mcp_rest_request_seen log) + REQUIREMENTS.md AC-07 re-alignment + /opt/server-docs/hetzner-mcp-architecture.md update

## Follow-up (post-4.5, not part of this phase)
- Port 3200 REST facade removal — scheduled after 7-day observability window confirms zero `mcp_rest_request_seen` events (see 04.5-04-SUMMARY command).

**UI hint**: no
**Scope note**: Decision doc: `.planning/decisions/2026-04-20-mcp-universal-consolidation.md`. Non-goals: changes to outbound call path (Sipgate REST stays per REQ-SIP-02), changes to Bridge `/outbound` trigger (REST stays per REQ-INFRA-13), tool-surface expansion. Sequencing: Phase 4.5 is gated on Phase 0 (legal) **only if** iOS-Claude-App compatibility is a production requirement — otherwise can land independently.

### Phase 5: Case 2 — Restaurant Reservation Outbound
**Goal**: First counterpart-facing outbound. NanoBot places a call to a restaurant with Carsten's CLI, negotiates a reservation within a pre-configured tolerance window, detects voicemail silently (never leaves a message), handles "Sind Sie ein Bot?" truthfully, and produces calendar entry + Discord summary. VAD is calibrated against real German counterpart acoustic conditions.
**Depends on**: Phase 4 and Phase 0 (legal gate must be green before first real counterpart call)
**Requirements**: C2-01, C2-02, C2-03, C2-04, C2-05, C2-06, C2-07, C2-08, QUAL-01, QUAL-02
**Success Criteria** (what must be TRUE):
  1. A real PSTN outbound to a restaurant results in a reservation confirmed within Carsten's pre-configured tolerance (date, time ±tolerance, party size) and a matching calendar entry + Discord summary within 60 s of `BYE`; QUAL-01/02 gate: ≥ 3-turn test with P50/P95 measured over ≥ 10 turns
  2. A test outbound to a known voicemail-only number is detected by the first-turn voicemail-phrase gate ("Mailbox", "nach dem Signalton", "ist gerade nicht erreichbar"), the bot hangs up silently without speaking, and zero tokens are billed beyond the first 5 s
  3. A reservation offer outside tolerance is politely declined, the call terminated, and a Discord escalation is raised with the counterpart's offer so Carsten can decide next step
  4. The retry scheduler obeys the 5/15/45/120-min backoff + N-per-day cap; duplicate bookings are prevented by the idempotency key on `create_calendar_entry` (two tool invocations with identical args produce exactly one calendar entry)
  5. VAD is calibrated to threshold 0.55–0.60 with silence_duration 700 ms and a 250 ms min-utterance gate; a cough/"mhm"/door-slam fixture run shows false-barge-in rate < 5 %; the bot answers "Sind Sie ein Bot?" truthfully in German and continues the call
**Plans**: TBD
**UI hint**: no
**Scope note**: All `carsten_bot` scope but GATED ON PHASE 0 legal completion. First real external call = first §201 exposure. Must not ship before lawyer opinion lands.

### Phase 05.1: AMD persona handoff redesign and ASR upgrade (INSERTED)

**Goal:** Close the 4 open structural defects surfaced by Phase 05 Plan 03 Task 5 live verification (defects #3 ASR quality, #4 retry-args zod contract, #5 same-day-retry UNIQUE violation, #6 persona handoff broken) so that the Case-2 outbound flow is live-test-passable. Surgical patch phase — Wave 3 architecture (AMD classifier, persona content, VAD thresholds, pre-greet, outbound-router) stays intact.
**Requirements**: C2-01, C2-02, C2-03, C2-04, C2-05, C2-06, C2-07, QUAL-01 (Phase 05 requirement set; this phase patches the implementation of those same requirements)
**Depends on:** Phase 05
**Plans:** 4/5 plans executed
**Source-of-truth:** `.planning/phases/05-case-2-restaurant-reservation-outbound/05-03-TASK5-DEFECTS.md` (6-defect report; defects #1 and #2 already shipped in c69ded9/59d653a/4db252c/13e2e50)
**Success criteria**:
  1. Defect #6 fixed: After `amd_result=human`, bot opens with "NanoClaw im Auftrag von Carsten" (not restaurant-assistant helper-mode). Root cause was missing `type: 'realtime'` in `session.update` at voice-bridge/src/sideband.ts:619 — verifiable at trace v6-persona-swap-failed.jsonl line 27 (`missing_required_parameter: session.type`). Fix: add type field + defense-in-depth synthetic `conversation.item.create role=user` directive.
  2. Defect #3 fixed: `SESSION_CONFIG.audio.input.transcription.model` = `gpt-4o-mini-transcribe` (upgrade from `whisper-1`). German short-utterance ASR no longer renders as English/Swedish garbage at 8 kHz telephony bandwidth.
  3. Defect #4 fixed: `voice_case_2_schedule_retry` called with zod-valid args (`call_id`, `target_phone`, `calendar_date`, `prev_outcome` ∈ enum, `idempotency_key`) for all 4 AMD voicemail reason codes. Fail-fast warn-log if required casePayload fields are missing.
  4. Defect #5 fixed: Two distinct idempotency_keys for the same `(target_phone, calendar_date)` both INSERT with `attempt_no=1` and `2`. Replaces hardcoded `attempt_no=1` with transactional `SELECT COALESCE(MAX(attempt_no),0)+1; INSERT`.
  5. Live PSTN verification: 3 calls matching Plan 05-03 Task 5 matrix (happy human pickup, voicemail, busy/no-answer) pass with new traces in `task5-traces-rerun/`.
  6. Wave 3 behavior preserved: AMD classifier verdicts unchanged, §201 zero-audio-leak invariant holds (no `audio_transcript.delta` before `amd_result`), CASE2_OUTBOUND_PERSONA content unchanged (only invocation mechanism fixed).

Plans:
- [x] 05.1-01: Persona handoff fix (defect #6) — TDD — Wave 1
- [x] 05.1-02: ASR upgrade to gpt-4o-mini-transcribe (defect #3) — Wave 1
- [x] 05.1-03: onVoicemail retry args zod-contract fix (defect #4) — TDD — Wave 2 (depends on 05.1-01 for webhook.ts merge order)
- [x] 05.1-04: same-day retry attempt_no transactional fix (defect #5) — TDD — Wave 1
- [ ] 05.1-05: Live PSTN verification (autonomous: false) — Wave 3 (depends on 01/02/03/04)

### Phase 05.2: persona-redesign-and-call-flow-state-machine (INSERTED)

**Goal:** Refactor the voice persona architecture from 3 monolith per-case personas to a Baseline+Task-Overlay pattern (OpenAI Realtime Cookbook 8-section structure, single `session.update` per call). Fix three architectural issues surfaced by Phase 05.1 live verification that are NOT Phase 05.1 scope: (a) Case-1 OUTBOUND_PERSONA_TEMPLATE role-hallucination (missing role-lock clause), (b) silence-monitor premature re-prompt (state-machine bug: timer armed on caller VAD, not bot-audio-aware), (c) outbound bot-speaks-first (create_response:true). Aligns with Carsten's "skill-based, not timer-based" architectural steer. Research-driven — see `.planning/research/voice-persona-architecture.md`.
**Requirements**: VOICE-01..12 (call-flow behavior), C2-* (Case-2 functional requirements preserved via task-overlay), C6B-* (inbound Carsten path unchanged semantically)
**Depends on:** Phase 05.1 (code fixes shipped, live verification 05.1-05 deferred into THIS phase's verification step)
**Plans:** 4/6 plans executed
**Source-of-truth:** `.planning/research/voice-persona-architecture.md` (819 lines, OpenAI Cookbook + Pipecat/LiveKit/Vapi/Retell/ElevenLabs/Deepgram/Twilio survey) + `.planning/phases/05.2-persona-redesign-and-call-flow-state-machine/05.2-CONTEXT.md` (10 locked decisions D-1..D-10)
**Success criteria**:
  1. Baseline persona (~515 tokens) + Case-2 task-overlay (~200 tokens) replace OUTBOUND_PERSONA_TEMPLATE + buildCase2OutboundPersona; ~66% token reduction at 5 cases.
  2. Role-lock clause (D-9) present in baseline; role-hallucination ("bot plays both roles") no longer observed in live verification.
  3. silence-monitor armed on `output_audio_buffer.stopped` (bot finished) not caller `speech_stopped`; "Bist du noch da" no longer fires right after bot's own sentence.
  4. Outbound `turn_detection.create_response: false` + manual `response.create` — bot waits for counterpart speech; 3 re-prompt attempts ("Hallo, ist da jemand?") then apologetic Sie-form farewell.
  5. Inbound self-greet unchanged (1000ms setTimeout post-/accept), but nudge ladder now routed through the same Baseline logic.
  6. Combined Phase 05.1 + 05.2 live-verification: 3 PSTN scenarios (HAPPY / VOICEMAIL / BUSY-or-NO-ANSWER) pass with new traces. Replaces the deferred Phase 05.1-05 verification.

Plans:
- [x] 05.2-01-PLAN.md — Baseline persona + overlay framework (TDD, Wave 1)
- [x] 05.2-02-PLAN.md — silence-monitor state-machine rewire D-7 (TDD, Wave 1)
- [x] 05.2-03-PLAN.md — Outbound wait-for-speech + nudge ladder D-8 (TDD, Wave 2)
- [x] 05.2-04-PLAN.md — Case-2 task-overlay migration + Case-6b overlay extract (TDD, Wave 2)
- [ ] 05.2-05-PLAN.md — AMD→baseline handoff mechanics + Q7 atomicity probe (TDD, Wave 2)
- [ ] 05.2-06-PLAN.md — Combined Phase 05.1 + 05.2 live verification (autonomous: false, Wave 3)

### Phase 6: Case 3 — Medical/Hair Appointment Outbound
**Goal**: NanoBot places a medical/hair appointment call with practice profile loaded, remains passively on IVR hold-music without inference cost, cross-checks offered slots against Carsten's calendar with travel-buffer from home and Audi-Standort, selects minimum-disruption slot, protects authorized-data-only disclosure, and escalates cleanly if DTMF-IVR or online-portal-only is encountered.
**Depends on**: Phase 4 and Phase 0 (legal gate). Phase 5 recommended complete for AMD/voicemail infra reuse.
**Requirements**: C3-01, C3-02, C3-03, C3-04, C3-05, C3-06, C3-07, C3-08
**Success Criteria** (what must be TRUE):
  1. A real PSTN outbound to a medical practice or hair salon loads the per-practice profile (phone, patient_id, insurance_type, authorized_data_fields[]) from Core before `/accept`; offered slots are cross-checked against Carsten's calendar including travel-buffer from both home and Audi-Standort (via Google Maps multi-origin), and the minimum-calendar-disruption + shortest-travel-time slot is selected
  2. During IVR hold music, the bot remains passively without triggering `response.create` (hold-music auto-mute on response-unaware-chatter detector); when human speech resumes, the bot re-engages within one turn; total IVR hold cost per call stays < €0.10
  3. A counterpart request for data beyond the practice's authorized-fields list ("Geben Sie mir Ihre Krankenversicherungsnummer") receives "Das bespreche ich vor Ort" with no elaboration and no disclosure; transcript-arg post-call diff confirms no unauthorized fields were spoken
  4. On confirmation, a two-form readback of the date/time appears in transcript ("Am Dienstag, dem siebzehnten Mai — das ist der 17.5. — um 17 Uhr, also fünf Uhr nachmittags. Korrekt?") and `create_calendar_entry` writes an entry with practice, address, and both travel-buffers; the extended silence timer (15 s in Case 3) does not fire during counterpart thinking pauses
  5. If the IVR requires DTMF input OR the counterpart insists on online-portal booking, the bot acknowledges politely, terminates the call, and Discord-escalates with the portal URL or practice number for manual follow-up (DTMF navigation stays v2-deferred)
**Plans**: TBD
**UI hint**: no
**Scope note**: All `carsten_bot` scope. GATED ON PHASE 0. Research flags IVR hold-music detection as the most underspecified area — expect a `/gsd-research-phase` during planning for hold-music detection heuristic and Google Maps multi-origin API patterns.

### Phase 7: Case 4 — Inbound Negotiation
**Goal**: The hardest case. Whitelisted inbound callers enter Case 4 mode; the bot loads the relevant Core contract, runs live competitor research within 30 s, resists time-pressure tactics, never makes a verbindliche Vertragszusage, disables PII disclosure beyond the counterpart's authorized list, terminates on identity-unverifiable callers, and transfers control to Carsten's phone via SIP REFER on a hotword with a ≤ 500 ms round-trip.
**Depends on**: Phase 4 and Phase 0. Phases 5/6 recommended for outbound/AMD infra reuse and VAD calibration maturity.
**Requirements**: SIP-09, C4-01, C4-02, C4-03, C4-04, C4-05, C4-06, C4-07, C4-08, C4-09, C4-10, C4-11, TOOLS-08
**Success Criteria** (what must be TRUE):
  1. FreeSWITCH dialplan routes whitelisted inbound CLIs (Telekom/Vodafone/major-insurer list) to Case 4 mode; unclassified inbound (not Case-6, not whitelisted) receives SIP 603 and falls back to Sipgate voicemail; a mock-phishing inbound claiming whitelisted identity but with mismatched counterpart-data vs. Core contract repo is terminated without PII disclosure
  2. On accept, the relevant contract is loaded from Core before the first response turn; within 30 s of the first turn, a live `search_competitors` call returns at least one candidate offer; when the counterpart proposes a concrete offer, the bot references the current-contract + best-competitor comparison in the response
  3. Under deliberate time-pressure probing ("nur heute verfügbar"), the bot deploys the calm-deflection phrase bank ("Wenn das Angebot heute gut ist, ist es morgen auch gut") and NEVER emits a commitment verb outside the allowed list; a `verbindliche_vertragszusage` canary tool returns zero invocations across a 30-call red-team fixture
  4. On Carsten's takeover hotword (detected in the transcript stream), the Director Bridge invokes `transfer_call(target)` which sends FreeSWITCH SIP REFER to Carsten's target number with a round-trip to Carsten's phone ringing within 500 ms; the counterpart hears the bot's graceful handoff line before the transfer
  5. Every Case 4 call produces a structured negotiation-result document in Core within 60 s of `BYE` containing counterpart identity, offer, current-contract comparison, competitor comparison, and recommendation; 60-min session-expiry triggers a graceful wrap-up at 50 min
**Plans**: TBD
**UI hint**: no
**Scope note**: All `carsten_bot` scope. GATED ON PHASE 0. Highest-risk case — research flags phishing heuristics and SIP REFER target decision (Carsten's mobile vs. dedicated Sipgate extension) as likely `/gsd-research-phase` items during planning. Hotword choice is a Carsten decision pending at Q-Sprint.

## Progress

**Execution Order:**
Phases execute in numeric order: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Phase 0 and Phase 1 may run partly in parallel (legal evidence ≠ infra bring-up). Phase 5 is hard-gated on Phase 0 completion (first counterpart call).

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 0. Pre-Production Legal Gate | 0/TBD | Not started | - |
| 1. Infrastructure & Webhook Path | 0/TBD | Not started | - |
| 2. Director Bridge v0 + Hot-Path Safety | 11/11 | Complete   | 2026-04-18 |
| 3. Case 6 MVP — Carsten ↔ NanoClaw voice working | 11/11 | Complete   | 2026-04-18 |
| 4. Core Tool Integration + Cost/Observability | 0/5 | Planned | - |
| 4.5. MCP Universal Consolidation | 0/5 | Planned | - |
| 5. Case 2 — Restaurant Reservation Outbound | 0/TBD | Not started | - |
| 6. Case 3 — Medical/Hair Appointment Outbound | 0/TBD | Not started | - |
| 7. Case 4 — Inbound Negotiation | 0/TBD | Not started | - |

---

*Roadmap created: 2026-04-16*
*Derived from: .planning/PROJECT.md, .planning/REQUIREMENTS.md (v1: 101 requirements), .planning/research/SUMMARY.md (8-phase research recommendation)*
*Coverage: 101/101 v1 requirements mapped, zero orphans*
*Granularity: standard (8 phases)*
