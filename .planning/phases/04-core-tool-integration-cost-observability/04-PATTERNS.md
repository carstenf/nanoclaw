# Phase 4: Core Tool Integration + Cost/Observability — Pattern Map

**Mapped:** 2026-04-19
**Files analyzed:** 17 new + 1 modified
**Analogs found:** 16 / 17 (1 has no direct analog — systemd-user timers)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `voice-bridge/src/cost/accumulator.ts` | utility (in-RAM state + event handler) | event-driven (`response.done`) | `voice-bridge/src/idempotency.ts` | role-match (same per-call in-RAM Map pattern) |
| `voice-bridge/src/cost/prices.ts` | config (static constants + optional env override) | config-load | `voice-bridge/src/config.ts` | exact |
| `voice-bridge/src/cost/gate.ts` | middleware (`/accept`-time SQL-SUM cap check) | request-response | `voice-bridge/src/core-mcp-client.ts` (Bridge→Core HTTP pattern) | role-match |
| `voice-bridge/src/cost/*.test.ts` (3 files) | test | vitest unit/integration | `voice-bridge/tests/idempotency.test.ts` | exact |
| `voice-bridge/src/sideband.ts` (MODIFIED) | existing WS message handler | event-driven | self (add new `evt.type === 'response.done'` branch) | self |
| `src/mcp-tools/voice-record-turn-cost.ts` | MCP tool handler (Bridge → Core write) | request-response (POST) | `src/mcp-tools/voice-schedule-retry.ts` | exact |
| `src/mcp-tools/voice-finalize-call-cost.ts` | MCP tool handler (Bridge → Core upsert) | request-response | `src/mcp-tools/voice-schedule-retry.ts` | exact |
| `src/mcp-tools/voice-search-competitors.ts` | MCP tool handler (Core → Claude/web) | request-response | `src/mcp-tools/voice-ask-core.ts` (Claude inference) + `src/mcp-tools/voice-get-contract.ts` (schema + JSONL) | role-match |
| `src/cost-ledger.ts` | service (SQLite CRUD) | CRUD | `src/db.ts` (prepared statements, `createSchema` pattern, router_state accessor pattern) | exact |
| `src/drift-monitor.ts` | scheduled-task worker (JSONL scan) | batch (file I/O rolling-window read) | `src/task-scheduler.ts` (task lifecycle) + `voice-bridge/src/turn-timing.ts` (JSONL format owner) | role-match |
| `src/recon-3way.ts` | scheduled-task worker (multi-source diff) | batch | `src/task-scheduler.ts` + `src/mcp-tools/voice-schedule-retry.ts` (JSONL+DB dual-source) | role-match |
| `src/recon-invoice.ts` | scheduled-task worker (monthly cross-check) | batch | `src/task-scheduler.ts` + `src/db.ts` SUM-query pattern | role-match |
| `src/mcp-stream-server.ts` | route (HTTP transport wrapper) | streaming (MCP StreamableHTTP) | `src/mcp-server.ts` | role-match (same Express+allowlist, different transport) |
| `src/mcp-stream-server.test.ts` | test | vitest integration (supertest) | `src/mcp-server.test.ts` (not re-read; same pattern) | exact |
| `scripts/audit-audio.sh` | utility (bash cron script) | batch (filesystem scan + HTTP POST) | `voice-stack/scripts/deploy.sh` + `voice-stack/scripts/test-outbound-smoke.sh` | role-match |
| `scripts/pricing-refresh.sh` | utility (bash cron script, Hetzner side) | batch (HTTP GET + diff + POST) | `voice-stack/scripts/deploy.sh` | role-match |
| `systemd/user/*.{service,timer}` (6 unit files) | config (systemd unit files) | OS-registered state | **none in repo** — research-provided template | no-analog |

---

## Pattern Assignments

### `voice-bridge/src/cost/accumulator.ts` (utility, event-driven)

**Analog:** `voice-bridge/src/idempotency.ts` — per-call in-RAM Map with lifecycle hooks (`clearCall` at `session.closed`), guard flags, concise exports for test observability (`_cacheSize`).

**Imports pattern** (idempotency.ts lines 1-9):
```typescript
// voice-bridge/src/idempotency.ts
// D-01..D-06: Bridge-side idempotency wrapper for mutating Realtime tool-calls.
// RFC 8785-style canonical JSON; sha256 key; in-process RAM Map; per-call TTL.
import { createHash } from 'node:crypto'
import type { Logger } from 'pino'

export interface IdempotencyEntry {
  result: unknown
  storedAt: number
}

const cache = new Map<string, IdempotencyEntry>()
```

Copy this exact convention: pino-typed `Logger`, module-level `const cache = new Map<…>()`, single-purpose header comment citing REQ-IDs.

**In-RAM per-call state + guard flags** (idempotency.ts lines 59-74):
```typescript
export function get(key: string): IdempotencyEntry | undefined {
  return cache.get(key)
}

export function set(key: string, result: unknown): void {
  cache.set(key, { result, storedAt: Date.now() })
}

/**
 * D-03: Per-call TTL. Clears the entire cache on session.closed.
 */
export function clearCall(_callId: string): void {
  cache.clear()
}
```

New cost accumulator mirrors this: `add(callId, turnId, usage, costEur)`, `totalEur(callId)`, `warned(callId)` / `markWarned(callId)`, `enforced(callId)` / `markEnforced(callId)`, `clearCall(callId)` at `session.closed`. Guard-flag naming `warned` / `enforced` locked from RESEARCH §Pattern 3.

**Observability-only test accessor** (idempotency.ts lines 106-109):
```typescript
// Observability/test-only accessor — never consumed in production code paths.
export function _cacheSize(): number {
  return cache.size
}
```

Mirror: `_stateSize()` for accumulator unit tests.

---

### `voice-bridge/src/cost/prices.ts` (config, config-load)

**Analog:** `voice-bridge/src/config.ts` — env-with-default + `Number(process.env.X ?? default)` idiom, lazy `get*()` for secrets.

**Constant + env-override pattern** (config.ts lines 6-17):
```typescript
// Port 4402 — 4401 is reserved by NanoClaw Core's Twilio voice-server
export const PORT = Number(process.env.BRIDGE_PORT ?? 4402)
export const HOST = process.env.BRIDGE_BIND ?? '10.0.0.2'

export const WG_PEER_URL =
  process.env.WG_PEER_URL ?? 'http://10.0.0.1:9876/__wg_canary'

export const DISCORD_ALERT_WEBHOOK_URL = process.env.DISCORD_ALERT_WEBHOOK_URL ?? ''
```

Apply to prices.ts: `export const USD_TO_EUR = Number(process.env.USD_TO_EUR ?? 0.93)`, `export const PRICES_USD_PER_MTOK = { text_in: 0.60, … } as const`.

**Note:** RESEARCH §Pattern 2 pins the exact constants — copy them verbatim from the research block (audio_in 10.00, audio_out 20.00, audio_cached_in 0.30, text_in 0.60, text_out 2.40).

---

### `voice-bridge/src/cost/gate.ts` (middleware, request-response)

**Analog:** `voice-bridge/src/core-mcp-client.ts` — AbortController + timeout + typed error classes + Bearer auth header (same wire contract the gate needs to call Core's SUM query via a new `voice.get_day_month_cost_sum` tool).

**Typed error classes** (core-mcp-client.ts lines 8-23):
```typescript
export class CoreMcpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`core-mcp: HTTP ${status}`)
    this.name = 'CoreMcpError'
  }
}

export class CoreMcpTimeoutError extends Error {
  constructor() {
    super('core-mcp: timeout')
    this.name = 'CoreMcpTimeoutError'
  }
}
```

Gate introduces `CostCapExceededError` in the same style; `/accept` catches and returns SIP 503.

**AbortController + timeout** (core-mcp-client.ts lines 44-66):
```typescript
const ctrl = new AbortController()
const timer = setTimeout(() => ctrl.abort(), timeoutMs)
const startedAt = Date.now()

const headers: Record<string, string> = { 'Content-Type': 'application/json' }
if (token) headers['Authorization'] = `Bearer ${token}`

const res = await fetch(`${baseUrl}/${name}`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ arguments: args }),
  signal: ctrl.signal,
})
clearTimeout(timer)
```

Gate reuses `callCoreTool('voice.get_day_month_cost_sum', {})` — no new HTTP client needed.

---

### `voice-bridge/src/sideband.ts` (MODIFIED — existing WS handler)

**Self-analog.** The sideband message handler already switches on `parsed?.type`. Phase 4 adds one new branch before "silent ignore".

**Existing `ws.on('message')` pattern** (sideband.ts lines 141-225):
```typescript
ws.on('message', (raw: unknown) => {
  try {
    const text = typeof raw === 'string' ? raw
      : Buffer.isBuffer(raw) ? raw.toString('utf-8')
      : String(raw)
    const parsed = JSON.parse(text) as { type?: unknown; … }

    if (parsed?.type === 'input_audio_buffer.speech_started') {
      opts.onSpeechStart?.()
      return
    }
    // … more branches …
    if (parsed?.type === 'response.function_call_arguments.done') {
      // dispatch fire-and-forget
      return
    }
    // All other event types: silent ignore.
  } catch (e: unknown) {
    log.warn({ event: 'sideband_message_parse_failed', call_id: callId, err: (e as Error).message })
  }
})
```

New branch (after RESEARCH §Pattern 2 + §Pattern 3):
```typescript
if (parsed?.type === 'response.done') {
  // Phase 4: INFRA-06 + COST-01..04 cost accumulation
  const costEur = costOfResponseDone(parsed as ResponseDoneEvent)
  accumulator.add(callId, /* turnId from parsed.response.id */, parsed.response?.usage, costEur)
  // fire-and-forget Core write; log-only on failure (never throw from WS handler)
  void callCoreTool('voice.record_turn_cost', { call_id: callId, … }).catch(noop)
  // threshold checks — synchronous in same tick (see Pitfall 2 in RESEARCH)
  const perCall = accumulator.totalEur(callId)
  if (perCall >= CAP_PER_CALL_EUR && !accumulator.enforced(callId)) {
    accumulator.markEnforced(callId)
    void triggerHardStop(ws, callId, perCall, log)
  } else if (perCall >= 0.8 * CAP_PER_CALL_EUR && !accumulator.warned(callId)) {
    accumulator.markWarned(callId)
    void sendDiscordAlert(`⚠️ Call ${callId} at 80% (€${perCall.toFixed(2)})`)
  }
  return
}
```

**Hard-stop = instructions-only `session.update` (NOT `tools`).** Use existing `updateInstructions` (sideband.ts lines 278-313) which already strips any `tools` field and logs a BUG-level event if present (AC-04/AC-05 compliant).

---

### `src/mcp-tools/voice-record-turn-cost.ts` (MCP handler, request-response)

**Analog:** `src/mcp-tools/voice-schedule-retry.ts` — identical shape: zod schema + `makeVoice*` factory returning `ToolHandler`, dep-injected `createTask` / `getAllTasks` → substitute `insertTurnCost`, JSONL append + latency timing + `BadRequestError` throw.

**Imports + schema + deps** (voice-schedule-retry.ts lines 1-31):
```typescript
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

const ScheduleRetrySchema = z.object({
  call_id: z.string().optional(),
  case_type: z.string().min(1).max(64),
  target_phone: z.string().regex(/^\+\d{8,15}$/, 'target_phone must be E.164 …'),
  not_before_ts: z.string(),
});

export interface VoiceScheduleRetryDeps {
  createTask: (task: Omit<ScheduledTask, 'last_run' | 'last_result'>) => void;
  getAllTasks: () => ScheduledTask[];
  getMainGroupAndJid: () => { folder: string; jid: string } | null;
  jsonlPath?: string;
  now?: () => number;
  maxFutureMs?: number;
}
```

Apply to `voice-record-turn-cost.ts`: schema = `{call_id, turn_id, audio_in_tokens, audio_out_tokens, cached_in_tokens, text_in_tokens, text_out_tokens, cost_eur}`. Deps inject `insertTurnCost(row)` (from new `src/cost-ledger.ts`), `jsonlPath` default `${DATA_DIR}/voice-cost.jsonl`, `now` for test determinism.

**Handler body pattern** (voice-schedule-retry.ts lines 41-82):
```typescript
return async function voiceScheduleRetry(args: unknown): Promise<unknown> {
  const start = now();

  const parseResult = ScheduleRetrySchema.safeParse(args);
  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0];
    const field = String(firstError?.path?.[0] ?? 'input');
    const message = firstError?.message ?? 'invalid';
    throw new BadRequestError(field, message);
  }

  const { call_id, case_type, target_phone, not_before_ts } = parseResult.data;
  // … business logic …
  appendJsonl(jsonlPath, {
    ts: new Date().toISOString(),
    event: 'retry_scheduled',
    tool: 'voice.schedule_retry',
    call_id: call_id ?? null,
    task_id,
    scheduled_for: not_before_ts,
    latency_ms: now() - start,
  });
  return { ok: true, result: { scheduled: true } };
};
```

**JSONL appender (non-fatal)** (voice-schedule-retry.ts lines 153-160):
```typescript
function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}
```

Copy verbatim — same file-append contract across every existing MCP tool.

**Registry wiring** (src/mcp-tools/index.ts lines 277-287 — same as schedule_retry):
```typescript
registry.register(
  'voice.record_turn_cost',
  makeVoiceRecordTurnCost({
    insertTurnCost,       // from new cost-ledger.ts
    jsonlPath: deps.dataDir ? `${deps.dataDir}/voice-cost.jsonl` : undefined,
  }),
);
```

---

### `src/mcp-tools/voice-finalize-call-cost.ts` (MCP handler, request-response)

Same pattern as `voice-record-turn-cost.ts`. Schema: `{call_id, ended_at, terminated_by, soft_warn_fired}`. Dep `upsertCallCost(row)` from cost-ledger.ts.

---

### `src/mcp-tools/voice-search-competitors.ts` (MCP handler, request-response)

**Analog:** `src/mcp-tools/voice-ask-core.ts` (for Claude-via-OneCLI invocation pattern) + `src/mcp-tools/voice-get-contract.ts` (for zod schema + JSONL + graceful `not_configured` return).

**Graceful `not_configured` return on missing prerequisite** (voice-get-contract.ts lines 125-141):
```typescript
let db: ContractsDb;
try {
  db = await readDb(contractsPath);
} catch (err) {
  if (err instanceof FlatDbNotFound) {
    logger.warn({ event: 'voice_get_contract_not_configured', contractsPath });
    return { ok: false, error: 'not_configured' };
  }
  if (err instanceof FlatDbParseError) {
    return { ok: false, error: 'parse_error' };
  }
  throw err;
}
```

Apply: if `SEARCH_COMPETITORS_PROVIDER` env absent → `return { ok: false, error: 'not_configured' }`. Prevents Phase-4 gate from failing when Carsten hasn't picked Brave/Sonnet/DDG yet (RESEARCH §Search Competitors = Claude discretion pending discuss).

**Result shape (from schemas/search_competitors.json):** `{ok: true, result: {offers: [{provider, price, terms, source_url}, …]}}`.

---

### `src/cost-ledger.ts` (service, CRUD)

**Analog:** `src/db.ts` — `createSchema()` idempotent migrations with `CREATE TABLE IF NOT EXISTS`, prepared-statement accessor pattern, router_state KV accessors.

**Schema migration pattern** (db.ts lines 17-85 — excerpt):
```typescript
function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      …
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);
    …
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
```

Apply the RESEARCH §Cost Ledger Schema verbatim (lines 502-548 of 04-RESEARCH.md). Migrations run at module load time inside `initDatabase()` in db.ts (NOT a new db). Add `createSchema` additions there, then implement typed accessors in a new `src/cost-ledger.ts`.

**Prepared-statement accessor pattern** (db.ts lines 417-458):
```typescript
export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `INSERT INTO scheduled_tasks (id, group_folder, …) VALUES (?, ?, …)`,
  ).run(task.id, task.group_folder, …);
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}
```

New cost-ledger accessors:
- `insertTurnCost(row: VoiceTurnCostRow): void`
- `upsertCallCost(row: VoiceCallCostRow): void` — use `INSERT … ON CONFLICT(call_id) DO UPDATE SET …` (same idiom as `storeChatMetadata` at db.ts:200)
- `sumCostSince(isoTs: string): number` — `SELECT COALESCE(SUM(cost_eur), 0) FROM voice_call_costs WHERE started_at >= ?`
- `sumCostCurrentDay(): number` / `sumCostCurrentMonth(): number` — SQL from RESEARCH §Pattern 3
- `insertPriceSnapshot(row: VoicePriceSnapshotRow): void`

**Router-state flag for COST-03** (db.ts lines 562-573):
```typescript
export function getRouterState(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM router_state WHERE key = ?').get(key)
    as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)').run(key, value);
}
```

COST-03 monthly-suspend uses `setRouterState('voice_channel_suspended', '1')` — no new table (RESEARCH assumption A11).

---

### `src/drift-monitor.ts` (scheduled-task worker, batch)

**Analog:** `src/task-scheduler.ts` (for invocation pattern — in-process, not daemon) + `voice-bridge/src/turn-timing.ts` (schema ground-truth for JSONL records).

**JSONL schema to scan** (turn-timing.ts lines 9-17):
```typescript
export interface TurnTimingEntry {
  ts_iso: string
  call_id: string
  turn_id: string
  t0_vad_end_ms: number
  t2_first_llm_token_ms: number | null
  t4_first_tts_audio_ms: number | null
  barge_in: boolean
}
```

Drift monitor scans `~/nanoclaw/voice-container/runs/turns-*.jsonl`, computes per-line latency = `t4_first_tts_audio_ms - t0_vad_end_ms`, filters rolling-24h window on `ts_iso`, returns P50. **Must match this schema exactly** — if new fields land Phase 4+ the drift monitor should tolerate unknowns (Pitfall 9 in RESEARCH — event-name drift caused recon false-positives).

**Base dir** (turn-timing.ts lines 25-30):
```typescript
function baseDir(): string {
  return (
    process.env.BRIDGE_LOG_DIR ??
    join(homedir(), 'nanoclaw', 'voice-container', 'runs')
  )
}
```

Drift monitor must respect `BRIDGE_LOG_DIR` override (for test isolation) — already the project-wide convention.

**Discord alert** — reuse `voice-bridge/src/alerts.ts` `sendDiscordAlert()` (see Shared Patterns below). Core has its own `src/alerts.ts` — use whichever matches the runtime (Core drift-monitor runs in Core, so use Core's).

---

### `src/recon-3way.ts` (scheduled-task worker, batch)

**Analog:** `src/task-scheduler.ts` (scheduled invocation) + `src/mcp-tools/voice-schedule-retry.ts` (dual-source dedup idiom).

**Dedup-via-source-comparison pattern** (voice-schedule-retry.ts lines 87-94):
```typescript
const existingTasks = deps.getAllTasks();
const duplicate = existingTasks.find(
  (t) =>
    t.status === 'active' &&
    t.prompt.includes(`case '${case_type}'`) &&
    t.prompt.includes(target_phone) &&
    t.schedule_value === not_before_ts,
);
```

Recon uses triple-set match:
- Source 1: state.db `voice_call_costs` + `tool_invocations` where `tool_name='create_calendar_entry'` → extract `confirmation_id`
- Source 2: `turns-{call_id}.jsonl` grep for `event='readback_confirmed'` (verify actual event name emitted by Phase-2 readback/ — see Pitfall 9)
- Source 3: Discord summary channel via existing channel accessor

Alert rule: `if (|src1 ∩ src2 ∩ src3| < max(|src1|, |src2|, |src3|))` → Discord + state-repo `open_points.md` write (per MEMORY.md `feedback_use_state_repo_for_asks`).

---

### `src/recon-invoice.ts` (scheduled-task worker, batch)

**Analog:** `src/db.ts` SUM-query accessor pattern (lines 516-527) + `src/mcp-tools/voice-ask-core.ts` for Claude-over-OneCLI if the fallback path (manual CSV in state-repo) is chosen.

**SUM-query pattern** (db.ts lines 516-527):
```typescript
export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(`
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run
    `)
    .all(now) as ScheduledTask[];
}
```

Apply: `SELECT SUM(cost_eur) FROM voice_call_costs WHERE started_at >= datetime('now','start of month')`. Compare to `invoice_eur` loaded from CSV or (if A3 lands) OpenAI management API. Drift >5 % → Discord + state-repo.

---

### `src/mcp-stream-server.ts` (route, streaming MCP transport)

**Analog:** `src/mcp-server.ts` — same Express scaffold, same peer-allowlist middleware, different transport.

**Server construction pattern** (mcp-server.ts lines 15-47):
```typescript
const DEFAULT_PORT = 3200;
const DEFAULT_BIND = '10.0.0.2';
// 10.0.0.1 = Hetzner, 10.0.0.2 = Lenovo1 self, 10.0.0.4 = iPhone Chat debug, 10.0.0.5 = iPad Chat debug
const DEFAULT_ALLOWLIST = ['10.0.0.1', '10.0.0.2', '10.0.0.4', '10.0.0.5'];

export function buildMcpApp(deps: McpDeps): express.Application {
  const log = deps.log ?? logger;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(peerAllowlistMiddleware(deps.allowlist, log));

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true, ts: Date.now(), bound_to: deps.boundTo,
      peers: deps.allowlist, tools: deps.registry.listNames(),
    });
  });
```

Stream server: port **3201** (RESEARCH §Streamable HTTP §Port & Binding), same bind `10.0.0.2`, same allowlist, same `/health`. Mount `StreamableHTTPServerTransport` on `POST /mcp/stream` with bearer-auth middleware in front (RESEARCH §Pattern 1 sketch at lines 262-279 + §Streamable HTTP §Route Layout). **The same `ToolRegistry` instance must be passed to both servers** — single-source registry invariant.

**Bearer-auth middleware** — simple shim in front of `peerAllowlistMiddleware`:
```typescript
app.use((req, res, next) => {
  if (req.header('Authorization') !== `Bearer ${bearerToken}`) {
    return res.status(401).end()
  }
  next()
})
```

Bearer token `MCP_STREAM_BEARER` registered via OneCLI per CLAUDE.md §Secrets.

**Server startup pattern** (mcp-server.ts lines 118-179):
```typescript
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log.fatal({ event: 'mcp_bind_failed', bind, port, err }, `MCP server cannot bind ${bind}:${port} — port in use`);
    process.exit(1);
  }
  log.error({ event: 'mcp_server_error', err });
});

server.listen(port, bind, () => {
  log.info({ event: 'mcp_server_started', bind, port, allowlist, tools: registry.listNames() },
    `MCP server listening on ${bind}:${port}`);
});
```

Copy verbatim — only port and event-name change (`mcp_stream_bind_failed` / `mcp_stream_server_started`).

---

### `scripts/audit-audio.sh` (utility, batch)

**Analog:** `voice-stack/scripts/deploy.sh` + `voice-stack/scripts/test-outbound-smoke.sh` (not read here — bash patterns; Research §Pattern 4 provides the exact template at 04-RESEARCH.md lines 400-423).

**Conventions from RESEARCH §Pattern 4:**
- `set -euo pipefail` at top
- Write findings to `mktemp` file, never into audited paths (Pitfall 4)
- `curl -fsS -X POST "$DISCORD_AUDIT_WEBHOOK"` — env-var-driven webhook URL
- Exit non-zero on any hit (triggers systemd failure → journalctl capture)
- `ROOTS=("$HOME" "/tmp" "/var/tmp" "/usr/local/freeswitch/recordings")` — verify on both hosts at install time

**systemd timer template** (RESEARCH lines 431-441):
```ini
[Unit]
Description=§201 audio filesystem audit — monthly
[Timer]
OnCalendar=*-*-01 02:00:00
RandomizedDelaySec=10min
Persistent=true
Unit=nanoclaw-audit-audio.service
[Install]
WantedBy=timers.target
```

Hetzner variant staggers 30 min later (`02:30:00`) to avoid simultaneous Discord alerts.

---

### `scripts/pricing-refresh.sh` (utility, batch, Hetzner-side)

**Analog:** same bash convention as audit-audio.sh.

**Hetzner-only constraint** (MASTER.md §0: Lenovo1 is internal-only; Lenovo1 scraping violates layout). Script runs under `systemd --user` as Hetzner user `carsten`. Scrape target `https://platform.openai.com/docs/models/gpt-realtime-mini`. Diff vs state-repo `~/nanoclaw-state/voice-pricing.json`. POST deltas to Lenovo1 at `/internal/pricing-update` over WG. **Never auto-update the TS constants** (Pitfall 5) — scraper only ALERTS; Carsten manually bumps.

---

### Test files (all 8 new `*.test.ts`)

**Analog:** `voice-bridge/tests/idempotency.test.ts` + `voice-bridge/tests/turn-timing.test.ts` for Bridge-side; `src/mcp-tools/voice-get-contract.test.ts` + `src/mcp-tools/voice-schedule-retry.test.ts` for Core-side.

**Vitest + mock logger pattern** (voice-bridge/tests/idempotency.test.ts lines 1-22):
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import {
  makeKey, canonicalJson, invokeIdempotent, clearCall, _cacheSize,
} from '../src/idempotency.js'

function mockLog(): Logger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: vi.fn(), level: 'info',
  } as unknown as Logger
}
```

Apply to `voice-bridge/src/cost/accumulator.test.ts` verbatim.

**Tmpdir + fixture deps pattern** (voice-schedule-retry.test.ts lines 14-53):
```typescript
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscheduleretry-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_NOW = new Date('2026-01-01T12:00:00Z').getTime();

function makeDeps(overrides: Partial<VoiceScheduleRetryDeps> = {}, …): VoiceScheduleRetryDeps & { capturedTask: ScheduledTask | null } {
  const deps = {
    capturedTask: null,
    createTask: (task) => { deps.capturedTask = task as ScheduledTask; },
    getAllTasks: () => existingTasks,
    getMainGroupAndJid: () => ({ folder: 'main', jid: 'main@g.us' }),
    jsonlPath: JSONL_PATH(),
    now: () => BASE_NOW,
    ...overrides,
  };
  return deps;
}
```

Apply to `voice-record-turn-cost.test.ts`, `voice-finalize-call-cost.test.ts`, `voice-search-competitors.test.ts` verbatim.

**JSONL roundtrip pattern** (voice-bridge/tests/turn-timing.test.ts lines 7-50):
```typescript
describe('openTurnLog — D-37 per-call JSONL sink', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-'))
    process.env.BRIDGE_LOG_DIR = dir
  })
  afterEach(() => {
    delete process.env.BRIDGE_LOG_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes turns-{callId}.jsonl with round-trippable fields', async () => {
    const tl = openTurnLog('rtc_abc')
    tl.append(e1); tl.append(e2); await tl.close()
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    …
  })
})
```

Apply to `src/drift-monitor.test.ts` (seeds fixture JSONL into tmpdir, asserts P50 math).

---

## Shared Patterns

### Authentication (Bridge → Core HTTP)

**Source:** `voice-bridge/src/core-mcp-client.ts` lines 55-58
**Apply to:** All new Phase-4 Bridge tool invocations (`voice.record_turn_cost`, `voice.finalize_call_cost`, `voice.get_day_month_cost_sum`)

```typescript
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
}
if (token) headers['Authorization'] = `Bearer ${token}`
```

Bearer token `CORE_MCP_TOKEN` already wired at config.ts — no new secret for Bridge→Core. **New secret** `MCP_STREAM_BEARER` for the StreamableHTTP endpoint only.

### Peer-allowlist (all new HTTP surfaces)

**Source:** `src/peer-allowlist.ts` (full file, 29 lines)
**Apply to:** Port 3201 (StreamableHTTP) — identical allowlist to port 3200

```typescript
export function peerAllowlistMiddleware(allowlist: string[], log: Log = logger) {
  const allowed = new Set(allowlist);
  return (req: Request, res: Response, next: NextFunction): void => {
    const peer = normalizePeerIp(req.socket.remoteAddress);
    if (allowed.size === 0 || !allowed.has(peer)) {
      log.warn({ event: 'mcp_peer_blocked', peer_ip: peer }, 'MCP peer blocked by allowlist');
      res.status(403).json({ error: 'peer_not_allowed', peer_ip: peer });
      return;
    }
    next();
  };
}
```

Mount identically on port 3201. **Never bind 0.0.0.0** (Pitfall 6) — explicit `10.0.0.2`.

### Error handling (MCP tool handlers)

**Source:** `src/mcp-tools/voice-on-transcript-turn.ts` `BadRequestError` (imported across all Core voice-tools)
**Apply to:** All new `src/mcp-tools/voice-*.ts` handlers (record-turn-cost, finalize-call-cost, search-competitors)

```typescript
import { BadRequestError } from './voice-on-transcript-turn.js';

const parseResult = Schema.safeParse(args);
if (!parseResult.success) {
  const firstError = parseResult.error.issues[0];
  throw new BadRequestError(
    String(firstError?.path?.[0] ?? 'input'),
    firstError?.message ?? 'invalid',
  );
}
```

`mcp-server.ts` lines 70-76 maps `BadRequestError` → HTTP 400 `{error: 'bad_request', field, expected}` — no new wiring needed.

### Validation (tool arg schemas)

**Source (Core-side):** `src/mcp-tools/voice-get-contract.ts` lines 28-31 — zod schema with `call_id` optional + typed fields + `.min/.max/.regex` constraints
**Source (Bridge-side):** `voice-bridge/src/tools/allowlist.ts` + `voice-bridge/src/tools/schemas/*.json` — ajv JSON-Schema-validate at dispatch

**Apply to:**
- Core handlers use **zod** (same as existing tools — don't switch)
- Bridge dispatch uses **ajv** with matching JSON-schema file in `voice-bridge/src/tools/schemas/` — only if the tool is exposed through the Realtime hot path. **Phase 4 new Core tools (`voice.record_turn_cost`, `voice.finalize_call_cost`) are Bridge-internal housekeeping — NOT exposed to OpenAI. They DO NOT need schemas in `allowlist.ts`.**
- `search_competitors` already has `voice-bridge/src/tools/schemas/search_competitors.json` — activate by changing `TOOL_TO_CORE_MCP['search_competitors']` from `null` to `'voice.search_competitors'` in `voice-bridge/src/tools/dispatch.ts:41`.

### Discord alert fan-out

**Source (Bridge-side):** `voice-bridge/src/alerts.ts` (full file, 22 lines — already read above)
**Apply to:** Cost soft-warn, hard-stop, cap-breach rejection events

```typescript
export async function sendDiscordAlert(message: string): Promise<void> {
  const url = process.env.DISCORD_ALERT_WEBHOOK_URL ?? ''
  if (!url) return // graceful degrade — JSONL is audit trail of last resort
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: message }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
  } catch { /* failed alert = JSONL last resort */ }
}
```

**Separate webhook** for audit alerts (`DISCORD_AUDIT_WEBHOOK_URL`) so cost noise doesn't drown §201 signals. Both env vars registered via OneCLI.

### Idempotency (mutating Phase-4 tools)

**Source:** `voice-bridge/src/idempotency.ts` `invokeIdempotent()` lines 81-104
**Apply to:** `create_calendar_entry`, `update_calendar_entry`, `delete_calendar_entry`, `schedule_retry`, `send_discord_message`, `request_outbound_call` (per RESEARCH Idempotency Scheme table)

**Audit task, not implementation task.** The wrapper is already live in Phase 2/3. Phase 4's job is to verify each Phase-4-owned dispatch path routes through `invokeIdempotent` before hitting Core. Check: `voice-bridge/src/tools/dispatch.ts` currently does NOT call `invokeIdempotent` — it calls `callCoreTool` directly. **Gap: either (a) idempotency is enforced Core-side via another wrapper, or (b) Phase 4 needs to wrap the dispatch call.** Plan-time verification required (RESEARCH A12).

**`voice.record_turn_cost` / `voice.finalize_call_cost` do NOT need idempotency** — turn_id is the natural primary key on `voice_turn_costs` (PRIMARY KEY can be `(call_id, turn_id)` → SQLite rejects duplicates naturally, per RESEARCH Security §V11 assumption). Use `INSERT OR IGNORE` in the prepared statement.

### StreamableHTTP Chat vs voice-call disjoint key space

**Source:** RESEARCH Pitfall 8
**Apply to:** `src/mcp-stream-server.ts` — every tool invocation from Chat path synthesizes `call_id = 'chat-' + uuid`, `turn_id = 'chat-' + ts`. **Do NOT use real call_ids.** Disjoint key space means Phase-2 idempotency cache can't collide across surfaces (Pitfall 8 — iPhone debug call accidentally double-booking real calendar entry).

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `systemd/user/*.{service,timer}` (6 Lenovo1 units + 2 Hetzner units) | config | OS-registered state | Repo has no existing systemd-user unit files. Use RESEARCH §Pattern 4 template (lines 430-441 of 04-RESEARCH.md) verbatim. Plan should create `systemd/user/` directory under the nanoclaw repo, document install via `systemctl --user enable --now`. |

All other Phase-4 files have a close role+flow analog.

---

## Metadata

**Analog search scope:**
- `voice-bridge/src/` (all files)
- `voice-bridge/tests/` (test pattern only)
- `src/` (orchestrator core)
- `src/mcp-tools/` (all Core voice-tools)
- `voice-stack/scripts/` (bash conventions)

**Files scanned:** 31 (read in full or excerpted)
**Key analogs re-read from disk (not RESEARCH):**
- `voice-bridge/src/idempotency.ts` (110 lines)
- `voice-bridge/src/core-mcp-client.ts` (95 lines)
- `voice-bridge/src/alerts.ts` (22 lines)
- `voice-bridge/src/tools/dispatch.ts` (346 lines)
- `voice-bridge/src/tools/allowlist.ts` (92 lines)
- `voice-bridge/src/sideband.ts` (lines 1-320)
- `voice-bridge/src/turn-timing.ts` (49 lines)
- `voice-bridge/src/config.ts` (lines 1-80)
- `src/mcp-server.ts` (181 lines)
- `src/peer-allowlist.ts` (30 lines)
- `src/db.ts` (partial — lines 1-805)
- `src/mcp-tools/index.ts` (336 lines)
- `src/mcp-tools/voice-schedule-retry.ts` (161 lines)
- `src/mcp-tools/voice-get-contract.ts` (172 lines)
- `src/task-scheduler.ts` (partial — lines 1-180)
- `src/mcp-tools/voice-get-contract.test.ts` (partial)
- `voice-bridge/tests/idempotency.test.ts` (partial)
- `voice-bridge/tests/turn-timing.test.ts` (partial)

**Pattern extraction date:** 2026-04-19

---

*Pattern mapping complete. Planner may now reference specific file+line analogs in PLAN.md actions without re-reading the codebase.*
