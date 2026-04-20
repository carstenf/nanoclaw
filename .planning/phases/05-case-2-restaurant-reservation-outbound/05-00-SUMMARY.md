---
phase: 05
plan: 00
subsystem: case-2-restaurant-reservation-outbound
tags: [mcp, wave-0, empirical-spikes, amd, sipgate, mailbox, travel-buffer]
requires:
  - 05-CONTEXT.md (D-1 AMD, D-2 retry cap, D-5 trigger schema, D-6 trigger surface)
  - 05-RESEARCH.md §2-§4 (AMD approach, tolerance negotiation, TOOLS-07 gap)
provides:
  - SPIKE-A evidence + persona_override/tools_override production seam
  - SPIKE-B evidence — Sipgate has no sync 486 body; History API is the source of truth
  - SPIKE-C corpus — 12 German mailbox greetings + hardened CASE2_MAILBOX_CUE_REGEX_V2
  - SPIKE-D decision — travel-buffer deferred for Case-2 MVP (no source_address arg)
  - Production dispatch handler for amd_result as Bridge-internal (hangup on verdict)
affects:
  - 05-02 (Wave 2 — Sipgate History API poller instead of 486 parser; voice_start_case_2_call schema finalized without source_address)
  - 05-03 (Wave 3 — audio-event-driven AMD instead of timer-based; two-stage regex-then-duration gate; amd_result verdict differentiation human vs voicemail/silence)
  - 05-04 (Wave 4 — QUAL-01 matrix adjusts: no travel-buffer in calendar entry verification)
  - production voice-bridge outbound pipeline (override envelope stays — serves Wave 3 too)
gate-to-wave-1: green
---

# Phase 5 Wave 0 Summary — Empirical Spikes Closed

All four spikes (A/B/C/D) completed and committed. Two spikes moved on to shipping small pieces of production code that Wave 2/3 need anyway; two closed on desk research / decision. Three of the four produced findings that **change** the Wave 2/3 plan text — these must be respected by downstream executors.

## Spike results overview

| Spike | Title | Method | Verdict | Carryforward |
|-------|-------|--------|---------|--------------|
| A | OpenAI Realtime function-call-first | 2 live PSTN calls | `partial` | Wave 3 AMD must gate on audio events, not model timer |
| B | Sipgate 486 body shape | 3 live Sipgate originate attempts | `no-486-exists` | Wave 2 must use Sipgate History API polling, not originate-body parsing |
| C | German mailbox greeting corpus | desk research (12 samples) | `regex-hardened` | Wave 3 uses extended regex + two-stage AMD pattern |
| D | Travel-buffer source address | decision analysis | `defer-travel-buffer` | Wave 2 schema omits `source_address`; Case-2 MVP no travel-buffer |

Each spike produced a `.md` under `spike-results/` with frontmatter `verdict`, evidence, and carryforward section.

## Commits (Wave 0 total: 8)

1. `59f60f8` — feat(05): add persona_override + tools_override to outbound pipeline (Path A seam)
2. `80ee673` — feat(05-00): spike-a AMD classifier script (throwaway)
3. `809e299` — docs(05-00): spike-a runbook
4. `a40dc64` — fix(05-00): handle amd_result as bridge-internal tool
5. `717264f` — docs(05-00): Spike-A complete — verdict=partial
6. `5647c92` — docs(05-00): Spike-B — no sync 486; Wave 2 redesign
7. `fddfe92` — docs(05-00): Spikes C + D — regex hardened, travel-buffer deferred
8. (this summary commit)

## Production code surviving Wave 0

- `voice-bridge/src/outbound-router.ts` — `OutboundTask` grew `persona_override?: string` + `tools_override?: ToolSpec[]`
- `voice-bridge/src/outbound-webhook.ts` — zod schema extended + tool-name regex validation
- `voice-bridge/src/webhook.ts` — `/accept` handler uses override when present
- `voice-bridge/src/sideband.ts` + `call-router.ts` — sideband trace emission for override-tasks
- `voice-bridge/src/tools/dispatch.ts` — `amd_result` handled as Bridge-internal (currently hangs up on ALL verdicts — Wave 3 refines)
- `voice-bridge/scripts/spike-a-amd-classifier.ts` — throwaway script, kept in repo for reference

Tests added for the override envelope: 311 passing (6 new coverage — persona_override, tools_override, regex-validation at zod boundary).

## Material changes vs. Plan 05-00 text

| Original plan text | Revision after Wave 0 |
|---|---|
| "Spike-B captures 486 body → Wave 2 parses it" | Wave 2 uses History API polling; no 486 parser needed |
| "AMD hybrid: timer-based classifier emits amd_result after 3s" | AMD must be audio-event-driven; classifier gated on `input_audio_buffer.speech_started` |
| "Simple source_address config or per-call arg for travel-buffer" | Defer entirely; MVP calendar entry has no travel-buffer |
| "amd_result dispatch triggers hangup on verdict" | Wave 3 must differentiate: human → persona swap + continue; voicemail/silence → hangup |

Wave 1/2/3 planners/executors MUST read the SPIKE files before starting — the PLAN files pre-date these findings.

## Gate to Wave 1

**Status: green.** Wave 0 evidence is sufficient for Wave 1 (SEED-001 voice_notify_user migration) and Wave 2 (orchestrator + DB) to proceed. Wave 3 (AMD + persona) has clear carryforward directives. No re-planning of the overall phase is needed — just local adjustments inside Wave 2 Task 4 (Sipgate-poller-not-486-parser) and Wave 3 Task 1/3 (audio-event-driven AMD + verdict-differentiated hangup).

## Self-Check: PASSED

- [x] All four spikes have SPIKE-X md files with `verdict:` frontmatter field
- [x] Spike-A: verdict=partial, 2 trials (sufficient — further trials would not yield new data)
- [x] Spike-B: verdict=no-486-exists, 3 call scenarios covered
- [x] Spike-C: 12 greetings corpus, extended regex covers 12/12, two-stage AMD documented
- [x] Spike-D: travel-buffer deferred decision with rationale
- [x] Audio compliance: `scripts/audit-audio.sh` PASS across all 3 search paths
- [x] No STATE.md / ROADMAP.md modifications from this wave
- [x] All commits pushed to origin/main
