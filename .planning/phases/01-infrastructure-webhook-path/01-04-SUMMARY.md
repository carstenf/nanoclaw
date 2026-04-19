---
phase: 01-infrastructure-webhook-path
plan: 04
subsystem: sip
tags: [freeswitch, dialplan, sip, openai-sip, pcmu, voice-channel]

requires:
  - phase: 01-01
    provides: WG MTU 1380 + Hetzner firewall rule for 9876 (DEFERRED — Wave 1 carsten-tasks; this plan is code-only, deploy waits for Wave 1)
  - phase: 01-03
    provides: rsync deploy mechanism to Hetzner (DEFERRED — Wave 1 owner uses same path to deploy this dialplan)
provides:
  - Phase-1 dialplan that bridges Sipgate inbound to OpenAI SIP TLS endpoint with PCMU lock and SIP-07 fail-fast
  - Pre-edit backup of legacy dialplan (sip-to-ai@127.0.0.1:5080) for one-command rollback
  - Outbound SIP-02 smoke-test script staged for Wave 1 follow-up (per Pitfall NEW-2)
affects:
  - 01-05 voice-bridge stub (no functional dependency, but the dialplan now drives the OpenAI SIP path that the bridge later observes via webhook)
  - 01-06 integration test (3 live PSTN calls — first plan that exercises this dialplan end-to-end)
  - Phase 4 outbound /endpoint (smoke-script command shape becomes the basis for the real outbound dialplan extension)

tech-stack:
  added:
    - sofia/external/sip:proj_4tEBz3XjO4gwM5hyrvsxLM8E@sip.api.openai.com;transport=tls (OpenAI SIP B-leg)
    - PCMU codec lock via absolute_codec_string + codec_string on both legs
    - originate_timeout=3 + continue_on_fail + respond 503 (SIP-07 fail-fast pattern)
  patterns:
    - "Bridge-string inline-var prefix: [absolute_codec_string=PCMU,codec_string=PCMU]sofia/... — locks codec on the B-leg origination per RESEARCH Template 8"
    - "Fail-fast B-leg: continue_on_fail enumerates the cause-codes that should fall through to the next dialplan action (the explicit respond 503), so any bridge failure within 3s yields a clean SIP 503 to Sipgate instead of timing out"
    - "Backup-before-edit hygiene: 01_sipgate_inbound.xml.bak-2026-04-16 preserves the legacy bridge target verbatim — single git checkout suffices for rollback"

key-files:
  created:
    - ~/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml.bak-2026-04-16 (pre-edit backup, identical to former on-disk state)
    - ~/nanoclaw/voice-stack/scripts/test-outbound-smoke.sh (executable, 113 LOC, SIP-02 smoke-test wrapper deferred to Wave 1)
  modified:
    - ~/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml (rewritten to Template 8 verbatim — bridge target now OpenAI SIP TLS, not legacy sip-to-ai loopback)

key-decisions:
  - "Dialplan edit = verbatim Template 8 from 01-RESEARCH.md (no deviation) — substituting nothing, no creative rewording, same destination_number regex preserved"
  - "Backup file naming = 01_sipgate_inbound.xml.bak-2026-04-16 (date suffix per task spec, not full timestamp — easier to git-grep, matches WG MTU backup convention from open_points.md Block 1)"
  - "Both files added to git in one atomic commit — voice-stack/conf/ subtree was previously untracked; this is the first commit that brings the overlay dialplan into version control alongside Plan 03's vs-webhook-forwarder/* additions"
  - "Task 2 reframed: PLAN.md asks to RUN fs_cli originate, but execution-context constraints (no docker exec, no SSH to Hetzner, deploy deferred to Wave 1) require code-only work. Resolved by staging an executable wrapper script (test-outbound-smoke.sh) that documents the exact command shape for Wave 1 follow-up — script is bash-syntax-validated but never invoked at commit time"
  - "01-04-NOTES.md NOT created at this stage — its contents (originate result + sofia status output) only exist post-deploy. Template for the file is embedded as a comment block at the bottom of test-outbound-smoke.sh, ready to be pasted into the planning dir after the Wave 1 owner runs the script"

patterns-established:
  - "Code-vs-deploy split for dialplan changes: Lenovo1 holds the canonical XML in repo + backup; deploy step (rsync to Hetzner + fs_cli reloadxml + sofia profile external rescan) lives in a separate plan/wave and never co-mingles with the edit commit"
  - "SIP-fail-fast via dialplan-only mechanics (no FreeSWITCH module config needed): originate_timeout + continue_on_fail + respond — works on the stock vs-freeswitch image"
  - "Smoke-script wrapper template for any future SIP gateway test: pre-flight REGED check → action → post-flight REGED check → grep-based verdict (PASS/FAIL/UNCLEAR exit codes)"

threat-coverage:
  - "T-04-02 (codec downgrade) — mitigated: absolute_codec_string=PCMU + codec_string=PCMU on A-leg + identical inline vars on B-leg origination string. Mid-call reINVITE codec change → FreeSWITCH rejects (covered by Pitfall #7 in cross-cutting PITFALLS.md, no new mitigation needed here)"
  - "T-04-03 (DoS pile-up if OpenAI SIP unreachable) — mitigated: originate_timeout=3 caps pending bridge attempts at 3s; continue_on_fail enumerates the failure causes that route to respond 503; explicit 503 returned to Sipgate frees A-leg resources immediately"
  - "T-04-05 (no log of inbound INVITE caller) — mitigated: <action application='log' data='INFO Sipgate inbound destnum=... caller=...'/> at the top of the dialplan ensures every inbound is recorded with destnum + caller_id_number"

metrics:
  duration: 7m
  completed_at: 2026-04-16
---

# Phase 1 Plan 04: FreeSWITCH dialplan — Sipgate → OpenAI SIP TLS bridge — Summary

Replaces the legacy loopback bridge target (`sofia/internal/sip-to-ai@127.0.0.1:5080`)
with the OpenAI realtime SIP endpoint
(`sofia/external/sip:proj_4tEBz3XjO4gwM5hyrvsxLM8E@sip.api.openai.com;transport=tls`),
locks PCMU on both legs (D-20, SIP-04), enforces a 3-second originate timeout
with explicit SIP 503 fallback (SIP-07), and stages an outbound smoke-test
script for Wave 1 follow-up (Pitfall NEW-2). Code-only — no deploy at commit time.

## What Changed

### Dialplan: legacy → OpenAI SIP

**Before** (`01_sipgate_inbound.xml.bak-2026-04-16`, 17 lines):

```xml
<action application="set" data="absolute_codec_string=PCMU"/>
<action application="bridge" data="[absolute_codec_string=PCMU,codec_string=PCMU]sofia/internal/sip-to-ai@127.0.0.1:5080"/>
```

**After** (`01_sipgate_inbound.xml`, 22 lines):

```xml
<action application="set" data="absolute_codec_string=PCMU"/>
<action application="set" data="codec_string=PCMU"/>
<action application="set" data="originate_timeout=3"/>
<action application="set" data="hangup_after_bridge=true"/>
<action application="set" data="continue_on_fail=NORMAL_TEMPORARY_FAILURE,USER_BUSY,NO_ANSWER,ALLOTTED_TIMEOUT,NO_USER_RESPONSE"/>
<action application="bridge" data="[absolute_codec_string=PCMU,codec_string=PCMU]sofia/external/sip:proj_4tEBz3XjO4gwM5hyrvsxLM8E@sip.api.openai.com;transport=tls"/>
<action application="respond" data="503 Service Unavailable"/>
```

Diff summary in plain English:
- B-leg target: legacy loopback → OpenAI SIP TLS endpoint (D-19)
- Codec lock: A-leg only → both legs (codec_string=PCMU added)
- Fail-fast: not present → originate_timeout=3 + continue_on_fail + respond 503 (SIP-07)
- BYE hygiene: implicit → hangup_after_bridge=true (D-22, SIP-06)
- Logging: existing log line preserved (now satisfies T-04-05 mitigation)

### Smoke-test script staged

`~/nanoclaw/voice-stack/scripts/test-outbound-smoke.sh` (4570 bytes, +x):
- Pre-flight: assert `sofia status gateway sipgate | grep REGED`
- Action: `fs_cli -x "originate sofia/gateway/sipgate/<target> &echo"`
- Post-flight: assert REGED still holds (catches deregister-on-failure bugs)
- Verdict logic: `+OK <uuid>` → PASS; `USER_BUSY|NO_ANSWER` → also PASS;
  `GATEWAY_DOWN|GATEWAY_UNAVAIL` → FAIL with exit code 2

Bash syntax validated (`bash -n`). NOT invoked at commit time per
execution-context constraint.

## Commits (all in `~/nanoclaw/`, branch `main`)

| Commit | Type | Files | Description |
|--------|------|-------|-------------|
| `534ae74` | feat | `voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml`, `…/01_sipgate_inbound.xml.bak-2026-04-16` | Bridge Sipgate inbound to OpenAI SIP endpoint (TLS, PCMU, 503 fallback) |
| `4c9d26f` | chore | `voice-stack/scripts/test-outbound-smoke.sh` | Stage SIP-02 outbound originate smoke script (deferred to Wave 1) |

Both commits passed the repo's pre-commit `npm run format:fix` hook
(no source files touched, all unchanged).

## Verification Performed (Local-Only)

| Check | Command | Result |
|-------|---------|--------|
| XML well-formed | `python3 -c "import xml.etree.ElementTree as ET; ET.parse('…/01_sipgate_inbound.xml')"` | `XML_VALID` |
| OpenAI SIP target present | `grep -q sip.api.openai.com …/01_sipgate_inbound.xml` | match (line 17) |
| 3s originate timeout present | `grep -q originate_timeout=3 …/01_sipgate_inbound.xml` | match (line 10) |
| 503 fallback present | `grep -q "respond.*503" …/01_sipgate_inbound.xml` | match (line 20) |
| PCMU on both legs | `grep -c "PCMU" …/01_sipgate_inbound.xml` | 4 occurrences (set codec_string + set absolute_codec + 2 in bridge prefix) |
| Backup integrity | `wc -l + grep extension` on `.bak-2026-04-16` | 17 lines, contains `extension` and `bridge` |
| Smoke script syntax | `bash -n test-outbound-smoke.sh` | `SHELL_SYNTAX_OK` |
| Smoke script executable | `ls -la` | `-rwxrwxr-x` |

## Verification Deferred (Wave 1 owner)

Per execution-context constraint, the following deploy + live verification
steps are NOT performed in this plan and are explicitly deferred:

| Check | Command | Owner / When |
|-------|---------|--------------|
| Deploy via rsync | `rsync -avz ~/nanoclaw/voice-stack/conf/overlay/ voice_bot@hetzner:/home/voice_bot/voice-stack/conf/overlay/` | carsten_bot post-Wave-1 |
| Reload | `ssh hetzner 'docker exec vs-freeswitch fs_cli -x "reloadxml"'` | carsten_bot post-Wave-1 |
| Sofia rescan (no call drop) | `ssh hetzner 'docker exec vs-freeswitch fs_cli -x "sofia profile external rescan"'` | carsten_bot post-Wave-1 |
| Channel-count delta == 0 | diff before/after `show channels count` | carsten_bot post-Wave-1 |
| INFRA-01 REGED | `sofia status gateway sipgate \| grep REGED` | carsten_bot post-Wave-1 |
| Dialplan parsed | `xml_locate dialplan public sipgate_inbound` returns new XML | carsten_bot post-Wave-1 |
| SIP-02 smoke | `./voice-stack/scripts/test-outbound-smoke.sh <target>` then write `01-04-NOTES.md` | carsten_bot post-Wave-1 |
| Live PSTN integration (3 calls) | Plan 06 (D-26) | Plan 06 owner |

## Deviations from Plan

### Rule 3 — Auto-fix blocking issue

**Task 2 reframed: PLAN.md asked to RUN fs_cli originate; execution-context
forbids it.**
- Found during: Task 2 start
- Issue: PLAN.md Task 2 prescribes invoking `ssh hetzner 'docker exec
  vs-freeswitch fs_cli -x "originate ..."'`, but the execution context
  for this run explicitly forbids docker exec, fs_cli, and SSH to Hetzner
  (deploy deferred until Wave 1 done). Running the originate would also
  dial a real PSTN number with no Wave 1 deploy in place — the new
  dialplan isn't even on Hetzner yet.
- Fix: Stage `voice-stack/scripts/test-outbound-smoke.sh` (executable,
  syntax-validated, with embedded NOTES.md template). Wave 1 owner runs
  it after deploy and pastes results into `01-04-NOTES.md`.
- Files modified: created `voice-stack/scripts/test-outbound-smoke.sh`
- Commit: `4c9d26f`

### Constraint not in PLAN.md but enforced

**XML validation only via Python ET, not via FreeSWITCH parser.**
- PLAN.md Task 1 step 9 prescribes `xml_locate dialplan public
  sipgate_inbound` against the live FreeSWITCH process. Without
  Hetzner access this is impossible. Local `python3 -c
  "ET.parse(...)"` proves XML well-formedness — necessary but
  not sufficient (FreeSWITCH-specific validations like dialplan-action
  argument checks happen at reloadxml time, not XML parse time).
- This is a known gap; Wave 1 owner runs the FreeSWITCH-side validation
  as part of deploy, and reverts to backup if `reloadxml` errors.

## Known Stubs

None. Both files are functional: dialplan is the production target
(awaiting deploy), smoke script is the production smoke-test wrapper
(awaiting invocation). No placeholder values, no TODO/FIXME markers,
no UI-bound stubs.

## Threat Flags

None. All threat surface introduced by this plan was already in
`<threat_model>` of 01-04-PLAN.md (T-04-01 through T-04-05). Mitigations
applied per the table above.

## Self-Check: PASSED

Verified post-write:
- `~/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml` — FOUND (committed in `534ae74`, contains `sip.api.openai.com`)
- `~/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml.bak-2026-04-16` — FOUND (committed in `534ae74`, 17 lines, contains `extension`)
- `~/nanoclaw/voice-stack/scripts/test-outbound-smoke.sh` — FOUND (committed in `4c9d26f`, executable, bash-syntax-valid)
- Commit `534ae74` — FOUND in `git log --oneline` of `~/nanoclaw/`
- Commit `4c9d26f` — FOUND in `git log --oneline` of `~/nanoclaw/`

## References

- 01-PLAN.md: `01-04-PLAN.md` (this plan)
- 01-CONTEXT.md: D-19, D-20, D-21, D-22 (locked dialplan decisions)
- 01-RESEARCH.md: §"Template 8: FreeSWITCH dialplan edit" (verbatim source for the new XML); §"Pitfall NEW-2: SIP-02 outbound dialplan" (smoke-test rationale); §Assumption A6 (sofia rescan vs restart, why rescan was chosen)
- Live PSTN integration test: deferred to Plan 06 (3 consecutive calls per D-26)
- Threat model: `01-04-PLAN.md <threat_model>` (T-04-01..05)

## Note on Dependency Update

Per `01-04-PLAN.md` frontmatter: `depends_on: ["01-01", "01-03"]` was
amended on 2026-04-16 (WARNING #5 closure). This plan still runs in
Wave 3 alongside Plan 05; the explicit dependency on Plan 03 only
documents that the rsync-deploy mechanism (Plan 03 Task 3) must
already exist when Wave 1 owner deploys this dialplan.

This commit fulfills the Plan 04 deliverable side. Deploy + live
verification ride along Plan 03's deploy step in Wave 1's tail.
