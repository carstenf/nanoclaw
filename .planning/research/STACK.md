# Stack Research — NanoClaw Voice Director Bridge

**Domain:** Production Director Bridge for OpenAI Realtime S2S sideband control + MCP tool routing + cost/audit instrumentation
**Researched:** 2026-04-16
**Confidence:** HIGH for hot-path libs (verified against npm registry + OpenAI docs + AC-xx measurements); MEDIUM for observability/testing stack (verified against ecosystem consensus, not project-specific evidence)

---

## 0. Executive Decision in One Paragraph

Build the **Director Bridge in TypeScript on Node.js ≥22** using `@openai/agents@^0.8.3` **plus** a thin raw-WebSocket sideband client built on `ws@^8.20` — NOT raw-only, NOT Agents-SDK-only. Webhook receiver is **Fastify v5** (raw-body first class, 2–3× Express throughput, matches NanoClaw Core's TS-first posture). MCP server for tool routing uses `@modelcontextprotocol/sdk@^1.29` in **stdio mode** (Claude Chat debugging per AC-07). Structured JSONL timing logs via `pino@^10.3` with `pino-roll` rotation. Cost accounting: custom module reading OpenAI `response.done` token-usage fields (no third-party lib covers Realtime pricing correctly as of 2026-04). **Python is explicitly rejected** for the bridge itself — every downstream consumer (NanoClaw Core, MCP clients, onecli, existing channel skills) is TS/Node, introducing Python would double the operational surface for zero measured benefit. Python's only foothold is the existing `sip-to-ai` container on Hetzner, which stays untouched.

---

## 1. Recommended Stack

### 1.1 Core Runtime & Language

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | ≥22.11 LTS | Director Bridge runtime | Native `WebSocket`, native `fetch` via Undici, stable ESM, same LTS line as NanoClaw Core (`engines: >=20` but ≥22 is the current LTS). [@openai/agents requires Node 22+](https://www.npmjs.com/package/@openai/agents). AC-07 says Bridge is a dedicated service process on Lenovo1 — same runtime as Core minimises operator burden. |
| TypeScript | 5.7.x (Core: `^5.7.0`) | Static types | Matches NanoClaw Core's exact tsconfig and tooling (ESLint flat config, prettier, vitest). Zero friction re-using Core type definitions over IPC. |
| `tsx` | `^4.19` | dev hot-reload | Already in Core's `devDependencies`; consistent `npm run dev` UX. |
| `vitest` | `^4.0` | test runner | Core already uses it; reuse test patterns. |

**Rationale vs Python:** A Python rewrite for the Bridge was considered and **rejected**. Arguments evaluated:
- *Pro-Python:* slightly richer ML ecosystem (irrelevant — Bridge does no ML, Claude runs async over HTTPS), async/await more mature (false — Node 22 async is at least as capable as asyncio for I/O-only workloads).
- *Against:* Core is TS, MCP tools will be written in TS, `onecli` is TS, all existing channel skills are TS. One runtime, one package manager, one deployment pattern. The existing `voice-sip-to-ai` Python container stays exactly where it is (Hetzner, AC-07) — that's the correct Python boundary.

**Confidence: HIGH.**

### 1.2 OpenAI Realtime Integration (Sideband Control Channel)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@openai/agents` | `^0.8.3` (pub 2026-04-06) | Session orchestration, `OpenAIRealtimeSIP.buildInitialConfig()`, tool schema declaration | For **call accept + initial config build + tool schema definition**. Use `buildInitialConfig()` so the POST `/v1/realtime/calls/{callId}/accept` body and the sideband-WS session start from identical defaults (prevents drift between accept-time tools and in-session behaviour). |
| `@openai/agents-realtime` | `^0.8.3` | Realtime transport types, `OpenAIRealtimeWebSocket` class | Source of truth for event type definitions (`response.function_call_arguments.done`, `conversation.item.create`, `session.update`, etc.). Import the *types* even if you don't use the high-level session runner. |
| `ws` | `^8.20` | Raw WebSocket client for sideband channel at `wss://api.openai.com/v1/realtime?call_id=...` | **Primary mid-call channel.** Raw `ws` over the Agents SDK's session runner for this hot path — full event visibility, zero abstraction tax on the critical 3s tool-cycle budget (REQ-DIR-04), explicit control over `conversation.item.create` + `response.create` ordering. |
| `openai` | `^6.34` (matches Core) | Webhook signature verification (`client.webhooks.unwrap`), `POST /calls/{id}/accept`, `POST /calls/{id}/reject`, `POST /calls/{id}/refer` (for Case 4 takeover) | REST control-plane operations. Use `client.webhooks.unwrap(rawBody, headers, { secret })` — do NOT hand-roll HMAC. |

**Architecture pattern (prescriptive):**

```
realtime.call.incoming webhook
  → Fastify raw-body handler
  → openai.webhooks.unwrap(...)                    [signature verify]
  → build initial config via OpenAIRealtimeSIP.buildInitialConfig()
      - inject directional persona prompt (AC-06)
      - register tool schemas (≤15 tools per session, AC-06 of DECISION)
      - set tool_choice='auto' + filler prompt (AC-04 of DECISION)
  → POST /v1/realtime/calls/{call_id}/accept  (within 3s — OpenAI community
     reports 3–5s INVITE→webhook delay is already eaten before we see event)
  → open raw ws client to wss://api.openai.com/v1/realtime?call_id=...
  → on 'response.function_call_arguments.done':
       parse arguments (JSON string) → call MCP tool via stdio transport
       → send 'conversation.item.create' w/ type='function_call_output'
       → send 'response.create'
  → on transcript events: fire-and-forget POST to Claude background director
  → on session close: write summary (REQ-DIR-07), close ws
```

**Why not use the high-level `RealtimeSession` runner for the sideband client?** Because the runner is built for *a single client owning the media path* (browser/WebRTC). Our bridge is server-side audio-less, purely a control observer/injector. The SDK's abstractions (automatic function execution, interruption handling, `history_updated` events) would add a frame of event loop overhead on every tool cycle, and REQ-DIR-04's 3000ms cycle budget is non-negotiable. Raw `ws` + SDK types is the right cut.

**Alternative tried and rejected — `transitive-bullshit/openai-realtime-api`:** Third-party, smaller ecosystem, no guarantee of event-type parity when OpenAI ships new Realtime events (v0.8.x is on a weekly release cadence per npm history: 0.8.0 → 0.8.3 in 14 days). Stick to first-party.

**Confidence: HIGH.** Verified against npm registry dates, OpenAI webhook docs, and community confirmation of WebSocket URL format (`wss://api.openai.com/v1/realtime?call_id=rtc_xxxxx`).

### 1.3 HTTP / Webhook Framework

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `fastify` | `^5.8` | HTTP server for the `realtime.call.incoming` webhook + internal health endpoints | (1) First-class `rawBody` support via `fastify-raw-body` or route-level `config: { rawBody: true }` — critical for HMAC signature verification without the Express-raw-body dance. (2) 2–3× Express throughput, ~40% lower memory. (3) Native JSON Schema validation (a Fastify first-party feature, not a plugin). (4) Plugin ecosystem with `@fastify/websocket` if we ever run outbound WS *from* the bridge as a WS server. |
| `@fastify/helmet` | `^13.0` | Security headers for the public webhook endpoint | Defence in depth even behind Caddy. |
| `zod` | `^4.3` | Runtime schema validation for webhook payloads and tool arguments | Matches the `@modelcontextprotocol/sdk`'s own Zod dependency (no version fork). |

**Why not Express:** NanoClaw Core uses Express 5 for its own IPC, but for a net-new service, Fastify's raw-body ergonomics + performance are the better default. This is a *new* service, so "match Core's framework" is a weak argument; match Core's *language and test framework* instead.

**Why not Hono:** Hono is the fastest of the three on synthetic benchmarks, but (a) it targets edge runtimes primarily (Cloudflare Workers, Deno) — our deployment is a plain Lenovo1 service; edge-first framing adds complexity without benefit; (b) signature-verification ergonomics (`context.req.text()`) are slightly more awkward than Fastify's `rawBody: true`; (c) smaller ecosystem for Node.js middleware.

**Why the webhook endpoint is public-reachable via Caddy on Hetzner (not tunnelled to Lenovo1):** AC-08 says all Hetzner↔Lenovo1 traffic traverses WireGuard, but the *OpenAI → us* direction is public internet by definition. Terminate TLS at Caddy on Hetzner (same box as FreeSWITCH, public IP + LetsEncrypt), then proxy the webhook POST into the WireGuard tunnel to the Director Bridge on Lenovo1. This keeps Sipgate/OpenAI's only public ingress on Hetzner; Lenovo1 stays invisible.

```
Public internet
  → Caddy (Hetzner, 128.140.104.236:443, auto-TLS)
  → reverse_proxy over WG to 10.0.0.2:8787 (Director Bridge /webhook)
  → Fastify + raw body + openai.webhooks.unwrap(...)
```

**Confidence: HIGH.**

### 1.4 MCP Server (Tool Exposure)

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| `@modelcontextprotocol/sdk` | `^1.29` (pub 2026-03-30) | Expose NanoClaw Core tools (calendar, contracts, competitor search, Discord push) as MCP tools | Official SDK, actively released (10 minor versions in the last 4 months). AC-07 explicitly calls for the Director Bridge to be an MCP tool server so Claude Chat can invoke the same tools for debugging. |

**Transport selection — prescriptive:**

| Transport | Use for | Reason |
|-----------|---------|--------|
| **stdio** | Director Bridge ⇄ NanoClaw Core local communication | AC-07 pattern. Core spawns MCP subprocess, zero network surface, lowest latency (sub-ms IPC). This is the standard MCP pattern for local tool servers. |
| **Streamable HTTP** | Claude Chat debugging + ad-hoc tool invocation | Remote access without running a subprocess. Mount the same tool handlers behind an HTTP endpoint on Lenovo1, bound to WireGuard IP only. |
| ~~HTTP+SSE~~ | — | Deprecated in MCP spec (kept for backwards compat only per SDK docs). Don't use. |

**Implementation pattern:** Define the tool handlers **once** (e.g. `createCalendarTool(coreClient)`), then register the same set against *both* a `StdioServerTransport` (for Bridge→Core calls during live voice sessions) and a `StreamableHttpServerTransport` (for Claude Chat / ops debugging). One tool implementation, two transports.

**Tool count hard cap: 15** per session — AC-006 of ARCHITECTURE-DECISION. Inventory from REQ-TOOLS: 8 tools defined, leaving 7-slot headroom for future cases.

**Why not SSE or plain JSON-RPC:** MCP's own spec evolution moved *away* from HTTP+SSE toward Streamable HTTP in 2025. Building on the deprecated path wastes runway.

**Confidence: HIGH.** Verified against MCP SDK npm listing + official repo release history.

### 1.5 Async Claude Director (Slow-Brain)

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.110` | Background context tracking, transcript analysis, instruction updates via `session.update` (instructions only, AC-05) | TypeScript SDK, streams messages as async generators, hooks for lifecycle interception, MCP client built-in. REQ-DIR-06 says forward transcripts to Claude for background tracking without blocking Hot-Path. |
| `@anthropic-ai/sdk` | `^0.89` | Raw Anthropic API access if Agent SDK is overkill (fallback) | Direct API for simple "summarise turn, push `session.instructions` if fact drift" loops. |

**Pattern (AC-02 compliant — Claude NEVER in hot-path):**

```ts
// Fire-and-forget from the raw ws handler
wsSideband.on('message', (raw) => {
  const evt = JSON.parse(raw);
  if (evt.type === 'conversation.item.created' && evt.item?.role === 'user') {
    // Never await — Claude is purely async background
    void directorQueue.push({ callId, transcriptChunk: evt.item });
  }
});
```

A separate worker (same process, different event loop tick) drains `directorQueue`, calls Claude, and writes instruction updates back through the same sideband ws with `session.update`. If Claude is slow/down, the hot path is unaffected (REQ-INFRA-11).

**Confidence: HIGH.**

### 1.6 Observability & Cost Accounting

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| `pino` | `^10.3` | Structured JSONL logging — T0 VAD-end, T2 LLM-first-token, T4 TTS-first-byte per REQ-INFRA-05 | Fastest JSON logger in the Node ecosystem (async, worker-thread transports). Newline-delimited JSON is native — writes to `~/nanoclaw/voice-container/runs/turns-*.jsonl` match the existing E1-1a spike file format directly. |
| `pino-roll` | `^4.0` | Daily log rotation keyed to call-boundary or calendar day | Required for filesystem hygiene under REQ-INFRA-10 adjacent constraint (no unbounded growth). |
| `pino-pretty` | `^13.1` | Dev-mode pretty printer | Dev only — **never** in production (slow). Gated behind `NODE_ENV`. |
| `prom-client` | `^15.1` | Prometheus metrics for latency histograms, cost counters, per-case success rates | Optional but recommended. Lets us expose `/metrics` for future Grafana dashboards without log-grep. Exposes `voice_turn_latency_ms_p50`, `voice_call_cost_eur`, `voice_unauthorized_commitments_total` (MOE-6 canary). |

**Cost-accounting module — build custom, no library covers this correctly:**

OpenAI Realtime pricing (as of 2026-04): `$32/1M audio-in`, `$64/1M audio-out`, `$0.40/1M cached`. `gpt-realtime-mini` is a discount tier. Actual per-call cost is computed by **summing the `response.done` event's `usage` field across the call** (OpenAI emits token counts per response, not per minute). No public npm package does Realtime-specific cost math correctly in April 2026 — I checked npm + github, the closest is generic token counters for chat completions.

**Prescriptive implementation:**

```ts
// In the sideband ws handler
let callUsageEur = 0;
const PRICES_EUR_PER_MTOK = { audio_in: 29.8, audio_out: 59.6, cached_in: 0.37 };
// ^ rough USD→EUR * 0.93 at spec time — refresh monthly from OpenAI pricing page

ws.on('message', (raw) => {
  const evt = JSON.parse(raw);
  if (evt.type === 'response.done') {
    const u = evt.response?.usage;
    if (u) {
      const cost =
        (u.input_token_details?.audio_tokens || 0) * PRICES_EUR_PER_MTOK.audio_in / 1_000_000 +
        (u.output_token_details?.audio_tokens || 0) * PRICES_EUR_PER_MTOK.audio_out / 1_000_000 +
        (u.input_token_details?.cached_tokens || 0) * PRICES_EUR_PER_MTOK.cached_in / 1_000_000;
      callUsageEur += cost;
      if (callUsageEur >= 0.80) warnDiscord(callId, callUsageEur);       // REQ-INFRA-09
      if (callUsageEur >= 1.00) terminateCallPolitely(callId);           // REQ-INFRA-06
    }
  }
});
```

Persist per-call totals to `better-sqlite3` (same DB lib Core uses) in a `calls(call_id, started_at, ended_at, case_type, cost_eur, outcome)` table. Daily/monthly caps (REQ-INFRA-07/08) are `SUM()` queries on startup + per-call-end.

**Why not OpenTelemetry:** Overkill for a single-service private deployment. Can bolt it on later if the stack expands, but for MVP one structured-log stream + one Prometheus scrape covers it.

**Confidence: HIGH for logging; MEDIUM for the cost math (pricing changes, need monthly refresh — flagged as an open point).**

### 1.7 Persistence & IPC

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `better-sqlite3` | `^12.9` (Core uses `11.10`) | Call metadata, cost ledger, audit markers (MOE-6, X6 from ConOps) | Same storage engine NanoClaw Core uses. Synchronous API is actually an asset here — writes to the cost ledger must be transactional relative to "should we allow next turn?" decisions. Zero network overhead. |
| Unix socket / stdio | — | Director Bridge ⇄ NanoClaw Core when Core reads Bridge summaries | MCP stdio transport covers this direction. For Bridge→Core events (session summary writes, REQ-DIR-07), add a simple append-only JSONL file the Core watcher picks up — matches Core's existing IPC pattern (`src/ipc.ts`). |

**Note on DB version drift:** Core pins `better-sqlite3@11.10.0`. The Bridge can pin `^12.9` independently because they don't share a DB file — each owns its own `.db`. If they ever must share, downgrade the Bridge to match.

**Confidence: HIGH.**

### 1.8 Deployment

| Technology | Purpose | Notes |
|------------|---------|-------|
| **systemd user service** under `carsten_bot` | Run the Director Bridge as a supervised service | REQ-INFRA-02 says `under carsten_bot` on Lenovo1. Matches NanoClaw Core's existing systemd unit pattern. **No Docker on Lenovo1** — Core isn't containerised, Bridge shouldn't introduce a new deployment paradigm. Docker stays on Hetzner (FreeSWITCH, sip-to-ai). |
| `npm run build && npm run start` | Standard Node service lifecycle | tsc → `dist/`, then `node dist/index.js`. |
| Caddy on Hetzner | TLS termination for `realtime.call.incoming` webhook | Auto-LetsEncrypt. Route `/voice-webhook/*` → `reverse_proxy 10.0.0.2:8787` over WireGuard. |

**Why not Docker on Lenovo1:** Adds a layer for zero measured benefit. Existing Core operations (launchctl/systemd, log location, secrets via OneCLI) are bare-metal. Making Bridge containerised breaks the existing ops mental model for a single private-use service.

**Confidence: HIGH.**

### 1.9 Testing

| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| `vitest` | `^4.0` (matches Core) | Unit and integration tests | Same test runner Core uses. |
| **Custom WebSocket replay harness** | — | Replay recorded OpenAI Realtime event sequences against the Bridge for deterministic CI | See §4 Testing Strategy below. |
| **`llmock` or `AIMock`** | latest | Mock OpenAI Realtime WebSocket server for load + chaos tests | `llmock` explicitly supports OpenAI Realtime over WS (the only mock that does as of 2026-04). Use for simulating "what if OpenAI returns malformed `response.done`" cases. |
| `nock` (via Vitest) | `^14` | HTTP-level mocking for the REST control plane (`/accept`, `/reject`, `/refer`, webhooks) | Standard, cassette support via `nock-vcr` if test fixtures grow large. |

See §4 for the full testing strategy — it's the only domain where the research produced a non-obvious answer.

**Confidence: MEDIUM-HIGH** — `llmock` and `AIMock` are 2025-era products, not battle-tested at scale; the custom replay harness is the reliable backstop.

---

## 2. Installation (prescriptive one-liner)

```bash
# Core Bridge runtime
npm install \
  @openai/agents@^0.8.3 \
  @openai/agents-realtime@^0.8.3 \
  openai@^6.34.0 \
  @modelcontextprotocol/sdk@^1.29.0 \
  @anthropic-ai/claude-agent-sdk@^0.2.110 \
  @anthropic-ai/sdk@^0.89.0 \
  ws@^8.20.0 \
  fastify@^5.8.5 \
  @fastify/helmet@^13.0.2 \
  zod@^4.3.6 \
  pino@^10.3.1 \
  pino-roll@^4.0.0 \
  prom-client@^15.1.3 \
  better-sqlite3@^12.9.0

# Dev dependencies
npm install -D \
  typescript@^5.7.0 \
  tsx@^4.19.0 \
  vitest@^4.0.18 \
  pino-pretty@^13.1.3 \
  nock@^14.0.0 \
  @types/ws@^8.5.13 \
  @types/better-sqlite3@^7.6.12 \
  @types/node@^22.10.0
```

---

## 3. Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Raw `ws` + SDK types for sideband | `@openai/agents` high-level `RealtimeSession` | Only if you want an all-in-one audio+control client (browser/WebRTC use cases). Not for server-side control-only. |
| Fastify 5 | Express 5 (Core's choice) | Only if you'd otherwise have two HTTP stacks in one codebase and the service genuinely shares middleware with Core. For a net-new isolated service, Fastify wins. |
| Fastify 5 | Hono 4.x | Edge deployment (Cloudflare Workers, Deno Deploy). Not Lenovo1 systemd. |
| `@modelcontextprotocol/sdk` stdio | JSON-RPC over Unix socket (hand-rolled) | Never — MCP protocol compliance is worth one dependency, and Claude Chat debugging (AC-07) only works with MCP-compliant servers. |
| `pino` | `winston` | Legacy apps, needing exotic transports, or if you're already using Winston elsewhere. For greenfield high-throughput JSONL: Pino. |
| systemd user unit | Docker Compose | Multi-service orchestration where containers already exist. Not this. |
| Custom cost module | Third-party LLM-cost-tracking lib | Today: none covers Realtime pricing correctly. Revisit in 6 months. |
| Node.js (TS) for Bridge | Python + `asyncio` | Never — operational split burden > any perceived benefit. Python lives only in `sip-to-ai` on Hetzner. |

---

## 4. Testing Strategy (answering the Tertiary question)

**Problem:** PSTN calls cost money, require Sipgate cooperation, can't run in CI, and have non-deterministic latency. But REQ-QUAL-01 mandates ≥3-turn end-to-end real PSTN test before any gate PASS. These are complementary not alternatives:

### 4.1 Three-tier test pyramid

| Tier | What it tests | Tools | Run frequency |
|------|---------------|-------|---------------|
| **Unit** | Individual functions: cost math, webhook sig verification, tool-arg parsing, Zod schemas | `vitest` + no I/O | Every commit |
| **Integration — replay harness** | Full Bridge event loop against recorded OpenAI Realtime event sequences | `vitest` + custom WS replay server + `nock` for REST | Every commit |
| **End-to-end — real PSTN** | Full stack incl. Sipgate + FreeSWITCH + Bridge + real OpenAI | Manual gate test per spike methodology | Per-gate PASS only |

### 4.2 Replay harness design (prescriptive)

The spike E artefacts already contain recorded `turns-*.jsonl` files — these ARE the test fixtures. Build a small in-process mock:

```ts
// test/harness/mock-realtime-ws.ts
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';

export function startMockRealtimeWs({ fixturePath }: { fixturePath: string }) {
  const events = readFileSync(fixturePath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    // Replay each event with its recorded relative delay
    let t0 = events[0].ts;
    for (const evt of events) {
      setTimeout(() => ws.send(JSON.stringify(evt)), evt.ts - t0);
    }
  });
  return wss;
}
```

In tests, point the Bridge's sideband ws URL at `ws://localhost:<port>` via env var override. Assert:
- tool call issued within X ms of `response.function_call_arguments.done`
- `conversation.item.create` payload matches schema
- cost ledger delta matches expected from `response.done.usage`
- no write to `~/nanoclaw/voice-container/runs/audio/*` happened (MOS-6 canary)

This gives you **deterministic, offline, free CI runs** that catch 95% of regressions. The other 5% (real PSTN jitter, Sipgate quirks, OpenAI-side behaviour changes) require real gate tests — that's unavoidable.

### 4.3 Chaos layer (optional, recommended before Case 4 go-live)

Use `llmock` or `AIMock` to inject:
- delayed `response.done` (does cost accounting handle 10s+ response?)
- malformed `response.function_call_arguments.done` (does tool router degrade gracefully per REQ-DIR-05?)
- ws close mid-tool-call (does Bridge log CRITICAL per REQ-INFRA-11?)

**Confidence: MEDIUM-HIGH.** The replay-harness pattern is proven in other real-time domains (financial trading, game networking); `llmock` is newer but specifically supports Realtime.

---

## 5. What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **Pipecat** (any version) | AC-03 hard exclusion. Spike F measured P50 ~5455ms, 8.6× over budget. Framework forces trailing-silence wait before LLM trigger — structural, not tunable. | Raw `ws` + OpenAI Realtime. |
| **LiveKit** (for Bridge or SIP) | Sipgate REGISTER incompatibility already proven 2026-04-12 + confirmed in 2026-04-15 assessment. Also adds a gateway hop when the existing FreeSWITCH→OpenAI path is 635ms P50. | Keep FreeSWITCH + sip-to-ai on Hetzner (AC-07). |
| **Any STT+LLM+TTS serial pipeline** (Azure STT + Claude streaming + Azure TTS, Deepgram + GPT + ElevenLabs, etc.) | AC-01 hard exclusion. Spike B 1533ms P50, 1.7× over revised 900ms threshold. Claude ttft variance alone (stdev 725ms) is structural. | Native S2S: `gpt-realtime-mini` only. |
| **Claude in the hot-path** (even streaming) | AC-02 hard exclusion. Any sync Claude call pushes P50 > 1500ms. Sideband-WS spike T5 also showed mid-call tool updates via `session.update` BREAK audio (0 audio-delta events for 15s). | Claude async background director (AC-03 of DECISION). Tool schemas set ONCE at `calls/{id}/accept`; only `instructions` may update mid-call (AC-04, AC-05 of PRD). |
| **Mid-call `session.update` for tool definitions** | Sideband-WS Spike T5: pipeline-break, 0-audio-delta for 15s. This is the single most dangerous footgun in the entire Realtime API. | Declare the full tool inventory at call accept. If different cases need different tools, branch the accept-time config on case type (inferred from CLI / case_type param). |
| **`express.json()` on the webhook route** | Breaks HMAC signature verification (whitespace/key-order mutations). | Fastify + `config: { rawBody: true }` or Express + `express.raw({type: 'application/json'})`. |
| **Weak persona prompts** ("be helpful, use tools when needed") | Sideband-WS Runde 1 FAIL: hallucinated availability before any tool call. | AC-06 directive prompt: explicit prohibition against providing domain data from memory. See REQ-DIR-09. |
| **`tool_choice='required'`** | AC-004 of DECISION: blocks filler phrase, counterpart hears silence while tool runs (Spike E notes.md). | `tool_choice='auto'` + explicit filler directive in persona prompt ("Sage IMMER 'Einen Moment…' bevor du ein Tool nutzt"). |
| **More than 15 tools per session** | AC-006 of DECISION. Token overhead doubles response time past ~50 tools; 15 is the practical ceiling for latency headroom. | Inventory in REQ-TOOLS stays ≤15. Per-case tool subsets if needed (Case 2: tools 1,2,6,8; Case 4: tools 3,4,6,10). |
| **Docker on Lenovo1 for the Bridge** | No existing container pattern there. Core is bare-metal systemd. Doubles operational surface for zero benefit. | systemd user service under `carsten_bot`. |
| **OpenTelemetry / Datadog / New Relic** at MVP | Overkill for a private-use single-node service. Adds ≥50MB deps, a collector process, and config surface. | Pino JSONL + prom-client. Add OTel later if the stack grows. |
| **Python rewrite of Core tool handlers** | Every downstream consumer is TS. Introduces a second runtime, second package manager, second lint/test toolchain. | TS/Node throughout the Bridge. Python stays in `sip-to-ai` on Hetzner only. |
| **Twilio Media Streams patterns** (found in many blog posts) | Twilio-specific WS audio bridging. We use Sipgate + direct OpenAI SIP — entirely different architecture. | Read Twilio blogs for *patterns* (accept+config flow, tool handling) but implement against our SIP + Sideband stack. |

---

## 6. Stack Patterns by Variant

### 6.1 If you're implementing Case 6 first (MVP per ConOps §4a.3)

- Minimal tool set: `check_calendar`, `create_calendar_entry`, `send_discord_message` (REQ-TOOLS-01/02/06) — 3 of 15 slots.
- No competitor search, no contract repo, no hotel search yet.
- Persona prompt can be straightforward ("Du bist NanoBot und sprichst gerade mit Carsten…") — directional prompting is most critical for counterpart-facing cases (2/3/4).
- Can skip the Case-4-specific takeover hotword handler initially.

### 6.2 If you're implementing Case 4 (hardest case)

- Add `get_contract`, `search_competitors` tools.
- Takeover hotword detection (REQ-C4-11): listen for hotword in transcript stream, then issue `POST /v1/realtime/calls/{call_id}/refer` with SIP REFER target = Carsten's mobile.
- Add phishing heuristic module: verify counterpart identity via `get_contract` cross-check BEFORE disclosing any PII (REQ-C4-08/09).
- This is where `AIMock` chaos testing pays off — malicious callers probing boundaries.

### 6.3 If cost anomalies appear in production

- Enable `pino` TRACE level for the `response.done` handler to capture full `usage` per turn.
- Add a `/metrics` counter `voice_turn_cost_eur` histogram; Grafana alert at P99 > 0.05€/turn.
- Refresh `PRICES_EUR_PER_MTOK` monthly from OpenAI pricing page (open point — no auto-updater lib exists).

---

## 7. Version Compatibility Matrix

| Package | Pinned | Compatible With | Notes |
|---------|--------|-----------------|-------|
| `@openai/agents@^0.8.3` | Node ≥22 | `@openai/agents-realtime@^0.8.3` | Keep both on same minor — v0.8 still pre-1.0, API changes possible. Lock-step upgrade. |
| `@modelcontextprotocol/sdk@^1.29` | Node ≥18 | `zod@^3` or `zod@^4` | SDK supports both Zod majors. We use Zod 4. |
| `openai@^6.34` | Node ≥18 | `@openai/agents@^0.8.3` | Agents SDK depends on the same `openai` base client. |
| `fastify@^5` | Node ≥20 | `@fastify/helmet@^13`, `@fastify/websocket@^11` | Fastify v5 broke some plugin APIs from v4; always verify plugin version ranges. |
| `pino@^10` | Node ≥18 | `pino-roll@^4`, `pino-pretty@^13` | v10 released 2025-Q3; pino-pretty v13 is the matching major. |
| `better-sqlite3@^12` | Node ≥20, native build | — | Requires `node-gyp` at install time; Lenovo1 has the toolchain already (Core installs it). |
| `@anthropic-ai/claude-agent-sdk@^0.2` | Node ≥20 | `@anthropic-ai/sdk@^0.89` | Agent SDK still 0.2.x — expect breaking changes before 1.0. |

**Node.js version:** Use **22.11 LTS or newer**. Agents SDK requires 22+; older Node versions will silently break sideband-WS subprotocol handling.

---

## 8. Open Questions Flagged for Roadmap

Things the research surfaced that need phase-specific decisions, NOT stack decisions:

1. **Webhook endpoint path + Caddy config lives on Hetzner** — this is `carsten` (server-admin)'s lane, NOT `carsten_bot`'s. Phase plan must include a Hetzner deployment sub-task separate from the Lenovo1 Bridge.
2. **Cost price refresh** — no auto-updater for OpenAI Realtime pricing. Add a monthly cron that pings the pricing page + Discord-alerts if the parsed numbers differ from the hardcoded constants. This is a 30-line skill, not a library.
3. **REFER transfer target for Case 4 takeover** — is it Carsten's mobile (tel:+49…) or a dedicated Sipgate extension? Affects Case 4 planning only, not Case 6 MVP.
4. **OpenAI ZDR mode activation** — AC-008 of DECISION says "pending activation". This is a project-settings toggle on platform.openai.com, not a code change. Confirm done before first live counterpart call.
5. **Fixture capture from spike/candidate-e/** — the replay harness needs 3-5 representative event sequences. Capture during first Lenovo1 smoke test, commit to `spike/fixtures/`.

---

## 9. Sources

**Primary (HIGH confidence):**

- [OpenAI Realtime API with SIP — official guide](https://platform.openai.com/docs/guides/realtime-sip) — SIP accept/reject/refer endpoints, webhook payload, SIP endpoint URL format.
- [OpenAI Webhooks and server-side controls](https://platform.openai.com/docs/guides/realtime-server-controls) — sideband WS URL `wss://api.openai.com/v1/realtime?call_id=…`, signature verification via `client.webhooks.unwrap`.
- [OpenAI Realtime Server Events reference](https://platform.openai.com/docs/api-reference/realtime-server-events) — `response.function_call_arguments.done` and `response.done` event schemas.
- [OpenAI Realtime Client Events reference](https://platform.openai.com/docs/api-reference/realtime-client-events) — `conversation.item.create` with `function_call_output` item type, `session.update`.
- [`@openai/agents` npm page](https://www.npmjs.com/package/@openai/agents) — v0.8.3, published 2026-04-06, Node ≥22 requirement.
- [`@openai/agents-realtime` npm page](https://www.npmjs.com/package/@openai/agents-realtime) — realtime transport types incl. `OpenAIRealtimeSIP.buildInitialConfig()`.
- [OpenAI Agents SDK TypeScript docs](https://openai.github.io/openai-agents-js/) — realtime transport guide, SIP attach pattern.
- [`@modelcontextprotocol/sdk` npm page](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — v1.29.0, published 2026-03-30; stdio and Streamable HTTP transports.
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) — release cadence, transport migration from SSE → Streamable HTTP.
- [Fastify v5 docs](https://fastify.dev/docs/latest/) — raw body support, plugin ecosystem.
- [Pino homepage](https://getpino.io/) — NDJSON output, performance characteristics.
- [NanoClaw Core `package.json`](/home/carsten_bot/nanoclaw/package.json) — existing dep versions (verified by direct read).
- [voice-channel-spec/ARCHITECTURE-DECISION.md](/home/carsten_bot/nanoclaw-state/voice-channel-spec/ARCHITECTURE-DECISION.md) — AC-001..009 constraints, Spike E/B/C/F measurements.
- [voice-channel-spec/PRD.md §7a](/home/carsten_bot/nanoclaw-state/voice-channel-spec/PRD.md) — AC-01..08 binding constraints.
- [voice-channel-spec/REQUIREMENTS.md](/home/carsten_bot/nanoclaw-state/voice-channel-spec/REQUIREMENTS.md) — REQ-DIR, REQ-TOOLS, REQ-INFRA verbatim.

**Secondary (MEDIUM confidence):**

- [Anthropic Claude Agent SDK GitHub](https://github.com/anthropics/claude-agent-sdk-typescript) — async generators, hooks, MCP client integration.
- [OpenAI Developer Community: INVITE→realtime.call.incoming delay](https://community.openai.com/t/consistently-3-5s-sometimes-7s-invite-realtime-call-incoming-delay-on-sip-realtime-accept-is-1s-any-guidance/1366874) — real-world webhook-arrival delays (3-5s, sometimes 7s).
- [Twilio: Outbound calls with Node + Realtime + Agents SDK](https://www.twilio.com/en-us/blog/outbound-calls-node-openai-realtime-api-voice) — tool-calling pattern reference (our architecture differs).
- [Better Stack: Pino vs Winston](https://betterstack.com/community/comparisons/pino-vs-winston/) — ecosystem consensus on Pino for high-throughput JSONL.
- [Dash0 Node.js logging libraries 2025](https://www.dash0.com/faq/the-top-5-best-node-js-and-javascript-logging-frameworks-in-2025-a-complete-guide).
- [llmock — Deterministic mock LLM server](https://llmock.copilotkit.dev/) — confirmed OpenAI Realtime over WS support.
- [AIMock](https://dev.to/copilotkit/aimock-one-mock-server-for-your-entire-ai-stack-1jhp) — realtime streaming physics, jitter profiles.

**Tertiary (LOW-MEDIUM, consulted for context only):**

- Hooklistener, codehooks, various 2026 blog posts on webhook patterns — ecosystem check, not primary sources.
- [Hono vs Fastify vs Express 2025 architecture guide](https://levelup.gitconnected.com/hono-vs-express-vs-fastify-the-2025-architecture-guide-for-next-js-5a13f6e12766) — performance comparison backing Fastify choice.

---

*Stack research for: NanoClaw Voice Director Bridge*
*Researched: 2026-04-16*
*Author: Claude Opus 4.6 (1M context) via GSD research agent*
*Next consumer: roadmap generation (Phase 7)*
