# Phase 2: Director Bridge v0 + Hot-Path Safety - Pattern Map

**Mapped:** 2026-04-17
**Files analyzed:** 14 (8 new, 6 modified)
**Analogs found:** 13 / 14

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `voice-bridge/src/sideband.ts` | service | event-driven (WS client) | `voice-bridge/src/heartbeat.ts` | role-match (async loop + graceful degrade) |
| `voice-bridge/src/idempotency.ts` | utility | transform | `voice-bridge/src/config.ts` (Map pattern) | partial (same module shape, no analog) |
| `voice-bridge/src/tools/allowlist.ts` | config/registry | request-response | `voice-bridge/src/config.ts` (getWhitelist) | role-match |
| `voice-bridge/src/tools/schemas/*.json` | config | static | `voice-bridge/tsconfig.json` (resolveJsonModule) | structural only |
| `voice-bridge/src/readback/normalize.ts` | utility | transform | `voice-bridge/src/webhook.ts` (extractCaller) | partial (same string normalization style) |
| `voice-bridge/src/readback/validator.ts` | utility | request-response | `voice-bridge/src/webhook.ts` (unwrap + error branch) | role-match |
| `voice-bridge/src/slow-brain.ts` | service | event-driven (queue) | `voice-bridge/src/heartbeat.ts` | role-match (async loop + degrade) |
| `voice-bridge/src/turn-timing.ts` | utility | file-I/O (JSONL write) | `voice-bridge/src/logger.ts` | exact (same JSONL sink) |
| `voice-bridge/src/webhook.ts` (modify) | controller | request-response | self (extend existing) | exact |
| `voice-bridge/src/index.ts` (modify) | controller | request-response | self (extend existing) | exact |
| `voice-bridge/src/config.ts` (modify) | config | — | self (extend existing) | exact |
| `voice-bridge/src/logger.ts` (modify) | utility | file-I/O | self (extend existing) | exact |
| `voice-bridge/tests/replay/*.test.ts` | test | batch (fixture replay) | `voice-bridge/tests/accept.test.ts` | role-match |
| `voice-bridge/tests/fixtures/spike-e/*.jsonl` | fixture | — | `nanoclaw-state/voice-channel-spec/spike/candidate-e/raw/` | exact (copy) |

---

## Pattern Assignments

### `voice-bridge/src/sideband.ts` (service, event-driven WS client)

**Analog:** `voice-bridge/src/heartbeat.ts`

**Imports pattern** (heartbeat.ts lines 1-10):
```typescript
import { setTimeout as sleep } from 'node:timers/promises'
import type pino from 'pino'
import { sendDiscordAlert } from './alerts.js'
```
Follow the same import style: named node: imports, type-only pino import, `.js` extension on all local imports (NodeNext moduleResolution requires `.js` even for `.ts` source files).

**Async loop + graceful degrade pattern** (heartbeat.ts lines 74-80):
```typescript
export async function startHeartbeat(log: pino.Logger): Promise<void> {
  const state: HeartbeatState = { lastAlertAt: 0, consecutiveFailures: 0 }
  while (true) {
    await runHeartbeatOnce(log, state)
    await sleep(POLL_INTERVAL_MS)
  }
}
```
For sideband: replace the polling loop with a WS event-driven model. The `state` struct pattern holds per-call session state (call_id, ws handle, ready flag, last-instruction-turn). Keep `startXxx(log)` + `runXxxOnce(log, state)` split — unit-testable without running the infinite loop.

**AbortController timeout pattern** (heartbeat.ts lines 31-38):
```typescript
const ctrl = new AbortController()
const timer = setTimeout(() => ctrl.abort(), FAIL_THRESHOLD_MS)
const r = await fetch(wgPeerUrl, { signal: ctrl.signal })
clearTimeout(timer)
```
Re-use for sideband WS connect timeout (D-43: 1500 ms SLA from `/accept` 200 to `sideband.ready`). WebSocket libraries accept an `AbortSignal`; if not, wrap in a `Promise.race` with a rejection timer.

**Error/degrade pattern** (heartbeat.ts lines 55-68):
```typescript
log.warn({
  event: 'wg_canary_fail',
  detail,
  elapsed_ms: elapsed,
  consecutive: state.consecutiveFailures,
})
```
For sideband failures: log `{event:'slow_brain_degraded', reason}` at `warn` level (not `error` — hot-path unaffected per D-27). Never throw from the sideband coroutine into the request path.

**Export for testing** (heartbeat.ts lines 24-27):
```typescript
export async function runHeartbeatOnce(
  log: pino.Logger,
  state: HeartbeatState,
): Promise<void> {
```
Export the per-connection handler (e.g. `openSidebandSession(callId, log, state)`) so tests can call it directly without entering the WS event loop.

---

### `voice-bridge/src/idempotency.ts` (utility, transform)

**No direct analog.** Closest structural reference is `config.ts` `getWhitelist()` which builds a `Set<string>` in-process. Follow the same module shape.

**Module shape to follow** (config.ts lines 52-60):
```typescript
export function getWhitelist(): Set<string> {
  const raw = process.env.INBOUND_CALLER_WHITELIST ?? ''
  return new Set(
    raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
  )
}
```

**Idempotency module pattern to implement:**
```typescript
// src/idempotency.ts
import { createHash } from 'node:crypto'

export interface IdempotencyEntry {
  result: unknown
  storedAt: number
}

// Per-call Map: key = sha256 hash, value = cached MCP result
// Cleared on session.closed (D-03).
const cache = new Map<string, IdempotencyEntry>()

/**
 * D-02: key = sha256(call_id + turn_id + tool_name + canonical_json(arguments))
 * canonical_json = RFC 8785-style sorted-keys, no whitespace.
 */
export function makeKey(
  callId: string,
  turnId: string,
  toolName: string,
  args: unknown,
): string {
  const canon = canonicalJson(args)
  return createHash('sha256')
    .update(`${callId}\0${turnId}\0${toolName}\0${canon}`)
    .digest('hex')
}

export function get(key: string): IdempotencyEntry | undefined {
  return cache.get(key)
}

export function set(key: string, result: unknown): void {
  cache.set(key, { result, storedAt: Date.now() })
}

export function clearCall(_callId: string): void {
  // Per D-03: TTL is per-call. Clear all entries on session.closed.
  // If multiple concurrent calls are needed later, key by callId prefix.
  cache.clear()
}
```

**JSONL log field for cache hit** (extend logger pattern per D-06):
```typescript
log.info({
  event: 'idempotency_hit',
  call_id,
  turn_id,
  tool_name,
  key_hash: key.slice(0, 16), // abbreviated for log readability
})
```

---

### `voice-bridge/src/tools/allowlist.ts` (config/registry, request-response)

**Analog:** `voice-bridge/src/config.ts` — the `getWhitelist()` lazy-getter pattern.

**Import pattern** (config.ts lines 1-6):
```typescript
// No zod — project uses plain TypeScript interfaces + process.exit(1) on missing config.
// Same approach: export named constants + lazy getter functions.
```

**Allowlist module pattern:**
```typescript
// src/tools/allowlist.ts
// Static tool registry derived from REQ-TOOLS-01..08 (D-07).
// Compiled by ajv at boot; mutating flag drives idempotency + readback scope.

import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type { JSONSchemaType } from 'ajv'

export interface ToolEntry {
  name: string
  mutating: boolean          // true = idempotency + readback applies
  schema: Record<string, unknown>  // JSONSchema7
  validate: (args: unknown) => boolean
}

// ajv strict mode, compiled at module load (D-08)
const ajv = new Ajv({ strict: true })
addFormats(ajv)

// Schemas imported via resolveJsonModule (tsconfig.json has "resolveJsonModule": true)
import checkCalendarSchema from './schemas/check_calendar.json' assert { type: 'json' }
// ... one import per tool schema file

const ENTRIES: ToolEntry[] = [
  {
    name: 'check_calendar',
    mutating: false,
    schema: checkCalendarSchema,
    validate: ajv.compile(checkCalendarSchema),
  },
  // ... add mutating tools (create_*, schedule_*, send_*, confirm_*)
]

// Keyed by name for O(1) lookup
const REGISTRY = new Map(ENTRIES.map((e) => [e.name, e]))

export function getAllowlist(): ToolEntry[] {
  return ENTRIES
}

export function getEntry(name: string): ToolEntry | undefined {
  return REGISTRY.get(name)
}
```

**Failure response pattern** (D-09 — synthetic tool_error, mirrors webhook 401 in webhook.ts lines 33-35):
```typescript
// Return this to Realtime session on allowlist miss or schema fail:
const INVALID_TOOL_RESPONSE = {
  type: 'tool_error',
  message: 'Das kann ich gerade leider nicht nachsehen.',
  code: 'invalid_tool_call',
}
```

**Boot-time schema compilation log** (extend accept log in webhook.ts):
```typescript
log.info({
  event: 'allowlist_compiled',
  tool_count: ENTRIES.length,
  mutating_count: ENTRIES.filter((e) => e.mutating).length,
})
```

---

### `voice-bridge/src/tools/schemas/*.json` (config, static)

**No code analog.** These are JSON Schema 7 files imported via `resolveJsonModule: true` (tsconfig.json line 13). Name files after the tool: `check_calendar.json`, `create_appointment.json`, etc.

**Fixture for import pattern** (tsconfig.json line 13):
```json
"resolveJsonModule": true
```
Import in TS: `import schema from './schemas/tool_name.json' assert { type: 'json' }`. NodeNext requires the `assert` clause for JSON imports.

---

### `voice-bridge/src/readback/normalize.ts` (utility, transform)

**Analog:** `voice-bridge/src/webhook.ts` `extractCaller()` function (lines 52-79) — same style: pure function, no class, explicit string transformations, returns typed output.

**String normalization pattern** (webhook.ts lines 62-77):
```typescript
function extractCaller(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) return undefined
  // sequential header scan, regex extraction, normalization chain
  for (const wantName of ['Remote-Party-ID', 'From']) {
    const h = headers.find((x) => x.name?.toLowerCase() === wantName.toLowerCase())
    if (!h) continue
    const m = h.value.match(/sip:(\+?\d+)@/)
    if (m && m[1]) {
      let num = m[1].startsWith('+') ? m[1] : `+${m[1]}`
      if (num.startsWith('+0')) num = '+49' + num.slice(2)
      return num
    }
  }
  return (data.from ?? data.caller_number) as string | undefined
}
```

**Module pattern for normalize.ts:**
```typescript
// src/readback/normalize.ts
// German numeric → digit normalization (D-13).
// Pure functions — no side effects, no logger dependency.

export function germanWordToNumber(word: string): number | null { ... }
export function normalizeGermanTime(text: string): string { ... }  // "halb drei" → "14:30"
export function normalizeGermanDate(text: string): string { ... }  // "dreiundzwanzigste" → "23"
export function foldDiacritics(text: string): string { ... }       // ä→ae, ö→oe, ü→ue, ß→ss
```

Keep all functions exported (pure, no class wrappers) — consistent with the extractCaller style. Tests call functions directly without factory overhead.

---

### `voice-bridge/src/readback/validator.ts` (utility, request-response)

**Analog:** `voice-bridge/src/webhook.ts` — same guard-then-act pattern: parse input, check condition, log result, return typed outcome.

**Guard-then-act pattern** (webhook.ts lines 112-125):
```typescript
// Only handle realtime.call.incoming; other event types ack-only.
if (eventType !== 'realtime.call.incoming') {
  log.info({ event: 'accept_skipped', event_type: eventType, call_id: callId })
  return reply.code(200).send({ ok: true })
}

if (!callId) {
  log.warn({ event: 'accept_missing_call_id' })
  return reply.code(200).send({ ok: true })
}
```

**Validator module pattern:**
```typescript
// src/readback/validator.ts
import type pino from 'pino'
import { normalizeGermanTime, foldDiacritics } from './normalize.js'

export type ReadbackResult =
  | { ok: true }
  | { ok: false; dimension: 'time' | 'name' | 'freetext'; expected: string; observed: string }

export function validateReadback(
  toolArgs: Record<string, unknown>,
  lastUtterance: string,
  log: pino.Logger,
  callId: string,
  turnId: string,
  toolName: string,
): ReadbackResult {
  // ... normalization + tolerance check per D-13
  // On mismatch, log before returning:
  log.warn({
    event: 'readback_mismatch',
    tool_name: toolName,
    call_id: callId,
    turn_id: turnId,
    expected,
    observed,
    tolerance_dim: dimension,
  })
  return { ok: false, dimension, expected, observed }
}
```

**JSONL field names** follow the `event:` snake_case style used throughout webhook.ts and heartbeat.ts.

---

### `voice-bridge/src/slow-brain.ts` (service, event-driven queue)

**Analog:** `voice-bridge/src/heartbeat.ts` — async worker loop with state struct, graceful degrade on failure, Discord alert on repeated failure.

**Async worker with back-pressure** (heartbeat.ts `startHeartbeat` pattern adapted):
```typescript
// src/slow-brain.ts
import type pino from 'pino'

export interface SlowBrainState {
  queue: TranscriptDelta[]
  lastUpdateAt: number
  turnsSinceUpdate: number   // for cadenceCap (D-25)
}

export async function startSlowBrain(log: pino.Logger): Promise<SlowBrainWorker> {
  // Returns a handle with .push(delta) + .stop() — fire-and-forget coroutine
}
```

**Degrade pattern** (heartbeat.ts lines 58-67 adapted):
```typescript
// On Claude timeout or 5xx (D-27):
log.warn({
  event: 'slow_brain_degraded',
  reason: err?.message ?? 'timeout',
  call_id,
})
// Do NOT throw — hot-path continues with last-known instructions
```

**Back-pressure** (D-28): if `queue.length > 5`, shift oldest before push. Log at `warn` with `event:'slow_brain_backpressure'`.

**Instructions-only guard** (D-26 — BUG level):
```typescript
// Before session.update(), strip tools field:
if ('tools' in payload) {
  log.error({ event: 'slow_brain_tools_field_stripped_BUG', call_id })
  delete (payload as Record<string, unknown>).tools
}
```

---

### `voice-bridge/src/turn-timing.ts` (utility, file-I/O JSONL write)

**Analog:** `voice-bridge/src/logger.ts` — exact same JSONL sink, same directory, same daily-rotation file.

**Logger sink pattern** (logger.ts lines 10-37):
```typescript
export function buildLogger(): pino.Logger {
  const dir =
    process.env.BRIDGE_LOG_DIR ??
    join(homedir(), 'nanoclaw', 'voice-container', 'runs')
  mkdirSync(dir, { recursive: true })

  const transport = pino.transport({
    targets: [
      {
        target: 'pino-roll',
        options: {
          file: join(dir, 'bridge'),
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          extension: '.jsonl',
          mkdir: true,
        },
        level: process.env.LOG_LEVEL ?? 'info',
      },
      ...
    ],
  })
  return pino({ base: { svc: 'voice-bridge' } }, transport)
}
```

**Turn-timing module: write to per-call file** (D-37 says `turns-{call_id}.jsonl`, not the rolling bridge log):
```typescript
// src/turn-timing.ts
import { createWriteStream } from 'node:fs'  // text JSONL, NOT audio — D-20 allows this
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface TurnTimingEntry {
  ts_iso: string
  call_id: string
  turn_id: string
  t0_vad_end_ms: number
  t2_first_llm_token_ms: number | null
  t4_first_tts_audio_ms: number | null
  barge_in: boolean
}

const dir = process.env.BRIDGE_LOG_DIR ??
  join(homedir(), 'nanoclaw', 'voice-container', 'runs')

export function openTurnLog(callId: string): (entry: TurnTimingEntry) => void {
  const path = join(dir, `turns-${callId}.jsonl`)
  const ws = createWriteStream(path, { flags: 'a', encoding: 'utf8' })
  return (entry) => ws.write(JSON.stringify(entry) + '\n')
}
```

Note: `createWriteStream` for `.jsonl` text files is explicitly allowed by D-20 (audio-only restriction).

---

### `voice-bridge/src/webhook.ts` (modify — extend /accept)

**Self-analog.** Extend `registerAcceptRoute` (lines 81-177) by:

1. Replacing the empty `tools: []` in the `realtime.calls.accept()` call (line 149) with `getAllowlist().map(toOpenAITool)`.
2. After successful `accept()`, open the sideband WS for this `callId` (fire-and-forget via `void openSidebandSession(callId, log)`).
3. Log additional JSONL fields on `call_accepted`:
```typescript
log.info({
  event: 'call_accepted',
  call_id: callId,
  caller_number: callerNumber,
  latency_ms: Date.now() - t0,
  tools_count: toolsList.length,        // new Phase 2 fields
  schema_compile_ok: true,
  sideband_opened: true,
})
```

Follow the existing try/catch structure exactly (lines 148-175) — do not restructure error handling.

---

### `voice-bridge/src/index.ts` (modify — register new routes)

**Self-analog.** Follow the existing register pattern (lines 53-55):
```typescript
registerHealthRoute(app)
registerWebhookRoute(app, openai, log, secret)
registerAcceptRoute(app, openai, log, secret, whitelist)
```

Phase 2 additions follow the same signature pattern:
```typescript
// After existing registrations:
registerReplayHealthRoute(app)    // optional: exposes last replay run result
```

For the `BuildAppOptions` interface (lines 14-21), add Phase 2 injection points:
```typescript
export interface BuildAppOptions {
  openaiOverride?: OpenAI
  whitelistOverride?: Set<string>
  skipApiKey?: boolean
  sidebandOverride?: SidebandClient   // new: allows test injection of mock WS
  slowBrainOverride?: SlowBrainWorker // new: allows test injection of mock queue
}
```

Keep `isMain` guard (lines 84-93) unchanged.

---

### `voice-bridge/src/config.ts` (modify — add Phase 2 config keys)

**Self-analog.** Follow the lazy-getter function pattern (lines 23-60). Add:

```typescript
// Phase 2: Slow-Brain cadence cap (D-25, configurable, default=2)
export const SLOW_BRAIN_CADENCE_CAP = Number(process.env.SLOW_BRAIN_CADENCE_CAP ?? 2)

// Phase 2: Idempotency — no config needed (per-call Map, no TTL setting)

// Phase 2: Sideband WS connect SLA (D-43)
export const SIDEBAND_CONNECT_TIMEOUT_MS = Number(
  process.env.SIDEBAND_CONNECT_TIMEOUT_MS ?? 1500,
)

// Phase 2: Slow-Brain Claude timeout (D-27)
export const SLOW_BRAIN_TIMEOUT_MS = Number(process.env.SLOW_BRAIN_TIMEOUT_MS ?? 8000)

// Phase 2: full persona prompt (replaces PHASE1_PERSONA)
export const PERSONA_PROMPT = process.env.PERSONA_PROMPT ?? PHASE1_PERSONA
```

No zod — project uses plain env vars + `process.exit(1)` in lazy getters. Do not introduce zod.

---

### `voice-bridge/src/logger.ts` (modify — extend JSONL schema)

**Self-analog.** The logger itself does not change — it is a passthrough pino instance. The JSONL fields are determined by what callers pass. Document the Phase 2 field extensions as inline comments in the files that emit them (same style as existing `// Per T-05-04` comments).

Phase 2 new event types and their fields (add as a comment block at top of logger.ts for discoverability):

```typescript
// Phase 2 JSONL event field extensions (do not change transport — add fields at call sites):
// idempotency_hit:    { event, call_id, turn_id, tool_name, key_hash }
// readback_mismatch:  { event, call_id, turn_id, tool_name, expected, observed, tolerance_dim }
// slow_brain_degraded: { event, reason, call_id }
// slow_brain_backpressure: { event, queue_depth, call_id }
// sideband_ready:     { event, call_id, latency_ms }
// sideband_timeout:   { event, call_id, elapsed_ms }
// turn_timing:        written to turns-{call_id}.jsonl (see turn-timing.ts), not bridge log
// ghost_scan_hit:     { event, call_id, path }  — alert-level
// mem_delta_mb:       { event, call_id, delta_mb }  — observability only (D-19)
```

---

### `voice-bridge/tests/replay/*.test.ts` (test, batch fixture replay)

**Analog:** `voice-bridge/tests/accept.test.ts` — the definitive model for all Phase 2 tests.

**Test file structure** (accept.test.ts lines 1-12):
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('POST /accept — Phase 1 inbound call handler', () => {
  let logDir: string

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'bridge-accept-test-'))
    process.env.OPENAI_WEBHOOK_SECRET = 'whsec_test_phase1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    process.env.BRIDGE_BIND = '127.0.0.1'
    process.env.BRIDGE_PORT = '0'
    process.env.BRIDGE_LOG_DIR = logDir
  })

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true })
    delete process.env.OPENAI_WEBHOOK_SECRET
    // ... delete all env vars set in beforeEach
  })
```

**Mock injection pattern** (accept.test.ts lines 32-62):
```typescript
function makeMockOpenAI(overrides?: { ... }): { openai: any, acceptSpy, rejectSpy } {
  const acceptSpy = overrides?.accept ?? vi.fn().mockResolvedValue({})
  // ...
  const openai = {
    webhooks: { unwrap: unwrapSpy },
    realtime: { calls: { accept: acceptSpy, reject: rejectSpy } },
  }
  return { openai, acceptSpy, rejectSpy }
}
```

For replay tests, replace the OpenAI mock with a fixture-driven mock that replays events from spike-E JSONL:
```typescript
function makeFixtureOpenAI(fixturePath: string): { openai: any, emittedEvents: unknown[] } {
  const turns = readFileSync(fixturePath, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  // synthesize WS events from turns[i].t_first_audio_ms etc.
  ...
}
```

**App injection pattern** (accept.test.ts lines 65-68 — use `app.inject`, never bind to real port):
```typescript
const { buildApp } = await import('../src/index.js')
const app = await buildApp({ openaiOverride: openai, whitelistOverride: new Set([...]) })
try {
  const res = await app.inject({ method: 'POST', url: '/accept', ... })
  // assertions
} finally {
  await app.close()
}
```

**Latency tolerance assertion pattern** (D-31 — ±100 ms):
```typescript
// Use performance.now() for monotonic timing (D-33 determinism note from 02-CONTEXT.md specifics)
const t0 = performance.now()
// ... inject events
const elapsed = performance.now() - t0
expect(elapsed).toBeLessThan(fixtureFirstAudioMs + 100)
expect(elapsed).toBeGreaterThan(fixtureFirstAudioMs - 100)
```

**Vitest config** — no changes needed. `vitest.config.ts` already covers `tests/**/*.test.ts`:
```typescript
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],   // covers tests/replay/*.test.ts automatically
    environment: 'node',
    pool: 'forks',
    testTimeout: 10000,
  },
})
```
Increase `testTimeout` if SBERT model loading exceeds 10 s on first CI run (D-31 cosine similarity check).

---

### `voice-bridge/tests/fixtures/spike-e/*.jsonl` (fixture, copy)

**Source:** `/home/carsten_bot/nanoclaw-state/voice-channel-spec/spike/candidate-e/raw/`

Five files to copy verbatim:
- `turns-1776242557.jsonl`
- `turns-1776242907.jsonl`
- `turns-1776243549.jsonl`
- `turns-1776243763.jsonl`
- `turns-1776243957.jsonl`

**Fixture JSONL schema** (from first inspection of raw files):
```json
{
  "turn_idx": 0,
  "text_pushed": "Ja.",
  "category": "simple",
  "tool_call_triggered": false,
  "tool_name": null,
  "tool_args_str": null,
  "transcription": "Yeah.",
  "t0_ms": 0.0,
  "t_first_audio_ms": 642.0,
  "t_tool_call_done_ms": null,
  "t_tool_result_sent_ms": null,
  "t_after_tool_audio_ms": null,
  "error": null,
  "phase": "warmup",
  "model": "gpt-realtime"
}
```
Golden reference latencies derive from `t_first_audio_ms` per turn. The ±100 ms band (D-31) is applied to this field.

---

## Shared Patterns

### JSONL Structured Logging
**Source:** `voice-bridge/src/logger.ts` lines 10-37 + `voice-bridge/src/webhook.ts` lines 36-44
**Apply to:** All new modules that emit log events

Rules derived from existing code:
1. Always use `log.info({...})` / `log.warn({...})` / `log.error({...})` with an object — never string-only log calls
2. First field is always `event:` with a snake_case string literal
3. `call_id` present on all call-scoped events
4. `latency_ms: Date.now() - t0` on any timed operation
5. `ts` field is injected automatically by pino — do not add manually
6. Full payloads only at `DEBUG` level (per T-05-04 comment in webhook.ts line 3)

### Lazy Config Getters (no zod)
**Source:** `voice-bridge/src/config.ts` lines 23-60
**Apply to:** `config.ts` additions, `allowlist.ts` boot validation

Pattern: exported `const` for safe-at-import-time values; exported `function getX()` for secrets that call `process.exit(1)` on missing. Tests override via `process.env` in `beforeEach`.

### Fastify `app.inject` for Testing (no real port binding)
**Source:** `voice-bridge/tests/accept.test.ts` lines 72-98
**Apply to:** All new route tests in Phase 2

Always use `buildApp({ ...overrides })` + `app.inject(...)` + `await app.close()` in `finally`. Never bind to `10.0.0.2` in tests — use `BRIDGE_BIND=127.0.0.1` + `BRIDGE_PORT=0` in `beforeEach`.

### AbortController Timeout
**Source:** `voice-bridge/src/heartbeat.ts` lines 31-38 + `voice-bridge/src/alerts.ts` lines 8-15
**Apply to:** `sideband.ts` (WS connect timeout), `slow-brain.ts` (Claude API timeout)

```typescript
const ctrl = new AbortController()
const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
try {
  const result = await someAsyncOp({ signal: ctrl.signal })
  clearTimeout(timer)
  return result
} catch (e) {
  // AbortError = timeout, treat as degrade not crash
}
```

### Graceful Degrade Pattern
**Source:** `voice-bridge/src/alerts.ts` lines 6-7 + `voice-bridge/src/heartbeat.ts` lines 55-68
**Apply to:** `slow-brain.ts`, `sideband.ts`

If optional component fails → log `warn`, continue with last known state. Never propagate to hot-path. Pattern: `if (!url) return` (alerts.ts line 7) — same for sideband: if WS unavailable, bridge proceeds with floor persona from `/accept`.

### NodeNext `.js` Import Extension
**Source:** All existing `src/` files (e.g. `import { sendDiscordAlert } from './alerts.js'`)
**Apply to:** All new source files

TypeScript `moduleResolution: NodeNext` requires `.js` extension on all relative imports, even though source files are `.ts`. This is already consistent across the codebase — do not deviate.

### SIGTERM / systemd Clean Shutdown
**Source:** `voice-bridge/src/index.ts` lines 76-81
**Apply to:** `slow-brain.ts` (flush queue on shutdown), `sideband.ts` (close WS on shutdown)

```typescript
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    process.exit(0)
  })
}
```
Phase 2 should extend this to call `slowBrain.stop()` and `sideband.close()` before `process.exit(0)`.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `voice-bridge/src/idempotency.ts` | utility | transform | No in-memory dedup cache exists in codebase; closest structural ref is `getWhitelist()` Set pattern |

---

## Metadata

**Analog search scope:** `/home/carsten_bot/nanoclaw/voice-bridge/src/`, `/home/carsten_bot/nanoclaw/voice-bridge/tests/`, `/home/carsten_bot/nanoclaw/voice-stack/sip-to-ai/app/`
**Files scanned:** 12 source files + 3 test files + spike-E fixtures
**Pattern extraction date:** 2026-04-17

**Key observations for planner:**
- All TypeScript uses `NodeNext` module resolution — `.js` extension mandatory on imports
- No zod anywhere — config validation is `process.exit(1)` pattern only
- vitest `pool: 'forks'` — tests are isolated processes; no shared module state between test files
- `buildApp()` injection interface is the correct extension point for all new mocks
- The `heartbeat.ts` `runXxxOnce(log, state)` split is the canonical pattern for any long-running async service (sideband, slow-brain)
- JSONL sink is shared via pino transport — do not open a second pino instance; pass `log` as parameter
- `createWriteStream` for `.jsonl` text files is explicitly allowed (D-20); audio file writes are forbidden
