# Phase 0: Pre-Production Legal Gate - Context

**Gathered:** 2026-04-16
**Status:** Ready for planning
**Mode:** Auto (recommended-default picks; see DISCUSSION-LOG.md for alternatives)

<domain>
## Phase Boundary

Phase 0 delivers the **hard legal prerequisite gate** that blocks any real PSTN call with a non-informed counterpart: OpenAI Zero Data Retention verified, a German telecom/AI lawyer opinion engaged and filed, daily audio-persistence audit tooling live on both hosts, and the persona master-prompt enforcing truthful-on-ask disclosure + prohibition on named-human impersonation.

**In scope:**
- LEGAL-01 ZDR verification evidence + staleness monitor
- LEGAL-02 Lawyer opinion engagement and filed artifact
- LEGAL-03 Daily audio-persistence audit script (Hetzner + Lenovo1) with Discord alert
- LEGAL-04 Persona master-prompt with unit-tested invariants

**Out of scope (other phases):**
- Any implementation of case logic, Director Bridge, or infrastructure (Phases 1+)
- Ongoing production monitoring of the cost caps / drift (Phase 4)
- The actual persona-content per case (Phase 2 directive prompting + Phase 3/5/6/7 per-case overlays)

</domain>

<decisions>
## Implementation Decisions

### ZDR Verification (LEGAL-01)

- **D-01:** ZDR is verified **manually via OpenAI dashboard**, because OpenAI exposes no programmatic ZDR-status API as of 2026-04 (Research STACK.md confirmed). Evidence = (a) ZDR confirmation email from OpenAI, (b) pinned dashboard screenshot, both stored under `legal-evidence/openai-zdr/`, each hashed SHA-256 with hash committed.
- **D-02:** Monthly `zdr_verify` cron job on Lenovo1 checks the age of the latest verification file; if >30 days, posts Discord alert to `legal-ops` channel. Verification refresh is Carsten's manual task (no automation can detect a dashboard revocation without the endpoint).
- **D-03:** Per-call ZDR assertion is NOT feasible (no header/event advertises per-session state); reliance is project-scope with monthly manual recheck.

### Lawyer Opinion (LEGAL-02)

- **D-04:** Engage a German telecom + AI-voice specialist firm. Target firms: **HÄRTING (Berlin)** or **LUTZ|ABEL (Munich)** — both have published practice in §201 StGB + AI-Act + DSGVO intersections. Carsten's decision which firm, engagement happens out-of-band via email/phone.
- **D-05:** Opinion scope (minimum):
  1. §201 StGB applicability to transient RAM-only audio capture by the user's agent, with specific attention to **speakerphone / third-party bystander** scenarios (counterpart's phone on speaker, bystander unconsenting).
  2. DSGVO Haushaltsausnahme (Art. 2 Abs. 2 lit. c) boundary — specifically: does using a voice agent for *personal* purposes (restaurant booking, medical appointment, contract negotiation) cross into "professional" activity?
  3. Passive-disclosure position — is the stance "never volunteer AI status, always truthful on direct ask" defensible under §201 + OpenAI ToS + likely-future AI Act Art. 50?
  4. EU AI Act Art. 50 applicability — personal use non-applicability argument plausibility; trigger conditions for applicability if scope changes.
- **D-06:** Opinion is filed as PDF under `legal-evidence/lawyer-opinion/YYYY-MM-DD-firm.pdf`, committed to state-repo.
- **D-07:** **Phase 0 exits with "Conditional PASS"** when LEGAL-01/03/04 are green AND LEGAL-02 is "Engaged" (email from firm confirming engagement + expected delivery date). Full PASS upgrades when opinion arrives. This unblocks Phases 1–4 + Phase 3 (Case 6) immediately; Phases 5–7 (external counterpart calls) are hard-gated on full PASS.

### Audio-Persistence Audit (LEGAL-03)

- **D-08:** Cron schedule **daily at 03:00 local**, not monthly. Daily runs are cheap and criminal-law exposure warrants tight detection.
- **D-09:** Hosts scanned: **Hetzner Python1 + Lenovo1** (both). Also scans any mounted backup drives visible to the process.
- **D-10:** Scan roots: `~/nanoclaw/`, `~/nanoclaw-voice/` (if present), `/tmp/`, `/var/tmp/`, `~/.cache/`, `/home/voice_bot/` (Hetzner only).
- **D-11:** File-extension allowlist for detection: `.wav`, `.mp3`, `.opus`, `.flac`, `.ogg`, `.m4a`, `.amr`, `.aac`, `.webm` (the `.webm` entry catches OpenAI response recordings in case of debug leakage).
- **D-12:** Alert destination: **Discord `legal-ops` channel** via webhook. Message includes hostname, path, file size, mtime.
- **D-13:** Self-verification: once monthly, cron seeds a synthetic file `~/zdr-audit-canary-{timestamp}.wav`, verifies alert fires within 15 min, then deletes the canary. Failure of canary triggers a higher-severity alert.
- **D-14:** Script language: **bash** (both hosts have bash; no Node/Python runtime dependency for a legal-critical tool).
- **D-15:** Script source committed to code-repo at `scripts/audit/audio-persistence-scan.sh`, deployed via state-repo-tracked systemd timer manifests under `legal-evidence/audit-tooling/`.

### Persona Master-Prompt (LEGAL-04)

- **D-16:** Structure: **single master file + case overlays**. Master file holds invariants (disclosure, identity prohibition, language directive, tool-first directive per AC-06). Case overlays hold per-case persona + scene-specific instructions.
- **D-17:** Paths:
  - Master: `~/nanoclaw/voice-container/persona/master.de.md`
  - Overlays: `~/nanoclaw/voice-container/persona/case-{6,2,3,4}.md`
- **D-18:** Assembly: Director Bridge concatenates `master.de.md + case-{N}.md` at `realtime.calls.accept()` time and passes as `session.instructions`. No mid-call re-assembly (respects AC-04).
- **D-19:** Invariants under unit test (`voice-container/tests/persona.spec.ts`):
  1. Master contains verbatim directive: **"Wenn Sie direkt gefragt werden 'Sind Sie ein Bot?' oder 'Bin ich mit einem Computer verbunden?' ODER ähnliche Frage: Antworte wahrheitsgemäß 'Ja, ich bin ein KI-Assistent von Herrn Freek und führe dieses Gespräch für ihn.'"**
  2. Master contains prohibition: **"Du darfst NIEMALS behaupten, eine namentlich benannte Person zu sein. Du bist ein KI-Assistent."**
  3. Master contains tool-directive: **"Du DARFST NIEMALS Termine, Preise oder Vertragskonditionen aus dem Kopf nennen — Du MUSST für jede domänenspezifische Auskunft das entsprechende Tool aufrufen."** (AC-06)
  4. Master never contains a named human identity claim (regex scan: no `ich bin [Vorname] [Nachname]` patterns except Carsten-as-subject).
  5. Each case overlay starts with `# Case-Overlay:` header and does NOT override master invariants.
- **D-20:** Versioned in git (code-repo nanoclaw). Every commit touching `persona/` files requires the unit tests to pass as a CI/pre-commit gate.

### Evidence Archive Location

- **D-21:** Evidence lives in **state-repo** under `voice-channel-spec/legal-evidence/` (not code-repo). Rationale: (a) legal documents don't belong in upstream-syncable nanoclaw code-repo, (b) state-repo already has the `sg claudestate` privacy + push workflow that matches legal-document handling.
- **D-22:** Subdirectories:
  - `legal-evidence/openai-zdr/` — screenshots + emails + SHA-256 hashes
  - `legal-evidence/lawyer-opinion/` — engagement confirmation + final opinion PDF
  - `legal-evidence/audit-tooling/` — systemd timer manifests + sample cron logs + canary test evidence

### Claude's Discretion

- Script shebang line style (`#!/usr/bin/env bash` vs `#!/bin/bash`) — Claude picks per existing repo convention.
- Exact Discord webhook URL retrieval — from OneCLI / `.env` as appropriate.
- SHA-256 tool invocation (`sha256sum` vs `shasum -a 256`) — Claude picks per OS availability on each host.
- Directory-tree creation order inside `legal-evidence/` — Claude sets up as needed.
- Canary filename timestamp format — Claude picks ISO-8601 compatible.

### Folded Todos

None — no backlog items matched Phase 0 scope in the todo index.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase-Level Spec

- `voice-channel-spec/PRD.md` §7a AC-01..AC-09 — Architecture Constraints (AC-04 and AC-06 are referenced directly in D-18 and D-19)
- `voice-channel-spec/CONOPS.md` §7 MOS 6 — No-Audio-Persistence requirement origin
- `voice-channel-spec/REQUIREMENTS.md` LEGAL-01..LEGAL-04 — the requirements this phase delivers
- `voice-channel-spec/ARCHITECTURE-DECISION.md` AC-008 — ZDR decision rationale

### Legal Framework (context for lawyer opinion scope)

- `voice-channel-spec/CONOPS.md` §External-1 — passive disclosure stance, §201 StGB mitigation via no-audio-persistence

### Research (domain context)

- `.planning/research/SUMMARY.md` — research synthesis, Phase 0 role
- `.planning/research/PITFALLS.md` — Pitfall #11 (ZDR audit gap), Pitfall #12 (§201 speakerphone/third-party), Pitfall #17 (language-drift) — three Catastrophic/Severe pitfalls this phase mitigates
- `.planning/research/STACK.md` — confirmation that OpenAI exposes no ZDR-status API

### Spike Evidence

- `voice-channel-spec/spike/candidate-e/` — Spike E dataset (used later by Director Bridge replay tests; referenced here only to note ZDR was active during the successful spike runs)
- `voice-channel-spec/decisions/2026-04-15-sideband-ws-spike.md` — Sideband-WS spike, including Runde 1 vs Runde 2 evidence for the directive-prompt invariant in D-19 #3

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **Discord webhook plumbing**: `~/nanoclaw/src/channels/discord/` — existing Discord channel skill can receive legal-ops alerts without new webhook config, OR a dedicated webhook can live in `.env`. D-12 leaves room for either path.
- **Audit-script idiom**: `~/nanoclaw/scripts/` exists but has no audio-audit script yet — Phase 0 adds a new file.
- **Systemd timer pattern**: Lenovo1 already runs `nanoclaw.service` under systemd; add `audio-persistence-audit.{service,timer}` units alongside.

### Established Patterns

- **`.env` secrets**: OpenAI keys + Discord webhook in `~/nanoclaw/.env`; OneCLI fronts secret injection. Legal tooling can read from `.env` directly because it runs on Lenovo1 outside container-boundary.
- **state-repo commits**: `sg claudestate -c "git push origin main"` is the push idiom for state-repo (seen in existing workflow).
- **TypeScript unit tests**: `~/nanoclaw/src/` uses `vitest` pattern — persona unit tests should follow.

### Integration Points

- LEGAL-04 persona prompt files live in code-repo (`~/nanoclaw/voice-container/persona/`); Phase 2+ Director Bridge reads them.
- LEGAL-03 audit script lives in code-repo (`~/nanoclaw/scripts/audit/`); systemd manifests live in state-repo (`legal-evidence/audit-tooling/`) for evidence preservation.
- LEGAL-01/02 evidence is state-repo only — never touches code-repo.

</code_context>

<specifics>
## Specific Ideas

- **D-19 invariants use verbatim German strings**: The unit tests assert exact wording because §201 / AI-Act disclosure defense requires the prompt to be demonstrably present. Paraphrased prompts are harder to defend in an incident review.
- **Canary test (D-13)** is borrowed from the pattern used in spam-filter and AV-engine self-tests — periodic known-bad files prove the detector is alive.
- **HÄRTING reference**: This firm published a widely-cited 2024 AI Act implementation guide and has a dedicated AI + telecom practice. LUTZ|ABEL is the Munich-local alternative Carsten can walk in to. No preference hard-coded; Carsten chooses.
- **Daily-not-monthly audit**: Research Pitfall-11 flagged ZDR audit-gap as Severe. One incident of persistent audio = criminal liability. The cost of daily `find | grep` is negligible; the cost of a monthly miss is catastrophic. Asymmetric risk → daily.

</specifics>

<deferred>
## Deferred Ideas

- **Automated ZDR status endpoint polling** — if OpenAI ever exposes `/v1/organization/zdr_status`, retrofit D-01/D-02 to poll it. Capture as backlog: "When OpenAI exposes ZDR API, replace manual verification with polling."
- **Per-call ZDR assertion** — similar: if `response.done.usage` or `session.created` ever includes a `zdr: true` flag, upgrade D-03 from trust-project-setting to per-call verify.
- **AV-grade audio file detection** — current extension-based scan misses audio data written to non-standard file extensions (e.g., `.dat`, `.bin`). Future hardening: integrate `file` magic-bytes detection on suspicious binaries. Phase 4 observability hardening can revisit.
- **Legal opinion refresh cadence** — should we commission a refreshed opinion annually, or only on scope change? Decide when first opinion lands.
- **Multi-firm opinion** — for extra rigour, some regulated fields commission opinions from two independent firms. Consider for v2 if scope expands beyond personal use.

### Reviewed Todos (not folded)

None reviewed — no todo index matches surfaced for Phase 0.

</deferred>

---

*Phase: 00-pre-production-legal-gate*
*Context gathered: 2026-04-16*
