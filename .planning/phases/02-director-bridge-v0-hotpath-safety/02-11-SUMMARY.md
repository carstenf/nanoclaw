---
phase: 02-director-bridge-v0-hotpath-safety
plan: 11
subsystem: voice-bridge
tags: [tool-dispatch, mcp-forward, sideband, function-call, openai-realtime]
dependency_graph:
  requires: [02-07, 02-09, 02-10, 03-01, 03-03, 03-04, 03-05, 03-06, 03-07]
  provides: [tool-dispatch-live, function-call-output-emission]
  affects: [sideband, dispatch, call-router]
tech_stack:
  added: []
  patterns: [fire-and-forget async dispatch, DI opts for test mocking, lazy-load to avoid circular import]
key_files:
  created:
    - voice-bridge/src/tools/tool-output-emitter.ts
    - voice-bridge/tests/tool-output-emitter.test.ts
  modified:
    - voice-bridge/src/tools/dispatch.ts
    - voice-bridge/tests/dispatch.test.ts
    - voice-bridge/src/sideband.ts
    - voice-bridge/tests/sideband.test.ts
    - voice-bridge/src/config.ts
    - voice-bridge/tests/replay/fabricated-tool.test.ts
    - voice-bridge/tests/replay/harness.ts
decisions:
  - "Lazy-load dispatchTool in sideband.ts via require() to avoid circular ESM import at module load"
  - "DI opts pattern (callCoreTool/emitFunctionCallOutput/emitResponseCreate) keeps dispatch unit-testable without real WS or network"
  - "Replay harness updated to use mock WS + no-op callCoreTool — latency measurement still valid (bridge-side work only)"
metrics:
  duration_min: 8
  completed_date: "2026-04-18"
  tasks_completed: 5
  files_changed: 9
---

# Phase 02 Plan 11: Bridge-side Tool-Dispatch Wireup Summary

**One-liner:** Async MCP-forward dispatch via voice.-prefixed Core tools, function_call_output + response.create emission, fire-and-forget sideband handler — replaces 02-07 stub.

## What Was Built

| Component | File | Role |
|---|---|---|
| WS-send helpers | `src/tools/tool-output-emitter.ts` | emitFunctionCallOutput + emitResponseCreate, try/catch, never throw |
| Async MCP dispatch | `src/tools/dispatch.ts` | TOOL_TO_CORE_MCP mapping, callCoreTool with 3s timeout, all error paths |
| Sideband handler | `src/sideband.ts` | `response.function_call_arguments.done` branch, fire-and-forget, malformed-args direct emit |
| Config | `src/config.ts` | DISPATCH_TOOL_TIMEOUT_MS=3000, TOOL_DISPATCH_JSONL_PATH |

## Commits

| Hash | Message |
|---|---|
| `6a8aefd` | feat(02-11): tool-output-emitter — emitFunctionCallOutput + emitResponseCreate WS helpers |
| `1f64601` | feat(02-11): dispatch.ts async MCP-forward + DISPATCH_TOOL_TIMEOUT_MS config |
| `4b78c9f` | feat(02-11): sideband.ts — function_call_arguments.done handler + dispatchTool fire-and-forget |
| `bbbaf08` | fix(02-11): update replay harness + fabricated-tool tests for async dispatchTool API |

## Tool Mapping

```typescript
const TOOL_TO_CORE_MCP = {
  check_calendar:        'voice.check_calendar',        // → Core MCP
  create_calendar_entry: 'voice.create_calendar_entry', // → Core MCP
  send_discord_message:  'voice.send_discord_message',  // → Core MCP
  get_contract:          'voice.get_contract',          // → Core MCP
  get_practice_profile:  'voice.get_practice_profile',  // → Core MCP
  schedule_retry:        'voice.schedule_retry',        // → Core MCP
  search_competitors:    null,  // not_implemented (03-08 skipped)
  search_hotels:         null,  // not_implemented (03-08 skipped)
  transfer_call:         null,  // bridge-internal, 02-12+
  confirm_action:        null,  // bridge-internal, 02-04 readback
}
```

## Error Paths

| Condition | Bot receives |
|---|---|
| Unknown tool | `{error:'invalid_tool_call'}` |
| Schema-fail args | `{error:'invalid_tool_call'}` |
| null mapping (not_impl) | `{error:'not_implemented'}` |
| Core timeout (3s) | `{error:'tool_timeout'}` |
| Core HTTP error | `{error:'tool_unavailable'}` |
| Network error | `{error:'tool_unavailable'}` |
| Malformed arguments JSON | `{error:'invalid_arguments'}` (emitted directly in sideband) |

## Bridge Deploy (Lenovo1)

```
service: voice-bridge.service (systemd --user)
host:    10.0.0.2:4402
restart: 2026-04-18 10:16:27 UTC
status:  active (running)
log:     {"event":"bridge_listening","host":"10.0.0.2","port":4402}
health:  {"ok":true,"secret_loaded":true,"uptime_s":5,"bind":"10.0.0.2","port":4402}
```

No ERRORs in startup log. `/health` 200 OK.

## Test Evidence

```
Before (02-10 baseline):  147 passed + 1 skipped (20 files)
After  (02-11):           158 passed + 1 skipped (21 files)
New tests:                +11 (5 tool-output-emitter, 8 dispatch, 3 sideband new, -5 replaced)
tsc --noEmit:             clean
```

## Caveats

1. **search_hotels / search_competitors return `{error:'not_implemented'}`** — bot behaviour on these calls not yet observed. Per Persona-Prompt AC-06: "Wenn Werkzeug fehlschlaegt, informiere Kunde und biete Callback an". First PSTN-Test will reveal if the phrasing is adequate.

2. **transfer_call + confirm_action remain stubbed** (null in TOOL_TO_CORE_MCP, bot receives `{error:'not_implemented'}`). Implementation scope: 02-12+.

3. **NO PSTN-Test in this plan** — per Briefing §7, live PSTN calls are Carsten-Tasks.

4. **Lazy-require for dispatchTool in sideband.ts** — uses `require()` to avoid ESM circular import. Works correctly at runtime (Node.js CJS fallback). If sideband.ts is ever moved to pure ESM-only dynamic import, this needs revisiting.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] replay/fabricated-tool.test.ts + harness.ts used old sync dispatch API**
- **Found during:** Task 04 full-suite run
- **Issue:** `dispatchTool` changed from sync 5-arg to async 8-arg — 8 tests failing
- **Fix:** Rewrote fabricated-tool.test.ts with mock WS + DI opts; updated harness.ts call site with mockWS + no-op callCoreTool
- **Files modified:** `tests/replay/fabricated-tool.test.ts`, `tests/replay/harness.ts`
- **Commit:** `bbbaf08`

**2. [Rule 1 - Bug] Test args didn't match actual JSON schemas**
- **Found during:** Task 02 GREEN phase
- **Issue:** Test used `{location, radius_km}` for search_competitors (requires `category+criteria`), `{}` for get_practice_profile (requires `name`), `{call_id, reason, delay_minutes}` for schedule_retry (requires `case_type+target_phone+not_before_ts`)
- **Fix:** Corrected args to match actual schema requirements in dispatch.test.ts
- **Files modified:** `tests/dispatch.test.ts`

## Known Stubs

- `transfer_call` → `{error:'not_implemented'}` until 02-12+
- `confirm_action` → `{error:'not_implemented'}` until bridge-internal wiring

## Next

**ACTION REQUIRED: Carsten PSTN Combined Test**
- Carsten ruft an und spricht Sätze die alle 6 Core-Tools triggern
- Verify: JSONL `data/tool-dispatch.jsonl` waechst per Tool-Call
- Verify: Bot antwortet korrekt nach Tool-Result (audio response nach response.create)
- Verify: `search_competitors` / `search_hotels` → Bot sagt "leider gerade nicht verfügbar, ich biete Callback"
- Chat beauftragen: "Wann machst du den PSTN-Combined-Test für 02-11?"

## Self-Check: PASSED

Files exist:
- `voice-bridge/src/tools/tool-output-emitter.ts` ✓
- `voice-bridge/src/tools/dispatch.ts` ✓ (async, min_lines 80 ✓)
- `voice-bridge/src/sideband.ts` ✓ (contains response.function_call_arguments.done ✓)
- `voice-bridge/src/config.ts` ✓ (contains DISPATCH_TOOL_TIMEOUT_MS ✓)

Commits exist: 6a8aefd, 1f64601, 4b78c9f, bbbaf08 ✓
Bridge health: active + /health 200 ✓
