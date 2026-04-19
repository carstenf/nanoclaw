# Phase 2+ Backlog

Ideas and features deferred from earlier phases. Prioritized in Phase-2 planning.

---

## Balance-Alert: OpenAI-Account low-credit warning

**Source:** Phase 1 (carsten_bot conversation 2026-04-16), decision `2026-04-16-sidecar-removal-bridge-accept.md` §6.

**Motivation:** Phase 1 had a 2+ hour debug session that was entirely caused by an empty OpenAI account — `realtime.calls.accept()` returns 200 OK without credits but inference output is silent-dropped. No error surfaces anywhere (Bridge, FS, webhook logs all green). External knowledge of account balance was the only way to diagnose.

**Goal:** Detect "credits exhausted" mode and alert before / during a call, not after user complaint.

**Options evaluated:**

1. **Direct billing-API poll** — App-scoped API keys generally lack billing scope (`/v1/dashboard/billing/*` requires session token or admin key). Unreliable without re-architecting key management.
2. **Reactive silent-inference heuristic** — Bridge watches for N consecutive PCMA-silence-packets (`0xd5d5...`) within M seconds after `Answered`. Emit Discord alert + attempt `calls.reject()` if threshold crossed. Works without billing scope.
3. **OpenAI Usage-API poll** (`/v1/organization/usage`) — Reports spend, not remaining balance. Can heuristically flag rapid-burn (spend per hour > threshold).

**Suggested for Phase-2:** Option 2 (reactive heuristic), optionally combined with Option 3 (weekly spend summary to Discord). Scope ~0.5 day.

**Acceptance hint:**
- On N=50 consecutive silence packets (~1 s), bridge emits `event: credits_exhausted_suspected` to JSONL log and Discord webhook
- Subsequent accepts log the same event but continue — avoids repeated spam
- Reset on any non-silence RTP frame observed

---

## Sidecar-based outbound call path rebuild

**Source:** Phase 1 cleanup (Plan 01-05b). `makeFreeswitchCall()` and `acceptOpenAICallForOutbound()` in legacy `freeswitch-voice.ts` depended on a non-running sidecar on `10.0.0.1:4500`. During cleanup these were reduced to a deprecation stub that throws on invocation.

**Blast radius if ignored:** Core can no longer initiate outbound FreeSWITCH-mediated calls (e.g. Twilio ↔ NanoClaw or agent-to-user callback flows that were designed against the old sidecar).

**Approach:** Rebuild outbound-initiator as a voice-bridge endpoint (`POST /originate` — hand off to FS via mod_sofia originate command, then return sideband-WS URL for the session). Phase 2 scope.

---

## voice-bridge session.update for dynamic persona

**Source:** Plan 01-05b — `PHASE1_PERSONA` is a hard-coded const in `voice-bridge/src/config.ts`. Per REQ-DIR-03 ("Bridge injects Core context at accept") the bridge should pull per-group / per-caller persona from Core at accept time and inject via `session.update` or accept-params.

**Approach:** voice-bridge calls Core on `accept` for persona lookup, then supplies to OpenAI. Needs a Core-to-Bridge protocol (REST or gRPC). Phase 2 scope.
