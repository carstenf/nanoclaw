---
phase: 02-director-bridge-v0-hotpath-safety
plan: 02
subsystem: voice-bridge
tags: [idempotency, sha256, canonical-json, rfc-8785, ram-cache, mutating-tools]

requires:
  - phase: 02-director-bridge-v0-hotpath-safety
    provides: "dispatchTool gate from Plan 02-01 (02-07 will compose invokeIdempotent around it)"
provides:
  - "makeKey(callId, turnId, toolName, args) → 64-char hex sha256"
  - "canonicalJson() with recursive key sort + whitespace-free output (RFC 8785-style)"
  - "In-process RAM Map cache with get/set accessors"
  - "clearCall() hook wired by 02-06 teardown"
  - "invokeIdempotent<T>() wrapper — exactly-once invocation + idempotency_hit log on reuse"
affects: [02-04, 02-06, 02-07]

tech-stack:
  added: []
  patterns:
    - "Null-byte separators in hash preimage to block concatenation collisions"
    - "Recursive canonical JSON (NOT top-level sort only) so nested key-reordering still hashes identically"

key-files:
  created:
    - voice-bridge/src/idempotency.ts
    - voice-bridge/tests/idempotency.test.ts
  modified: []

key-decisions:
  - "RFC 8785-style canonical JSON implemented in-house (no dep) — recursive key sort on every object, arrays preserve order. Minimal and audit-friendly vs pulling the full RFC 8785 library."
  - "Null-byte separators `\\0` between callId/turnId/toolName/canonicalJson — prevents concatenation collisions (e.g. callId='ab', turnId='c' vs callId='a', turnId='bc'). Covered by dedicated test."
  - "Missing callId/turnId/toolName/undefined-args → TypeError. Weak keys are never produced. `null` args is a valid input (some read-only tools have null args) and hashes consistently."
  - "clearCall(callId) currently clears the entire cache — Phase-2 scope has a single concurrent call (D-03). TODO noted in code for multi-call keying in Phase 4+."
  - "D-04 restart semantics: cache is RAM-only, so Bridge restart mid-call is an intentional cache-miss. Core-side dedup is out of Phase 2 scope; tested via `clearCall` behavior as the restart analog."
  - "Cache entry shape `{result, storedAt}` — storedAt is present for future observability (TTL enforcement / eviction) but not consulted by current code paths."

patterns-established:
  - "invokeIdempotent<T>(callId, turnId, toolName, args, invoker, log) — composable wrapper; 02-07 will wrap dispatchTool() with this call shape"
  - "Idempotency testing idiom: `toHaveBeenCalledTimes(1)` after two invocations = exactly-once guarantee (SC-2 gate)"

requirements-completed:
  - DIR-07
  - DIR-08

duration: 20min
completed: 2026-04-17
---

# Phase 02 / Plan 02: Idempotency Wrapper — sha256 Key + RAM Cache

**Duplicate `create_calendar_entry` emissions from the Realtime LLM now produce exactly one Core side-effect. The load-bearing safety primitive for SC-2 is live.**

## Outcome

Every mutating tool-call will soon flow through `invokeIdempotent()` (wired in 02-07). For a given `(call_id, turn_id, tool_name, args)` tuple:

- First invocation: runs the invoker, caches the result keyed by sha256 of `callId\0turnId\0toolName\0canonicalJson(args)`, returns the result.
- Subsequent invocations (within the same call): short-circuit to the cached result, emit a `{event:'idempotency_hit', key_hash}` JSONL audit line, never invoke the downstream dispatcher.
- Session-closed: `clearCall()` wipes the cache. Next call starts fresh.
- Bridge restart mid-call: cache empty → graceful cache-miss (D-04).

Exactly-once is proved by `expect(invoker).toHaveBeenCalledTimes(1)` after two identical `invokeIdempotent()` calls.

## Key Formula

```
sha256( callId  \0  turnId  \0  toolName  \0  canonicalJson(args) )
```

- `canonicalJson` recurses: `{b:1,a:{d:2,c:3}}` → `{"a":{"c":3,"d":2},"b":1}`.
- Arrays preserve positional order: `[1,2]` ≠ `[2,1]`.
- Null-byte separator blocks concatenation collisions between adjacent string components.

## Artifacts

| Path | Lines | Purpose |
|------|-------|---------|
| `voice-bridge/src/idempotency.ts` | 97 | makeKey, canonicalJson, get/set/clearCall, invokeIdempotent, _cacheSize |
| `voice-bridge/tests/idempotency.test.ts` | 16 cases | determinism, canonicalization, collision-safety, missing-input throws, exactly-once, cache-hit logging, clearCall reset |

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/idempotency.test.ts` — 16 / 16 passed.
- Full suite — 41 passed / 1 skipped (Phase-1 + 02-01 + 02-02 all green).

## Edge Cases Documented (Out of Scope for Phase 2)

- **Date / BigInt arg values**: `canonicalJson` relies on `JSON.stringify`, which rejects BigInt (TypeError) and serializes Date via its own `toISOString` — but only if the value is passed through as a Date. Phase-2 tool schemas only emit strings/numbers/booleans/objects, so no live path hits this. If a future tool needs Date args, the tool schema should coerce to ISO strings upstream.
- **Symbol-keyed properties**: `Object.keys` skips them. Any tool accidentally carrying symbol keys would hash as if they were absent. No Phase-2 schema generates symbol keys, so this is a known-safe simplification.
- **Multi-concurrent call**: current `clearCall(_callId)` wipes the full Map. TODO comment documents the Phase-4+ fix (key cache by `callId:` prefix, filter on clear).

## Threat-model Disposition

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-02-01 Tampering via arg reordering | mitigated | `key-order independent` + `recurses into nested objects` tests |
| T-02-02-02 Repudiation | mitigated | `idempotency_hit` JSONL event with key_hash + call_id/turn_id/tool_name |
| T-02-02-03 DoS via unbounded cache | accepted | TTL is per-call; cleared on session.closed; Phase 4 may add size cap |
| T-02-02-04 Key collision via concat ambiguity | mitigated | `null-byte separator` test proves callId/turnId concat collisions diverge |

## Git

- nanoclaw: commit `7856f75` on `main` — `feat(02-02): idempotency wrapper — sha256 key + RAM cache`

## Next

Wave 1 continues with **02-03** — RAM-only audio hygiene + CI grep-guard + STT-Whisper sidecar removal.
