---
phase: 4
slug: core-tool-integration-cost-observability
status: draft
nyquist_compliant: false
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
| *TBD* | *—* | *—* | *—* | *—* | *—* | *—* | *—* | *—* | ⬜ pending |

*Planner populates this table from PLAN.md tasks. Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

From research `Wave 0 Gaps` section — tests/scripts that must exist before behavior tasks run:

- [ ] `voice-bridge/src/cost/accumulator.test.ts` — per-turn cost math + 80%/100% thresholds
- [ ] `voice-bridge/src/cost/prices.test.ts` — static pricing table + USD→EUR
- [ ] `voice-bridge/src/cost/gate.test.ts` — /accept-time daily/monthly SUM gate
- [ ] `src/cost-ledger.test.ts` — DB migrations + SUM queries
- [ ] `src/mcp-tools/voice-record-turn-cost.test.ts`
- [ ] `src/mcp-tools/voice-finalize-call-cost.test.ts`
- [ ] `src/mcp-tools/voice-search-competitors.test.ts` — TOOLS-05
- [ ] `src/drift-monitor.test.ts` — rolling P50
- [ ] `src/recon-3way.test.ts` — cal ↔ transcript ↔ Discord
- [ ] `src/recon-invoice.test.ts` — monthly OpenAI invoice compare
- [ ] `src/mcp-stream-server.test.ts` — StreamableHTTP transport + auth
- [ ] `scripts/audit-audio.sh` + shell test harness
- [ ] `scripts/pricing-refresh.sh` + shell test

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

**Approval:** pending
