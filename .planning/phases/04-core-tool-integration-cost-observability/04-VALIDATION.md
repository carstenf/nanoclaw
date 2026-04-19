---
phase: 4
slug: core-tool-integration-cost-observability
status: plan-mapped
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-19
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from 04-RESEARCH.md → Validation Architecture section. Planner fills per-task rows below.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest@^4.0.18 (both Core and Bridge) |
| **Config file** | vitest.config.ts (both repos) |
| **Quick run command** | `npm run test -- --run src/cost-ledger.test.ts voice-bridge/src/cost/` |
| **Full suite command** | `npm run test && (cd voice-bridge && npm run test)` |
| **Estimated runtime** | ~40–60 seconds full, <5 s quick |

---

## Sampling Rate

- **After every task commit:** Run `npm run typecheck && npm run lint && npm run test -- --run <changed-test-files>`
- **After every plan wave:** Run full suite command (both repos)
- **Before `/gsd-verify-work`:** Full suite must be green AND one synthetic cost-cap call AND one seeded §201 audit run AND one Chat-Claude StreamableHTTP invocation
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-T1 | 01 | 1 | INFRA-06 | T-04-01-01,02,03 | Wave-0 tests RED (imports not found) | unit | cd voice-bridge && npx vitest run src/cost/prices.test.ts src/cost/accumulator.test.ts | yes (after T1) | ⬜ |
| 04-01-T2 | 01 | 1 | INFRA-06 | T-04-01-02 | accumulator cached-subset math Pitfall 1 | unit | cd voice-bridge && npm run test -- --run src/cost/prices.test.ts src/cost/accumulator.test.ts | yes | ⬜ |
| 04-01-T3 | 01 | 1 | INFRA-06 | T-04-01-01,05 | PRIMARY KEY(call_id,turn_id) dedup + prepared statements | unit | npm run test -- --run src/cost-ledger.test.ts | yes | ⬜ |
| 04-01-T4 | 01 | 1 | INFRA-06 | T-04-01-06 | zod-validated MCP tool handler + BadRequestError | unit | npm run test -- --run src/mcp-tools/voice-record-turn-cost.test.ts src/mcp-tools/voice-finalize-call-cost.test.ts | yes | ⬜ |
| 04-02-T1 | 02 | 2 | COST-01 | T-04-02-08 | A12: invokeIdempotent wraps mutating tools | unit | cd voice-bridge && npm run test -- --run src/tools/dispatch.test.ts tests/idempotency.test.ts | yes | ⬜ |
| 04-02-T2 | 02 | 2 | COST-02,03 | T-04-02-05,07 | Gate SUM query via voice.get_day_month_cost_sum, reset via manual tool | unit | npm run test -- --run src/mcp-tools/voice-get-day-month-cost-sum.test.ts src/mcp-tools/voice-reset-monthly-cap.test.ts && cd voice-bridge && npm run test -- --run src/cost/gate.test.ts | yes | ⬜ |
| 04-02-T3 | 02 | 2 | COST-01,04 | T-04-02-02,03,04,09 | Pitfall 2 atomic guard-flag + instructions-only farewell (AC-04/AC-05) | integration | cd voice-bridge && npm run test -- --run src/sideband.test.ts src/cost/gate.test.ts | yes | ⬜ |
| 04-03-T1 | 03 | 3 | TOOLS-05 | T-04-03-08 | SDK install + Import resolves | smoke | node --input-type=module -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m=>{if(!m.McpServer)process.exit(1)})" | yes (after install) | ⬜ |
| 04-03-T2 | 03 | 3 | TOOLS-05 | T-04-03-06,09 | Graceful not_configured when SEARCH_COMPETITORS_PROVIDER absent | unit | npm run test -- --run src/mcp-tools/voice-search-competitors.test.ts && cd voice-bridge && npm run test -- --run src/tools/dispatch.test.ts | yes | ⬜ |
| 04-03-T3 | 03 | 3 | TOOLS-01,02,04,05,06,07 | T-04-03-01..08 | Bearer+peer-allowlist, explicit 10.0.0.2 bind, Pitfall 8 disjoint keys | integration | npm run test -- --run src/mcp-stream-server.test.ts | yes | ⬜ |
| 04-03-T4 | 03 | 3 | TOOLS-01,02,04,06,07 | T-04-02-08 | Dispatch routing smoke for all Phase-4 TOOLS | integration | cd voice-bridge && npm run test -- --run src/tools/ | yes | ⬜ |
| 04-04-T1 | 04 | 4 | QUAL-04 | T-04-04-02,05,06 | audit exit-1 on seeded .wav; read-only script | integration (shell) | bash scripts/audit-audio.test.sh | yes | ⬜ |
| 04-04-T2 | 04 | 4 | INFRA-07 | T-04-04-01,03,08 | Pitfall 5: NEVER auto-update TS constants | integration (shell) | bash scripts/pricing-refresh.test.sh && npm run test -- --run src/mcp-tools/voice-insert-price-snapshot.test.ts | yes | ⬜ |
| 04-04-T3 | 04 | 4 | QUAL-03,COST-05 | T-04-04-04,07,09 | Pitfall 9 event-name, Pitfall 7 CSV-fallback | unit | npm run test -- --run src/drift-monitor.test.ts src/recon-3way.test.ts src/recon-invoice.test.ts | yes | ⬜ |
| 04-05-T1 | 05 | 5 | (deploy) | T-04-05-02 | systemctl --user enable --now + port-bind check (2 systemd timers total: 1× Lenovo1 `nanoclaw-audit-audio.timer` + 1× Hetzner `voice-audit-audio.timer` + 1× Hetzner `voice-pricing-refresh.timer` = 3 timer units across 2 hosts; drift-monitor/recon-3way/recon-invoice are in-process scheduled_tasks, NOT systemd units) | integration (manual+automated) | systemctl --user list-timers 'nanoclaw-*' && ss -tlnp \| grep -E ':320[01]' | no (runtime) | ⬜ |
| 04-05-T2 | 05 | 5 | COST-01 | T-04-05-03 | Synthetic cost-cap — Option A spike-replay preferred | checkpoint:human-verify | sqlite query for terminated_by='cost_cap_call' | no (evidence) | ⬜ |
| 04-05-T3 | 05 | 5 | AC-07 | T-04-03-03,07 | iPhone Claude-App end-to-end | checkpoint:human-verify | curl http://10.0.0.2:3201/mcp/stream/health | no (evidence) | ⬜ |
| 04-05-T4 | 05 | 5 | QUAL-04 | T-04-04-02 | Seeded .wav → service fails; clean → active | integration (manual) | systemctl --user status *-audit-audio.service after seed | no (runtime) | ⬜ |
| 04-05-T5 | 05 | 5 | (gate) | — | Full test suites both repos green | unit+lint | npm run test && cd voice-bridge && npm run test | yes (runtime) | ⬜ |

*Planner populates this table from PLAN.md tasks. Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

From research `Wave 0 Gaps` section — tests/scripts that must exist before behavior tasks run:

- [ ] `voice-bridge/src/cost/accumulator.test.ts` — per-turn cost math + 80%/100% thresholds (Plan 04-01 Wave 0)
- [ ] `voice-bridge/src/cost/prices.test.ts` — static pricing table + USD→EUR (Plan 04-01 Wave 0)
- [ ] `voice-bridge/src/cost/gate.test.ts` — /accept-time daily/monthly SUM gate (Plan 04-02 Wave 2, alongside code)
- [ ] `src/cost-ledger.test.ts` — DB migrations + SUM queries (Plan 04-01 Wave 0)
- [ ] `src/mcp-tools/voice-record-turn-cost.test.ts` (Plan 04-01 Wave 0)
- [ ] `src/mcp-tools/voice-finalize-call-cost.test.ts` (Plan 04-01 Wave 0)
- [ ] `src/mcp-tools/voice-insert-price-snapshot.test.ts` — pricing snapshot MCP tool (Plan 04-04 Task 2 subtask 2b-pre, Wave-0-for-Wave-4)
- [ ] `voice-bridge/src/sideband.test.ts` — response.done hook skeleton with .todo placeholders (Plan 04-02 Task 3 subtask 3a-pre, Wave-0-for-Wave-2 — Bridge-side, intentionally NOT in Plan 04-01 to keep Plan 01's Core-only Wave-0 boundary clean)
- [ ] `src/mcp-tools/voice-search-competitors.test.ts` — TOOLS-05 (Plan 04-03 Task 2)
- [ ] `src/drift-monitor.test.ts` — rolling P50 (Plan 04-04 Task 3)
- [ ] `src/recon-3way.test.ts` — cal ↔ transcript ↔ Discord (Plan 04-04 Task 3)
- [ ] `src/recon-invoice.test.ts` — monthly OpenAI invoice compare (Plan 04-04 Task 3)
- [ ] `src/mcp-stream-server.test.ts` — StreamableHTTP transport + auth (Plan 04-03 Task 3)
- [ ] `scripts/audit-audio.sh` + shell test harness (Plan 04-04 Task 1)
- [ ] `scripts/pricing-refresh.sh` + shell test (Plan 04-04 Task 2)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Chat-Claude invokes a tool via StreamableHTTP end-to-end | AC-07 | Requires iPhone Claude App config + WG peer | 1. `claude mcp add` on iPhone with bearer + URL. 2. Ask Claude "check my calendar for Monday". 3. Verify call appears in Bridge logs and returns JSON. |
| Synthetic 30-min cost-cap call triggers farewell | COST-01 | Live OpenAI call costs money; can't fully automate | Use the synthetic-test runner from Phase 1; verify 80% soft-warn fires at ~24 min, 100% hang-up at ~30 min. |
| §201 audit FAILs loud on seeded `.wav` | QUAL-04 | Destructive test on shared host | Seed `/tmp/audit-test-$(date +%s).wav` on both hosts, run timer unit, assert exit code != 0 and Discord alert. |
| Monthly OpenAI invoice reconciliation >5% drift alert | COST-05 | Requires real monthly billing data | Fetch last month's invoice via OpenAI dashboard CSV, compare against ledger SUM, assert alert fires when stub-mutates ledger by 6%. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references listed above
- [ ] No watch-mode flags in commands
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter after planner fills the per-task map

**Approval:** plan-mapped by planner 2026-04-19; revision iteration 1 applied 2026-04-19 (BLOCKERs 1+2, WARNINGs 1-5, NIT — see 04-RESEARCH.md §Open Questions RESOLVED + plans 02/03/04); checker review pending
