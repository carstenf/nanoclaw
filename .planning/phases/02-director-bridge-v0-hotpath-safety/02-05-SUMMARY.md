---
phase: 02-director-bridge-v0-hotpath-safety
plan: 05
subsystem: voice-bridge
tags: [sideband-ws, openai-realtime, claude-sonnet, slow-brain, cadence-cap, graceful-degrade]

requires:
  - phase: 02-director-bridge-v0-hotpath-safety
    provides: "ws + @anthropic-ai/sdk deps pre-installed by Plan 02-04"
provides:
  - "openSidebandSession(callId, log, opts) opens per-call WS with Authorization + OpenAI-Beta + connect SLA"
  - "updateInstructions(state, instructions, log, extraSession) sends instructions-only session.update with 'tools' stripped + BUG-logged"
  - "startSlowBrain(log, sideband, opts) event-driven Claude Sonnet worker with cadence cap, queue back-pressure, AbortController timeout, graceful degrade"
  - "6 new config exports + getAnthropicKey()"
affects: [02-06, 02-07]

tech-stack:
  added: []  # deps added in 02-04; this plan only consumes
  patterns:
    - "Test-injectable wsFactory + AnthropicClient — zero real-network in vitest"
    - "createRequire(import.meta.url) to lazy-load a CJS dep from an ESM module — avoids NodeNext default-export churn"
    - "Fire-and-forget coroutine (`void runLoop()`) with cooperative `running` flag + AbortController stop"

key-files:
  created:
    - voice-bridge/src/sideband.ts
    - voice-bridge/src/slow-brain.ts
    - voice-bridge/tests/sideband.test.ts
    - voice-bridge/tests/slow-brain.test.ts
  modified:
    - voice-bridge/src/config.ts

key-decisions:
  - "Instructions-only strict filter in updateInstructions: extraSession spread first, then `instructions` overrides, then `tools` is unconditionally deleted. Any path that accidentally carries a `tools` key triggers a BUG-level log so red-team tests can catch it in CI."
  - "Connect SLA implemented via setTimeout (not AbortController) because ws@8 does not expose a fetch-style AbortSignal. The timer is cleared on `open` and on close(), and the `timedOut` latch prevents a late-arriving `open` from flipping state.ready back to true after the warning fired."
  - "Cadence cap `turnsSinceUpdate < cap` semantics: turn 1 coalesces, turn 2 triggers Claude. Tests with cap=2 + 4 pushes confirm ≤2 create() calls. cap=0 disables the coalescer entirely for testing."
  - "Dynamic default client via createRequire: the Anthropic SDK is CJS (type:commonjs, main:index.js) and under NodeNext strict the default export shape is brittle. Using createRequire(import.meta.url) keeps the default-client path runtime-safe while tests ignore the path via opts.anthropicClient injection."
  - "Queue back-pressure strategy: shift oldest (FIFO drop-head). Rationale: the most recent transcript delta is freshest; the model benefits more from current context than from a stale historical segment. drop-head + WARN log matches D-28."
  - "All failure modes log at WARN (never ERROR) so pino level thresholds do not page. The only ERROR-level log in this plan is `slow_brain_tools_field_stripped_BUG` — that is a code defect, not a runtime condition."
  - "Reconnect-on-close is OUT of Phase-2 scope per 02-CONTEXT deferred section. Phase 2 opens the sideband once per call; if it closes prematurely, state.ready goes false and subsequent updateInstructions calls log sideband_update_skipped. Reconnect logic arrives in Phase 3."

patterns-established:
  - "test-time WS mocking via in-memory EventEmitter subclass + readyState integer constants — no `ws` library subclassing required"
  - "slow-brain opts override pattern: cadenceCap/timeoutMs/queueMax/pollIntervalMs all env-configurable + test-overridable"
  - "AnthropicClient minimal structural interface — tests inject `{ messages: { create } }`, production uses the real SDK"

requirements-completed:
  - DIR-01
  - DIR-02
  - DIR-03
  - DIR-04
  - DIR-05
  - DIR-06
  - DIR-11

duration: 45min
completed: 2026-04-17
---

# Phase 02 / Plan 05: Sideband WS + Slow-Brain Worker + Config

**The async brain layer is live: Claude Sonnet processes transcript deltas off the hot-path, the sideband pushes only instructions (never tools), and every failure mode degrades gracefully. SC-5 (sideband connect within 1500 ms) and AC-05 (instructions-only) both have test coverage.**

## Outcome

Two complementary modules, both consumed by the 02-07 /accept wiring:

- **sideband.ts** — opens a WebSocket to `wss://api.openai.com/v1/realtime?call_id={callId}` with `Authorization: Bearer $OPENAI_SIP_API_KEY` and `OpenAI-Beta: realtime=v1`. Emits `sideband_ready` on SLA pass, `sideband_timeout` on SLA miss, `sideband_error`/`sideband_closed` through life. `updateInstructions()` is the single writer into the WS.
- **slow-brain.ts** — fire-and-forget async loop consuming a per-call queue of `TranscriptDelta`. Coalesces via cadence cap, aborts stuck Claude calls via AbortController, emits `slow_brain_degraded` / `slow_brain_backpressure` JSONL on failure modes. On success: `updateInstructions(sideband, claudeText, log)`.

The hot-path never awaits either module. Every failure is a logged WARN; no exception propagates.

## Config Matrix

| Constant | Default | Env override | Rationale |
|----------|---------|--------------|-----------|
| `SIDEBAND_CONNECT_TIMEOUT_MS` | 1500 | same | SC-5 gate |
| `SLOW_BRAIN_CADENCE_CAP` | 2 | same | D-25; 0 = disabled |
| `SLOW_BRAIN_TIMEOUT_MS` | 8000 | same | D-27 |
| `SLOW_BRAIN_QUEUE_MAX` | 5 | same | D-28 |
| `SLOW_BRAIN_MODEL` | `claude-sonnet-4-5-20241022` | same | future Phase-3 bump |
| `SIDEBAND_WS_URL_TEMPLATE` | `wss://api.openai.com/v1/realtime?call_id={callId}` | same | env-overridable for staging |

## Artifacts

| Path | Lines | Purpose |
|------|-------|---------|
| `voice-bridge/src/sideband.ts` | 130 | WS client + SLA + updateInstructions + tools-strip |
| `voice-bridge/src/slow-brain.ts` | 150 | async worker + cadence + back-pressure + timeout |
| `voice-bridge/src/config.ts` | +40 lines | 6 new exports |
| `voice-bridge/tests/sideband.test.ts` | 6 cases | open→ready, timeout, headers, tools-strip x2, not-ready skip |
| `voice-bridge/tests/slow-brain.test.ts` | 5 cases | cadence cap, cap=0 disabled, back-pressure, timeout-degrade, continues-after-failure |

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/sideband.test.ts tests/slow-brain.test.ts` — 11 / 11 passed.
- Full suite — 85 passed / 1 skipped.

## SC-5 / AC-05 Gate Evidence

### SC-5 Sideband Connect SLA
```
open → simulate WS 'open' → state.ready=true + log sideband_ready {latency_ms}
silent past 1500ms → timedOut flag + log sideband_timeout {elapsed_ms}
```

### AC-05 Instructions-Only Session Update
```
updateInstructions(state, 'foo', log, { tools: [{ name: 'leak' }] })
→ ws.send({type:'session.update', session:{instructions:'foo'}})  // tools stripped
→ log.error({ event: 'slow_brain_tools_field_stripped_BUG' })
```

## Out of Scope (Deferred)

- **Reconnect after sideband close** — Phase-3 concern. Phase 2 opens once per call. If the WS closes mid-call, `state.ready` falls to `false` and subsequent `updateInstructions` calls log `sideband_update_skipped`.
- **Slow-Brain fine-tuning** — default cadence cap = 2 and queue max = 5 are conservative placeholders. Phase-3 Case-6 live-test data will inform recalibration (same DIR-13 recalibration language applies).
- **Content audit filter on Claude output** — Phase 4+ may add a guardrail that rejects tool-definition-shaped instructions. Current guard is structural (tools field) not semantic.

## Threat-model Disposition

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-05-01 Tampering (tools in session.update) | mitigated | tools-strip test + BUG-level log |
| T-02-05-02 DoS (Claude hang blocks hot-path) | mitigated | AbortController timeout, back-pressure, fire-and-forget; timeout-degrade test proves hot-path uninvolved |
| T-02-05-03 Info disclosure (key in URL) | accepted | bearer is in Authorization header; URL only carries `call_id` |
| T-02-05-04 EoP (Claude writes arbitrary instructions) | accepted | Phase-4+ content audit planned; structural strip in place now |

## Git

- nanoclaw: commit `965dc5a` on `main` — `feat(02-05): sideband WS + Slow-Brain worker + config`

## Next

Wave 2 complete. Ready for Wave 3:
- **02-06** — Turn-timing JSONL + teardown + ghost-scan + PHASE2_PERSONA (D-16..D-19, D-37..D-38)
