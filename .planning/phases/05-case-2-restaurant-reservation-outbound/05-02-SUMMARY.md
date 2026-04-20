---
phase: "05"
plan: "02"
subsystem: "case-2-orchestration"
tags: [case-2, restaurant, outbound, retry-ladder, active-session-tracker, tdd]
dependency_graph:
  requires: [05-01]
  provides: [voice_start_case_2_call, voice_case_2_schedule_retry, sipgate-error-parser, active-session-tracker-wiring]
  affects: [src/db.ts, src/config.ts, src/index.ts, src/mcp-tools/index.ts, voice-bridge/src/outbound-router.ts, voice-bridge/src/outbound-webhook.ts, voice-bridge/src/sipgate-rest-client.ts]
tech_stack:
  added: [crypto.createHash sha256 for D-7 idempotency]
  patterns: [DI factory makeXxx(deps), TDD RED/GREEN per task, INSERT OR FAIL collision retry]
key_files:
  created:
    - src/mcp-tools/voice-start-case-2-call.ts
    - src/mcp-tools/voice-case-2-retry.ts
    - src/channels/active-session-tracker.ts
    - src/index.test.ts
  modified:
    - src/db.ts
    - src/cost-ledger.ts
    - src/config.ts
    - src/mcp-tools/index.ts
    - src/index.ts
    - voice-bridge/src/outbound-router.ts
    - voice-bridge/src/outbound-webhook.ts
    - voice-bridge/src/sipgate-rest-client.ts
decisions:
  - "D-7 idempotency key: sha256(phone|date|time|party_size) WITHOUT call_id — revised 2026-04-20 to avoid call_id unavailability"
  - "Spike-B fallback: no Sipgate 486 body exists; all originate failures treated as retryable (Research §4.4)"
  - "INSERT OR FAIL with up-to-10 PK collision retries for Pitfall-7 race protection"
  - "Active-session-tracker DI-injected so voice_notify_user routing is testable without index.ts boot"
metrics:
  duration: "~3.5 hours"
  completed: "2026-04-20"
  tasks_completed: 5
  files_modified: 12
---

# Phase 05 Plan 02: Case-2 Orchestration Layer Summary

Case-2 restaurant reservation outbound: full orchestration layer — DB schema, two new Core MCP tools (voice_start_case_2_call + voice_case_2_schedule_retry), OutboundTask case_type extension, Sipgate error parser redesign, and active-session-tracker wired into the inbound message loop.

## Tasks Completed

| # | Task | Commit (RED) | Commit (GREEN) | Files |
|---|------|--------------|----------------|-------|
| 1 | DB schema + OutboundTask case_type | 132d7b4 | 851dc61 | src/db.ts, src/cost-ledger.ts, src/config.ts, voice-bridge/src/outbound-router.ts, voice-bridge/src/outbound-webhook.ts |
| 2 | voice_case_2_schedule_retry | c6c14e2 | 7af28fd | src/mcp-tools/voice-case-2-retry.ts |
| 3 | voice_start_case_2_call | 35d56da | 5bfee7b | src/mcp-tools/voice-start-case-2-call.ts |
| 4 | Sipgate error parser (Spike-B) | bc7c2f2 | 08afdc3 | voice-bridge/src/sipgate-rest-client.ts |
| 5 | active-session-tracker wiring | 5c638ff | 298b32f | src/index.ts, src/mcp-tools/index.ts, src/index.test.ts |

## Decisions Made

**D-7 Idempotency key design (revised 2026-04-20):** sha256(restaurant_phone|requested_date|requested_time|party_size) without call_id. Original design included call_id but this was dropped because call_id is unavailable at the point the MCP tool is invoked by the assistant.

**Spike-B Sipgate 486 redesign:** The spike established that Sipgate's SIP 486 (line busy) is a SIP-layer response not surfaced in the REST API. The sipgate-rest-client was extended with SipgateRestErrorDetails and parseSipgateErrorDetails(), but the Research §4.4 fallback applies: all non-2xx originate errors → retryable:true. The lineBusy field is reserved for future detection if Sipgate adds body content.

**INSERT OR FAIL collision retry:** voice_case_2_schedule_retry uses INSERT OR FAIL (not INSERT OR IGNORE) so unique constraint violations are detected. Up to 10 attempt_no increments are tried to avoid race-condition data loss (Pitfall-7).

**activeSessionTracker DI injection:** The tracker is instantiated in main() and passed into buildDefaultRegistry via the RegistryDeps interface, making voice_notify_user routing testable in isolation without spinning up index.ts.

## Test Results

Core (npm test):
- 641 passed, 1 pre-existing failure (gmail.test.ts unrelated to Plan 05-02)
- All new plan tests: 14 (voice-case-2-retry) + 14 (voice-start-case-2-call) + 5 (index.test.ts tracker contract) = 33 new tests — all pass

Voice-bridge (cd voice-bridge && npm test):
- 320 passed, 4 skipped — all pass

TypeScript build: clean (npm run build exits 0)

Bridge allowlist count: 15 entries — REQ-TOOLS-09 satisfied (no new bridge tools added in this plan)

## Deviations from Plan

**1. [Rule 1 - Bug] Fixed `z.record()` wrong arity in outbound-webhook.ts**
- Found during: Task 1
- Issue: `z.record(z.unknown())` is not valid in Zod v3 — requires 2 args
- Fix: Changed to `z.record(z.string(), z.unknown())`
- Files modified: voice-bridge/src/outbound-webhook.ts
- Commit: 851dc61

**2. [Rule 1 - Bug] Fixed `require()` in ESM test file (db.test.ts)**
- Found during: Task 1
- Issue: db.test.ts initially used `require('./db.js')` which is invalid in the project's ESM setup
- Fix: Used the existing `getDatabase` import directly (already imported in the file)
- Files modified: src/db.test.ts
- Commit: 132d7b4

**3. [Spike-B redesign] Sipgate 486 parser approach changed**
- Spike-B established no 486 body exists in Sipgate REST responses
- Original plan called for body-based line_busy detection
- Actual implementation: all originate errors → retryable:true (Research §4.4 fallback), lineBusy field reserved
- This is expected behavior documented in Spike-B SUMMARY

## Known Stubs

None — all routing logic is fully wired with live data paths.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: input-validation | src/mcp-tools/voice-start-case-2-call.ts | E.164 phone validation present via z.regex; restaurant_phone and target_jid validated. No additional surface. |

(No new network endpoints or auth paths introduced — voice_start_case_2_call delegates to the existing bridge REST endpoint via bridgeUrl dep.)

## Self-Check: PASSED

- src/mcp-tools/voice-start-case-2-call.ts: FOUND
- src/mcp-tools/voice-case-2-retry.ts: FOUND
- src/index.test.ts: FOUND
- Commit 298b32f: FOUND (git log confirms)
- Commit 5bfee7b: FOUND
- Commit 7af28fd: FOUND
- Commit 08afdc3: FOUND
- Commit 851dc61: FOUND
- npm run build: PASS (0 errors)
- npm test (core): 641 pass
- voice-bridge npm test: 320 pass
