---
phase: 05-case-2-restaurant-reservation-outbound
artifact: PLAN-REVIEW
reviewed: 2026-04-20
reviewer: gsd-plan-checker
plans_checked: [05-00, 05-01, 05-02, 05-03, 05-04]
status: needs_revision
blockers: 2
majors: 3
minors: 4
infos: 2
---

# Phase 5 Plan Review — Case 2 Restaurant Reservation Outbound

## Verdict

`status: needs_revision` — 2 blockers + 3 majors. Plans are substantively strong (requirements traced, locked decisions respected, spikes gate Wave 3, pitfalls addressed) but two correctness issues must land before execute: (a) 05-02 omits `depends_on: 05-00` while consuming Spike-B output, and (b) RESEARCH.md still carries the pre-revision D-7 formulation verbatim, creating a documentation landmine.

## Findings Table

| # | Severity | Dimension | Plan | Finding |
|---|----------|-----------|------|---------|
| 1 | **blocker** | dependency_correctness | 05-02 | `depends_on: [05-01]` but Task 4 requires SPIKE-B-sipgate-486.md (Wave 0 artifact) |
| 2 | **blocker** | context_compliance (D-7) | RESEARCH.md | Old D-7 formulation `sha256(...+call_id_originating_session)` quoted verbatim in 4 places; contradicts 2026-04-20 revised D-7 |
| 3 | major | tool_cap | 05-03 | `must_haves.truths` item 6 explicitly accepts 16 tools for Case-2 sessions; REQ-TOOLS-09 caps at 15 per-session |
| 4 | major | push_early | 05-00, 05-01, 05-02, 05-03 | Only 05-04 Task 4 has `git push`; memory rule `feedback_push_early.md` wants push after each plan |
| 5 | major | pitfall_coverage | 05-03 | Pitfalls 5, 6, 7 from Research §5.2 are not signed off in 05-03 success criteria (only 1–4); 05-04 covers all 7, but 05-03 claims "Pitfalls 1,2,3,4 addressed" — leaves 5,6,7 unaddressed between Wave 2 and Wave 4 gate |
| 6 | minor | req_coverage | 05-02 | C2-02 "ring timeout = 30s" enforced only in Plan 05-02 Task 4 action step 5 as a code-comment assertion; no explicit test named; verification grep is weak |
| 7 | minor | scope_sanity | 05-02 | 5 tasks with 14 files modified; borderline oversized. Splitting Task 1 (DB+OutboundTask) from Task 5 (Andy wire-in) into a 05-02a / 05-02b is worth considering |
| 8 | minor | task_completeness | 05-03 Task 5 | Live checkpoint's `<verify>` uses `sqlite3 state.db` but the DB path should be project-rooted (`~/nanoclaw/state.db` or per config.ts); ambiguous in CI |
| 9 | minor | research_resolution | RESEARCH.md | `## Open Questions` section has 5 OQs; OQ-1/OQ-3/OQ-5 are routed to Wave 0 spikes (good), OQ-2 was resolved in CONTEXT D-7 revision (2026-04-20), OQ-4 has a proposed recommendation but no explicit resolution. Section heading not marked `(RESOLVED)`. |
| 10 | info | architectural_tier | 05-03 | amd_result tool bypasses Core MCP for dispatch — documented as Bridge-internal; this is a defensible tier placement for classifier-latency reasons |
| 11 | info | spec_drift | 05-CONTEXT.md | D-7 block is correctly marked "revised 2026-04-20" — CONTEXT is the source of truth; finding 2 is a RESEARCH-level lag, not a CONTEXT-level lag |

## Detailed Findings

### Blocker 1 — 05-02 missing dependency on 05-00

**Evidence:**
- `05-02-PLAN.md` line 6-7: `depends_on:\n  - 05-01`
- `05-02-PLAN.md` line 124: `@.planning/phases/05-case-2-restaurant-reservation-outbound/spike-results/SPIKE-B-sipgate-486.md` in context
- `05-02-PLAN.md` line 447: Task 4 `read_first` lists `spike-results/SPIKE-B-sipgate-486.md` as **AUTHORITATIVE**
- `05-02-PLAN.md` line 459: Task 4 action step 1 "Read SPIKE-B-sipgate-486.md to determine whether Sipgate distinguishes busy vs timeout"
- `05-00-PLAN.md` SPIKE-B produces this file

**Impact:** Executor could start Wave 2 before Wave 0 spikes complete. Task 4 would fail because SPIKE-B-sipgate-486.md wouldn't exist.

**Fix:** Add `- 05-00` to 05-02 `depends_on`. Wave number becomes 2 (max(0,1)+1 = 2, unchanged).

### Blocker 2 — RESEARCH.md carries pre-revision D-7

**Evidence:**
- `05-RESEARCH.md:36` quotes verbatim: `sha256(restaurant_phone + requested_date + requested_time + party_size + call_id_originating_session) — DIR-08 pattern.`
- `05-RESEARCH.md:9`: `locked_decisions_unchanged: D-1, D-2, D-3, D-4, D-5, D-6, D-7` — asserts D-7 unchanged, contradicting the 2026-04-20 revision in CONTEXT.md:118-120
- `05-RESEARCH.md:407` (Pitfall 3 table): describes the OLD formulation as the pitfall, now stale
- `05-RESEARCH.md:465-466` (OQ-2): flags the ambiguity but was not post-edited once CONTEXT was revised

**Impact:** CONTEXT is correct; all plans implement the REVISED D-7 correctly (verified in 05-02-PLAN lines 43, 154, 199-204, 427). But future readers (Phase 6 reuse, post-mortem) will hit contradictory source material. Also trips finding 5's pitfall-coverage logic because Pitfall 3 text is stale.

**Fix:** Either (a) update RESEARCH.md §User Constraints and OQ-2 to reflect the revised D-7 with a `(REVISED 2026-04-20)` stamp, or (b) add an explicit errata block at the top of RESEARCH.md pointing to CONTEXT D-7 as authoritative. Option (a) preferred.

### Major 3 — Tool-cap claim contradicts REQ-TOOLS-09

**Evidence:**
- `05-03-PLAN.md:46`: `"Case-2 sessions temporarily carry 16 which is acceptable per research §5.2 A5 mitigation (amd_result is Bridge-internal)."`
- REQUIREMENTS.md TOOLS-09: "Per-session tool list capped at 15 (AC-006)"
- Research §5.2 Pitfall 2 (line 406) explicitly warns current count = 12, post-Phase-5 projection 15-16; recommended mitigation is "make amd_result Bridge-internal (not model-facing)"
- BUT `05-03-PLAN.md:329` action step 2: "tools = [...existingCase6bOutboundTools, amdResultToolSpec]" — amd_result IS added to the OpenAI /accept tools array, which means the Realtime model DOES see it as a function tool (it has to, to emit the function_call)

**Analysis:** "Bridge-internal" semantically means "Bridge dispatches it without Core-MCP roundtrip" — that's correct. But from REQ-TOOLS-09's vantage point, the cap is on the Realtime-session tool list (the array passed to `openai.realtime.calls.accept({ tools: [...] })`). amd_result IS in that list for Case-2 sessions, so it DOES count against the cap. 16 > 15 violates REQ-TOOLS-09 literally.

**Fix:** Either (a) confirm with Carsten that amd_result is a sanctioned exception (amend REQ-TOOLS-09 wording to "15 non-classifier tools + optional AMD classifier"), or (b) drop one existing Case-2 tool from the outbound session tools list to make room (the Case-2 outbound probably doesn't need all 12 Case-6 tools), or (c) make amd_result a Bridge-side pseudo-tool triggered by transcript pattern rather than a model-emitted function_call — but this materially changes the AMD design and would require re-spiking. Recommend (b) as lowest-risk.

### Major 4 — Push-early rule missing in 4 of 5 plans

**Evidence:** `grep -n "git push"` returned matches only in 05-04 Task 4. Memory `feedback_push_early.md`: "Nach jedem abgeschlossenen Phase/Plan `git push origin main`".

**Impact:** Risk of 100+-commit backlog per memory rule.

**Fix:** Add final action step to each of 05-00, 05-01, 05-02, 05-03: `git push origin main`.

### Major 5 — Pitfall coverage gap

**Evidence:** `05-03-PLAN.md:516`: "Pitfalls 1, 2, 3, 4 addressed". Pitfalls 5 (Sipgate 486), 6 (cost-cap), 7 (daily-cap race) are addressed in 05-02 (Task 4 step 5 for Pitfall 6, Task 4 overall for Pitfall 5, Task 2 Test 11 for Pitfall 7) — good there. But 05-03 success criteria should clarify it relies on Wave 2 for 5-7, not re-address them.

**Impact:** Verifier (post-execute) may flag 05-03 as incomplete for Pitfalls 5-7 since it's the last pre-gate implementation wave.

**Fix:** Amend 05-03 success criteria line 516 to read: "Pitfalls 1, 2, 3, 4 addressed in this wave; Pitfalls 5, 6, 7 inherited from Wave 2 (verified in 05-04 gate)."

## Dimension Scores

| Dimension | Score | Notes |
|-----------|-------|-------|
| Requirement coverage (C2-01..08 + QUAL-01/02) | 10/10 | Every requirement mapped to ≥1 task; trace table in RESEARCH §Phase Requirements is complete |
| Locked-decision fidelity (D-1..D-7) | 9/10 | D-1..D-6 clean; D-7 correctly implemented in plans but RESEARCH.md carries pre-revision wording (Blocker 2) |
| Research directive adherence | 8/10 | OQ-1/3/5 spiked in Wave 0; but 05-02 missing depends_on: 05-00 (Blocker 1); OQ-4 not explicitly resolved |
| Executability | 8/10 | Tasks have files/action/verify/done; Major 4 push-early + minor sqlite3 path ambiguity |
| Scope sanity | 7/10 | 05-02 is 5 tasks/14 files (borderline); others well-sized (3–4 tasks) |
| Tool-cap compliance (REQ-TOOLS-09) | 5/10 | 05-03 knowingly exceeds by 1 for Case-2 sessions — Major 3 |
| Non-goals enforcement | 10/10 | Restaurant-Adressbuch, voice-trigger, Phase-3/4 migration all correctly excluded |
| Nyquist validation | 9/10 | All code tasks have `<verify>/<automated>`; live checkpoints rely on human verify + harness unit tests |
| Context compliance (CONTEXT.md) | 9/10 | All 7 D-decisions have implementing tasks; deferred ideas absent from all plans |

## Per-Plan Summary

### 05-00 (Wave 0 — spikes)
- Quality: strong. 4 spikes, all with resume-signals, all with automated verify grepping evidence files.
- Coverage: evidence-only (correct — spikes don't deliver requirements).
- Fix: push step missing.

### 05-01 (Wave 1 — SEED-001 / voice_notify_user)
- Quality: strong. 3 TDD tasks, interface-first, 18+ tests total.
- Coverage: C2-04, C2-05 plumbing ready.
- D-4 locked fidelity: verbatim. Tool-name `voice_notify_user` regex-compliant — asserted at module load (line 246).
- Fix: push step.

### 05-02 (Wave 2 — orchestrator + DB)
- Quality: strong but oversized. 5 tasks covering DB migration, 2 new MCP tools, Sipgate parser, tracker wire-in.
- Coverage: C2-01, C2-02, C2-04, C2-05, C2-08 all plumbed.
- D-7 revised correctly implemented (line 199-204, code-comment citation line 427).
- Daily-cap race (Pitfall 7) explicitly tested (Task 2 Test 11).
- Fix: Blocker 1 (depends_on: 05-00), Major 4 (push), Minor 6 (explicit 30s ring-timeout test).

### 05-03 (Wave 3 — AMD + Case-2 persona)
- Quality: strong. 5 tasks (4 auto-tdd + 1 live checkpoint); AMD classifier, persona extensions, /accept branch, outcome routing.
- Coverage: C2-01, C2-03, C2-04, C2-05, C2-06, C2-07 closed (modulo gate).
- D-1 AMD implementation: hybrid prompt + VAD cadence matches Research §2.3 recommendation.
- Live checkpoint (Task 5) correctly gated on Phase 0.
- Fix: Major 3 (tool-cap), Major 5 (pitfall sign-off), Minor 8 (sqlite3 path).

### 05-04 (Wave 4 — gate + flip)
- Quality: strong. 2 TDD tasks + 1 live checkpoint + 1 doc-flip task.
- Coverage: QUAL-01 harness with 6 scenarios (5 D-3 required + 1 daily-cap drill — good addition); QUAL-02 P50/P95 aggregator.
- Pitfall sign-off matrix (7/7) correct.
- REQUIREMENTS.md / ROADMAP.md flip with evidence guard (grep GATE APPROVED).
- Good: only plan with explicit `git push` step (Task 4 action 4).

## Required Revisions Before Execute

1. **[Blocker 1]** 05-02 frontmatter `depends_on:` must include `- 05-00`.
2. **[Blocker 2]** 05-RESEARCH.md §User Constraints D-7 block (line 36) update verbatim quote to revised form OR add errata block at top citing CONTEXT D-7 as authoritative (also touch lines 9, 407, 435, 438, 465-466).
3. **[Major 3]** 05-03 must decide tool-cap path: document sanctioned exception in REQ-TOOLS-09 OR remove one Case-6 tool from Case-2 outbound /accept tools list. Recommend removing `search_competitors` (Case-4 use), `get_practice_profile` (Case-3 use), or `get_contract` (Case-4 use) from Case-2 session tools — all three are irrelevant to restaurant reservation. Drop one, cap stays at 15.
4. **[Major 4]** Add `git push origin main` as final action step in 05-00, 05-01, 05-02, 05-03.
5. **[Major 5]** 05-03 success criterion line 516 amended to clarify Pitfalls 5-7 inherited from Wave 2.
6. **[Minor 6]** 05-02 Task 4 action step 5 — add an explicit test: "assert sipgate-rest-client AbortController timeout ≤ 30000 ms (C2-02)".
7. **[Minor 8]** 05-03 Task 5 `<verify>` — use an absolute path or config-resolved path for sqlite3 DB lookup (e.g., `$(node -e "console.log(require('./src/config.js').DB_PATH)")`).
8. **[Minor 9]** 05-RESEARCH.md — mark `## Open Questions` heading `(RESOLVED)` after noting OQ-1/3/5 → spikes, OQ-2 → CONTEXT D-7 revision, OQ-4 → recommendation accepted.

## Non-Blocking Observations

- The daily-cap drill as a 6th scenario in Wave 4 (beyond the D-3-required 5) is a quality add — not required but appreciated.
- D-6 trigger surface (Discord + WhatsApp text) is not explicitly implemented in any Wave 1-3 plan — instead the plans assume Andy's existing freeform-extraction path delivers structured D-5 args into `voice_start_case_2_call`. This is defensible (D-6 says "Andy handler: parse ... extract D-5 fields via Claude extraction") but the plans never wire the Andy-side Discord/WhatsApp trigger handler → voice_start_case_2_call explicitly. Likely implicit in Andy's existing message loop, but worth a sanity-check grep before execute.
- Tolerance-negotiation few-shots from Research §3.3 are referenced (05-03 Task 2 read_first line 267) but not materialized as persona constants. May emerge naturally from Claude generation at execute time; flag as quality risk only.

---

**Reviewer recommendation:** Return to planner with revision list above. Blockers 1-2 and Majors 3-5 are the execute-gating set. Minors 6-9 are quality improvements that can batch into the same revision.
