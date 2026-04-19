---
phase: 04-core-tool-integration-cost-observability
plan: 01
subsystem: infra
tags: [cost, ledger, sqlite, zod, vitest, infra-06, openai-realtime, pricing]

# Dependency graph
requires:
  - phase: 03-voice-mcp-endpoint
    provides: MCP-tool DI pattern, ToolRegistry, BadRequestError, voice-schedule-retry analog, WG peer-allowlist on port 3200
  - phase: 02-director-bridge-v0-hotpath-safety
    provides: idempotency.ts per-call RAM Map pattern, sideband.ts response event handler, better-sqlite3 11.10.0 dependency, voice-bridge config env-with-default idiom
provides:
  - voice_call_costs, voice_turn_costs, voice_price_snapshots SQLite tables (migrated idempotently in src/db.ts createSchema())
  - src/cost-ledger.ts with insertTurnCost, upsertCallCost, sumCostCurrentDay, sumCostCurrentMonth, insertPriceSnapshot
  - voice-bridge/src/cost/prices.ts static pricing constants + USD_TO_EUR env-override
  - voice-bridge/src/cost/accumulator.ts per-call RAM accumulator with guard flags + Pitfall-1 cached-subset math
  - Core MCP tools voice.record_turn_cost, voice.finalize_call_cost (both Bridge-internal housekeeping, not in Realtime allowlist)
  - Wave-0 test suite (5 files, 32 total passing tests across both repos)
affects: [04-02 (gate + sideband hook), 04-03 (streamable-http exposes cost tools over MCP proper), 04-04 (pricing-refresh cron writes voice_price_snapshots, recon-invoice reads voice_call_costs)]

# Tech tracking
tech-stack:
  added: []  # no new dependencies; all reuse existing zod, better-sqlite3, vitest, fs/path
  patterns:
    - "Per-turn persistence + per-call aggregate upsert (Pitfall 3 — Bridge restart never loses already-recorded turns)"
    - "Pitfall 1: audio_billed = max(0, audio_tokens - cached_tokens); cached billed separately at cached_in rate"
    - "In-RAM per-call state Map mirror of voice-bridge/src/idempotency.ts pattern"
    - "INSERT OR IGNORE on compound PRIMARY KEY (call_id, turn_id) for A12 natural dedup"
    - "Dual createSchema: production call chained in src/db.ts, in-memory re-export in src/cost-ledger.ts for unit tests"
    - "MCP tool DI factory (makeVoice*) mirrors voice-schedule-retry.ts: zod schema + BadRequestError + appendJsonl + graceful DB-error degrade"
    - "vitest include pattern extended to src/**/*.test.ts in voice-bridge (co-located cost/ tests)"

key-files:
  created:
    - src/cost-ledger.ts
    - src/cost-ledger.test.ts
    - src/mcp-tools/voice-record-turn-cost.ts
    - src/mcp-tools/voice-record-turn-cost.test.ts
    - src/mcp-tools/voice-finalize-call-cost.ts
    - src/mcp-tools/voice-finalize-call-cost.test.ts
    - voice-bridge/src/cost/prices.ts
    - voice-bridge/src/cost/prices.test.ts
    - voice-bridge/src/cost/accumulator.ts
    - voice-bridge/src/cost/accumulator.test.ts
  modified:
    - src/db.ts  # +3 CREATE TABLE blocks, +getDatabase() handle export
    - src/mcp-tools/index.ts  # +2 registry.register() calls, +imports
    - voice-bridge/vitest.config.ts  # include pattern adds src/**/*.test.ts

key-decisions:
  - "PRIMARY KEY (call_id, turn_id) on voice_turn_costs — natural compound dedup replaces AUTOINCREMENT id (A12 dictate)"
  - "voice.record_turn_cost + voice.finalize_call_cost are Bridge-internal housekeeping, NOT exposed to OpenAI Realtime allowlist (per PATTERNS.md §Shared Patterns)"
  - "USD_TO_EUR default 0.93 fixed at module-load via env override; pricing-refresh cron (Plan 04-04) bumps via voice_price_snapshots, never mutates prices.ts"
  - "cost-ledger re-exports createSchema() independently of db.ts initDatabase() so in-memory unit tests can spin up just the voice_* tables"
  - "finalize_call_cost recomputes cost_eur via sumTurnCosts DI — never trusts Bridge in-RAM totals (Pitfall 3 defense against mid-call restart)"
  - "DB errors in both MCP tools are graceful-degrade warn-logs — JSONL is the audit trail of last resort"

patterns-established:
  - "Cost math: Pitfall-1 formula documented in accumulator.ts comment + asserted in accumulator.test.ts first test"
  - "Guard flags (warned, enforced) are per-call single-threaded atomicity — check-then-mark in one tick, no race"
  - "MCP tools DI pattern: jsonlPath + now injected for test determinism, real deps supplied in mcp-tools/index.ts"

requirements-completed: [INFRA-06]

# Metrics
duration: 10min
completed: 2026-04-19
---

# Phase 4 Plan 01: Cost-Ledger Skeleton Summary

**Per-turn SQLite cost-ledger + Bridge-side `response.done.usage` math (Pitfall-1 cached-subset) + two Core MCP housekeeping tools — zero enforcement, pure plumbing for Plan 04-02 to build the gate on.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-04-19T14:59:50Z
- **Completed:** 2026-04-19T15:09:00Z
- **Tasks:** 4 (all auto, TDD RED → GREEN)
- **Files created:** 10 (5 production + 5 tests)
- **Files modified:** 3 (src/db.ts, src/mcp-tools/index.ts, voice-bridge/vitest.config.ts)

## Accomplishments

- Extended `src/db.ts` createSchema() with 3 idempotent CREATE TABLE blocks for voice_call_costs / voice_turn_costs / voice_price_snapshots plus 2 supporting indexes.
- Introduced `src/cost-ledger.ts` with 5 typed accessors (insertTurnCost, upsertCallCost, sumCostCurrentDay, sumCostCurrentMonth, insertPriceSnapshot) and an independent `createSchema()` for in-memory testing.
- Landed `voice-bridge/src/cost/prices.ts` with the exact pinned gpt-realtime-mini Nov-2025 pricing table (audio_in 10.00, audio_out 20.00, audio_cached_in 0.30, text_in 0.60, text_out 2.40 USD/Mtok) + `USD_TO_EUR` env-override (default 0.93).
- Landed `voice-bridge/src/cost/accumulator.ts` with Pitfall-1 `costOfResponseDone()` formula explicitly commented in code and asserted in the first test; per-call RAM state Map with guard flags `warned`/`enforced`; `clearCall()` hook for Plan 04-02 to wire at session.closed.
- Registered `voice.record_turn_cost` and `voice.finalize_call_cost` as always-on Core MCP tools following the voice-schedule-retry.ts DI/JSONL/BadRequestError pattern verbatim.
- Wave-0 test suite: 32 passing tests across both repos (19 Core, 13 Bridge) — TDD cycle clean (RED commit eaf4f3f → GREEN commits).

## Task Commits

Each task committed atomically:

1. **Task 1: Wave-0 test skeletons (RED)** — `eaf4f3f` (test)
2. **Task 2: Bridge cost math prices + accumulator (GREEN)** — `4e3fa0a` (feat)
3. **Task 3: DB schema + cost-ledger module (GREEN)** — `9db33f2` (feat)
4. **Task 4: Core MCP tools voice.record_turn_cost + voice.finalize_call_cost (GREEN)** — `938300a` (feat)
5. **Style sweep: prettier format** — `8827b96` (style)

## Files Created/Modified

### Created

- `src/cost-ledger.ts` — SQLite accessors, typed row interfaces, in-memory schema creator
- `src/cost-ledger.test.ts` — 6 tests covering schema, SUM aggregations, PRIMARY KEY dedup, upsert
- `src/mcp-tools/voice-record-turn-cost.ts` — zod-validated DI handler, JSONL audit, graceful DB-fail
- `src/mcp-tools/voice-record-turn-cost.test.ts` — 6 tests (happy path, schema errors, graceful degrade)
- `src/mcp-tools/voice-finalize-call-cost.ts` — upsert handler with sumTurnCosts DI recomputation
- `src/mcp-tools/voice-finalize-call-cost.test.ts` — 7 tests (all terminated_by enum values, soft_warn_fired)
- `voice-bridge/src/cost/prices.ts` — static USD/Mtok constants + USD_TO_EUR env-override
- `voice-bridge/src/cost/prices.test.ts` — 6 tests (all 5 constants + EUR rate)
- `voice-bridge/src/cost/accumulator.ts` — Pitfall-1 math, per-call RAM Map, guard flags
- `voice-bridge/src/cost/accumulator.test.ts` — 7 tests (math, per-call isolation, guard flags, _stateSize)

### Modified

- `src/db.ts` — +3 CREATE TABLE blocks in createSchema() at line 87; +`getDatabase()` handle accessor for cost-ledger.ts
- `src/mcp-tools/index.ts` — +imports and +2 `registry.register()` calls at the end of buildDefaultRegistry()
- `voice-bridge/vitest.config.ts` — include pattern extended to `['tests/**/*.test.ts', 'src/**/*.test.ts']`

## DI Signatures (for Plan 04-02 reference)

```typescript
// src/mcp-tools/voice-record-turn-cost.ts
export interface VoiceRecordTurnCostDeps {
  insertTurnCost: (row: VoiceTurnCostRow) => void;
  jsonlPath?: string;
  now?: () => number;
}
export function makeVoiceRecordTurnCost(deps: VoiceRecordTurnCostDeps): ToolHandler;

// src/mcp-tools/voice-finalize-call-cost.ts
export interface VoiceFinalizeCallCostDeps {
  upsertCallCost: (row: VoiceCallCostRow) => void;
  sumTurnCosts: (call_id: string) => { sum_eur: number; count: number };
  jsonlPath?: string;
  now?: () => number;
}
export function makeVoiceFinalizeCallCost(deps: VoiceFinalizeCallCostDeps): ToolHandler;

// voice-bridge/src/cost/accumulator.ts
export function costOfResponseDone(evt: ResponseDoneEvent): number;
export function add(callId: string, turnId: string, usage: ResponseDoneUsage | undefined, costEur: number): void;
export function totalEur(callId: string): number;
export function warned(callId: string): boolean;
export function enforced(callId: string): boolean;
export function markWarned(callId: string): void;
export function markEnforced(callId: string): void;
export function clearCall(callId: string): void;
export function _stateSize(): number;
```

## Actual Schema (as landed in src/db.ts)

```sql
CREATE TABLE IF NOT EXISTS voice_call_costs (
  call_id TEXT PRIMARY KEY,
  case_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  cost_eur REAL NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  terminated_by TEXT,
  soft_warn_fired INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT 'gpt-realtime-mini'
);
CREATE INDEX IF NOT EXISTS idx_voice_call_costs_started ON voice_call_costs(started_at);

CREATE TABLE IF NOT EXISTS voice_turn_costs (
  call_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  audio_in_tokens INTEGER NOT NULL DEFAULT 0,
  audio_out_tokens INTEGER NOT NULL DEFAULT 0,
  cached_in_tokens INTEGER NOT NULL DEFAULT 0,
  text_in_tokens INTEGER NOT NULL DEFAULT 0,
  text_out_tokens INTEGER NOT NULL DEFAULT 0,
  cost_eur REAL NOT NULL,
  PRIMARY KEY (call_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_voice_turn_costs_call ON voice_turn_costs(call_id);

CREATE TABLE IF NOT EXISTS voice_price_snapshots (
  ts TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  audio_in_usd REAL NOT NULL,
  audio_out_usd REAL NOT NULL,
  audio_cached_usd REAL NOT NULL,
  text_in_usd REAL NOT NULL,
  text_out_usd REAL NOT NULL,
  usd_to_eur REAL NOT NULL,
  source TEXT NOT NULL
);
```

## Actual Pinned Pricing (as landed)

```typescript
// voice-bridge/src/cost/prices.ts
export const PRICES_USD_PER_MTOK = {
  text_in: 0.6,
  text_out: 2.4,
  audio_in: 10.0,
  audio_out: 20.0,
  audio_cached_in: 0.3,
} as const
export const USD_TO_EUR = Number(process.env.USD_TO_EUR ?? 0.93)
```

## Decisions Made

All per-plan. No architectural deviations. Notable:

- **PRIMARY KEY (call_id, turn_id) on voice_turn_costs** (plan-prescribed, A12 compliant): natural compound dedup replaces AUTOINCREMENT id — SQLite's own `INSERT OR IGNORE` enforces idempotency at the DB layer, so the MCP-tool handler is free of dedup logic.
- **`voice.record_turn_cost` / `voice.finalize_call_cost` are Bridge-internal**: per PATTERNS.md, these do NOT need schemas in `voice-bridge/src/tools/allowlist.ts`. They are never surfaced to the OpenAI Realtime model — only the Bridge process calls them via Core MCP HTTP.
- **`getDatabase()` accessor added to src/db.ts** (plan implicit, Rule-3 convenience): the plan's sketch imported `db as coreDb` directly, but `db` was module-local. Adding a typed `getDatabase()` accessor preserves initialization guarantees while letting cost-ledger share the same handle.
- **`cost-ledger.ts` re-exports `createSchema()`** (plan-prescribed): enables isolated in-memory unit tests without pulling the full NanoClaw schema + JSON-migration side effects.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] voice-bridge vitest include pattern excluded src/**/*.test.ts**
- **Found during:** Task 1 (Wave-0 test skeletons)
- **Issue:** `voice-bridge/vitest.config.ts` only included `tests/**/*.test.ts`. Plan explicitly requires `voice-bridge/src/cost/prices.test.ts` and `voice-bridge/src/cost/accumulator.test.ts` (co-located pattern). Without config change, vitest would not discover the new tests.
- **Fix:** Extended `include` pattern to `['tests/**/*.test.ts', 'src/**/*.test.ts']`.
- **Files modified:** `voice-bridge/vitest.config.ts`
- **Verification:** `npx vitest run src/cost/prices.test.ts src/cost/accumulator.test.ts` now discovers and runs both files (13 tests pass after Task 2).
- **Committed in:** `eaf4f3f` (part of Task 1 commit)

**2. [Rule 3 - Blocking] Plan import path `'../src/cost-ledger.js'` in cost-ledger.test.ts wrong for src/ colocation**
- **Found during:** Task 1 (writing test skeleton)
- **Issue:** Plan action block suggested `import … from '../src/cost-ledger.js'` but the test file lives AT `src/cost-ledger.test.ts`, so the relative path to its sibling is `'./cost-ledger.js'`.
- **Fix:** Used `'./cost-ledger.js'` (sibling import) in the test.
- **Files modified:** `src/cost-ledger.test.ts`
- **Verification:** Test discovers the module after Task 3 lands `src/cost-ledger.ts` (6/6 GREEN).
- **Committed in:** `eaf4f3f`

**3. [Rule 3 - Blocking] `db` variable not exported from src/db.ts**
- **Found during:** Task 3 (writing cost-ledger.ts)
- **Issue:** Plan sketch used `import { db as coreDb } from './db.js'` but `db` was `let db: Database.Database` — module-local, not exported. Direct import would be `undefined`.
- **Fix:** Added `export function getDatabase(): Database.Database` accessor to db.ts that throws if called before `initDatabase()`/`_initTestDatabase()`. cost-ledger.ts uses it as the default for `sumCostCurrentDay/Month` when no explicit handle is passed. MCP tool wiring in index.ts uses `getDatabase()` inside the closure (lazy, so test registry builds before DB init don't blow up).
- **Files modified:** `src/db.ts`, `src/cost-ledger.ts`, `src/mcp-tools/index.ts`
- **Verification:** `npx tsc --noEmit` 0 errors; all tests GREEN.
- **Committed in:** `9db33f2` (db.ts + cost-ledger.ts), `938300a` (mcp-tools/index.ts)

---

**Total deviations:** 3 auto-fixed (all Rule 3 - blocking)
**Impact on plan:** All three are minor wiring corrections where the plan's literal code sketch diverged from actual file structure. No architectural changes. No scope creep.

## Issues Encountered

- `npx tsc --noEmit` in `voice-bridge/` surfaces PRE-EXISTING errors (fastify/ajv-formats/fastest-levenshtein module not found) due to worktree `node_modules` being incomplete — **pre-existing, out of scope** for this plan. Verified with `grep -E "src/cost/"` that NO typecheck errors in the new `src/cost/*` files. Core-repo typecheck (`npx tsc --noEmit` at repo root) is clean.
- Lint warnings (`no-catch-all/no-catch-all`) on both new MCP tools for the graceful-degrade catch-blocks. Identical to the existing convention in `src/mcp-tools/voice-schedule-retry.ts` (same 2 warnings there). 0 Errors. Not a regression.

## Open Items Flagged for Plan 04-02

Per plan `<output>` requirement:

- **(i) sideband.ts hook NOT installed.** `voice-bridge/src/sideband.ts` still has no `parsed?.type === 'response.done'` branch. Plan 04-02 Task 3 is scoped to add it, calling `costOfResponseDone(evt) + accumulator.add(...) + fire-and-forget voice.record_turn_cost` and then checking the 80%/100% thresholds.
- **(ii) gate.ts NOT installed.** `/accept`-time daily/monthly SUM query gate is deferred to Plan 04-02 Task 2 (new `voice.get_day_month_cost_sum` MCP tool + Bridge-side `gate.ts`).
- **(iii) A12 invokeIdempotent wrapper in dispatch.ts NOT nachgerüstet.** `voice-bridge/src/tools/dispatch.ts` currently calls `callCoreTool` directly without idempotency. Plan 04-02 Task 1 audits this and wraps the dispatch path through `invokeIdempotent()` for the mutating tools per the RESEARCH Idempotency Scheme table.

## User Setup Required

None — no external service configuration. USD_TO_EUR env-override is optional (default 0.93).

## Next Phase Readiness

- **Plan 04-02 unblocked:** All DI signatures + DB schema + RAM accumulator primitives are in place. The gate (Task 2) and sideband hook (Task 3) consume the `voice.record_turn_cost`/`voice.finalize_call_cost` tools and the `accumulator.ts` module shipped here.
- **Plan 04-03 (StreamableHTTP) unblocked:** both cost-housekeeping tools live in the same `ToolRegistry` the new `src/mcp-stream-server.ts` will mount — single-source registry invariant preserved.
- **Plan 04-04 (pricing refresh cron) unblocked:** `voice_price_snapshots` table + `insertPriceSnapshot()` accessor exist; Hetzner-side `pricing-refresh.sh` will POST via a new `voice.insert_price_snapshot` tool (Plan 04-04 Task 2 Wave-0-for-Wave-4).

## Self-Check: PASSED

Files verified to exist:
- FOUND: src/cost-ledger.ts
- FOUND: src/cost-ledger.test.ts
- FOUND: src/mcp-tools/voice-record-turn-cost.ts
- FOUND: src/mcp-tools/voice-record-turn-cost.test.ts
- FOUND: src/mcp-tools/voice-finalize-call-cost.ts
- FOUND: src/mcp-tools/voice-finalize-call-cost.test.ts
- FOUND: voice-bridge/src/cost/prices.ts
- FOUND: voice-bridge/src/cost/prices.test.ts
- FOUND: voice-bridge/src/cost/accumulator.ts
- FOUND: voice-bridge/src/cost/accumulator.test.ts

Commits verified to exist:
- FOUND: eaf4f3f (Task 1)
- FOUND: 4e3fa0a (Task 2)
- FOUND: 9db33f2 (Task 3)
- FOUND: 938300a (Task 4)
- FOUND: 8827b96 (prettier sweep)

Wave-0 tests verified GREEN:
- Core: 19/19 passing (cost-ledger.test.ts 6 + voice-record-turn-cost.test.ts 6 + voice-finalize-call-cost.test.ts 7)
- Bridge: 13/13 passing (prices.test.ts 6 + accumulator.test.ts 7)

---

*Phase: 04-core-tool-integration-cost-observability*
*Completed: 2026-04-19*
