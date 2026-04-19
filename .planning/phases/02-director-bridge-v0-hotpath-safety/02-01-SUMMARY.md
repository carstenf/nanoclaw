---
phase: 02-director-bridge-v0-hotpath-safety
plan: 01
subsystem: voice-bridge
tags: [allowlist, ajv, schema-validation, mcp-proxy, tool-safety, nodenext-esm]

requires:
  - phase: 01-infrastructure-webhook-path
    provides: "voice-bridge fastify app, pino JSONL logger pattern, NodeNext ESM tsconfig, vitest harness"
provides:
  - "Static tool allowlist of 9 ToolEntry records covering REQ-TOOLS-01..08 + confirm_action"
  - "ajv strict validators precompiled at module load, one per tool"
  - "REQ-TOOLS-09 15-tool ceiling guard fires at module load"
  - "dispatchTool() gate returning synthetic tool_error on unknown name / schema fail"
  - "INVALID_TOOL_RESPONSE canonical safety message for downstream reuse"
affects: [02-02, 02-04, 02-06, 02-07]

tech-stack:
  added: ["ajv@^8.17.1", "ajv-formats@^3.0.1"]
  patterns:
    - "JSONSchema7 (draft-07) with additionalProperties: false and explicit required arrays"
    - "ajv default export unwrap via .default for NodeNext ESM/CJS interop"
    - "Static REGISTRY + ENTRIES[] at module scope, getEntry/getAllowlist as read-only accessors"

key-files:
  created:
    - voice-bridge/src/tools/allowlist.ts
    - voice-bridge/src/tools/dispatch.ts
    - voice-bridge/src/tools/schemas/check_calendar.json
    - voice-bridge/src/tools/schemas/create_calendar_entry.json
    - voice-bridge/src/tools/schemas/send_discord_message.json
    - voice-bridge/src/tools/schemas/get_contract.json
    - voice-bridge/src/tools/schemas/search_competitors.json
    - voice-bridge/src/tools/schemas/get_practice_profile.json
    - voice-bridge/src/tools/schemas/schedule_retry.json
    - voice-bridge/src/tools/schemas/transfer_call.json
    - voice-bridge/src/tools/schemas/confirm_action.json
    - voice-bridge/tests/allowlist.test.ts
    - voice-bridge/tests/dispatch.test.ts
  modified:
    - voice-bridge/package.json

key-decisions:
  - "9 tool entries — NOT 10 as the plan frontmatter (must_haves + acceptance_criteria) read. The code sample in Task 01-02 lists 9 (TOOLS-01..08 = 8 + confirm_action = 1). The '10' in must_haves is a spec typo; a follow-up patch to the PLAN frontmatter is recommended."
  - "ajv strict: true — rejects schemas that omit required metadata. Future schemas must include type + required arrays."
  - "additionalProperties: false on every schema — prevents silent argument drift (T-02-01-02)."
  - "ajv-formats default import unwrapped via `.default`. Under NodeNext + pure-CJS ajv-formats, the default import resolves to the module namespace instead of the function; manual unwrap keeps the call fully typed."
  - "dispatchTool() returns placeholder `{type:'tool_call_accepted', tool_name}` on success — MCP forwarding intentionally deferred to Phase 3/4 per D-36. 02-02 idempotency wrapper will cache this stub."
  - "mutating-flag mapping (D-05): 5 mutating (create_calendar_entry, send_discord_message, schedule_retry, transfer_call, confirm_action), 4 read-only (check_calendar, get_contract, search_competitors, get_practice_profile). Confirm_action is MUTATING even though it has no side-effect by itself — it is the C6-03 readback anchor that unlocks a later mutating call."

patterns-established:
  - "Bridge-side schema validation pattern: JSONSchema7 file → precompiled ajv ValidateFunction → ToolEntry registry → dispatch gate"
  - "Synthetic tool_error pattern: `{type:'tool_error', message, code:'invalid_tool_call'}` + log.warn JSONL — reused by future invalid-call paths"
  - "ESM/CJS interop shim for default-function modules under NodeNext"

requirements-completed:
  - DIR-08
  - DIR-10
  - VOICE-09

duration: 25min
completed: 2026-04-17
---

# Phase 02 / Plan 01: Tool Allowlist + ajv Schemas + MCP-Proxy Dispatch

**The Bridge now has a hard safety envelope — fabricated tool names and malformed args are rejected before reaching NanoClaw Core, closing D-07..D-10 and anchoring PRD AC-09 (Bridge as thin MCP-proxy).**

## Outcome

Every Realtime-side tool-call now passes through a single gate (`dispatchTool()`) that:

1. Rejects unknown names (`reason: 'unknown_name'`) — T-02-01-01 spoofing mitigated.
2. Rejects schema-fail args (`reason: 'schema_fail'`) — T-02-01-02 tampering mitigated; `additionalProperties: false` prevents silent argument drift.
3. Returns the canonical synthetic `INVALID_TOOL_RESPONSE` on both failure modes, so the Realtime model receives a deterministic failure shape it can recover from.
4. On success, returns an accepted-stub `{type:'tool_call_accepted', tool_name}`. Actual MCP forwarding to NanoClaw Core is intentionally deferred to Phase 3/4 (D-36); the 02-02 idempotency wrapper will cache this stub so duplicate invocations short-circuit here.

Tool handlers remain 100% in NanoClaw Core (AC-09). `grep -r "Core MCP\|handler body" voice-bridge/src/tools/` returns zero matches — no handler code leaked into the Bridge.

## Artifacts

| Path | Lines | Purpose |
|------|-------|---------|
| `voice-bridge/src/tools/allowlist.ts` | 66 | ToolEntry[] registry + compiled validators + ceiling guard |
| `voice-bridge/src/tools/dispatch.ts` | 53 | MCP-proxy gate with JSONL warn logs |
| `voice-bridge/src/tools/schemas/*.json` | 9 files | JSONSchema7 per tool (draft-07, strict additionalProperties) |
| `voice-bridge/tests/allowlist.test.ts` | 11 cases | registry shape + mutating audit + fabricated-name path |
| `voice-bridge/tests/dispatch.test.ts` | 5 cases | unknown_name / schema_fail / happy-path / confirm_action / additionalProperties injection |

## Tool Inventory (9 entries, cap 15)

| Name | Mutating | Notes |
|------|----------|-------|
| check_calendar | no | read-only |
| create_calendar_entry | yes | idempotent (REQ-TOOLS-02) |
| send_discord_message | yes | idempotent via content-hash (REQ-TOOLS-03) |
| get_contract | no | read-only |
| search_competitors | no | read-only, flexible criteria object |
| get_practice_profile | no | read-only |
| schedule_retry | yes | E.164 target_phone, ISO date-time not_before_ts |
| transfer_call | yes | FreeSWITCH REFER — Case 4 takeover |
| confirm_action | yes | C6-03 readback anchor (flag=mutating because it gates later mutators) |

`REGISTRY.size === 9`, `ENTRIES.length > 15` guard throws at boot.

## Verification

- `npm run build` (tsc --noEmit) — clean.
- `npx vitest run tests/allowlist.test.ts tests/dispatch.test.ts` — 16 / 16 passed.
- Full suite `npx vitest run` — 25 passed / 1 skipped (Phase-1 tests unaffected).
- `ls voice-bridge/src/tools/schemas/*.json | wc -l` = 9 (NOT 10 — see "Deviations").
- `grep -c 'additionalProperties": false' schemas/*.json` matches all 9 files.
- `grep -r 'Core MCP\|handler body' voice-bridge/src/tools/` = 0 matches → AC-09 trace clean.

## Deviations from PLAN

1. **Schema count**: PLAN frontmatter `must_haves.truths[0]` and `acceptance_criteria` both specify "10" schemas / "exactly 10 tool entries". The PLAN's own Task 01-02 code listing has 9 entries (TOOLS-01..08 + confirm_action), and the mutating-counts test ("true=5, false=4", sum=9) only balances at 9. Implemented 9 as per the authoritative code sample. Recommend a spec patch to REQUIREMENTS.md and PLAN frontmatter to read "9 entries".

2. **ajv default-import unwrap**: The PLAN's code sample uses `import Ajv from 'ajv'` and `import addFormats from 'ajv-formats'`. Under NodeNext strict ESM, neither works — ajv's TS default export maps to the namespace object, and ajv-formats returns the namespace instead of the function. Replaced with `import { Ajv } from 'ajv'` (named) and a manual `.default` unwrap for ajv-formats. Runtime behavior identical; types remain sound.

3. **Extra helper `logAllowlistCompiled(log)`**: Added a small helper that emits the PATTERNS-mandated JSONL boot event (`event: 'allowlist_compiled', tool_count, mutating_count`). Not wired into the app yet — 02-07 (/accept full wiring) will call it at boot. Zero-cost to ship now; would otherwise need a duplicate edit in 02-07.

## Threat-model Disposition

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-01-01 Spoofing (fabricated name) | mitigated | dispatch.test.ts `foo_bar_drop_db` path → `INVALID_TOOL_RESPONSE`, JSONL `reason: 'unknown_name'` |
| T-02-01-02 Tampering (bad args) | mitigated | allowlist.test.ts `additionalProperties` rejection + dispatch.test.ts `schema_fail` path |
| T-02-01-03 Elevation (un-vetted MCP dispatch) | mitigated | dispatch.ts is the only callsite; success branch returns accepted-stub only |
| T-02-01-04 Info disclosure (ajv.errors in logs) | accepted | errors are structural, not user PII |

## Git

- nanoclaw: commit `f4b174a` on `main` — `feat(02-01): tool allowlist + ajv schemas + MCP-proxy dispatch gate`

## Next

Wave 1 continues with:
- **02-02** — idempotency sha256 wrapper (mutating-only, RAM map, per-call TTL) that wraps `dispatchTool()`
- **02-03** — RAM-only audio hygiene + CI grep-guard + STT-Whisper sidecar removal
