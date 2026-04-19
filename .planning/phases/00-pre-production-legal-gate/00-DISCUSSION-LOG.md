# Phase 0: Pre-Production Legal Gate - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-16
**Phase:** 0-Pre-Production-Legal-Gate
**Areas discussed:** ZDR verification, Lawyer engagement, Phase-0 PASS definition, Audio-audit design, Persona-prompt shape, Evidence-archive location
**Mode:** Auto (recommended-default picks across all 6 gray areas, single pass)

---

## ZDR Verification (LEGAL-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Manual dashboard screenshot + confirmation email, SHA-256 hashed, monthly staleness cron | No programmatic ZDR API exists (Research STACK.md) — manual is the only option today | ✓ |
| Programmatic polling via `/v1/organization/...` endpoint | Does not exist as of 2026-04; deferred until OpenAI adds it | |
| Per-call ZDR header inspection | Not exposed by OpenAI Realtime API today | |

**User's choice:** Recommended default (auto-mode)
**Notes:** If OpenAI later exposes a ZDR API, retrofit. Captured in CONTEXT.md Deferred Ideas.

---

## Lawyer Engagement (LEGAL-02)

| Option | Description | Selected |
|--------|-------------|----------|
| HÄRTING (Berlin) OR LUTZ|ABEL (Munich), Carsten picks out-of-band; scope = §201 + DSGVO + Passive Disclosure + Art. 50 AI Act applicability | Both firms have telecom + AI-voice practice; concrete scope is enforceable | ✓ |
| Small solo practitioner | Cheaper but lower defensibility in incident-review | |
| Two firms for dual opinion | Stronger defense; expensive for personal-use scope; possible v2+ | |

**User's choice:** Recommended default (auto-mode) — HÄRTING or LUTZ|ABEL, Carsten picks
**Notes:** Captured full opinion scope in CONTEXT.md D-05. Two-firm option in Deferred Ideas.

---

## Phase-0 PASS Definition

| Option | Description | Selected |
|--------|-------------|----------|
| Conditional PASS when 01/03/04 green + 02 engaged; full PASS on opinion arrival; external-counterpart phases (5-7) gated on full PASS | Parallelizes external dependency with implementable work; Case 6 (Carsten-only) unblocked immediately | ✓ |
| Hard block — no phase progresses until LEGAL-02 opinion filed | Zero-risk but pessimistic; Opinion lead time could be 2-6 weeks | |
| Self-attestation only — Carsten signs internal memo, no external lawyer | Fastest but lowest legal defense; rejected due to §201 criminal exposure | |

**User's choice:** Recommended default (auto-mode) — conditional PASS with external-call gate
**Notes:** Matches research recommendation (PITFALLS.md Pre-Production Legal Gate as HARD prerequisite for Phase 5+, NOT Phase 3).

---

## Audio-Audit Design (LEGAL-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Daily cron on Hetzner + Lenovo1, ext-allowlist scan `~/`, `/tmp`, `/var/tmp`, state-dirs; Discord `legal-ops` channel alert; monthly synthetic canary | Daily detection; canary self-verifies detector alive; matches existing scripts + systemd pattern | ✓ |
| Monthly audit only | Too loose for criminal-law exposure — one monthly miss = potential months of persistent audio | |
| Real-time filesystem-watcher (inotify) | Overkill; adds runtime dependency on every host; daily cron is sufficient | |

**User's choice:** Recommended default (auto-mode) — daily cron
**Notes:** Cost of daily find+grep is negligible (~5 sec on both hosts); asymmetric risk argues for daily.

---

## Persona-Prompt Shape (LEGAL-04)

| Option | Description | Selected |
|--------|-------------|----------|
| Single master `master.de.md` + per-case overlays assembled at call-accept; invariants under unit test | Clean separation; master-invariants tested once; overlays easy to author per case | ✓ |
| Monolithic per-case prompts, no master | Duplicates invariants across files; risk of invariant-drift per case | |
| Database-stored templates with DB-side versioning | Adds state.db coupling; harder to review in git; overkill for 4 cases | |

**User's choice:** Recommended default (auto-mode) — master + overlays
**Notes:** Unit tests in `voice-container/tests/persona.spec.ts` assert 5 invariants (see CONTEXT.md D-19).

---

## Evidence-Archive Location

| Option | Description | Selected |
|--------|-------------|----------|
| `voice-channel-spec/legal-evidence/` in state-repo — ZDR screenshots, lawyer opinion, audit-tooling manifests | Matches existing `sg claudestate` privacy workflow; legal docs out of upstream-syncable code-repo | ✓ |
| Separate private git repo | Extra infra; state-repo already has the privacy model | |
| Encrypted archive on external storage | Overkill for this scope; state-repo privacy is sufficient | |

**User's choice:** Recommended default (auto-mode) — state-repo subtree
**Notes:** state-repo is privacy-controlled + gitlab-ignored from public pushes.

---

## Claude's Discretion

- Script shebang style (`#!/usr/bin/env bash` vs `#!/bin/bash`) — follow existing repo convention
- SHA-256 tool invocation (`sha256sum` vs `shasum -a 256`) — per OS availability per host
- Directory-tree creation inside `legal-evidence/` — as needed
- Canary filename timestamp format — ISO-8601 compatible
- Unit test organization (single file vs per-invariant) — per `vitest` codebase style

## Deferred Ideas

- Automated ZDR status endpoint polling (when OpenAI adds it)
- Per-call ZDR assertion (when Realtime API exposes it)
- AV-grade file detection via magic-bytes (Phase 4 observability)
- Annual lawyer opinion refresh cadence (decide when first opinion lands)
- Two-firm dual-opinion for regulated-scope expansion (v2+)
