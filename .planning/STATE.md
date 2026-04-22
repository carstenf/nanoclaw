---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Completed 03-11-PLAN.md — Case-6b end-to-end ready, awaiting Carsten PSTN test
last_updated: "2026-04-22T21:07:19.989Z"
last_activity: 2026-04-22 -- Phase 05.3 planning complete
progress:
  total_phases: 12
  completed_phases: 3
  total_plans: 64
  completed_plans: 51
  percent: 80
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-16)

**Core value:** Carsten can delegate telephone tasks without being present, with zero unauthorized commitments.
**Current focus:** Phase 05.2 — persona-redesign-and-call-flow-state-machine

## Current Position

Phase: 05.2 (persona-redesign-and-call-flow-state-machine) — EXECUTING
Plan: 1 of 6
Status: Ready to execute
Last activity: 2026-04-22 -- Phase 05.3 planning complete

Progress: [█████████░] 94%

## Performance Metrics

**Velocity:**

- Total plans completed: 5
- Average duration: —
- Total execution time: 0 h

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| — | — | — | — |
| 04.5 | 5 | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 01 P03 | 18min | 2 tasks | 10 files |
| Phase 01-infrastructure-webhook-path P04 | 7min | 2 tasks (code-only, deploy deferred) tasks | 3 files (1 dialplan + 1 backup + 1 smoke script) files |
| Phase 01-infrastructure-webhook-path P05 | 62 | 3 tasks | 14 files |
| Phase 03-voice-mcp-endpoint P03-02 | 16 | 5 tasks | 8 files |
| Phase 03-voice-mcp-endpoint P03-03 | 40 | 5 tasks | 8 files |
| Phase 03-voice-mcp-endpoint P03-04 | 4 | 4 tasks | 6 files |
| Phase 03-voice-mcp-endpoint P05 | 10 | 4 tasks | 6 files |
| Phase 03-voice-mcp-endpoint P06 | 15 | 5 tasks | 11 files |
| Phase 03 P07 | 22 | 3 tasks | 5 files |
| Phase 02-director-bridge-v0-hotpath-safety P11 | 8 | 5 tasks | 9 files |
| Phase 03-voice-mcp-endpoint P08 | 5 | 4 tasks | 7 files |
| Phase 02-director-bridge-v0-hotpath-safety P12 | 15 | 3 tasks | 7 files |
| Phase 03-voice-mcp-endpoint P09 | 70 | 7 tasks | 15 files |
| Phase 03-voice-mcp-endpoint P10 | 75 | 5 tasks | 7 files |
| Phase 02-director-bridge-v0-hotpath-safety P14 | 20 | 4 tasks | 9 files |
| Phase 03-voice-mcp-endpoint P11 | 72 | 6 tasks | 16 files |

## Accumulated Context

### Roadmap Evolution

- Phase 05.1 inserted after Phase 05: AMD persona handoff redesign and ASR upgrade (URGENT) — blocks Phase 05 Plan 05-03 Task 5 live verification (Defects #4, #5, #6)

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- E1-1a (2026-04-15): `gpt-realtime-mini` as Hot-Path model (635 ms P50 validated)
- E1-1a (2026-04-15): Claude Sonnet as async Slow-Brain, never hot-path (AC-02)
- E1-1a (2026-04-15): Tools set once at accept, never mid-call (AC-04)
- Research (2026-04-16): Director Bridge in Node.js/TypeScript (matches Core ecosystem; resolves STACK vs. ARCHITECTURE language conflict)
- Research (2026-04-16): Case 6 first, then 2 → 3 → 4; Case 1 stays v2+
- [Phase 01]: Plan 03: vs-webhook-forwarder Python+FastAPI relay code complete (98 LOC main.py, 4 passed + 1 doc-skip pytest); deploy DEFERRED until Wave 1 (carsten Hetzner tasks) PASS
- [Phase 01-infrastructure-webhook-path]: Plan 04: FreeSWITCH dialplan rewritten verbatim from Template 8 — Sipgate inbound now bridges to OpenAI SIP TLS endpoint with PCMU lock + originate_timeout=3 + respond 503 (D-19..D-22, SIP-04, SIP-07); deploy DEFERRED until Wave 1 PASS
- [Phase 01-infrastructure-webhook-path]: openai.webhooks.unwrap() is async (returns Promise) — await required; try/catch alone misses rejections
- [Phase 01-infrastructure-webhook-path]: voice-bridge config uses lazy getSecret() not module-level constant to avoid process.exit during vitest imports
- [Phase 01-infrastructure-webhook-path]: systemd ExecStart uses nvm node path on Lenovo1 — /usr/bin/node absent, must use ~/.nvm path
- [Phase 03-voice-mcp-endpoint]: SLOW_BRAIN_PROXY_URL separate from ONECLI_URL — port 10255 with token for host-process inference
- [Phase 03-voice-mcp-endpoint]: claude-sonnet-4-5 as default Slow-Brain model (alias, not date-versioned)
- [Phase 03-voice-mcp-endpoint]: Throw BadRequestError (not ok:false) for validation — mcp-server.ts maps to 400
- [Phase 03-voice-mcp-endpoint]: Force refreshAccessToken() when access_token empty — handles post-initial-auth token file state
- [Phase 03-voice-mcp-endpoint]: voice.send_discord_message conditional registration — tool absent when allowlist empty (fail-safe deny-all)
- [Phase 03-voice-mcp-endpoint]: sendDiscordMessage callback returns {ok}|{ok:false,error} — no throw — handler maps gracefully to discord_not_configured
- [Phase 03-voice-mcp-endpoint]: Raw fetch over SDK for Distance Matrix — zero dep footprint
- [Phase 03-voice-mcp-endpoint]: JSONL never logs origin/destination — PII-clean by default
- [Phase 03-voice-mcp-endpoint]: Always-register get_contract + get_practice_profile (not_configured fallback, no side-effects)
- [Phase 03-voice-mcp-endpoint]: Shared voice-lookup.jsonl for both flat-db tools
- [Phase 03]: Always-register voice.schedule_retry — returns no_main_group if DI callback absent; simpler than conditional registration
- [Phase 03]: getMainGroupAndJid DI provides both folder+jid in one call — avoids two separate DI deps
- [Phase 02-director-bridge-v0-hotpath-safety]: Lazy-load dispatchTool in sideband.ts via require() to avoid circular ESM import
- [Phase 02-director-bridge-v0-hotpath-safety]: DI opts pattern keeps dispatch testable without real WS or MCP network calls
- [Phase 03-voice-mcp-endpoint]: skill-loader separate from flat-db-reader (different namespace)
- [Phase 03-voice-mcp-endpoint]: topic slug-regex in Zod prevents path-traversal before filesystem access
- [Phase 03-voice-mcp-endpoint]: skill_not_configured as ok:true answer for graceful bot degradation
- [Phase 02-director-bridge-v0-hotpath-safety]: ask_core + get_travel_time wired in 02-12; bridge-allowlist now consistent with all 8 core-existing tools; tools_count=11
- [Phase 03-voice-mcp-endpoint]: REQ-TOOLS schemas are the contract: Bridge shapes accepted as-is, Core handlers refactored to match
- [Phase 03-voice-mcp-endpoint]: check_calendar v0-simple: 1440 - busy_minutes >= duration_minutes (no contiguous-slot puzzle)
- [Phase 03-voice-mcp-endpoint]: onOutput streaming in andy-agent-runner: resets container idle-timeout on cold starts (60-120s)
- [Phase 03-voice-mcp-endpoint]: No sessionId in voice containerInput: fresh conversations only, no session resume
- [Phase 02-director-bridge-v0-hotpath-safety]: CASE6B_PERSONA uses ASCII umlauts per Plan truths[8] strict template
- [Phase 02-director-bridge-v0-hotpath-safety]: emitFiller awaited before callCoreTool — filler on wire before 90s container wait, failure does not block dispatch
- [Phase 03-voice-mcp-endpoint]: OutboundRouter: DI timers mock + in-memory queue; 10.0.0.2 in peer allowlist (Core+Bridge colocated); buildOutboundPersona plain string.replace; tools_count 11→12
- [Phase 04-core-tool-integration]: A12 idempotency closed — dispatch.ts routes mutating tools through invokeIdempotent (per-tool `mutating: true` flag drives the branch); read-only tools bypass
- [Phase 04-core-tool-integration]: state.db schema extended — voice_call_costs + voice_turn_costs + voice_price_snapshots tables; PRIMARY KEY (call_id, turn_id) SQL-level dedup for voice.record_turn_cost
- [Phase 04-core-tool-integration]: Hard-stop via `session.update { instructions }` only — NEVER mutate tools mid-call (AC-04/AC-05 compliance); followed by response.create + 4s hold + ws.close(1000)
- [Phase 04-core-tool-integration]: StreamableHTTP MCP on port 3201 (bearer + peer-allowlist) — disjoint key space via synthetic `chat-<uuid>` call_id/turn_id prefix; Pitfall 6 enforced bind 10.0.0.2 not 0.0.0.0
- [Phase 04-core-tool-integration]: MCP SDK per-request Server+Transport pattern — singleton `connect()` breaks on second client with -32600; stateless mode (`sessionIdGenerator: undefined`) is the canonical fix
- [Phase 04-core-tool-integration]: audit-audio.sh dev-artefact exclusions — `*/node_modules/*`, `*/_archive*/*`, `*/spike/*`, `*/voice-stack/runs/*`, `*/site-packages/*`, `-not -name silence.wav`; production call recordings never land in those roots
- [Phase 04-core-tool-integration]: Hetzner Caddy route `/nanoclaw-voice/*` uses forward_auth + `header_up Authorization "Bearer ..."` rewrite — OAuth at edge, static bearer internal, no app-code change for consistency with existing /hetzner /discord /lenovo1 pattern

### Pending Todos

- **Phase 4 follow-up:** spike-replay-harness for COST-01 live verification — drives accumulator with 10 synthetic usage events, asserts soft-warn + hard-stop + session.update flow, posts Discord results.
- **Phase 4 follow-up:** iOS Claude App UI-compat fix — session-based MCP transport-map (replace stateless per-request) OR set `capabilities.tools.listChanged:false`. iOS currently hangs app while MCP connected.
- **Phase 4 low-prio:** recon-invoice.ts "append-only" bug — 3 duplicate "missing CSV for 2026-03" entries in `~/nanoclaw-state/open_points.md`; add write-if-not-present check.

### Blockers/Concerns

- **Phase 5/6/7 hard-gated on Phase 0:** No real counterpart call may place before ZDR verified + lawyer opinion filed. Phase 3/4 (Case 6 internal) may proceed independently.
- **Phase 0 external dependency:** Lawyer opinion is external (German telecoms lawyer, e.g. HÄRTING or LUTZ|ABEL); lead time unknown — start engagement early.
- **carsten server-admin coordination:** Phase 0 (OpenAI ZDR dashboard toggle) and Phase 1 (Caddy subdomain, OpenAI webhook URL registration, WireGuard MTU) require `carsten` user; sub-tasks must be isolated from `carsten_bot` lanes.
- **Phase 6 IVR hold-music:** Research flagged this as single most underspecified area (LOW-MEDIUM confidence); plan a `/gsd-research-phase` before implementation.
- **Phase 7 hotword + REFER target:** Carsten decisions pending (hotword string, REFER target = mobile vs. dedicated extension).
- **REQUIREMENTS.md coverage header stale:** File header says "98 total" but actual count is 101 (LEGAL:4 + INFRA:8 + SIP:9 + VOICE:12 + DIR:13 + TOOLS:9 + C6:5 + C2:8 + C3:8 + C4:11 + COST:5 + DISC:4 + QUAL:5). Traceability table below reflects correct 101 mapping.

## Deferred Items

Items explicitly carried forward (per PRD § Out of Scope) — not roadmap phases:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Case 1 | Hotel research & booking (multi-call campaign, credit-card constraint) | Deferred to v2+ | PRD v1.0 / Research 2026-04-16 |
| Case 5 | Smart voicemail | Deferred indefinitely | PRD v1.0 |
| DTMF | Keypad send/receive for IVR navigation | Deferred to v2 unless Case 3 blocker | REQ-C3-08, research |
| C4-EXT | Discord one-time-whitelist override + adversarial-pattern learning loop | Deferred to v2 | PRD v1.0 |

## Session Continuity

Last session: 2026-04-18T19:53:33.032Z
Stopped at: Completed 03-11-PLAN.md — Case-6b end-to-end ready, awaiting Carsten PSTN test
Resume file: None
