# Phase 4: Core Tool Integration + Cost/Observability — Research

**Researched:** 2026-04-19
**Domain:** Cost ledger + tool surface completion + reconciliation for a live voice agent already running Phase 3 on PSTN
**Confidence:** HIGH for stack/existing-code re-use, HIGH for cost math (verified), MEDIUM for §201 audit formalization (pre-existing informal), MEDIUM-LOW for pricing auto-refresh (no library, custom scrape)

---

## Summary

Phase 4 completes the Case-6 tool surface on a codebase that already landed the safety envelope (Phase 2) and the first end-to-end Case-6 PSTN call (Phase 3). The six TOOLS-* requirements assigned to Phase 4 (TOOLS-01, -02, -04, -05, -06, -07) are **mostly already implemented** (per REQUIREMENTS.md traceability table: -01/-02/-04/-06/-07 are "Complete", only -05 `search_competitors` is "Pending"). Phase 4's real delivery is therefore **not new tool handlers** but:

1. **Cost enforcement** (COST-01..05, INFRA-06, INFRA-07) — a greenfield subsystem. `voice-bridge/` has no cost accumulator yet, no `response.done.usage` handler, no ledger, no pricing-refresh cron. This is the bulk of the work.
2. **Reconciliation + drift alerts** (COST-05, QUAL-03) — new cron jobs against `state.db` + JSONL artefacts.
3. **Streamable HTTP MCP transport** on the already-existing tool registry (AC-07 debug surface) — confirmed gap: the Core exposes an Express `/mcp/:tool_name` endpoint (peer-allowlisted over WG, port 3200) but that is a home-grown REST shape, NOT MCP protocol compliant. AC-07 wording ("Chat-Claude can invoke the same tools via Streamable HTTP") requires a proper `@modelcontextprotocol/sdk` StreamableHTTP transport so Claude Chat can `mcp connect` it.
4. **§201 filesystem audit** (QUAL-04, formal implementation of LEGAL-03) — Phase 0 SUMMARY.md explicitly flags "existing tooling/process may inform Phase 4 (Cost/Observability) if Carsten chooses to formalize the existing audit as systemd-managed" — that is exactly the Phase 4 deliverable here.
5. **TOOLS-05 `search_competitors`** — the only genuinely new tool (the schema file exists at `voice-bridge/src/tools/schemas/search_competitors.json` but dispatch maps it to `null` = `not_implemented`).

**Primary recommendation:** Build the cost ledger first (it is the critical path for COST-01..05 and blocks the Phase-4 gate). Reuse the existing Bridge→Core MCP HTTP pattern for tool completion. Land Streamable HTTP transport as a thin wrapper around the existing `ToolRegistry` in `src/mcp-server.ts`. Install audit + pricing-refresh as `systemd --user` timers (Lenovo1 carsten_bot, Hetzner carsten — MASTER.md §2).

---

## User Constraints (from CONTEXT.md)

**Status:** No CONTEXT.md exists yet for Phase 04 (`ls` on `.planning/phases/04-core-tool-integration-cost-observability/` returned empty at research time). `/gsd-discuss-phase` has not been run. All decisions below are Claude-discretion research findings; planner MUST invoke discuss/decide cycle before locking the cost-cap thresholds, reconciliation drift tolerances, and Streamable HTTP exposure auth model.

**Locked decisions (inherited from ROADMAP + REQUIREMENTS):**
- Per-call hard cap = €1.00 (COST-01); daily = €3.00 (COST-02); monthly = €25.00 (COST-03); soft-warning = 80 % (COST-04); monthly-drift alert >5 % (COST-05)
- Rolling-24h P50 >1200 ms → Discord alert (QUAL-03)
- Monthly filesystem audit on BOTH Hetzner and Lenovo1 (QUAL-04, LEGAL-03 formalisation)
- Chat-Claude invokes same tools via Streamable HTTP (AC-07)
- Idempotency keys on mutating tools (already landed Phase 2 — reuse D-02 formula)
- Travel-buffer on calendar entries (TOOLS-02 — already landed, see `voice-create-calendar-entry.ts`)

**Claude's discretion (planner must decide or escalate):**
- `state.db` table layout for cost ledger (proposed below)
- Streamable HTTP auth model (bearer-token vs OAuth 2.1 PKCE vs WG-peer-only)
- `search_competitors` data source (Brave Search? OpenAI web-search tool? DuckDuckGo scrape?)
- Pricing-refresh source (OpenAI pricing page scrape? RSS? manual monthly file commit?)
- Reconciliation drift-alert channel (Discord only, or also state-repo open_points.md?)

**Deferred (OUT OF SCOPE of Phase 4):**
- Case-5 smart voicemail (ROADMAP out-of-scope)
- Tool for IVR hold-music detection (Phase 6)
- Phishing heuristic (Phase 7)
- Parallel multi-call cost math (single-user, single-concurrent-call — Phase 4 cost math assumes concurrency=1)

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INFRA-06 | Cost accumulator sums `response.done.usage` per call; cost stored in state.db | §Cost Ledger Architecture + §OpenAI Pricing Math |
| INFRA-07 | Daily + monthly pricing-refresh cron fetches OpenAI Realtime price tiers | §Pricing Refresh Cron (Hetzner-only host, MEDIUM-LOW conf) |
| TOOLS-01 | `check_calendar(date, duration)` | Already complete — `src/mcp-tools/voice-check-calendar.ts`. Phase 4 scope = verify Bridge allowlist wiring + add cost-ledger call-out. |
| TOOLS-02 | `create_calendar_entry` with travel-buffer | Already complete — `src/mcp-tools/voice-create-calendar-entry.ts` already takes `travel_buffer_before_min`/`travel_buffer_after_min` and inserts two "Anfahrt"/"Rueckfahrt" events. Phase 4 = verify readback + idempotency keys wire through end-to-end. |
| TOOLS-04 | `get_contract(provider_name)` | Already complete — `src/mcp-tools/voice-get-contract.ts` (flat-db-reader). Phase 4 = verify Bridge dispatch + Streamable HTTP surface. |
| TOOLS-05 | `search_competitors(category, criteria)` | **Gap — schema exists, handler missing.** `voice-bridge/src/tools/dispatch.ts` maps to `null` (not_implemented). See §Search Competitors. |
| TOOLS-06 | `get_practice_profile` | Already complete — `src/mcp-tools/voice-get-practice-profile.ts`. Phase 4 = verify wiring. |
| TOOLS-07 | `schedule_retry` | Already complete — `src/mcp-tools/voice-schedule-retry.ts` creates a `scheduled_tasks` row. Phase 4 = verify Bridge allowlist + idempotency. |
| COST-01 | Per-call cap €1.00 → farewell + Discord alert | §Cost Enforcement Flow, §Hard-Stop Farewell |
| COST-02 | Daily cap €3.00 → no outbound + alert | §Cost Enforcement Flow + startup SUM query |
| COST-03 | Monthly cap €25 → channel suspend + alert (manual reset) | §Cost Enforcement Flow + `voice_channel_suspended` flag in state.db |
| COST-04 | Soft-warn at 80 % | §Cost Enforcement Flow (two-threshold guard in session) |
| COST-05 | Monthly reconciliation vs OpenAI invoice; >5 % drift → alert | §Monthly Reconciliation Cron |
| QUAL-03 | P50 >1200 ms rolling 24h → Discord alert | §Drift Monitor (rolling window over turn-timing JSONL) |
| QUAL-04 | Monthly audio-file FS audit on Hetzner AND Lenovo1 | §§201 Filesystem Audit |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| `response.done.usage` parse + cost math | **Director Bridge** (Lenovo1, voice-bridge) | — | Bridge already owns the sideband WS event stream. Cost is a function of events Bridge already sees. |
| Cost ledger persistence (`state.db`) | NanoClaw Core (Lenovo1) | Bridge (writes via MCP) | Core already owns `better-sqlite3` instance; Bridge writes cost rows via a new `voice.record_turn_cost` MCP tool to keep one DB owner. |
| Soft-warn/hard-stop decision | Bridge | — | In-RAM accumulator is canonical during the live call; SQLite is authoritative post-call. |
| Hard-stop farewell instruction | Bridge | — | Via `session.update{instructions}` + `response.create` then `session.close` — instructions-only (AC-05). |
| Daily/monthly cap startup check | Bridge (at `/accept`) | Core (provides `SUM()`) | Bridge SELECTs from Core at `/accept`, rejects with SIP 503 if cap already breached. |
| Pricing refresh | **Hetzner carsten** (public egress + systemd timer) | Lenovo1 carsten_bot (consumes via shared file or HTTP) | MASTER.md §0: Lenovo1 is internal-only. Outbound scraping of `openai.com/api/pricing` from Lenovo1 over WG-then-internet would still exit Hetzner. Cleaner to run the scraper on Hetzner and POST results over WG. |
| `search_competitors` handler | Core (`src/mcp-tools/voice-search-competitors.ts`, new) | — | Business-logic belongs in Core; Bridge just dispatches. |
| Streamable HTTP MCP server | Core (`src/mcp-server.ts`, alongside existing Express route) | — | Runs on Lenovo1 because Claude Chat connects via iPhone/iPad over WG (peers `10.0.0.4`/`10.0.0.5` already allowlisted in peer-allowlist.ts:23). |
| §201 FS audit cron | BOTH Hetzner carsten AND Lenovo1 carsten_bot | — | QUAL-04 explicit "on both hosts". Two systemd timers, one scanner script replicated. |
| Drift monitor (P50 rolling 24h) | Core scheduled task | Bridge (produces JSONL) | Core already has `task-scheduler.ts`; JSONL lives under `~/nanoclaw/voice-container/runs/turns-*.jsonl` already. |
| 3-way reconciliation (cal ↔ transcript ↔ Discord) | Core scheduled task | — | All three data sources already land in Core's filesystem/DB. |

---

## Project Constraints (from CLAUDE.md)

Directives extracted from `./CLAUDE.md` that Phase 4 tasks must honour:

- **OneCLI-gated secrets.** API keys (OpenAI, Google Maps, Anthropic, Brave-if-used) MUST flow through `onecli` — never passed to containers directly, never written to ad-hoc `.env` fragments. Applies to any new env var introduced by cost/pricing subsystems.
- **Single Node.js process.** No new long-running services without justification. Cost module = in-process in voice-bridge. Reconciliation/drift/audit = scheduled tasks via `src/task-scheduler.ts`, NOT new daemons. Exception: `systemd --user` timers for audit scripts (acceptable because they're one-shot invocations).
- **Run commands directly.** Research-driven plans should install deps and run tests, not tell the user to.
- **Container buildkit caches aggressively.** N/A for Phase 4 — no container rebuilds touched.
- **Kurze Antworten (MEMORY.md).** Respect: plan descriptions concise, no Aufbläh-Tabellen beyond what is load-bearing.
- **Kein Pfusch (MEMORY.md).** Cost math must be analytically correct. Do not hand-wave "approximate" pricing if an exact-token formula is available (it is — see §OpenAI Pricing Math).
- **State-repo contract.** Any drift-alert must also land in `~/nanoclaw-state/open_points.md` per MEMORY.md "feedback_use_state_repo_for_asks", NOT only in Discord chat.
- **Voice-channel inbound/outbound separation.** MEMORY.md "feedback_inbound_outbound_separate" + "project_outbound_greeting_logic" — Phase 4 touches neither inbound nor outbound call logic; cost math is a shared layer BELOW that split. Verify: no task in this phase edits `voice-bridge/src/outbound-*.ts` or inbound webhook handlers.

---

## Standard Stack

### Core (already pinned — REUSE)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | 11.10.0 (Core) / 12.9 (Bridge allowed) | state.db cost ledger | `[VERIFIED: nanoclaw/package.json]`. Already used for scheduled_tasks. Synchronous API fits cost-cap decision determinism. |
| `pino` | ^10.3.1 | structured JSONL cost events | `[VERIFIED: voice-bridge/package.json]`. Already the Bridge logger. |
| `ws` | ^8.20.0 | sideband WS (emits `response.done`) | `[VERIFIED: voice-bridge/package.json]`. Already wired in `sideband.ts`. |
| `@modelcontextprotocol/sdk` | ^1.29 | StreamableHTTP server transport for AC-07 | `[CITED: npmjs.com/package/@modelcontextprotocol/sdk, verified 2026-04-16 per .planning/research/STACK.md]`. Same SDK both Core and Bridge would consume. |
| `zod` | ^4.3.6 | tool-arg validation | `[VERIFIED: package.json]`. Already used across `src/mcp-tools/`. |
| `ajv` | ^8.17.1 | JSON-schema validation at Bridge dispatch | `[VERIFIED: voice-bridge/package.json]`. |

### New dependencies to introduce

| Library | Version | Purpose | Rationale |
|---------|---------|---------|-----------|
| `@modelcontextprotocol/sdk` | ^1.29 | add to NANOCLAW CORE (currently absent) | `[VERIFIED: grep in nanoclaw/package.json]`. Core currently exposes a home-grown `/mcp/:tool_name` REST API; to satisfy AC-07 (Claude Chat connects with `mcp connect`), a proper Streamable HTTP MCP transport is needed. Install in Core. |

### Version verification (performed during research)

```bash
npm view @modelcontextprotocol/sdk version  # confirm ^1.29 still current (research time)
npm view @modelcontextprotocol/sdk dist-tags
```

**Action for plan-writer:** Re-run these at plan generation time and pin the exact latest minor. `[ASSUMED: 1.29 is still current; last checked 2026-04-16 via .planning/research/STACK.md]`

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@modelcontextprotocol/sdk` StreamableHTTP | keep home-grown `/mcp/:tool_name` REST + document it as "MCP-like" | Breaks AC-07 formal wording. Claude Chat's `/mcp` command expects a real MCP endpoint, not a REST facade. Rejected. |
| In-process cost accumulator | separate "cost service" microservice | Adds IPC + 1 failure mode for zero benefit. Accumulator runs inside the same Bridge process that owns the sideband WS. Rejected. |
| Prometheus `prom-client` | Pino JSONL only | STACK.md already flagged prom-client as "recommended but optional". Phase 4 can stay with JSONL; add Prometheus in a later phase if Grafana is wanted. Deferred. |
| OpenAI management API for monthly-invoice reconciliation | screen-scrape OpenAI dashboard | `[ASSUMED]` OpenAI exposes a usage-export or billing API — verify at plan time. If absent, fall back to manual monthly CSV export + compare script. |

---

## Architecture Patterns

### System Architecture Diagram

```
  ┌─────────────────────────── LIVE CALL (Lenovo1) ─────────────────────────────┐
  │                                                                              │
  │   OpenAI Realtime WS ───► voice-bridge/sideband.ts                           │
  │   (response.done)        │                                                   │
  │                          ├──► cost/accumulator.ts   (new, Phase 4)           │
  │                          │        │ parse usage → price math                 │
  │                          │        │ check 80 % → alert                       │
  │                          │        │ check 100 % → emit farewell instr        │
  │                          │        │                                          │
  │                          │        ▼                                          │
  │                          │     per-call RAM total (EUR)                      │
  │                          │                                                   │
  │                          └──► tools/dispatch.ts ──► Core HTTP MCP ──► state.db
  │                                                     (existing)                │
  │                                                                              │
  │   At /accept:                                                                │
  │     Bridge SELECTs SUM(cost_eur) WHERE day=today / month=now                 │
  │     If daily ≥ €3 → reject call with 503 (COST-02)                          │
  │     If monthly ≥ €25 → reject + voice_channel_suspended flag (COST-03)      │
  │                                                                              │
  │   At session.closed:                                                         │
  │     Flush per-call RAM total → state.db (one INSERT)                        │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────── SCHEDULED TASKS (Lenovo1 Core) ───────────────────────────┐
  │                                                                              │
  │   task-scheduler.ts (existing, reuse):                                       │
  │     ├── daily 03:00   drift-monitor.ts  → rolling-24h P50 on turns-*.jsonl  │
  │     ├── daily 03:15   recon-3way.ts     → cal ↔ transcript ↔ Discord diff  │
  │     ├── monthly 01d   recon-invoice.ts  → accumulator vs OpenAI invoice    │
  │     └── monthly 01d   audit-audio.ts    → find *.wav/*.mp3/*.opus/*.flac   │
  │                                                                              │
  │   Streamable HTTP MCP endpoint (new): /mcp/stream  (port 3201)              │
  │     ├── Reuses src/mcp-tools ToolRegistry (single-source)                   │
  │     └── Bearer-token auth over WG (same peer-allowlist as 3200)             │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────── HETZNER (carsten user) ───────────────────────────────────┐
  │                                                                              │
  │   systemd --user timer:                                                      │
  │     ├── daily 02:00   pricing-refresh.sh  → scrape openai pricing          │
  │     │                                       POST deltas over WG             │
  │     │                                       to Core: /internal/pricing      │
  │     └── monthly 01d   audit-audio.sh      → find *.wav/*.mp3/*.opus/*.flac │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────────┘

  ┌─────────────────── CHAT-CLAUDE DEBUG (AC-07) ────────────────────────────────┐
  │                                                                              │
  │   iPhone Chat (10.0.0.4) ──► WG ──► Lenovo1:3201 /mcp/stream                 │
  │                                     ├── Auth: Bearer token                   │
  │                                     └── Same tool handlers as voice path     │
  │                                                                              │
  └──────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure (additions only)

```
voice-bridge/src/
├── cost/
│   ├── accumulator.ts            # NEW — parse response.done.usage, EUR math
│   ├── accumulator.test.ts
│   ├── prices.ts                 # NEW — token → EUR constants + refresh hook
│   ├── prices.test.ts
│   ├── gate.ts                   # NEW — /accept-time cap check (daily/monthly SUM)
│   └── gate.test.ts

src/                              # NanoClaw Core — additions
├── mcp-tools/
│   ├── voice-record-turn-cost.ts # NEW — accepts per-turn cost delta from Bridge
│   ├── voice-search-competitors.ts # NEW — TOOLS-05
│   └── …
├── cost-ledger.ts                # NEW — state.db read/write for call costs
├── drift-monitor.ts              # NEW — rolling-24h P50 scan + Discord alert
├── recon-3way.ts                 # NEW — calendar ↔ transcript ↔ Discord diff
├── recon-invoice.ts              # NEW — monthly OpenAI invoice compare
└── mcp-stream-server.ts          # NEW — @modelcontextprotocol/sdk StreamableHTTP

scripts/                          # NEW dir (or existing)
├── audit-audio.sh                # §201 FS scan (replicates to Hetzner)
└── pricing-refresh.sh            # Hetzner-side scraper → POST to Core

systemd/user/                     # NEW (or existing home-unit location)
├── nanoclaw-audit-audio.service
├── nanoclaw-audit-audio.timer
├── nanoclaw-drift-monitor.service
├── nanoclaw-drift-monitor.timer
├── nanoclaw-recon-3way.service
├── nanoclaw-recon-3way.timer
├── nanoclaw-recon-invoice.service
└── nanoclaw-recon-invoice.timer

# Hetzner systemd --user (carsten):
├── voice-audit-audio.service / .timer
└── voice-pricing-refresh.service / .timer
```

### Pattern 1: Single-Source Tool Registry Extended to StreamableHTTP (AC-07)

**What:** The existing `src/mcp-tools/ToolRegistry` (see `src/mcp-server.ts:49` — `deps.registry.invoke(toolName, args)`) is already the single source. Phase 4 mounts it behind TWO transports:

1. (existing) Express `/mcp/:tool_name` over WG on port 3200 — used by the Bridge's `core-mcp-client.ts` during live calls
2. (NEW) `@modelcontextprotocol/sdk` StreamableHTTPServerTransport on port 3201 — for Claude Chat via iPhone/iPad

The same `ToolRegistry` handler closure is registered against both transports. Zero handler duplication.

**When to use:** Always — this IS the AC-07 implementation.

**Example (sketch):**

```ts
// src/mcp-stream-server.ts (NEW)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ToolRegistry } from './mcp-tools/index.js'

export function buildMcpStreamServer(registry: ToolRegistry): McpServer {
  const server = new McpServer({ name: 'nanoclaw-voice', version: '1.0.0' })
  for (const name of registry.listNames()) {
    const entry = registry.get(name)
    server.tool(name, entry.schema, async (args) => {
      const result = await registry.invoke(name, args)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    })
  }
  return server
}
```

`[CITED: github.com/modelcontextprotocol/typescript-sdk; Deepwiki StreamableHTTPServerTransport reference]`

### Pattern 2: Cost Math from `response.done.usage` (REQ-INFRA-06)

**What:** OpenAI emits a `response.done` event at turn boundaries. Its `response.usage` field contains:

```json
{
  "total_tokens": 1234,
  "input_tokens": 900,
  "output_tokens": 334,
  "input_token_details": {
    "text_tokens": 45,
    "audio_tokens": 840,
    "cached_tokens": 15
  },
  "output_token_details": {
    "text_tokens": 8,
    "audio_tokens": 326
  }
}
```

`[CITED: platform.openai.com/docs/api-reference/realtime-server-events response.done schema]`

Compute per-turn EUR cost:

```ts
// voice-bridge/src/cost/prices.ts (USD/1M, gpt-realtime-mini)
// [CITED: eesel.ai/blog/gpt-realtime-mini-pricing 2025-11-14]
export const PRICES_USD_PER_MTOK = {
  text_in: 0.60,
  text_out: 2.40,
  audio_in: 10.00,
  audio_out: 20.00,
  audio_cached_in: 0.30,
} as const

// USD→EUR: use a configurable fixed rate (no runtime FX lookup).
// Default: 0.93 per STACK.md historical. Refresh monthly via pricing-refresh.
export const USD_TO_EUR = Number(process.env.USD_TO_EUR ?? 0.93)
```

```ts
// voice-bridge/src/cost/accumulator.ts
export function costOfResponseDone(evt: ResponseDoneEvent): number {
  const u = evt.response?.usage
  if (!u) return 0
  const i = u.input_token_details ?? {}
  const o = u.output_token_details ?? {}
  const audioIn = (i.audio_tokens ?? 0)
  const cachedIn = (i.cached_tokens ?? 0)  // cached_tokens is a SUBSET of audio_tokens
  const audioInBilled = Math.max(0, audioIn - cachedIn)
  const textIn = (i.text_tokens ?? 0)
  const audioOut = (o.audio_tokens ?? 0)
  const textOut = (o.text_tokens ?? 0)
  const usd =
    (audioInBilled * PRICES_USD_PER_MTOK.audio_in) / 1_000_000 +
    (cachedIn * PRICES_USD_PER_MTOK.audio_cached_in) / 1_000_000 +
    (textIn * PRICES_USD_PER_MTOK.text_in) / 1_000_000 +
    (audioOut * PRICES_USD_PER_MTOK.audio_out) / 1_000_000 +
    (textOut * PRICES_USD_PER_MTOK.text_out) / 1_000_000
  return usd * USD_TO_EUR
}
```

**Note (gotcha):** `[VERIFIED: Microsoft Q&A 2026-02 + OpenAI community 2025-11]` — Realtime sends non-zero `cached_tokens` even on the FIRST turn because system-prompt prefix caching is automatic. Do NOT subtract cached_tokens a second time elsewhere. Cached tokens are billed at the cached price, the rest at the uncached price.

### Pattern 3: Cost Enforcement Flow

```
  response.done event
     │
     ▼
  costOfResponseDone(evt) → Δ EUR
     │
     ▼
  perCall += Δ  (in-RAM per CallSession)
     │
     ▼
  if perCall >= 0.80 * CAP_PER_CALL and !warnedSoft:
      warnedSoft = true
      sendDiscordAlert(`⚠️ Call ${callId} at 80% (€${perCall.toFixed(2)})`)
      append JSONL: {event:'cost_soft_warn', call_id, eur: perCall}
     │
     ▼
  if perCall >= CAP_PER_CALL and !enforced:
      enforced = true
      emit session.update({instructions: FAREWELL_INSTR})
      emit response.create
      schedule session.close after farewell TTS (2-3 s delay)
      append JSONL: {event:'cost_hard_stop', call_id, eur: perCall}
      sendDiscordAlert(`🛑 Call ${callId} hard-stopped at €${perCall.toFixed(2)}`)
```

**Farewell instruction (German, one line):** *"Dein Zeitbudget für dieses Gespräch ist aufgebraucht. Verabschiede dich jetzt höflich mit einem einzigen Satz, z.B. 'Vielen Dank, ich melde mich später erneut. Auf Wiederhören.' und sage danach nichts mehr."*

`[ASSUMED]` — exact wording needs Carsten confirmation in discuss-phase.

**Daily/monthly enforcement (at `/accept`):**

```sql
-- Lenovo1 state.db, called from Bridge at /accept
SELECT COALESCE(SUM(cost_eur), 0) AS today_eur
  FROM voice_call_costs
 WHERE started_at >= datetime('now','localtime','start of day');

SELECT COALESCE(SUM(cost_eur), 0) AS month_eur
  FROM voice_call_costs
 WHERE started_at >= datetime('now','localtime','start of month');
```

- today_eur ≥ 3.00 → reject call with SIP 503 (inbound) or refuse /outbound (outbound); Discord alert
- month_eur ≥ 25.00 → additionally set `voice_channel_suspended=1` in `router_state` table; manual reset required

### Pattern 4: §201 Filesystem Audit — Dual-Host systemd Timer

**What:** QUAL-04 requires the audit on BOTH Hetzner and Lenovo1. Identical script, two systemd-user units.

```bash
#!/usr/bin/env bash
# scripts/audit-audio.sh
# REQ-QUAL-04 / REQ-LEGAL-03 monthly filesystem audit for audio files.
# Exits non-zero (and posts Discord alert) on ANY hit.
set -euo pipefail
HOST=$(hostname)
ROOTS=("$HOME" "/tmp" "/var/tmp" "/usr/local/freeswitch/recordings")
FINDINGS=$(mktemp)
for r in "${ROOTS[@]}"; do
  [ -d "$r" ] || continue
  find "$r" -type f \
    \( -name "*.wav" -o -name "*.mp3" -o -name "*.opus" -o -name "*.flac" \) \
    >> "$FINDINGS" 2>/dev/null || true
done
COUNT=$(wc -l < "$FINDINGS")
JSON=$(jq -Rn --arg host "$HOST" --arg count "$COUNT" --slurpfile files \
  <(jq -R . "$FINDINGS" | jq -s .) '{host:$host, count:$count|tonumber, files:$files[0], ts:(now|todateiso8601)}')
curl -fsS -X POST "$DISCORD_AUDIT_WEBHOOK" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"§201 audit on $HOST: count=$COUNT\n\`\`\`$JSON\`\`\`\"}" || true
if [ "$COUNT" -gt 0 ]; then
  exit 1
fi
```

**Validation gotcha:** Phase 0 SUMMARY.md noted LEGAL-03 is "pre-existing tooling/process" — meaning the scanner may already exist informally. The plan MUST audit the existing ad-hoc tooling before writing new scripts (avoid duplication). `[ASSUMED]` — verify at plan time.

**Systemd unit pair (Lenovo1, installable via `systemctl --user`):**

```ini
# ~/.config/systemd/user/nanoclaw-audit-audio.timer
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

`[CITED: ArchWiki Systemd/Timers; SUSE Working with Timers documentation]`

### Pattern 5: Pricing-Refresh (Hetzner Host)

**What:** No library auto-updates OpenAI Realtime pricing. Build a scraper-cron.

Hetzner carsten runs `pricing-refresh.sh` daily. It fetches `https://platform.openai.com/docs/models/gpt-realtime-mini` (public docs page, no auth), parses the pricing block with `grep`/`jq` or a 30-line Python helper, compares against the currently-pinned `PRICES_USD_PER_MTOK` file at `~/nanoclaw-state/voice-pricing.json`, and alerts Discord if any value has drifted >5 %.

**Implementation detail:**

- Source-of-truth file lives in the state-repo, not the code repo. Lenovo1 Bridge reads it at startup (not hot path — pricing doesn't change mid-call).
- Bridge reloads prices on SIGHUP or next call (whichever is first).
- Drift >5 % ≠ auto-update. It's an alert — Carsten manually bumps the pinned constants.

`[ASSUMED]` — OpenAI docs page is scrapeable. If it's heavily JS-rendered, fall back to monthly manual commit.

### Pattern 6: 3-Way Reconciliation

**What:** For each Case-6 call in `[yesterday, today)`:

1. Query state.db for `calls` + associated `tool_invocations` where `tool_name='create_calendar_entry'`. Extract `{call_id, confirmation_id}` triples.
2. Grep `~/nanoclaw/voice-container/runs/turns-{call_id}.jsonl` for `event='readback_confirmed'` with a matching `confirmation_id`.
3. Grep Discord summary channel messages for the same `confirmation_id`.
4. A call is "consistent" if all 3 sources agree on the confirmation_id set. "2-of-3 drift" = exactly one source disagrees — alert Discord + write to `~/nanoclaw-state/open_points.md`.

Runs nightly via `task-scheduler.ts`. Stateless — just a differential over the prior 24 h.

### Anti-Patterns to Avoid

- **Cost-ledger in Bridge SQLite.** Rejected — Core already owns `state.db`; two DBs = drift risk. Bridge WRITES cost via `voice.record_turn_cost` MCP tool; Core OWNS the persistence.
- **Mid-call `session.update{tools: …}` to trigger hard-stop.** Reproduces Sideband-WS Spike T5 bug (AC-04 hard-exclusion). Hard-stop = instructions-only + response.create + session.close. Tools MUST NOT change.
- **Per-turn polling Anthropic API to confirm token counts.** OpenAI's `response.done.usage` is authoritative. Anthropic is not in this loop.
- **Running the pricing scraper from Lenovo1.** Violates MASTER.md §0 (Lenovo1 = internal only). Scrape from Hetzner.
- **Using Core's existing `/mcp/:tool_name` REST as the AC-07 surface.** That's a home-grown REST facade; it's not MCP-protocol compliant. Claude Chat's `/mcp` needs a real StreamableHTTP endpoint. Ship the SDK-backed one alongside, don't retrofit the REST.
- **Soft-warn at 80 % only in log.** MUST also push to Discord (COST-04 requires "Discord notification").
- **Manual monthly reset for COST-03 done by editing DB.** Instead: add a `reset-monthly-cap` admin tool (documented) so there's an audit row. `[ASSUMED]` — plan decides.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Realtime cost accumulator | custom token counter by scanning audio frames | `response.done.usage` from OpenAI event stream | OpenAI emits authoritative token counts per turn; anything else is wrong. |
| MCP Streamable HTTP transport | custom JSON-RPC-over-HTTP shim | `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` | Protocol compliance required for `claude chat /mcp connect`. |
| Idempotency keys (Phase 4 mutating tools) | new scheme | reuse Phase-2 `voice-bridge/src/idempotency.ts` `makeKey(callId, turnId, toolName, args)` | Already shipped, tested, in production Phase 2/3. |
| Calendar insert with travel-buffer | new code | reuse `src/mcp-tools/voice-create-calendar-entry.ts` with `travel_buffer_before_min`/`travel_buffer_after_min` | TOOLS-02 "Complete" — just verify. |
| Google Maps travel-time lookups for search/planning | custom geocoder | reuse `src/mcp-tools/maps-client.ts` + `voice-get-travel-time.ts` | Already works, raw-fetch + AbortController timeout. |
| Discord alert fan-out | new webhook client | reuse `voice-bridge/src/alerts.ts` `sendDiscordAlert()` | Already exists, already graceful-degrades when URL unset. |
| Cron/timer orchestration | new daemon | `src/task-scheduler.ts` (in-process) for Core tasks; `systemd --user` timers for audit/pricing | Core scheduler already runs — no new service. |
| Bridge→Core tool dispatch | new HTTP client | reuse `voice-bridge/src/core-mcp-client.ts` `callCoreTool()` | Already works with AbortController timeout + typed errors. |
| JSONL turn-timing storage | new file format | reuse `voice-bridge/src/turn-timing.ts` `openTurnLog(callId)` | Already writes `~/nanoclaw/voice-container/runs/turns-{call_id}.jsonl` that the drift monitor can scan. |

**Key insight:** Phase 4 is almost entirely **orchestration and reconciliation over infrastructure that already exists**. The dangerous failure mode is "shadow-implement" — writing a new cost lib when `response.done.usage` handling should just be added to `sideband.ts`, writing new idempotency when Phase-2's is already tested, writing a new calendar tool when one ships. Resist.

---

## Cost Ledger Schema (proposed state.db additions)

```sql
-- New table: per-call totals (one row per terminated call)
CREATE TABLE IF NOT EXISTS voice_call_costs (
  call_id          TEXT PRIMARY KEY,
  case_type        TEXT NOT NULL,              -- 'case_6a' | 'case_6b' | 'case_2' | …
  started_at       TEXT NOT NULL,              -- ISO-8601 localtime
  ended_at         TEXT,                       -- ISO-8601; NULL until session.closed
  cost_eur         REAL NOT NULL DEFAULT 0,    -- sum of voice_turn_costs.cost_eur
  turn_count       INTEGER NOT NULL DEFAULT 0,
  terminated_by    TEXT,                       -- 'counterpart_bye' | 'cost_cap_call' | 'cost_cap_daily' | 'cost_cap_monthly' | 'timeout'
  soft_warn_fired  INTEGER NOT NULL DEFAULT 0,
  model            TEXT NOT NULL DEFAULT 'gpt-realtime-mini'
);
CREATE INDEX IF NOT EXISTS idx_voice_call_costs_started ON voice_call_costs(started_at);

-- New table: per-turn granularity (auditability + reconciliation)
CREATE TABLE IF NOT EXISTS voice_turn_costs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id          TEXT NOT NULL,
  turn_id          TEXT NOT NULL,
  ts               TEXT NOT NULL,              -- ISO-8601
  audio_in_tokens  INTEGER NOT NULL DEFAULT 0,
  audio_out_tokens INTEGER NOT NULL DEFAULT 0,
  cached_in_tokens INTEGER NOT NULL DEFAULT 0,
  text_in_tokens   INTEGER NOT NULL DEFAULT 0,
  text_out_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_eur         REAL NOT NULL,
  FOREIGN KEY (call_id) REFERENCES voice_call_costs(call_id)
);
CREATE INDEX IF NOT EXISTS idx_voice_turn_costs_call ON voice_turn_costs(call_id);

-- router_state already exists; reuse for the suspend flag
-- key='voice_channel_suspended'  value='1'|'0'  (set by COST-03 enforcement, cleared manually)

-- Pricing snapshots (so reconciliation can replay historical pricing)
CREATE TABLE IF NOT EXISTS voice_price_snapshots (
  ts               TEXT PRIMARY KEY,           -- ISO-8601, one per refresh
  model            TEXT NOT NULL,
  audio_in_usd     REAL NOT NULL,
  audio_out_usd    REAL NOT NULL,
  audio_cached_usd REAL NOT NULL,
  text_in_usd      REAL NOT NULL,
  text_out_usd     REAL NOT NULL,
  usd_to_eur       REAL NOT NULL,
  source           TEXT NOT NULL               -- 'openai_docs' | 'manual' | 'hetzner_scrape'
);
```

**Write path:**
- Bridge emits `voice.record_turn_cost {call_id, turn_id, tokens…, cost_eur}` per `response.done`
- Core appends row to `voice_turn_costs`
- On `session.closed`, Bridge emits `voice.finalize_call_cost {call_id, ended_at, terminated_by, soft_warn_fired}`; Core computes `SUM()` and upserts `voice_call_costs`

---

## Idempotency Scheme (mutating tools — reuse Phase-2)

Already implemented at `voice-bridge/src/idempotency.ts`:

```
key = sha256(call_id \0 turn_id \0 tool_name \0 canonicalJson(args))
```

Phase 4 scope = **verify** this applies to all mutating tools the phase ships. Audit `voice-bridge/src/tools/allowlist.ts`:

| Tool | Mutating | Idempotency wrap | Action |
|------|----------|------------------|--------|
| `create_calendar_entry` | true | **Must verify** Phase-2 wrapper active in dispatch path | plan-check |
| `update_calendar_entry` | true | ditto | plan-check |
| `delete_calendar_entry` | true | ditto | plan-check |
| `schedule_retry` | true | ditto | plan-check |
| `send_discord_message` | true | ditto (Phase 3 content-hash already shipped) | plan-check |
| `search_competitors` (new) | false (read-only) | — | none |
| `request_outbound_call` | true | ditto (Phase 3 already covers) | plan-check |

**Storage:** per-call RAM Map (D-04, cleared at `session.closed`). No DB. This is correct by design — duplicates only make sense *within* a call.

**TTL / collision policy:** per-call only. Bridge restart mid-call = graceful cache-miss (documented acceptable at D-04). Same call_id+turn_id+tool_name+args canonical JSON = deterministic hit.

---

## Streamable HTTP Exposure (AC-07)

### Auth Model (recommendation — pending discuss)

**Option A: Bearer token over WG peer-allowlist** `[RECOMMENDED, ASSUMED pending discuss]`
- Reuse `src/peer-allowlist.ts` (already allowlists 10.0.0.1 Hetzner, 10.0.0.2 self, 10.0.0.4 iPhone, 10.0.0.5 iPad)
- Add a static bearer token in OneCLI, injected via env `MCP_STREAM_BEARER`
- Reject requests missing/wrong bearer
- Binding: `10.0.0.2` only (WG interface), port 3201

**Option B: OAuth 2.1 PKCE** `[CITED: modelcontextprotocol.io/docs/tutorials/security/authorization]`
- Spec-mandated for public MCP. Not needed for WG-internal.
- Adds auth server complexity for zero private-use benefit.

**Verdict:** Option A. Private-use, single-user, WG-only exposure. OAuth only if we ever publish MCP externally. Escalate to discuss.

### Port & Binding

- Port **3201** (3200 already used by home-grown REST)
- Bind `10.0.0.2` (never `0.0.0.0`)
- No Caddy / no public reverse proxy
- Reachable from iPhone (10.0.0.4) via WG tunnel

### Route Layout

```
POST /mcp/stream            ← StreamableHTTPServerTransport main endpoint
GET  /mcp/stream/health     ← liveness
```

Claude Chat connects via `claude mcp add nanoclaw-voice http://10.0.0.2:3201/mcp/stream --header "Authorization: Bearer ${MCP_STREAM_BEARER}"` (on an iPhone that has the WG profile + bearer token in its keychain).

---

## Cron/Timer Deployment Layout

| Job | Host | Owner | Mechanism | Schedule | Output |
|-----|------|-------|-----------|----------|--------|
| §201 audio audit | Lenovo1 | carsten_bot | `systemd --user` timer | `OnCalendar=*-*-01 02:00:00` | Discord alert on any hit; exit-1 if count>0 |
| §201 audio audit | Hetzner | carsten | `systemd --user` timer | `OnCalendar=*-*-01 02:30:00` (staggered) | Discord alert on any hit |
| Pricing refresh | Hetzner | carsten | `systemd --user` timer | `OnCalendar=daily 02:00` | POST over WG to Lenovo1 `/internal/pricing-update`; alert on >5 % drift |
| Drift monitor (P50 24h) | Lenovo1 | carsten_bot | `src/task-scheduler.ts` in-process | daily 03:00 | Discord alert if rolling-P50 >1200 ms |
| 3-way reconciliation | Lenovo1 | carsten_bot | `src/task-scheduler.ts` in-process | daily 03:15 | Discord alert + open_points.md write on 2-of-3 drift |
| Monthly invoice recon | Lenovo1 | carsten_bot | `src/task-scheduler.ts` in-process | monthly 02d 04:00 | Discord alert if drift >5 %; needs manual OpenAI invoice CSV OR management API |

**Rationale for split:**
- Audit MUST run on both hosts (QUAL-04 verbatim)
- Pricing refresh MUST run on the host with outbound-internet access to OpenAI docs — Hetzner (MASTER.md: Lenovo1 is internal-only)
- Drift/recon jobs use state.db + JSONL files that ONLY exist on Lenovo1 — no cross-host need

**CLAUDE.md compatibility check:** "Single Node.js process" — scheduled tasks in Core run in-process via task-scheduler.ts (already the existing pattern, not new daemons). Systemd timers for audit + pricing are one-shot invocations, not long-running services — compliant.

---

## Search Competitors (TOOLS-05, the only NEW handler)

**Current state:** `voice-bridge/src/tools/schemas/search_competitors.json` exists; `voice-bridge/src/tools/dispatch.ts:41` maps it to `null` = `not_implemented`. No Core handler.

**Schema shape (verified from schema file):** `{category: string, criteria: string}` → `{offers: [{provider, price, terms, source_url}, ...]}`

**Data source options (Claude discretion — escalate to discuss):**

| Option | Pros | Cons | Cost |
|--------|------|------|------|
| OpenAI web-search-tool (if available on Realtime API surface) | Zero new API key | Realtime tools are our cost line — mixes feature + infra cost | unclear |
| Brave Search API | Independent index; already in GSD agent config | New API key | $3/1k queries |
| DuckDuckGo scraping | No auth | Fragile, rate-limited | free |
| Claude Sonnet with web-search tool (via Slow-Brain async) | Already wired in Phase 3 | Violates "Claude never in hot-path" IF it's synchronous; acceptable async | metered |

**Architectural pattern:** Because C4 (contract negotiation, Phase 7) is the REAL consumer of `search_competitors` and Phase 4 just has to ship a WORKING handler for Case-6 debugging, a minimum-viable Sonnet-via-web-search implementation that returns `{offers: [...]}` is sufficient. Phase 7 can harden.

**Don't hand-roll:** there's no "scrape competitor contract pages" ML task hidden here. The tool is a thin LLM-over-web-search wrapper.

---

## Common Pitfalls

### Pitfall 1: Double-counting cached_tokens

**What goes wrong:** You treat `cached_tokens` as an independent count on top of `audio_tokens`, doubling the bill.
**Why it happens:** OpenAI's schema has `input_token_details: {audio_tokens, text_tokens, cached_tokens}` — `cached_tokens` is a SUBSET of the input, not a sibling.
**How to avoid:** `audio_billed = max(0, audio_tokens - cached_tokens)`, then bill the cached portion at the cached rate.
**Warning signs:** per-turn cost ~2× ground-truth from OpenAI dashboard.
`[VERIFIED: Microsoft Q&A 2026-02 OpenAI realtime cached_input_tokens; OpenAI community 2025-11]`

### Pitfall 2: Cost-cap race condition

**What goes wrong:** Two `response.done` events arrive back-to-back; the second crosses 100 % before the first's enforcement path has emitted `session.close`. You spend €0.02 extra.
**Why it happens:** Accumulator reads+writes aren't atomic across event handlers.
**How to avoid:** Single-threaded event loop makes this safe IF the accumulator update and the threshold check happen in the SAME tick. Use a guard flag `enforced = true` set synchronously on first crossing. Subsequent events short-circuit.
**Warning signs:** duplicate `cost_hard_stop` JSONL events for one call.

### Pitfall 3: Bridge restart mid-call loses RAM accumulator

**What goes wrong:** Bridge crashes at €0.75 mid-call. Restart. Call is gone (WS is process-local per Phase-2 architecture) — so no accumulator to lose. But DB has no record either. You undercount by €0.75.
**Why it happens:** Per-call finalize only fires on clean `session.closed`.
**How to avoid:** Persist turn-costs **as they happen** (INSERT per `response.done`), not only at session end. Accept that a call that never reached `session.closed` has no `ended_at` in `voice_call_costs` but does have all its `voice_turn_costs` rows. Monthly recon job reconciles orphan turn-costs into parent call rows.
**Warning signs:** `voice_call_costs` row with `cost_eur < SUM(voice_turn_costs.cost_eur WHERE call_id=…)`.

### Pitfall 4: §201 audit script writes log to audited path

**What goes wrong:** Audit script creates its own `.wav` file somewhere — next audit cries wolf.
**Why it happens:** Sloppy shell output.
**How to avoid:** Audit script only writes `.jsonl` + `.log`. Explicit grep for its own extensions in the script's output path.
**Warning signs:** audit count grows by 1 each month.

### Pitfall 5: Pricing refresh auto-applies stale data

**What goes wrong:** OpenAI renames a JSON field. Scraper returns 0.00 for audio_in. Bridge now charges €0/call. Carsten doesn't notice until monthly invoice.
**Why it happens:** Scraper doesn't validate output shape.
**How to avoid:** **Never auto-update constants.** Scraper ONLY writes to `voice_price_snapshots` (audit trail) and ALERTS. Carsten manually bumps `prices.ts`. `[ASSUMED]` — could be relaxed if scraper has schema validation, but default conservative.

### Pitfall 6: Streamable HTTP without peer-allowlist = silent public exposure

**What goes wrong:** Bind `0.0.0.0:3201` with bearer auth. Someone port-scans public IPs, finds 3201, brute-forces bearer.
**Why it happens:** Lenovo1 is supposed to be WG-internal but a misconfigured firewall opens 3201 to the world.
**How to avoid:** Bind **explicitly** to `10.0.0.2` (WG interface); add `peer-allowlist.ts` middleware on 3201 just like 3200.
**Warning signs:** `netstat -tln` shows `0.0.0.0:3201` not `10.0.0.2:3201`.

### Pitfall 7: Monthly invoice reconciliation has no accessible source

**What goes wrong:** COST-05 says "compare accumulator vs OpenAI invoice drift >5 %". You assume OpenAI has a management API. It may not expose one for project-level usage at daily granularity.
**Why it happens:** Feature assumption without verification.
**How to avoid:** Plan must verify the API exists before writing the cron. If absent, fall back to "monthly manual CSV export by Carsten, checked into state-repo, recon job reads CSV".
**Warning signs:** Plan writer picks "use OpenAI usage API" without citing a specific endpoint.
`[ASSUMED]` — needs verification in planning.

### Pitfall 8: Streamable HTTP transport session collision with voice call

**What goes wrong:** Chat-Claude (iPhone) invokes `create_calendar_entry` via StreamableHTTP with a bogus `call_id` (or no call_id). It collides with a real voice call's idempotency key.
**Why it happens:** Idempotency key formula includes `call_id` and `turn_id` — debug invocations from Chat don't have these.
**How to avoid:** Streamable HTTP path uses a synthetic `call_id = f"chat-{uuid}"`, `turn_id = f"chat-{ts}"`. Key space is disjoint. Also: Chat path does NOT wrap in idempotency at Core level — it's a debug call, every invocation is independent.
**Warning signs:** Discord summary with duplicate calendar entries on same day after a Chat debug session.

### Pitfall 9: Three-way recon false-positive on transcript matching

**What goes wrong:** Recon script parses `turns-{call_id}.jsonl` looking for `event='readback_confirmed'` but the Phase-2 schema doesn't emit that event name.
**Why it happens:** Specification drift between research and implementation.
**How to avoid:** Plan-checker reads `voice-bridge/src/readback/` + turn-timing.ts to enumerate the actual event names emitted, then builds the recon query against ground-truth.
**Warning signs:** recon always says "2-of-3 drift" on every call.

### Pitfall 10: Soft-warn 80 % fires on legitimate short call that spans midnight

**What goes wrong:** Daily 80 % = €2.40 cumulative. A 5-min call at 23:58 pushes cumulative €2.35 → €2.55 at 00:01. If the accumulator is per-call but the 80 % check is against a rolling daily total, the 80 % warning fires for a call whose own cost was only €0.20.
**Why it happens:** Two separate concepts — per-call 80 % vs daily 80 %.
**How to avoid:** Soft-warn at 80 % of the ENCLOSING cap (per-call's 80 % = €0.80 in the same call; daily's 80 % = €2.40 total — but daily triggers at the /accept of the NEXT call, not mid-call). Document that daily caps only reject new calls, never interrupt live ones.
**Warning signs:** users confused by why a tiny call "triggered a warning".

---

## Runtime State Inventory

Phase 4 is additive (new tables, new files, new cron, new MCP endpoint). It does NOT rename or migrate anything. However, there ARE runtime-state items worth flagging:

| Category | Items | Action |
|----------|-------|--------|
| Stored data | state.db is shared with Core; new tables `voice_call_costs`, `voice_turn_costs`, `voice_price_snapshots` | Migration: `CREATE TABLE IF NOT EXISTS` on startup (matches existing pattern in `src/db.ts`) |
| Live service config | `router_state` gains key `voice_channel_suspended`; `DISCORD_AUDIT_WEBHOOK_URL`, `MCP_STREAM_BEARER` envs via OneCLI | Plan must include OneCLI secret registration sub-task |
| OS-registered state | NEW systemd --user timers on Lenovo1 (4) + Hetzner (2) | `systemctl --user enable --now` in plan |
| Secrets/env vars | New: `DISCORD_AUDIT_WEBHOOK_URL`, `MCP_STREAM_BEARER`, `USD_TO_EUR` (optional override), `OPENAI_PRICING_SOURCE_URL` | Route through OneCLI per CLAUDE.md |
| Build artifacts | None — TS-only additions, no new containers, no migrations |  — |

**Nothing found in category:** None — every row has content.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| `better-sqlite3` 11.10.0 | state.db | ✓ (Core) | pinned | — |
| `@modelcontextprotocol/sdk` | Streamable HTTP endpoint | ✗ (Core) | to install | — (blocks AC-07) |
| systemd --user | timers | ✓ (Lenovo1 + Hetzner) | — | cron as fallback only if systemd is unavailable |
| curl + jq | audit script | ✓ (both hosts) | — | — |
| OpenAI docs page scrapeable | pricing refresh | `[ASSUMED]` | — | manual monthly commit by Carsten |
| OpenAI usage/management API | monthly invoice recon | **unverified** | — | manual CSV export from dashboard |
| Brave/Sonnet web search | search_competitors | Claude-discretion | — | Sonnet alone with reasoning-only (no citations) |
| Discord webhook URL for alerts | COST-01..04, QUAL-03/04, reconciliation | pre-existing in env per `voice-bridge/src/alerts.ts` | — | JSONL-only degrade (already coded) |

**Missing with no fallback (blocking):** none.

**Missing with fallback:** OpenAI usage API, pricing scrape (both fall back to manual/semi-manual).

---

## Code Examples

### Parsing response.done.usage

```ts
// voice-bridge/src/sideband.ts — HOOK into existing message handler
ws.on('message', (raw) => {
  const evt = JSON.parse(raw.toString())
  // … existing handlers (function_call_*, speech_*, etc.) …
  if (evt.type === 'response.done') {
    const costEur = costOfResponseDone(evt)
    accumulator.add(callId, turnId, evt.response.usage, costEur)
    void recordTurnCost(callId, turnId, evt.response.usage, costEur).catch(noop)
    const perCall = accumulator.totalEur(callId)
    if (perCall >= CAP_PER_CALL_EUR && !accumulator.enforced(callId)) {
      accumulator.markEnforced(callId)
      void triggerHardStop(ws, callId, perCall, log)
    } else if (perCall >= 0.8 * CAP_PER_CALL_EUR && !accumulator.warned(callId)) {
      accumulator.markWarned(callId)
      void sendDiscordAlert(`⚠️ Call ${callId} at 80% (€${perCall.toFixed(2)})`)
    }
  }
})
```

### Hard-stop via session.update (instructions only — AC-05)

```ts
async function triggerHardStop(ws: WebSocket, callId: string, eur: number, log: Logger) {
  log.warn({event:'cost_hard_stop', call_id: callId, eur})
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      instructions: COST_CAP_FAREWELL_INSTR,
      // NO tools field (AC-04)
      // NO other mid-call mutations
    }
  }))
  ws.send(JSON.stringify({type: 'response.create'}))
  setTimeout(() => {
    try { ws.close(1000) } catch {}
  }, 4000)  // let the farewell TTS finish
  void sendDiscordAlert(`🛑 Call ${callId} hard-stopped at €${eur.toFixed(2)}`)
}
```

### Streamable HTTP endpoint (single-source registry reuse)

```ts
// src/mcp-stream-server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'

export async function attachMcpStream(
  app: express.Application,
  registry: ToolRegistry,
  bearerToken: string
) {
  const server = new McpServer({name: 'nanoclaw-voice', version: '1.0.0'})
  for (const name of registry.listNames()) {
    server.tool(name, registry.schemaOf(name), async (args) => ({
      content: [{type: 'text', text: JSON.stringify(await registry.invoke(name, args))}],
    }))
  }
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: () => crypto.randomUUID()})
  await server.connect(transport)
  app.all('/mcp/stream', (req, res, next) => {
    const auth = req.header('Authorization')
    if (auth !== `Bearer ${bearerToken}`) return res.status(401).end()
    return transport.handleRequest(req, res, req.body)
  })
}
```
`[CITED: github.com/modelcontextprotocol/typescript-sdk/README#streamable-http-transport]`

### Audit script skeleton

See §Pattern 4 above.

---

## Closest Code Analogs (file paths)

| Need | Closest existing pattern |
|------|--------------------------|
| Per-event handler in sideband | `voice-bridge/src/sideband.ts` (existing switch on `evt.type`) |
| SQLite migrations | `src/db.ts` `createSchema()` at module load |
| Scheduled task (in-Core) | `src/task-scheduler.ts` + `scheduled_tasks` table |
| JSONL append with PII redaction | `src/mcp-tools/voice-get-travel-time.ts` (omits origin/destination) |
| HTTP MCP dispatch from Bridge | `voice-bridge/src/core-mcp-client.ts` `callCoreTool()` |
| Zod-validated MCP tool handler | `src/mcp-tools/voice-schedule-retry.ts` |
| Idempotency wrapper | `voice-bridge/src/idempotency.ts` `invokeIdempotent()` |
| Discord webhook | `voice-bridge/src/alerts.ts` `sendDiscordAlert()` |
| Peer-allowlist middleware | `src/peer-allowlist.ts` (apply to new port 3201) |
| State.db reads at startup | `src/db.ts` + config loads |
| systemd-user unit files | none in repo yet — see `systemd/` recommendation above |

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Home-grown REST `/mcp/:tool_name` | MCP SDK StreamableHTTP | AC-07 compliance |
| cron | systemd --user timers | Phase 4 — persistent, journalctl-observable |
| Hand-rolled cost tracker | `response.done.usage` authoritative | accuracy |
| Separate Bridge DB | Core-owned state.db + MCP `voice.record_turn_cost` | single owner, single SUM() source |

**Deprecated/outdated:**
- Using `session.update{tools: …}` to change tools mid-call (AC-04 excluded). Applies here because hard-stop MUST NOT touch tools.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `vitest@^4.0.18` (both Core and Bridge) |
| Config | `vitest.config.ts` (both repos) |
| Quick run (Core) | `npm run test -- --run src/cost-ledger.test.ts` |
| Quick run (Bridge) | `cd voice-bridge && npm run test -- --run src/cost/` |
| Full suite (Core) | `npm run test` |
| Full suite (Bridge) | `cd voice-bridge && npm run test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| INFRA-06 | `response.done.usage` → per-turn EUR in state.db | unit + integration | `npm run test -- voice-bridge/src/cost/accumulator.test.ts` | ❌ Wave 0 |
| INFRA-06 | Bridge sends `voice.record_turn_cost` per turn | integration | `npm run test -- voice-bridge/src/cost/mcp-dispatch.test.ts` | ❌ Wave 0 |
| INFRA-07 | Pricing refresh detects 5 % drift | unit | `bash scripts/pricing-refresh-test.sh` (shell test) | ❌ Wave 0 |
| TOOLS-01 | check_calendar already shipped; Bridge dispatch path OK | smoke | `cd voice-bridge && npm run test -- tools/dispatch.test.ts --grep check_calendar` | ✅ exists |
| TOOLS-02 | create_calendar_entry with travel buffers | unit + smoke | `npm run test -- voice-create-calendar-entry.test.ts` | ✅ exists |
| TOOLS-04 | get_contract flat-db lookup | unit | `npm run test -- voice-get-contract.test.ts` | ✅ exists |
| TOOLS-05 | search_competitors returns offers | unit | `npm run test -- voice-search-competitors.test.ts` | ❌ Wave 0 |
| TOOLS-06 | get_practice_profile | unit | `npm run test -- voice-get-practice-profile.test.ts` | ✅ exists |
| TOOLS-07 | schedule_retry inserts scheduled_tasks row | unit | `npm run test -- voice-schedule-retry.test.ts` | ✅ exists |
| COST-01 | Per-call cap triggers farewell + session.close | integration | `npm run test -- voice-bridge/src/cost/gate.test.ts --grep 'per-call'` | ❌ Wave 0 |
| COST-02 | Daily cap rejects /accept with 503 | integration | `npm run test -- 'gate.test.ts' --grep 'daily'` | ❌ Wave 0 |
| COST-03 | Monthly cap sets suspension flag | integration | `npm run test -- 'gate.test.ts' --grep 'monthly'` | ❌ Wave 0 |
| COST-04 | 80 % soft-warn Discord alert | unit | `npm run test -- 'accumulator.test.ts' --grep 'soft-warn'` | ❌ Wave 0 |
| COST-05 | Monthly recon detects >5 % drift | unit | `npm run test -- recon-invoice.test.ts` | ❌ Wave 0 |
| QUAL-03 | Rolling-24h P50 over JSONL | unit | `npm run test -- drift-monitor.test.ts` | ❌ Wave 0 |
| QUAL-04 | Audit script finds seeded .wav, FAILs loud | integration (shell) | `bash scripts/audit-audio.sh # with seeded file` | ❌ Wave 0 |
| AC-07 | Chat-Claude invokes via StreamableHTTP | manual E2E | `curl -H "Authorization: Bearer $T" -X POST http://10.0.0.2:3201/mcp/stream` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `npm run typecheck && npm run lint && npm run test -- --run src/cost-ledger.test.ts voice-bridge/src/cost/` (fast — cost-focused tests only)
- **Per wave merge:** `npm run test && (cd voice-bridge && npm run test)` (full suite both repos)
- **Phase gate:** full suite GREEN + one synthetic cost-cap call + one monthly-audit-seeded run + one StreamableHTTP Claude Chat invocation (manual, but documented in PLAN verification steps)

### Wave 0 Gaps

- [ ] `voice-bridge/src/cost/accumulator.test.ts` — per-turn cost math + 80 %/100 % thresholds
- [ ] `voice-bridge/src/cost/prices.test.ts` — static pricing table + USD→EUR conversion
- [ ] `voice-bridge/src/cost/gate.test.ts` — /accept-time daily/monthly SUM gate
- [ ] `src/cost-ledger.test.ts` — DB migrations + SUM queries
- [ ] `src/mcp-tools/voice-record-turn-cost.test.ts` — new MCP tool
- [ ] `src/mcp-tools/voice-finalize-call-cost.test.ts` — new MCP tool
- [ ] `src/mcp-tools/voice-search-competitors.test.ts` — TOOLS-05
- [ ] `src/drift-monitor.test.ts` — rolling P50 scanner
- [ ] `src/recon-3way.test.ts` — cal ↔ transcript ↔ Discord diff
- [ ] `src/recon-invoice.test.ts` — monthly OpenAI invoice compare
- [ ] `src/mcp-stream-server.test.ts` — StreamableHTTP transport + auth
- [ ] `scripts/audit-audio.sh` + shell test harness (bats or hand-rolled)
- [ ] `scripts/pricing-refresh.sh` + shell test

---

## Security Domain

**security_enforcement:** not set in `.planning/config.json` → treat as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | yes | Bearer token over WG peer-allowlist (StreamableHTTP MCP) |
| V3 Session Management | yes | MCP-SDK `sessionIdGenerator` for StreamableHTTP |
| V4 Access Control | yes | `peer-allowlist.ts` on port 3201 + bearer |
| V5 Input Validation | yes | zod + ajv (already in place for tools); new cost-event schemas |
| V6 Cryptography | no new surface | reuse existing HMAC via `openai.webhooks.unwrap` |
| V8 Data Protection | yes | state.db on Lenovo1 only; never replicate cost ledger off-host |
| V9 Communication | yes | WG tunnel + TLS on all public egress (pricing refresh) |
| V11 Business Logic | yes | Idempotency reused from Phase 2; new turn-cost dedup via PRIMARY KEY (call_id, turn_id) `[ASSUMED]` — add if needed |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via cost ledger | Tampering | Use prepared statements (`better-sqlite3` API); never string-concat call_id into SQL |
| Forged `response.done` event (compromised WS) | Tampering | WSS only; trust OpenAI origin; do not accept evts from any other source |
| Bearer token theft from iPhone keychain | Spoofing | Rotate bearer quarterly; short-lived tokens preferred `[ASSUMED]` |
| Cost-cap bypass via log-spam DoS (many tiny calls) | DoS | Daily cap is the counter-measure; COST-02 already handles |
| §201 audit log leaks call metadata | Information Disclosure | JSONL is text-only, no audio; script uses exit-code not content in Discord alert |
| Pricing-refresh MitM injecting 0.0 prices | Tampering | Never auto-update code; scraper only logs + alerts; manual bump required |
| StreamableHTTP bind on 0.0.0.0 | Information Disclosure | Explicit bind 10.0.0.2; add netstat check to plan verify |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@modelcontextprotocol/sdk@^1.29` is still current at plan time | Standard Stack | Version bump needed; minor |
| A2 | OpenAI pricing docs page is scrapeable | Pricing Refresh | Fallback to manual monthly commit |
| A3 | OpenAI exposes project-level usage API | Monthly Recon | Fallback to manual CSV export |
| A4 | Bearer token + WG peer-allowlist is acceptable auth for AC-07 (not full OAuth 2.1) | Streamable HTTP | Carsten may want OAuth; escalate to discuss |
| A5 | `PRICES_USD_PER_MTOK` values (10/20/0.3/0.6/2.4) are current for gpt-realtime-mini | Pricing | Small drift ~±10 %; caught by monthly recon |
| A6 | `USD_TO_EUR = 0.93` default is close to reality for the pay period | Pricing | Max ±10 % drift; caught by monthly recon |
| A7 | `cached_tokens` is a subset of `audio_tokens`, not a sibling | Pitfall 1 | Double-counting by 2× in the worst case |
| A8 | Phase-0 pre-existing audit tooling is either absent or minimal and can be replaced without regressing compliance | §201 Audit | Carsten may object; plan must audit current state first |
| A9 | Farewell instruction wording is acceptable to Carsten | Hard-Stop | Minor — just a German string, easily changed |
| A10 | Brave/Sonnet/DuckDuckGo acceptable for `search_competitors` prototype | TOOLS-05 | Phase 7 will need real competitor data anyway; MVP is fine |
| A11 | `voice_channel_suspended` via `router_state` key is acceptable (not a new table) | Cost Ledger | None — just a location choice |
| A12 | All Phase-4 mutating tool invocations already route through `voice-bridge/src/idempotency.ts` | Idempotency Scheme | If not, Phase 4 ships with MOE-6 hole — plan-checker MUST verify |

**All A1–A12 require user confirmation or plan-time verification before locking.**

---

## Open Questions

1. **Does OpenAI expose a project-level usage API?**
   - What we know: usage appears in dashboard.
   - What's unclear: programmatic/CSV export endpoint, daily granularity.
   - Recommendation: plan-time `curl` probe; fallback = monthly manual CSV.

2. **Where do OpenAI Realtime pricing constants live between refreshes?**
   - What we know: `voice-bridge/src/cost/prices.ts` as TypeScript constants.
   - What's unclear: whether to mirror to `~/nanoclaw-state/voice-pricing.json`.
   - Recommendation: Yes — state-repo mirror so Chat/carsten can see current prices without touching code repo. Bridge reads code-repo constants only (no runtime file loads mid-call).

3. **Should monthly caps reset AUTO or MANUAL?**
   - COST-03 says "manual reset". Confirmed — no auto reset. Plan must include admin CLI command `onecli nanoclaw voice-reset-monthly-cap` or similar.

4. **How does Chat-Claude discover the StreamableHTTP endpoint?**
   - iPhone Chat config? MCP registry? One-time manual add via `claude mcp add`?
   - Recommendation: manual add in the iPhone Claude app once, document in state-repo.

5. **Phase-0 pre-existing audit tooling: what is it?**
   - Needs inventory at plan time before replacement.

---

## Sources

### Primary (HIGH confidence)

- `/home/carsten_bot/nanoclaw/.planning/REQUIREMENTS.md` — REQ-IDs, traceability table (existing tool completion status)
- `/home/carsten_bot/nanoclaw/.planning/ROADMAP.md` — Phase 4 goal + success criteria verbatim
- `/home/carsten_bot/nanoclaw/.planning/research/STACK.md` — pre-existing stack decisions (verified)
- `/home/carsten_bot/nanoclaw/.planning/research/ARCHITECTURE.md` — component boundaries, data flows
- `/home/carsten_bot/nanoclaw/.planning/research/PITFALLS.md` — catalog of known pitfalls (referenced)
- `/home/carsten_bot/nanoclaw/.planning/research/SUMMARY.md` — executive summary
- `/home/carsten_bot/nanoclaw/voice-bridge/src/idempotency.ts` — Phase-2 idempotency implementation (reuse)
- `/home/carsten_bot/nanoclaw/voice-bridge/src/tools/allowlist.ts` — mutating-flag per tool
- `/home/carsten_bot/nanoclaw/voice-bridge/src/tools/dispatch.ts` — TOOL_TO_CORE_MCP mapping (null entries = Phase-4 gaps)
- `/home/carsten_bot/nanoclaw/voice-bridge/src/core-mcp-client.ts` — Bridge→Core HTTP pattern
- `/home/carsten_bot/nanoclaw/voice-bridge/src/alerts.ts` — Discord webhook reuse
- `/home/carsten_bot/nanoclaw/voice-bridge/src/turn-timing.ts` — JSONL format for drift-monitor scan
- `/home/carsten_bot/nanoclaw/src/db.ts` — `createSchema()` migration pattern
- `/home/carsten_bot/nanoclaw/src/mcp-server.ts` — existing Core MCP home-grown REST
- `/home/carsten_bot/nanoclaw/src/mcp-tools/voice-create-calendar-entry.ts` — travel-buffer already handled
- `/home/carsten_bot/nanoclaw/.planning/phases/00-pre-production-legal-gate/00-SUMMARY.md` — "Phase 4 … formalize the existing audit as systemd-managed"
- `/home/carsten_bot/nanoclaw/.planning/phases/02-director-bridge-v0-hotpath-safety/02-CONTEXT.md` — idempotency D-01..D-06
- https://platform.openai.com/docs/api-reference/realtime-server-events — `response.done.usage` schema
- https://www.eesel.ai/blog/gpt-realtime-mini-pricing — gpt-realtime-mini token prices (Nov-2025)

### Secondary (MEDIUM confidence)

- https://learn.microsoft.com/en-us/answers/questions/5834804/ — cached_tokens semantics verification
- https://learn.microsoft.com/en-us/answers/questions/5845915/ — Azure OpenAI usage drift report
- https://github.com/modelcontextprotocol/typescript-sdk — StreamableHTTP server reference
- https://deepwiki.com/modelcontextprotocol/typescript-sdk/4.2-streamable-http-client-transport — client-side usage pattern
- https://modelcontextprotocol.io/docs/tutorials/security/authorization — auth models
- https://wiki.archlinux.org/title/Systemd/Timers — OnCalendar syntax
- https://documentation.suse.com/smart/systems-management/html/systemd-working-with-timers/index.html — timer unit patterns
- https://platform.openai.com/docs/guides/realtime-costs — managing Realtime costs

### Tertiary (LOW confidence, flagged for validation)

- OpenAI project-level usage/management API (existence/endpoint unverified — A3)
- Brave Search API still active with current keys (ops check needed)
- Phase-0 existing audit tooling inventory (A8)

---

## Metadata

**Confidence breakdown:**

- Existing infrastructure reuse: HIGH — file paths verified, code read.
- Cost math: HIGH — pricing verified Nov-2025, schema verified OpenAI docs, gotcha (cached subset) verified MS Q&A.
- Streamable HTTP auth: MEDIUM — recommend bearer+WG but discuss-phase should confirm.
- Pricing refresh: MEDIUM-LOW — scraping is fragile; recommended manual-alert-only mode.
- Monthly invoice recon: LOW — API availability unconfirmed.
- §201 audit: MEDIUM — must reconcile with Phase-0 pre-existing tooling before writing.
- Search competitors data source: LOW-discretion — discuss-phase decision.

**Research date:** 2026-04-19
**Valid until:** 2026-05-19 (30-day default; sooner if OpenAI pricing changes)

---

*Research complete. Planner may now generate PLAN.md files. Recommended wave breakdown: Wave 1 = cost ledger skeleton (schema + accumulator, no enforcement); Wave 2 = enforcement (soft-warn + hard-stop); Wave 3 = StreamableHTTP + TOOLS-05; Wave 4 = cron jobs (audit, pricing, drift, 3-way recon, invoice recon); Wave 5 = phase-gate verification.*
