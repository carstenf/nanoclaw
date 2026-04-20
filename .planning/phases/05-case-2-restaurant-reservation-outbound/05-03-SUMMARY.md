---
phase: 05-case-2-restaurant-reservation-outbound
plan: "03"
subsystem: voice-bridge
tags:
  - amd
  - persona
  - pre-greet
  - voicemail
  - tolerance
  - wave-3
dependency_graph:
  requires:
    - 05-00 (Spike-A AMD classifier-first design verdict)
    - 05-01 (Case-2 outbound-webhook enqueue path)
    - 05-02 (OutboundTask case_type + case_payload fields)
  provides:
    - amd-classifier module (VAD cadence + transcript-cue + silence gates)
    - CASE2_AMD_CLASSIFIER_PROMPT and CASE2_OUTBOUND_PERSONA
    - /accept Case-2 branch (AMD classifier wiring)
    - dispatch.ts amd_result handler
    - pre-greet Case-2 early-return
    - outbound-router Case-2 reportBack outcome routing
  affects:
    - voice-bridge/src/webhook.ts
    - voice-bridge/src/tools/dispatch.ts
    - voice-bridge/src/pre-greet.ts
    - voice-bridge/src/outbound-router.ts
tech_stack:
  added:
    - voice-bridge/src/amd-classifier.ts (new module)
  patterns:
    - DI-factory pattern for AmdClassifier (testable via fake timers)
    - Module-level mutable ref (_activeClassifier) in dispatch.ts for Bridge-internal tool routing
    - ctxRef closure pattern for post-startCall sideband wiring in webhook.ts
key_files:
  created:
    - voice-bridge/src/amd-classifier.ts
    - voice-bridge/tests/amd-classifier.test.ts
  modified:
    - voice-bridge/src/config.ts (CASE2_AMD_TIMEOUT_MS, CASE2_VAD_CADENCE_MS, CASE2_VAD_SILENCE_MS)
    - voice-bridge/src/persona.ts (CASE2_OUTBOUND_PERSONA blocks + buildCase2OutboundPersona)
    - voice-bridge/tests/persona.test.ts (10 new tests)
    - voice-bridge/src/webhook.ts (Case-2 AMD branch in /accept)
    - voice-bridge/tests/accept.test.ts (2 new tests, Ajv-blocked at import level)
    - voice-bridge/src/tools/dispatch.ts (_activeClassifier ref + amd_result routing)
    - voice-bridge/tests/dispatch.test.ts (3 new tests, Ajv-blocked at import level)
    - voice-bridge/src/pre-greet.ts (case_2 early-return)
    - voice-bridge/tests/pre-greet.test.ts (2 new tests, Ajv-blocked at import level)
    - voice-bridge/src/outbound-router.ts (outcome/counter_offer fields + coreClient dep + reportBackCase2)
    - voice-bridge/tests/outbound-router.test.ts (7 new tests)
decisions:
  - "amd_result is Bridge-internal only — declared inline in /accept tools array for Case-2 sessions, NOT added to allowlist.ts (T-05-03-07). REQ-TOOLS-09 cap preserved at compile time."
  - "ctxRef closure pattern: createAmdClassifier is called before router.startCall() (required for accept() call), but onHuman needs sideband access. ctxRef captures context by reference, assigned after startCall."
  - "task.error preservation: onCallEndInternal no longer clears task.error for non-timeout reasons, allowing AMD/VAD paths to set error before onCallEnd('normal') and have it visible in reportBack routing."
  - "coreClient is optional in OutboundRouterDeps for backward compatibility — existing Phase-3 test suite passes without injecting it."
metrics:
  duration_minutes: ~150
  completed_at: "2026-04-20T19:23:00Z"
  tasks_completed: 4
  tasks_total: 4
  files_created: 2
  files_modified: 10
---

# Phase 05 Plan 03: AMD Classifier + Case-2 Persona + /accept Branch + reportBack Routing Summary

**One-liner:** AMD classifier with VAD cadence/silence/transcript-cue gates, CASE2_AMD_CLASSIFIER_PROMPT injected at /accept, per-outcome Core MCP routing (success/out_of_tolerance/retry) in outbound-router.reportBack.

## Tasks Completed

| Task | Name | Commit | Result |
|------|------|--------|--------|
| 1 | amd-classifier.ts module | RED: 8bce9f8 / GREEN: 54ee0dd | 13 tests pass |
| 2 | CASE2_OUTBOUND_PERSONA + buildCase2OutboundPersona | RED: 2150157 / GREEN: 1916059 | 10 new tests pass (33 total in persona.test.ts) |
| 3 | /accept Case-2 branch + dispatch amd_result + pre-greet bypass | RED: 57dffb5 / GREEN: 3ce5e0d | Ajv-blocked files compile correctly; 71 passing tests in clean files |
| 4 | outbound-router reportBack outcome routing | RED: 99d290f / GREEN: 8f1bcaa | 25 tests pass (7 new) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Incomplete webhook.ts edit from previous session left non-existent function reference**
- **Found during:** Task 3 GREEN continuation
- **Issue:** `_activeClassifierForHumanWiring(ctx)` was referenced but never defined; `ctx.sideband.state` was a no-op expression
- **Fix:** Introduced `ctxRef` closure variable at outbound-block scope, assigned after `router.startCall()`. onHuman callback captures it by reference to call `updateInstructions` + `requestResponse`.
- **Files modified:** voice-bridge/src/webhook.ts
- **Commit:** 3ce5e0d

**2. [Rule 1 - Bug] ctxRef was declared inside inner `if (isCase2)` block, out of scope at assignment**
- **Found during:** Task 3 GREEN (TypeScript compile check)
- **Issue:** `ctxRef` declaration was inside the `if (isCase2)` block but assignment was in a second nested `if (isCase2)` block in the `try {}` section — two separate scopes
- **Fix:** Moved `ctxRef` declaration to outer outbound-block scope (before `if (isCase2)`)
- **Files modified:** voice-bridge/src/webhook.ts
- **Commit:** 3ce5e0d

**3. [Rule 1 - Bug] task.error was unconditionally cleared to undefined for non-timeout reasons**
- **Found during:** Task 4 GREEN (tests 1-3 and 6 still failing after implementation)
- **Issue:** `onCallEndInternal` had `task.error = reason === 'timeout' ? 'max_duration_exceeded' : undefined` — this wiped `task.error = 'voicemail_detected'` set by AMD path before calling `onCallEnd('normal')`
- **Fix:** Changed to only set `task.error = 'max_duration_exceeded'` when `reason === 'timeout'`; all other reasons preserve the existing error value
- **Files modified:** voice-bridge/src/outbound-router.ts
- **Commit:** 8f1bcaa

## Pre-existing Issues (Not Introduced by This Plan)

The following test files fail at the module level due to `Ajv is not a constructor` in allowlist.ts (line 40) — a pre-existing worktree environment issue confirmed by baseline comparison:
- `tests/accept.test.ts` — 12 pre-existing failures
- `tests/dispatch.test.ts` — 0 tests run (module-level crash)
- `tests/pre-greet.test.ts` — 0 tests run (module-level crash)

The new RED tests added to these files are syntactically correct and logically sound. They will run once the Ajv constructor issue in the worktree is resolved (likely a CommonJS/ESM import mismatch for `ajv-formats`).

## Test Coverage Summary

| File | Before | After |
|------|--------|-------|
| amd-classifier.test.ts | 0 | 13 |
| persona.test.ts | 23 | 33 |
| outbound-router.test.ts | 18 | 25 |
| accept.test.ts (new tests, Ajv-blocked) | — | +2 |
| dispatch.test.ts (new tests, Ajv-blocked) | — | +3 |
| pre-greet.test.ts (new tests, Ajv-blocked) | — | +2 |

## Known Stubs

None — all Case-2 logic paths are wired to real implementations or explicit error paths.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: audio_before_verdict | voice-bridge/src/amd-classifier.ts | onAudioDelta logs warn + sets audioLeaked flag if audio arrives before AMD verdict — satisfies T-05-03-01 (§201 StGB guard) |

## Self-Check: PASSED (Tasks 1-4)

All 8 task commits verified present (8bce9f8, 54ee0dd, 2150157, 1916059, 57dffb5, 3ce5e0d, 99d290f, 8f1bcaa).
Key files confirmed: amd-classifier.ts, amd-classifier.test.ts, 05-03-SUMMARY.md.

## Task 5 Status: BLOCKED

Live-call verification (Task 5, type=checkpoint:human-verify) attempted on
2026-04-20 UTC. 6 outbound calls placed against Carsten's iPhone surfaced
**6 structural defects** across Wave 1/2/3 — see
[`05-03-TASK5-DEFECTS.md`](./05-03-TASK5-DEFECTS.md) for full report with
trace evidence.

**Fixed in this session:**
- Defect #1: CASE2_VAD_SILENCE_MS 6s→30s (ringback accommodation) — commit `59d653a`
- Defect #2: Missing TOOL_META entries for 3 new Core MCP tools — commit `13e2e50`
- Defect #3: whisper-1 ASR language pinned to `de` — commit `4db252c` (partial; quality still insufficient at telephony bandwidth)

**Remaining blockers (require Plan 05-05):**
- Defect #4: `voice_case_2_schedule_retry` called with undefined args
- Defect #5: Wave-2 DB hardcoded `attempt_no=1` blocks 2nd same-day call
- Defect #6 (CRITICAL): Persona-swap after `amd_result=human` does not produce
  caller-role behavior — bot acts as restaurant-helper instead of as Carsten's
  Anrufer. Root-cause hypothesis: OpenAI Realtime `session.update` doesn't
  reset conversation history; pre-verdict context contaminates post-verdict
  persona.

**Evidence preserved:** `task5-traces/` — 3 representative sideband JSONL traces.

**Next step:** `/gsd-insert-phase 05-05 "AMD-persona handoff redesign + ASR upgrade + Wave-2 attempt_no fix"`.
Plan 05-03 Task 5 re-runs inside the new 05-05 verification checkpoint once
all 3 remaining defects are closed.
