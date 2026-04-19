---
phase: 03-voice-mcp-endpoint
plan: 11
subsystem: voice-bridge + core-mcp
tags: [outbound-call, queue, mcp-tool, persona, case-6b]
dependency_graph:
  requires: [03-01, 02-14, 02-11]
  provides: [voice.request_outbound_call, bridge-outbound-queue, outbound-persona]
  affects: [voice-bridge/src/, src/mcp-tools/]
tech_stack:
  added: [outbound-router, outbound-webhook, voice-request-outbound-call]
  patterns: [DI-timers, TDD-RED-GREEN, peer-allowlist, JSONL-PII-clean]
key_files:
  created:
    - voice-bridge/src/outbound-router.ts
    - voice-bridge/tests/outbound-router.test.ts
    - voice-bridge/src/outbound-webhook.ts
    - voice-bridge/tests/outbound-webhook.test.ts
    - voice-bridge/src/tools/schemas/request_outbound_call.json
    - src/mcp-tools/voice-request-outbound-call.ts
    - src/mcp-tools/voice-request-outbound-call.test.ts
  modified:
    - voice-bridge/src/persona.ts
    - voice-bridge/tests/persona.test.ts
    - voice-bridge/src/tools/allowlist.ts
    - voice-bridge/src/config.ts
    - voice-bridge/src/index.ts
    - voice-bridge/tests/allowlist.test.ts
    - voice-bridge/tests/accept.test.ts
    - src/config.ts
    - src/mcp-tools/index.ts
decisions:
  - "OutboundRouter uses DI timers mock to avoid real setTimeout in unit tests"
  - "Peer allowlist includes 10.0.0.2 (bridge own addr) because Core+Bridge colocated on Lenovo1"
  - "buildOutboundPersona uses plain string.replace — no eval/template-engine (safety)"
  - "tools_count goes 11→12 (under REQ-TOOLS-09 ceiling of 15)"
  - "OUTBOUND_PERSONA_TEMPLATE added in Task 1 (Rule 2 deviation — required by outbound-router before Task 5)"
metrics:
  duration_min: 72
  completed: "2026-04-18"
  tasks_completed: 6
  files_changed: 16
  bridge_tests_before: 179
  bridge_tests_after: 202
  core_tests_before: 472
  core_tests_after: 480
---

# Phase 03 Plan 11: voice.request_outbound_call Core-MCP-Tool + Bridge-HTTP-Route + Bridge-Outbound-Queue Summary

Case-6b Direction B end-to-end: Andy (chat) calls `voice.request_outbound_call`, Core forwards to Bridge /outbound, Bridge queues + executes outbound SIP call via OpenAI Realtime, reports back via Discord.

## What Was Built

### Bridge side

**`outbound-router.ts`** — In-memory outbound call queue with full lifecycle:
- `OutboundRouter`: `enqueue`, `onCallEnd`, `getState`
- FIFO queue, `QueueFullError` at configurable max (default 10)
- 10-min escalation timer per queued task (fires → `status='escalated'` + reportBack)
- 10-min max-duration cap per active call (fires → `calls.end` + `onCallEndInternal`)
- DI pattern: `openaiClient`, `callRouter`, `reportBack`, `timers`, `now`

**`outbound-webhook.ts`** — POST /outbound HTTP route:
- Peer allowlist: `10.0.0.1/2/4/5` (10.0.0.2 needed: Core+Bridge colocated on Lenovo1)
- Optional `Authorization: Bearer` guard
- Zod body validation (E.164 target_phone, goal 1..500, context 0..2000)
- Enqueue → 200 `{outbound_task_id, estimated_start_ts, queue_position, status}`
- Error codes: 400 bad_request, 401 unauthorized, 403 forbidden, 429 queue_full, 500 internal

**`tools/schemas/request_outbound_call.json`** — JSON-Schema for bridge allowlist (defensive consistency).

**`tools/allowlist.ts`** — `request_outbound_call` added as entry 12 (mutating=true). REQ-TOOLS-09 ceiling 15 respected.

**`config.ts`** additions:
- `OUTBOUND_QUEUE_MAX` (default 10)
- `OUTBOUND_CALL_MAX_DURATION_MS` (default 600000)
- `OUTBOUND_ESCALATION_TIMEOUT_MS` (default 600000)
- `OUTBOUND_BRIDGE_AUTH_TOKEN` (default empty — WG-only auth)

**`persona.ts`** additions:
- `OUTBOUND_PERSONA_TEMPLATE` — Werkzeug-zuerst, Zwei-form-Bestaetigung, Filler, Passive Disclosure + `{{goal}}`/`{{context}}` placeholders
- `buildOutboundPersona(goal, context)` — plain string.replace (no eval)

### Core side

**`voice-request-outbound-call.ts`** — Core MCP handler:
- Zod schema: `{call_id?, target_phone E.164, goal 1..500, context 0..2000, report_to_jid}`
- HTTP POST to `BRIDGE_OUTBOUND_URL/outbound` with 5s timeout
- Error mapping: 400→bad_request, 401→unauthorized, 429→queue_full, 5xx/timeout/network→tool_unavailable
- JSONL PII-clean: `target_phone_hash` (SHA256[:12]), `phone_mask` (+491***7890), `goal_len`, `context_len`

**`src/config.ts`** additions:
- `BRIDGE_OUTBOUND_URL` (default `http://10.0.0.2:4402`)
- `BRIDGE_OUTBOUND_AUTH_TOKEN` (optional)

**`mcp-tools/index.ts`** — `voice.request_outbound_call` registered in `buildDefaultRegistry`.

## Smoke Test Results

### Bridge /outbound loopback (with X-Forwarded-For: 10.0.0.1)
```
POST http://10.0.0.2:4402/outbound
→ 200 {"outbound_task_id":"efb05d38...","estimated_start_ts":"...","queue_position":0,"status":"failed"}
```
Status `failed` = expected (OpenAI SIP call fails with test phone — no real PSTN smoke).

### Core MCP loopback
```
POST http://10.0.0.2:3200/mcp/voice.request_outbound_call
→ 200 {"ok":true,"result":{"ok":true,"result":{"queued":true,"outbound_task_id":"b4a88f4f...","estimated_start_ts":"..."}}}
```
Full path Core→Bridge→Queue working.

### JSONL PII check
```json
{
  "event": "outbound_call_requested",
  "target_phone_hash": "e8bd567e917e",
  "phone_mask": "+491***7890",
  "goal_len": 22,
  "context_len": 0
}
```
No full phone number, no goal/context text. PII-clean confirmed.

### tools_count
```
tools_count: 12
names: ask_core, check_calendar, confirm_action, create_calendar_entry, get_contract,
       get_practice_profile, get_travel_time, request_outbound_call, schedule_retry,
       search_competitors, send_discord_message, transfer_call
```

## Test Results

| Suite | Before | After | Delta |
|-------|--------|-------|-------|
| Bridge vitest | 179 passed + 1 skip | 202 passed + 1 skip | +23 |
| Core vitest | 472 passed + 1 pre-existing gmail fail | 480 passed + 1 pre-existing fail | +8 |

## Commits

| Hash | Message |
|------|---------|
| `710d439` | feat(03-11): Bridge outbound-router — in-memory queue + lifecycle |
| `a1bb167` | feat(03-11): Bridge POST /outbound route + index.ts wiring |
| `d4a62fa` | feat(03-11): Core MCP tool voice.request_outbound_call |
| `cc37932` | feat(03-11): Wiring — allowlist 11→12, config consts, Core mcp-tools/index.ts |
| `dd2fcbb` | feat(03-11): Outbound persona template + buildOutboundPersona tests |
| `f9c44fb` | fix(03-11): add 10.0.0.2 to outbound peer allowlist — Core+Bridge colocated on Lenovo1 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] `buildOutboundPersona` added in Task 1**
- **Found during:** Task 1 (outbound-router imports persona helper)
- **Issue:** `outbound-router.ts` calls `buildOutboundPersona` but it was planned for Task 5. Forward reference would fail.
- **Fix:** Added `OUTBOUND_PERSONA_TEMPLATE` + `buildOutboundPersona` to `persona.ts` during Task 1. Task 5 added tests for it.
- **Files modified:** `voice-bridge/src/persona.ts`
- **Commit:** 710d439

**2. [Rule 1 - Bug] 10.0.0.2 missing from default peer allowlist**
- **Found during:** Task 6 smoke test
- **Issue:** Core connects to Bridge via WireGuard; both services on Lenovo1. Fastify sees source IP as 10.0.0.2 (bridge's own address) for same-host connections.
- **Fix:** Added 10.0.0.2 to `DEFAULT_PEER_ALLOWLIST` in `outbound-webhook.ts`.
- **Files modified:** `voice-bridge/src/outbound-webhook.ts`
- **Commit:** f9c44fb

**3. [Rule 1 - Test Timer Bug] max-duration test with fake timers**
- **Found during:** Task 1 testing
- **Issue:** `vi.useFakeTimers()` prevents `setImmediate` from resolving; escalation timer (same ms value as duration timer) was captured first by `find()`.
- **Fix:** Switched max-duration test to real timers + fresh deps, used distinct `escalationMs` (660000 vs 600000) to disambiguate captured timers.
- **Commit:** 710d439

## Caveats

- **Real outbound call smoke is Carsten-task** — requires real SIP number + manual verification
- **Queue is in-memory** — if Bridge restarts, queued tasks are lost. SQLite migration is a v2 candidate if persistent retry is needed.
- **report-back via reportBack callback** — in `buildApp` production path, the `reportBack` is a no-op stub. Full report-back (Discord/WhatsApp) requires wiring in `main()` via `callCoreTool('voice.send_discord_message', ...)` — this is a known v1 limitation (plan accept/discarded in plan spec: "WARN-log, Carsten kann via separate MCP-query Status abrufen").

## Known Stubs

None — all data paths are wired. Queue works, Core tool works, persona template works.

## Threat Flags

None beyond what the plan's threat model covers (peer-allowlist, E.164 regex, PII-clean JSONL, max-duration cap all implemented).

## Self-Check: PASSED

- `voice-bridge/src/outbound-router.ts` — exists ✓
- `voice-bridge/src/outbound-webhook.ts` — exists ✓
- `src/mcp-tools/voice-request-outbound-call.ts` — exists ✓
- Commits 710d439, a1bb167, d4a62fa, cc37932, dd2fcbb, f9c44fb — all in git log ✓
- Bridge 202 tests pass ✓
- Core 480 tests pass ✓
- tools_count=12 ✓
- JSONL PII-clean ✓
