---
phase: 04-core-tool-integration-cost-observability
plan: 02
subsystem: cost
tags: [cost, enforcement, idempotency, a12, cost-01, cost-02, cost-03, cost-04]

# Dependency graph
requires:
  - phase: 04-core-tool-integration-cost-observability
    plan: 01
    provides: "cost-ledger skeleton — voice_call_costs / voice_turn_costs / voice_price_snapshots tables, insertTurnCost/upsertCallCost/sumCostCurrentDay/sumCostCurrentMonth accessors, accumulator.ts + prices.ts Bridge modules, voice.record_turn_cost + voice.finalize_call_cost MCP tools"
  - phase: 02-director-bridge-v0-hotpath-safety
    provides: "idempotency.ts invokeIdempotent / clearCall / makeKey, sideband.ts updateInstructions(tools-strip), alerts.ts sendDiscordAlert"
  - phase: 03-voice-mcp-endpoint
    provides: "voice-bridge/src/tools/dispatch.ts async MCP-forward, allowlist.ts ToolEntry with mutating flag, core-mcp-client.ts callCoreTool"
provides:
  - "A12 closed: dispatch.ts routes mutating tools through invokeIdempotent (create/update/delete_calendar_entry, send_discord_message, schedule_retry, transfer_call, confirm_action, request_outbound_call, end_call). Read-only tools bypass."
  - "voice-bridge/src/cost/gate.ts checkCostCaps() — /accept-time gate with CAP_PER_CALL_EUR=1.00, CAP_DAILY_EUR=3.00, CAP_MONTHLY_EUR=25.00, SOFT_WARN_FRACTION=0.80 locked. Fail-open on Core outage."
  - "voice.get_day_month_cost_sum MCP tool (COST-02 gate read path) + voice.reset_monthly_cap MCP tool (COST-03 manual override)."
  - "sideband.ts response.done → accumulator.add + voice.record_turn_cost fire-and-forget + 80% Discord soft-warn (once) + 100% hard-stop (updateInstructions + response.create + 4s hold + ws.close(1000)) + voice.finalize_call_cost."
  - "sideband.ts session.closed/terminated → voice.finalize_call_cost (if not already enforced) + accumulator.clearCall."
  - "webhook.ts /accept → checkCostCaps → SIP 503 via openai.realtime.calls.reject for all three rejection decisions."
  - "Core-side auto-suspend in voice.finalize_call_cost: after upsert, if sumCostCurrentMonth >= €25 → setRouterState('voice_channel_suspended','1'). Atomic with finalize write (variant b, A12 surface tight — no new voice.set_suspend tool)."
affects:
  - "04-03 StreamableHTTP (voice.get_day_month_cost_sum + voice.reset_monthly_cap join the same ToolRegistry, auto-surface via StreamableHTTPServerTransport when plan lands)"
  - "04-04 recon-invoice (reads voice_call_costs SUM, auto-suspend flag from monthly_cap_auto_suspend JSONL rows)"

# Tech tracking
tech-stack:
  added: []  # No new dependencies. All reuse existing zod, better-sqlite3, vitest, pino, ws, fastify.
  patterns:
    - "Idempotency gate on mutating tools: entry.mutating → invokeIdempotent(callId, turnId, toolName, args, invoke, log); read-only tools bare callCore (A12 closed)"
    - "Single-threaded check-and-mark guard flags (Pitfall 2): accumulator.warned() / markWarned() and enforced() / markEnforced() atomic within one tick — no concurrent response.done can double-fire"
    - "AC-04/AC-05-compliant hard-stop: reuses Phase-2 updateInstructions wrapper (strips any `tools` key and logs BUG-level if present). NO new session.update send-path that could leak tools mid-call."
    - "Fail-open cost gate on Core outage: single-user host, blocking all calls during a Core glitch is a worse failure mode than temporarily bypassing the daily/monthly cap. JSONL is audit trail of last resort."
    - "Farewell TTS hold: 4000ms between response.create and ws.close(1000) so the last syllable isn't clipped (T-04-02-04 mitigation)."
    - "Core-side auto-suspend variant (b, locked per WARNING-2): SUM + setRouterState inside voice.finalize_call_cost keeps suspension write atomic with upsert write — no surface expansion (A12 tight)."
    - "DI injection of cost accumulator / callCoreTool / sendDiscordAlert into SidebandOpenOpts — tests assert behaviour with zero real IO; production defaults to real modules."

key-files:
  created:
    - src/mcp-tools/voice-get-day-month-cost-sum.ts
    - src/mcp-tools/voice-get-day-month-cost-sum.test.ts
    - src/mcp-tools/voice-reset-monthly-cap.ts
    - src/mcp-tools/voice-reset-monthly-cap.test.ts
    - voice-bridge/src/cost/gate.ts
    - voice-bridge/src/cost/gate.test.ts
    - .planning/phases/04-core-tool-integration-cost-observability/deferred-items.md
  modified:
    - voice-bridge/src/tools/dispatch.ts
    - voice-bridge/tests/dispatch.test.ts
    - voice-bridge/src/sideband.ts
    - voice-bridge/tests/sideband.test.ts
    - voice-bridge/src/webhook.ts
    - voice-bridge/tests/accept.test.ts
    - src/mcp-tools/voice-finalize-call-cost.ts  # Core-side auto-suspend ADDENDUM (variant b)
    - src/mcp-tools/index.ts  # +2 Core MCP tool registrations + wire auto-suspend deps into finalize

key-decisions:
  - "Variant (b) locked for monthly auto-suspend: Core-side in voice.finalize_call_cost (atomic with upsert). Rejected variant (a) — new voice.set_suspend MCP tool — keeps A12 surface tight."
  - "Fail-open on Core MCP unreachable at gate-time: single-user host, availability trumps enforcement. Logged as cost_gate_core_unreachable WARN for visibility."
  - "response.done with no usage block is silently ignored: avoids 0-cost ledger noise + keeps existing sideband tests green without forcing every test to inject a callCoreTool mock."
  - "DI for cost hooks on SidebandOpenOpts (costAccumulator, callCoreTool, sendDiscordAlert, capPerCallEur, softWarnFraction, farewellTtsHoldMs, setTimeoutFn, caseType) — tests run in 0.4s with zero real IO; production leaves all unset."
  - "vi.resetModules() in gate-test beforeEach: necessary because CORE_MCP_URL is module-scoped const captured at import, and the test needs a per-case fetch stub wired to a real URL."
  - "FAREWELL_INSTR text matches the plan draft verbatim: \"Dein Zeitbudget für dieses Gespräch ist aufgebraucht. Verabschiede dich jetzt höflich mit einem einzigen Satz, z.B. 'Vielen Dank, ich melde mich später erneut. Auf Wiederhören.' und sage danach nichts mehr.\""

patterns-established:
  - "Cost-enforcement hooks as opts DI — future modules (future mid-call rules, price-drift auto-actions) can swap the accumulator/transport without touching sideband.ts lifecycle."
  - "Reject-with-status-503 via openai.realtime.calls.reject(callId, {status_code: 503}) — matches Phase-1 reject(486) pattern, uses the OpenAI SDK refuse endpoint (not raw HTTP 503 — that's Fastify reply, which OpenAI never reads)."
  - "JSONL auto-suspend audit row: monthly_cap_auto_suspend entry in voice-cost.jsonl with month_eur + cap_eur — gives recon-invoice (Plan 04-04) a single-source timeline of suspensions."

requirements-completed: [COST-01, COST-02, COST-03, COST-04]

# Metrics
duration: 15min
completed: 2026-04-19
---

# Phase 4 Plan 02: Cost Enforcement Live + A12 Closure Summary

**Cost-enforcement cascade wired end-to-end: per-call €1 hard-stop via instructions-only farewell, daily €3 + monthly €25 SIP 503 at /accept, Core-side auto-suspend on monthly breach, A12 idempotency gap in dispatch.ts closed.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-19T15:13:58Z
- **Completed:** 2026-04-19T15:28:00Z
- **Tasks:** 3 (all TDD auto, RED → GREEN → commit)
- **Files created:** 7 (3 production + 3 tests + 1 deferred-items log)
- **Files modified:** 8

## Accomplishments

- **A12 closed (Task 1):** `voice-bridge/src/tools/dispatch.ts` now routes mutating tools through `invokeIdempotent(callId, turnId, toolName, args, invoke, log)` and read-only tools bypass. The allowlist already carried `mutating: boolean` per entry — no allowlist surgery needed. MOE-6 risk mitigated: identical create/update/delete tool calls inside the same (call_id, turn_id) only hit Core once, even if the Realtime model re-emits the function-call frame. 3 new dispatch tests prove both branches.
- **Core MCP read + reset tools (Task 2):** `voice.get_day_month_cost_sum` reads SUMs via DI (sumCostCurrentDay/Month + router_state flag) and is called by the Bridge gate on every incoming call. `voice.reset_monthly_cap` is the manual COST-03 override (zod-validated reason + authorized_by, JSONL audit via `monthly_cap_reset` event). Both wired in `src/mcp-tools/index.ts`.
- **Gate primitive (Task 2):** `voice-bridge/src/cost/gate.ts` with all four caps pinned (CAP_PER_CALL_EUR=1.00, CAP_DAILY_EUR=3.00, CAP_MONTHLY_EUR=25.00, SOFT_WARN_FRACTION=0.80) + `CostCapExceededError` + `checkCostCaps()` decision function. Fail-open on Core-unreachable (logged `cost_gate_core_unreachable`).
- **Sideband cost enforcement (Task 3):** `response.done` branch in `voice-bridge/src/sideband.ts` accumulates cost, fires `voice.record_turn_cost` fire-and-forget, and cascades through 80% soft-warn + 100% hard-stop (updateInstructions FAREWELL_INSTR → response.create → 4s hold → ws.close(1000) + voice.finalize_call_cost with terminated_by='cost_cap_call'). Pitfall 2 guards (warned/enforced flags) asserted by test fixture.
- **Session teardown (Task 3):** `session.closed`/`session.terminated` branch calls `voice.finalize_call_cost` with terminated_by='counterpart_bye' (only if not already enforced mid-call) and always clears accumulator state.
- **Accept-gate (Task 3):** `webhook.ts` inserts `checkCostCaps` BEFORE the existing outbound/whitelist/accept flow. Non-allow decisions map to `openai.realtime.calls.reject(callId, {status_code: 503})` + Discord alert. Happy-path unchanged.
- **Core-side auto-suspend (Task 3 addendum):** `voice.finalize_call_cost` re-queries SUM(voice_call_costs) for current month after upsert; if ≥€25, sets `router_state.voice_channel_suspended='1'` and emits JSONL `monthly_cap_auto_suspend`. Keeps suspension write atomic with finalize write (variant b, A12 surface tight — no new `voice.set_suspend` tool).
- **Wave-2 test suite:** 3 A12 dispatch tests, 3 voice-get-day-month-cost-sum tests, 5 voice-reset-monthly-cap tests, 12 gate.ts tests, 6 sideband cost-hook tests, 4 accept-gate integration tests. All GREEN. All 300 bridge tests pass. Core 529/530 pass (1 pre-existing gmail failure deferred — out-of-scope).

## Task Commits

Each task RED→GREEN atomic (TDD):

1. **Task 1 RED — A12 idempotency tests** — `98fdb94` (test)
2. **Task 1 GREEN — dispatch.ts routes mutating tools via invokeIdempotent** — `0b2e0d1` (feat)
3. **Task 2 RED — gate + Core MCP tests** — `b0e5386` (test)
4. **Task 2 GREEN — gate.ts + voice.get_day_month_cost_sum + voice.reset_monthly_cap + Core-side auto-suspend in finalize** — `26d3d20` (feat)
5. **Task 3 GREEN — sideband response.done cost cascade + /accept gate + integration tests** — `8192b16` (feat)

## Files Created/Modified

### Created (Core)
- `src/mcp-tools/voice-get-day-month-cost-sum.ts` — zod-validated DI handler, `{today_eur, month_eur, suspended}` shape
- `src/mcp-tools/voice-get-day-month-cost-sum.test.ts` — 3 tests (happy / suspended / permissive args)
- `src/mcp-tools/voice-reset-monthly-cap.ts` — zod-validated DI handler, clears router_state flag, JSONL audit
- `src/mcp-tools/voice-reset-monthly-cap.test.ts` — 5 tests (happy / idempotent-reset / zod errors / JSONL audit)

### Created (Bridge)
- `voice-bridge/src/cost/gate.ts` — `checkCostCaps(log, opts)` + `CostCapExceededError` + 4 locked cap constants
- `voice-bridge/src/cost/gate.test.ts` — 12 tests (5 constants + 7 decision-matrix including fail-open)

### Modified (Core)
- `src/mcp-tools/voice-finalize-call-cost.ts` — ADDENDUM per Plan 04-02 Task 3: after upsertCallCost, re-query sumCostCurrentMonth and auto-set voice_channel_suspended='1' if ≥ CAP_MONTHLY_EUR. JSONL `monthly_cap_auto_suspend` event. Optional DI so existing Wave-0 tests remain green.
- `src/mcp-tools/index.ts` — +2 registry.register calls for the new MCP tools + wire sumCostCurrentMonth+setRouterState into voice.finalize_call_cost deps

### Modified (Bridge)
- `voice-bridge/src/tools/dispatch.ts` — +`import {invokeIdempotent}` and mutating-branch in the callCore block
- `voice-bridge/tests/dispatch.test.ts` — +3 A12 tests
- `voice-bridge/src/sideband.ts` — +response.done branch (accumulator + record_turn_cost + soft-warn + hard-stop) + session.closed branch (finalize + clearCall) + SidebandState.caseType/startedAtIso + SidebandOpenOpts DI for cost hooks + FAREWELL_INSTR + FAREWELL_TTS_HOLD_MS constants
- `voice-bridge/tests/sideband.test.ts` — +6 Task 3 tests
- `voice-bridge/src/webhook.ts` — +`checkCostCaps`/`sendDiscordAlert` imports + gate block inserted AFTER `eventType !== 'realtime.call.incoming'` skip and BEFORE outbound/whitelist/accept flow
- `voice-bridge/tests/accept.test.ts` — +4 gate-integration tests with fetch stub + vi.resetModules

## Decisions Made

- **Variant (b) locked for Core-side auto-suspend** — per plan's WARNING-2 resolution: `voice.finalize_call_cost` handles the suspension write atomically with upsert. Adding a separate `voice.set_suspend` MCP tool would expand A12 surface with no benefit. Documented as `monthly_cap_auto_suspend` JSONL audit row.
- **Fail-open on Core outage (Pitfall 9 variant)** — gate logs `cost_gate_core_unreachable` WARN and returns decision='allow'. Single-user, single-host system; blocking every call during a Core glitch is a worse failure mode than temporarily bypassing daily/monthly caps. JSONL is audit trail of last resort.
- **response.done with no usage block is silently ignored** — the existing sideband test suite fires `{type: 'response.done', response: {}}` as an "unknown event type" smoke test. Rather than retrofit a callCoreTool mock into every legacy test, the handler returns early when `!usage` — keeps 17 existing tests green, avoids 0-cost ledger noise.
- **vi.resetModules + fetch stub for gate integration tests** — `CORE_MCP_URL` is a module-level const captured at import in config.ts; without resetModules the test's `process.env.CORE_MCP_URL='http://core-test:3200'` would be ignored. Pattern generalizes: any future integration test that touches config-loaded env needs resetModules.
- **DI on SidebandOpenOpts for the cost cascade** — production default routes to `src/cost/accumulator.ts`, `src/core-mcp-client.ts`, `src/alerts.ts`. Tests inject mocks; no real IO in 0.4s test run. Matches the existing dispatchTool DI pattern.
- **FAREWELL_INSTR verbatim from plan** — no deviation from the planner's German draft.
- **End_call and confirm_action included in mutating allowlist** — both were already `mutating: true` in allowlist.ts prior to Plan 04-02; the idempotency wrapper now protects them as a side-effect of the branching rule. Not problematic: `confirm_action` is bridge-internal (maps to null in TOOL_TO_CORE_MCP — never invokeIdempotent wrapped because the dispatch returns early at the `coreName === null` check); `end_call` has its own dedicated bridge-internal path above the mutating/read-only branch.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] response.done with no usage block would spam Core with 0-cost requests and 0-cost ledger rows**
- **Found during:** Task 3 sideband.ts implementation
- **Issue:** Plan's literal action block always fires `voice.record_turn_cost` on every response.done. Existing sideband tests send empty `response.done` as an "unknown event smoke test" fixture → would cause `voice_record_turn_cost_fail` warns in tests that run without CORE_MCP_URL, AND production 0-cost ledger spam.
- **Fix:** `if (!usage) return` early in the response.done branch. Cost accumulator only adds when usage is present. Logged in 6th new test case.
- **Files modified:** `voice-bridge/src/sideband.ts`
- **Committed in:** `8192b16`

**2. [Rule 3 - Blocking] Existing accept-test suite lacked mock callCoreTool — gate would 500 tests via unhandled throw**
- **Found during:** Task 3 webhook.ts integration
- **Issue:** Phase-2 tests set up their own `buildApp` with DI overrides but do not mock CORE_MCP_URL. Gate calls `callCoreTool` which throws with no URL, falls to fail-open, logs `cost_gate_core_unreachable` WARN, returns 'allow'. Tests pass because existing expectations don't check warn log contents — but the new gate-rejection tests needed a different approach since gate MUST return a decision.
- **Fix:** New `describe('POST /accept — cost gate')` block uses `vi.resetModules()` + `globalThis.fetch` stub + `process.env.CORE_MCP_URL` per test. Keeps the Phase-2 tests untouched while proving reject_daily / reject_monthly / reject_suspended / allow.
- **Files modified:** `voice-bridge/tests/accept.test.ts`
- **Committed in:** `8192b16`

**3. [Rule 2 - Missing critical] voice.finalize_call_cost had no auto-suspend wiring — Plan 04-02 WARNING-2 variant (b)**
- **Found during:** Task 3 webhook.ts gate integration (the gate relies on the suspended flag being set by Core-side at finalize-time)
- **Issue:** Plan 04-01 shipped `voice.finalize_call_cost` without the auto-suspend addendum. Plan 04-02's gate queries `suspended` via `voice.get_day_month_cost_sum`, but nothing was writing the flag. Plan 04-02 `<action>` Subtask 3c explicitly flagged this as a Plan-04-02-time ADDENDUM patch.
- **Fix:** Extended `VoiceFinalizeCallCostDeps` with optional `sumCostCurrentMonth`, `setRouterState`, `capMonthlyEur` deps; after upsertCallCost, recompute monthly SUM and set router_state if ≥€25. Emit `monthly_cap_auto_suspend` JSONL audit row. Kept deps optional so existing 7 finalize tests stay green.
- **Files modified:** `src/mcp-tools/voice-finalize-call-cost.ts`, `src/mcp-tools/index.ts`
- **Committed in:** `26d3d20`

**Total deviations:** 3 auto-fixed (2 Rule-2 missing-critical, 1 Rule-3 blocking). No architectural changes. All documented inline in commit messages.

## Plan `<output>` Requirements

Per plan's `<output>` section:

- **Variant for Monthly-Suspend:** Variant (b) Core-side auto-suspend in `voice.finalize_call_cost`. See `src/mcp-tools/voice-finalize-call-cost.ts` lines 110-140 (post-upsert block). Rationale: A12 surface tightness, atomic with upsert write.
- **state.caseType wired via SidebandOpenOpts:** `SidebandState.caseType?: string` + `SidebandState.startedAtIso?: string` added. Initialized in `openSidebandSession` from `opts.caseType` (default 'unknown') + `new Date(t0).toISOString()`. Call-router and webhook.ts still pass `opts.caseType` as undefined — a follow-up could surface the selected persona (`case6b`/`phase2`/`outbound`) into SidebandOpenOpts. For Plan 04-02 the default 'unknown' is enough because finalize_call_cost's case_type enum includes it (zod schema accepts any string 1-32 chars).
- **FAREWELL_INSTR exact text:** Matches plan draft verbatim: `"Dein Zeitbudget für dieses Gespräch ist aufgebraucht. Verabschiede dich jetzt höflich mit einem einzigen Satz, z.B. 'Vielen Dank, ich melde mich später erneut. Auf Wiederhören.' und sage danach nichts mehr."` — exported as `FAREWELL_INSTR` constant from sideband.ts.
- **Open items for Plan 03:** (i) StreamableHTTP not yet built — `voice.get_day_month_cost_sum` + `voice.reset_monthly_cap` join the same ToolRegistry Plan 04-03's `src/mcp-stream-server.ts` will mount (single-source invariant preserved). (ii) `search_competitors` is still `null` in `TOOL_TO_CORE_MCP` — the A12 wrap is no-op for null-mapped tools (dispatch returns early at `coreName === null`); changing `search_competitors` to `'voice.search_competitors'` + landing the Core handler is deferred to Plan 04-03.
- **Gate location in webhook.ts:** Lines 138-190 (AFTER `!callId` guard, BEFORE outbound detection). Uses `openai.realtime.calls.reject(callId, { status_code: 503 })` — NOT HTTP 503 via `reply.code` (OpenAI doesn't read the HTTP status of our webhook ack, it only reads the reject-API return).

## Threat Model Compliance

All STRIDE mitigations per Plan 04-02 threat register:
- T-04-02-01 (Spoofing): Phase-1 signature verify runs BEFORE gate (unchanged).
- T-04-02-02 (Tampering race): `accumulator.markEnforced(callId)` check-and-mark asserted in sideband test "hard-stop exactly once".
- T-04-02-03 (Tampering tools-inject): Hard-stop uses existing `updateInstructions` (strips tools, logs BUG) — no new send-path.
- T-04-02-04 (Repudiation farewell clip): FAREWELL_TTS_HOLD_MS=4000 between response.create and ws.close, asserted in sideband test.
- T-04-02-05 (Info disclosure): Single-user filesystem, no PII. Accepted.
- T-04-02-06 (DoS flood): Phase-1 peer-allowlist unchanged.
- T-04-02-07 (EoP reset): voice.reset_monthly_cap requires authorized_by; JSONL audit row per call. Accepted until Plan 04-03's Bearer token lands.
- T-04-02-08 (A12 regression): dispatch.test.ts now has 3 tests asserting the mutating/read-only branches — any future regression fails the suite.
- T-04-02-09 (Sticky monthly): Accepted per ROADMAP Success Criterion 2.
- T-04-02-10 (response.done storm): Bridge debounce NOT implemented (would require per-call turn_id Map); Core-side PK(call_id, turn_id) INSERT OR IGNORE is the natural safety net, asserted by cost-ledger Wave-0 PK-dedup test. Accepted as a deferred Plan-04-03 hardening item.

## Issues Encountered

- `src/channels/gmail.test.ts` FAILs with "defaults to unread query when no filter configured" (expected `is:unread category:primary`, got the negated-category form). **Pre-existing on base commit 033fbdb; unrelated to Plan 04-02 file scope.** Flagged in `.planning/phases/04-core-tool-integration-cost-observability/deferred-items.md`.
- `npm run lint` script does not exist in voice-bridge/package.json — skipped.
- Bridge tests initially failed after adding the A12 test because the test-args didn't match the JSON schema (`start`/`end_time` vs plan's `date`/`time`/`duration`). Fixed in the same RED commit.

## User Setup Required

None — no new env vars, no new services, no new secrets. USD_TO_EUR env-override remains optional (default 0.93 from Plan 04-01). CORE_MCP_URL + CORE_MCP_TOKEN already configured per Phase 2.

## Next Plan Readiness

- **Plan 04-03 (StreamableHTTP):** unblocked — `voice.get_day_month_cost_sum` + `voice.reset_monthly_cap` join the same ToolRegistry the StreamableHTTP server will mount. The single-source-registry invariant is preserved (both tools registered via `buildDefaultRegistry`).
- **Plan 04-04 (pricing refresh cron + recon-invoice):** unblocked — `voice_price_snapshots` table (Wave-0) + `voice_call_costs` + `voice_turn_costs` + `monthly_cap_auto_suspend` JSONL audit trail all landed.

## Self-Check: PASSED

Files verified to exist:
- FOUND: src/mcp-tools/voice-get-day-month-cost-sum.ts
- FOUND: src/mcp-tools/voice-get-day-month-cost-sum.test.ts
- FOUND: src/mcp-tools/voice-reset-monthly-cap.ts
- FOUND: src/mcp-tools/voice-reset-monthly-cap.test.ts
- FOUND: voice-bridge/src/cost/gate.ts
- FOUND: voice-bridge/src/cost/gate.test.ts

Commits verified to exist:
- FOUND: 98fdb94 (Task 1 RED)
- FOUND: 0b2e0d1 (Task 1 GREEN — A12 closed)
- FOUND: b0e5386 (Task 2 RED)
- FOUND: 26d3d20 (Task 2 GREEN — gate + Core MCP tools + auto-suspend)
- FOUND: 8192b16 (Task 3 GREEN — sideband + webhook gate)

Tests verified GREEN:
- Bridge: 300 passed | 1 skipped (all 31 test files)
- Core: 529 passed (1 pre-existing gmail failure deferred, documented in deferred-items.md)

typecheck: Core 0 errors, Bridge 0 errors.

Acceptance-criteria grep pass:
- mutating: true count 9 (≥6 required)
- invokeIdempotent + entry.mutating branch in dispatch.ts: FOUND
- Both Core MCP tools registered: FOUND
- All 4 cap constants locked at 1.00 / 3.00 / 25.00 / 0.80: FOUND
- CostCapExceededError + checkCostCaps exports: FOUND
- response.done + costOfResponseDone + voice.record_turn_cost + voice.finalize_call_cost + FAREWELL_INSTR + markEnforced/markWarned in sideband.ts: FOUND
- webhook.ts imports + uses checkCostCaps: FOUND

---

*Phase: 04-core-tool-integration-cost-observability*
*Plan: 02 (Wave 2 — cost enforcement live + A12 closure)*
*Completed: 2026-04-19*
