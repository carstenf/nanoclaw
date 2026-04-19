---
phase: 02-director-bridge-v0-hotpath-safety
plan: 14
subsystem: voice-bridge
tags: [persona, filler-inject, case6b, dispatch, webhook]
dependency_graph:
  requires: [02-11, 02-12, 03-10]
  provides: [case6b-persona, filler-phrase-injection]
  affects: [voice-bridge/src/persona.ts, voice-bridge/src/tools/filler-inject.ts, voice-bridge/src/tools/dispatch.ts, voice-bridge/src/webhook.ts, voice-bridge/src/config.ts]
tech_stack:
  added: [filler-inject.ts module]
  patterns: [DI-optional emitFiller in DispatchOpts, FILLER_MESSAGES Map, env-driven FILLER_PHRASE_TOOLS]
key_files:
  created:
    - voice-bridge/src/tools/filler-inject.ts
    - voice-bridge/tests/filler-inject.test.ts
  modified:
    - voice-bridge/src/persona.ts
    - voice-bridge/tests/persona.test.ts
    - voice-bridge/src/tools/dispatch.ts
    - voice-bridge/tests/dispatch.test.ts
    - voice-bridge/src/webhook.ts
    - voice-bridge/tests/accept.test.ts
    - voice-bridge/src/config.ts
decisions:
  - "CASE6B_PERSONA uses ASCII umlauts (Gedaechtnis, etc.) per Plan truths[8] strict template — do not normalize to Unicode without Chat approval"
  - "emitFiller is awaited before callCoreTool so filler is on wire before 90s container wait starts, but emitFiller failure does not block dispatch"
  - "accept.test.ts persona assertion updated from PHASE2 marker to CASE6B marker — caller +491708036426 now correctly routes to case6b"
metrics:
  duration: ~20min
  completed: 2026-04-18
  tasks_completed: 4
  files_changed: 9
---

# Phase 02 Plan 14: Case-6b Persona-Split + Filler-Phrase-Injection Summary

**One-liner:** CASE6B_PERSONA for Carsten's CLI + code-side 'Moment, ich frage Andy...' filler via emitFillerPhrase before ask_core dispatch.

## Commits

| Hash | Message |
|------|---------|
| 14ce757 | feat(02-14): add CASE6B_PERSONA constant for Carsten CLI calls |
| d0bdc9a | feat(02-14): add filler-inject.ts — code-side filler-phrase emission for ask_core |
| a6af659 | feat(02-14): wire persona-selection in webhook.ts + filler in dispatch.ts |
| c5efd5e | feat(02-14): add CARSTEN_CLI_NUMBER + FILLER_PHRASE_TOOLS env-consts to config.ts |

## Bridge Health Post-Deploy

- Service: `active (running)` after `systemctl --user restart voice-bridge`
- `/health`: 200 OK, `secret_loaded: true`
- Tools count: 11 (confirmed via accept.test.ts `session.tools.length === 11`, unchanged)
- Startup log: `bridge_listening host=10.0.0.2 port=4402`, no errors
- `persona_selected: case6b` visible in test log output for caller +491708036426

## Test Results

| Phase | Count |
|-------|-------|
| Baseline (pre-02-14) | 166 passed + 1 skipped |
| Post-02-14 | **179 passed + 1 skipped** |
| New tests added | +13 |
| Newly failing | 0 |

New tests by file:
- `persona.test.ts`: +6 (CASE6B_PERSONA content checks)
- `filler-inject.test.ts`: +5 (happy path, unknown tool, ws throws, empty name, sequence order)
- `dispatch.test.ts`: +2 (ask_core triggers emitFiller, check_calendar does not)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] accept.test.ts persona assertion updated for case6b**
- **Found during:** Task 03 GREEN phase
- **Issue:** Existing test `passes full SESSION_CONFIG + PHASE2_PERSONA` used caller `+491708036426` (= CARSTEN_CLI_NUMBER) and expected `aus dem Gedächtnis` (PHASE2_PERSONA substring). After 02-14, that caller now correctly gets CASE6B_PERSONA (which uses ASCII `Gedaechtnis`).
- **Fix:** Updated test description + assertion to check for `Carsten` and `ask_core` (CASE6B_PERSONA markers).
- **Files modified:** `voice-bridge/tests/accept.test.ts`
- **Commit:** a6af659

## Caveats

- **PSTN validation pending:** `persona_selected: case6b` is visible in unit-test log output but not yet confirmed via a real PSTN call from Carsten's CLI. First real call will produce the audit log entry.
- **Filler is UX-bridge not architecture:** emitFillerPhrase fires before callCoreTool but if ws.send fails, the bridge continues silently (warn-log only). Worst-case: user hears silence during 90s container cold-start — same as pre-02-14.
- **CASE6B_PERSONA uses ASCII umlauts** per Plan truths[8] strict template. This is intentional — TTS renders them identically to Unicode umlauts.
- **FILLER_PHRASE_TOOLS hard-coded to ask_core (v1):** Extensible via env var or by adding entries to FILLER_MESSAGES Map in filler-inject.ts.

## Next Step

Plan 03-11: `request_outbound_call` — direction B (Bridge initiates outbound call via OpenAI Realtime).

## Self-Check: PASSED

- voice-bridge/src/persona.ts — FOUND (CASE6B_PERSONA exported)
- voice-bridge/src/tools/filler-inject.ts — FOUND (emitFillerPhrase, 'Moment, ich frage Andy...')
- voice-bridge/src/tools/dispatch.ts — FOUND (emitFiller wired, FILLER_PHRASE_TOOLS import)
- voice-bridge/src/webhook.ts — FOUND (CARSTEN_CLI_NUMBER check, persona_selected log)
- voice-bridge/src/config.ts — FOUND (CARSTEN_CLI_NUMBER, FILLER_PHRASE_TOOLS)
- Commits: 14ce757, d0bdc9a, a6af659, c5efd5e — all in git log
- Tests: 179 passed, 0 failing
- Service: active (running)
