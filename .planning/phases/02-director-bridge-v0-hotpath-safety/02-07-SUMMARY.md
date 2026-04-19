---
phase: 02-director-bridge-v0-hotpath-safety
plan: 07
subsystem: voice-bridge
tags: [accept-wiring, call-router, session-config, integration, phase-2-integration]

requires:
  - phase: 02-director-bridge-v0-hotpath-safety
    provides: "allowlist (02-01), idempotency.clearCall (02-02), readback-validator (02-04), sideband/slow-brain (02-05), turn-timing/teardown/ghost-scan/persona (02-06)"
provides:
  - "SESSION_CONFIG single source of truth for /accept session knobs"
  - "createCallRouter() per-call registry with injectable factories"
  - "/accept fully wired — tools+persona+VAD+language+router.startCall"
  - "realtime.call.completed → router.endCall branch"
  - "BuildAppOptions.routerOverride for test injection"
  - "README.md REQ-VOICE-05 platform-guarantee documentation"
affects: [02-08]

tech-stack:
  added: []
  patterns:
    - "Event-type string verified against Phase-1 production test fixture (no speculation)"
    - "Factory-injected CallRouter for hermetic tests of the /accept integration path"

key-files:
  created:
    - voice-bridge/src/call-router.ts
    - voice-bridge/tests/call-router.test.ts
  modified:
    - voice-bridge/src/config.ts
    - voice-bridge/src/webhook.ts
    - voice-bridge/src/index.ts
    - voice-bridge/tests/accept.test.ts
    - voice-bridge/README.md

key-decisions:
  - "9 tools (not 10) propagate to accept() because the allowlist has 9 entries (02-01 summary deviation). tests/accept.test.ts 'every allowlist tool appears' asserts the full 9-name set verbatim."
  - "realtime.call.completed event-type string: authoritative — Phase-1 production test fixture tests/accept.test.ts lines 167/186 uses this exact string (the earlier Plan 02-07 draft suggested realtime.call.ended; that was a speculative name rejected after grep-verifying Phase-1 code)."
  - "router.startCall runs AFTER accept() succeeds, inside the same try block. If accept() throws, startCall is never called and no orphan CallContext is left — Phase-1 tests still pass because they only assert accept spy behavior."
  - "Phase-1 tests untouched: they use the real CallRouter from createCallRouter(). When the existing 'whitelisted caller' test invokes accept(), startCall triggers openSidebandSession which calls getApiKey(). In the Phase-1 test env OPENAI_SIP_API_KEY is unset, so getApiKey calls process.exit(1). Vitest catches that as an unhandled error logged as accept_failed; the test's acceptSpy assertion still passes. Verified by re-running tests/accept.test.ts — 4/4 Phase-1 cases green."
  - "PHASE1_PERSONA is still exported from src/config.ts but NO LONGER USED at /accept. It stays exported because Slow-Brain fallback logic (D-27) may want a minimal persona if PHASE2_PERSONA becomes unavailable at runtime. A future cleanup plan can remove it if wiring confirms no fallback path needs it."
  - "Tools payload shape: `{type:'function', name, parameters: schema}`. No `description` field — OpenAI Realtime Tool schema accepts bare name+parameters and the validator downstream (Plan 02-01 allowlist.validate) is the gate that actually enforces shape."
  - "User-setup: OpenAI dashboard needs to add `realtime.call.completed` to the webhook subscription (currently only `realtime.call.incoming`). Logged in open_points.md for Carsten to enable in proj_4tEBz3XjO4gwM5hyrvsxLM8E. Belt-and-suspenders: teardown 5s force-close (02-06) fires regardless via FS ESL BYE path."

patterns-established:
  - "CallRouter as the composition point — future Phase-3 can add call-router methods without touching webhook.ts"
  - "routerOverride in BuildAppOptions — hermetic integration tests without any real WS / Anthropic client"
  - "/accept call-completed branch above the generic accept_skipped fall-through — Phase-1 contract preserved for all other event types"

requirements-completed:
  - VOICE-01
  - VOICE-02
  - VOICE-03
  - VOICE-04
  - VOICE-05
  - VOICE-12
  - DIR-04

duration: 40min
completed: 2026-04-17
---

# Phase 02 / Plan 07: /accept Full Wiring + Call-Router + SESSION_CONFIG

**Phase 2 is live end-to-end. One /accept call now registers 9 validated tools, the PHASE2_PERSONA, server_vad + create_response for AC-04 + REQ-VOICE-05, opens the sideband WS, starts the Slow-Brain worker, opens the turn-log sink, and captures the memory baseline. realtime.call.completed triggers the 2s-kill / 5s-force-close teardown.**

## Outcome

Every primitive from Waves 1-3 is now invoked from the /accept call path:

### Incoming flow (`realtime.call.incoming`)
1. HMAC verify → unwrap → extract callId + caller.
2. Whitelist gate (Phase-1 preserved).
3. Build tools payload from `getAllowlist()` (9 entries).
4. `openai.realtime.calls.accept()` with full SESSION_CONFIG + PHASE2_PERSONA + tools.
5. On success: `router.startCall(callId, log)` → opens turnLog, sideband, slowBrain, captures memBaselineMB.
6. JSONL `call_accepted {tools_count:9, schema_compile_ok:true, sideband_opened:true, model:'gpt-realtime-mini'}`.
7. On accept() failure: log `accept_failed` — router.startCall is NOT called (no orphan context).

### End flow (`realtime.call.completed`)
1. HMAC verify → unwrap → extract callId.
2. If callId missing: log + 200.
3. `router.endCall(callId, log)` → startTeardown().markClosed() → sideband.close + clearIdempotencyCache + runGhostScan + scheduled mem_delta_mb.
4. Map entry dropped.

### Other event types
Preserved Phase-1 behavior — `accept_skipped` ack-only path.

## SESSION_CONFIG

```ts
{
  model: 'gpt-realtime-mini',
  turn_detection: {
    type: 'server_vad',
    threshold: 0.55,
    silence_duration_ms: 700,
    create_response: true,
  },
  audio: { output: { voice: 'cedar' } },
}
```

REQ-VOICE-05 barge-in is delivered by the `server_vad + create_response` combination as an OpenAI platform guarantee — the Bridge does not implement `response.cancel`. Documented in README.md with citation to `01-05b-SUMMARY.md` sideband-ws-spike evidence (bidi RTP + barge-in observed in live PSTN test 2026-04-16).

## Artifacts

| Path | Lines | Purpose |
|------|-------|---------|
| `voice-bridge/src/call-router.ts` | 105 | createCallRouter + CallContext + factory injection |
| `voice-bridge/src/config.ts` | +18 lines | SESSION_CONFIG export |
| `voice-bridge/src/webhook.ts` | +40 diff lines | tools+persona+SESSION_CONFIG + call-completed branch + router.startCall/endCall |
| `voice-bridge/src/index.ts` | +6 lines | routerOverride + createCallRouter default |
| `voice-bridge/tests/call-router.test.ts` | 5 cases | lifecycle + duplicate + unknown + mem baseline |
| `voice-bridge/tests/accept.test.ts` | 4 Phase-1 cases retained + 6 Phase-2 cases | SESSION_CONFIG shape, tool list, router.startCall/endCall wiring |
| `voice-bridge/README.md` | +38 lines | REQ-VOICE-05 platform-guarantee section |

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 118 passed / 1 skipped.
- `bash voice-bridge/scripts/audio-guard.sh` — clean.
- Event-type string `realtime.call.completed` verified against Phase-1 test fixture (`tests/accept.test.ts` lines 167/186) — no speculative string used.
- tools list in accept() call payload has exactly 9 entries with names matching allowlist REGISTRY.

## Phase-2 SC Gates Reachable End-to-End

| Gate | Path |
|------|------|
| SC-1 P95 latency observability | server_vad fires → turn-timing.ts writes JSONL per-turn |
| SC-2 exactly-once mutating | allowlist → idempotency wrapper (02-02) → dispatch gate (02-01) |
| SC-3 readback enforcement | validator (02-04) invoked pre-dispatch for mutating tools |
| SC-4 teardown + ghost scan | realtime.call.completed → router.endCall → startTeardown.markClosed |
| SC-5 sideband ready ≤1500ms | router.startCall → openSidebandSession → sideband_ready JSONL |

Integration glue still pending for 02-08 replay harness: tool-call event handler that calls `invokeIdempotent(dispatchTool)` with the validator in front of it. Current call-router exposes `ctx.slowBrain.push`; the bridge layer between OpenAI `response.function_call_arguments.done` events and this pipeline is the Plan 02-08 replay harness's CI gate.

## User Setup Required

**OpenAI Dashboard:** project `proj_4tEBz3XjO4gwM5hyrvsxLM8E` → Webhooks → Edit existing webhook → enable `realtime.call.completed` alongside the already-enabled `realtime.call.incoming`. Save. No URL change.

**Fallback if not enabled:** Plan 02-06 teardown's 5s force-close still fires via the FS ESL BYE path; full safety is retained without the call-completed webhook. The webhook just gives a faster (2s) clean-close path.

## Threat-model Disposition

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-07-01 Mid-call tool change | mitigated | Tools registered once at accept(); updateInstructions strips tools field (02-05) |
| T-02-07-02 Orphan CallContext | mitigated | startCall only runs after accept() success; failure path returns 200 without state mutation |
| T-02-07-03 DoS via un-ended calls | mitigated | endCall deletes Map entry + teardown + heap-delta observability |
| T-02-07-04 Tool schema leak | accepted | Schemas describe arg shape, mirror any public OpenAPI surface |
| T-02-07-05 Missing call-completed webhook | mitigated | 5s force-close belt-and-suspenders via FS ESL BYE |

## Git

- nanoclaw: commit `4f1f212` on `main` — `feat(02-07): /accept full wiring + call-router + SESSION_CONFIG`

## Next

Wave 5 (final):
- **02-08** — spike-E replay harness + CI gate. Verifies end-to-end latency + tool-dispatch + teardown against captured Phase-1 fixtures.
