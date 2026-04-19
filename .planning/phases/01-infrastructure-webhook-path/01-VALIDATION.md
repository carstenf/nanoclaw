---
phase: 1
slug: infrastructure-webhook-path
status: planned
nyquist_compliant: true
wave_0_complete: false  # Wave 0 covered by Plan 03 Task 1 + Plan 05 Task 1
created: 2026-04-16
last_updated: 2026-04-16
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Linked from RESEARCH.md §"Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| Bridge framework | vitest 4.x (matches Core convention per STACK.md) |
| Bridge config file | `voice-bridge/vitest.config.ts` (created in Plan 05 Task 1) |
| Bridge quick run | `cd ~/nanoclaw/voice-bridge && npx vitest run` |
| Bridge full suite | `cd ~/nanoclaw/voice-bridge && npm test` |
| Forwarder framework | pytest (created in Plan 03 Task 1) |
| Forwarder config | `voice-stack/vs-webhook-forwarder/pyproject.toml` |
| Forwarder quick run | `cd ~/nanoclaw/voice-stack/vs-webhook-forwarder && . .venv/bin/activate && pytest -x` |
| Forwarder full suite | same — only one test file in Phase 1 |
| Integration tests | manual D-25 (Plan 06 Task 1) + D-26 3 live PSTN calls (Plan 06 Task 2) |
| Estimated unit-suite runtime | ~5s (bridge) + ~5s (forwarder) |

---

## Sampling Rate

- **After every task commit:** Run framework's quick command (vitest for bridge tasks, pytest for forwarder tasks)
- **After every plan wave:** Run full suite of any tests in that wave's plans
- **Before `/gsd-verify-work`:** Full suite green + sofia status REGED + curl /health green
- **Max feedback latency:** ~10s for unit tests; integration tests are gated to Plan 06 wave 4

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | INFRA-04 | T-01-01, T-01-02 | Hetzner public 9876 blocked; firewall enforced | manual | `nc -zv -w 3 128.140.104.236 9876` returns refused/timeout | N/A — checkpoint | ⬜ pending |
| 1-01-02 | 01 | 1 | INFRA-04 | T-01-03 | Lenovo1 wg0 MTU=1380; PMTU probe confirms (success at 1352, fail at 1500) | smoke | `ip link show wg0 \| grep -q 'mtu 1380' && ping -M do -s 1352 -c 1 -W 2 10.0.0.1 >/dev/null && ! ping -M do -s 1500 -c 1 -W 2 10.0.0.1 >/dev/null 2>&1 && echo MTU_VERIFIED` | ✓ post-deploy | ⬜ pending |
| 1-02-01 | 02 | 1 | INFRA-02 | T-02-04, T-02-03 | Caddy snippet + DNS + TLS green; catch-all 404 | manual | `curl -fsSI https://voice-webhook.<domain>/anything-else` returns 404 | N/A — checkpoint | ⬜ pending |
| 1-02-02 | 02 | 1 | INFRA-03 | T-02-02 | Webhook URL configured + secret on Hetzner; chmod 600 | manual | carsten reports grep count = 1 | N/A — checkpoint | ⬜ pending |
| 1-02-03 | 02 | 1 | INFRA-03 | T-02-02 | Secret mirrored to Lenovo1 with chmod 600 | smoke | `grep -c '^OPENAI_WEBHOOK_SECRET=whsec_' ~/nanoclaw/.env \| grep -q '^1$' && stat -c '%a' ~/nanoclaw/.env \| grep -q '^600$'` | ✓ post-task | ⬜ pending |
| 1-02-04 | 02 | 1 | SIP-05 | T-02-06 | Hetzner cloud firewall allows UDP 60000-60100 inbound for RTP media (per D-21 / D-23) — without this, D-26 live calls have one-way silence | manual | `(test -f ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/firewall-rtp-confirmed.txt && grep -qE '60000-?60100' ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/firewall-rtp-confirmed.txt) \|\| (test -f ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/firewall-rtp-confirmed.png && carsten manual confirm)` | N/A — checkpoint (evidence file post-task) | ⬜ pending |
| 1-03-01 | 03 | 2 | INFRA-03 | T-03-01, T-03-06 | Wave 0 — pytest scaffold; RED gate | unit (RED) | `cd voice-stack/vs-webhook-forwarder && test -f pyproject.toml && test -f tests/test_signature.py && grep -q "test_invalid_signature_returns_401" tests/test_signature.py` | ✓ post-task | ⬜ pending |
| 1-03-02 | 03 | 2 | INFRA-03 | T-03-01..06 | Forwarder code GREEN (4 unit tests pass) | unit (GREEN) | `cd voice-stack/vs-webhook-forwarder && . .venv/bin/activate && pytest tests/test_signature.py -x` | ✓ post-task | ⬜ pending |
| 1-03-03 | 03 | 2 | INFRA-02, INFRA-03 | T-03-01, T-03-04 | Forwarder deployed; canary reachable over WG; public 9876 still blocked | smoke | `curl -sS -o /dev/null -w "%{http_code}\n" -m 3 http://10.0.0.1:9876/__wg_canary \| grep -q '^204$'` | ✓ post-deploy | ⬜ pending |
| 1-04-01 | 04 | 3 | INFRA-01, SIP-01, SIP-03..07 | T-04-02, T-04-03, T-04-05 | Dialplan replaced; reload no-drop; gateway REGED | smoke | `ssh hetzner 'docker exec vs-freeswitch fs_cli -x "sofia status gateway sipgate"' \| grep -qE 'State[[:space:]]+REGED' && grep -q 'sip\.api\.openai\.com' ~/nanoclaw/voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml` | ✓ post-deploy | ⬜ pending |
| 1-04-02 | 04 | 3 | SIP-02 | T-04-01 | Outbound originate smoke (Pitfall NEW-2 coverage) | smoke | `test -f .planning/phases/01-infrastructure-webhook-path/01-04-NOTES.md && grep -qE '^Verdict:[[:space:]]*PASS' .planning/phases/01-infrastructure-webhook-path/01-04-NOTES.md` | ✓ post-task | ⬜ pending |
| 1-05-01 | 05 | 3 | INFRA-03, INFRA-04 | T-05-01, T-05-08 | Wave 0 — vitest scaffold; RED gate | unit (RED) | `cd voice-bridge && test -f vitest.config.ts && test -f tests/synthetic-webhook.test.ts && test -f tests/heartbeat.test.ts && test -d node_modules` | ✓ post-task | ⬜ pending |
| 1-05-02 | 05 | 3 | INFRA-03, INFRA-04 | T-05-01..06 | Bridge code GREEN (vitest passes) | unit (GREEN) | `cd voice-bridge && npm run build && npm test 2>&1 \| tail -10 \| grep -qE "(Test Files .* passed\|✓.*passed)"` | ✓ post-task | ⬜ pending |
| 1-05-03 | 05 | 3 | INFRA-04, INFRA-08 | T-05-02, T-05-03, T-05-07 | systemd active; bind=10.0.0.2; kill -9 recovery; ALERT path | smoke | `systemctl --user is-active voice-bridge \| grep -q '^active$' && curl -sS http://10.0.0.2:4401/health \| jq -e '.ok == true and .secret_loaded == true and .bind == "10.0.0.2" and .port == 4401' >/dev/null && ss -tlnp \| grep ':4401' \| grep -q '10.0.0.2:4401'` | ✓ post-deploy | ⬜ pending |
| 1-06-01 | 06 | 4 | INFRA-03 | T-06-01, T-06-02 | D-25 synthetic webhook → bridge JSONL signature_valid | integration | `test -f ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/synthetic-webhook-result.txt && grep -qE 'D-25 VERDICT: (PASS\|FAIL)' ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/synthetic-webhook-result.txt` | ✓ post-task | ⬜ pending |
| 1-06-02 | 06 | 4 | INFRA-01..04, INFRA-08, SIP-01, SIP-03..06 | T-06-01..04 | D-26 3 live PSTN calls captured with real PASS/FAIL verdict (not template placeholder) | integration (manual) | `for n in 1 2 3; do test -f ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/live-call-${n}.txt && grep -qE 'PASS / FAIL:[[:space:]]+(PASS\|FAIL)\b' ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/live-call-${n}.txt; done` | ✓ post-test | ⬜ pending |
| 1-06-03 | 06 | 4 | (rolls up all 12 Phase 1 REQs) | — | Consolidated test-results.md per D-27 | smoke | `test -f ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/test-results.md && grep -qE "Phase 1 Exit Verdict" ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/test-results.md && grep -qE "Overall:.*\\*\\*(PASS\|FAIL)" ~/nanoclaw-state/voice-channel-spec/spike/01-webhook-path/test-results.md` | ✓ post-task | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**SIP-05 coverage note:** Previously the only reference to SIP-05 in Phase 1 was the
Plan 06 test-results template REQ map row (which credited a non-existent "Plan 02
carsten task"). BLOCKER #2 closure (2026-04-16) added Plan 02 Task 4
(`checkpoint:human-action` for carsten) which produces evidence file
`voice-channel-spec/spike/01-webhook-path/firewall-rtp-confirmed.{txt,png}`.
The Plan 06 REQ map for SIP-05 now points to that evidence file as the verification source.

**Wave numbering note:** Plans 04 and 05 are both Wave 3 (Plan 04 added `01-03` to
its `depends_on` per WARNING #5 closure; Plan 05's depends_on already includes
`01-03`). Both still execute as the third wave; no semantic change to ship order.

---

## Wave 0 Requirements

- [ ] `~/nanoclaw/voice-stack/vs-webhook-forwarder/pyproject.toml` — pytest config (Plan 03 Task 1)
- [ ] `~/nanoclaw/voice-stack/vs-webhook-forwarder/tests/test_signature.py` — 4 behaviors covering INFRA-03 forwarder half (Plan 03 Task 1)
- [ ] `~/nanoclaw/voice-stack/vs-webhook-forwarder/.venv` — pytest install (Plan 03 Task 1)
- [ ] `~/nanoclaw/voice-bridge/package.json` + `tsconfig.json` + `vitest.config.ts` — TS scaffold (Plan 05 Task 1)
- [ ] `~/nanoclaw/voice-bridge/tests/synthetic-webhook.test.ts` — covers INFRA-03 bridge half + /health + /webhook 401 (Plan 05 Task 1)
- [ ] `~/nanoclaw/voice-bridge/tests/heartbeat.test.ts` — covers INFRA-04 logic (canary throttle + recovery) (Plan 05 Task 1)
- [ ] `~/nanoclaw/voice-bridge/node_modules` — npm install (Plan 05 Task 1)

*All Wave 0 work is co-located with the implementation plans (Plans 03 + 05)
rather than a separate Wave-0 plan. Per RESEARCH §Validation Architecture
"Wave 0 Gaps".*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Hetzner public firewall blocks 9876/tcp | INFRA-02-related (Pitfall NEW-1 mitigation) | Verifying public-facing firewall from a non-Hetzner non-WG host requires external network access carsten_bot does not have | carsten or carsten_bot from a mobile-tethered Lenovo1 path: `nc -zv -w 3 128.140.104.236 9876` → expect refused/timeout |
| Hetzner cloud firewall allows UDP 60000-60100 inbound for RTP | SIP-05 | Hetzner Cloud firewall changes require dashboard access OR `hcloud` CLI auth that carsten_bot does not hold | carsten via Path A (`hcloud firewall describe` to txt evidence) OR Path B (dashboard screenshot to `firewall-rtp-confirmed.png`); Plan 02 Task 4 |
| OpenAI dashboard webhook URL configured | INFRA-03 | Dashboard is a SaaS UI without programmatic verification (per RESEARCH Open Question #5 ZDR-style note) | carsten visually verifies + screenshots Plan 02 Task 2 step 2 |
| Live PSTN call signal-path | INFRA-01..04, INFRA-08, SIP-01..06 | Requires real mobile phone dialing; no automation possible at PSTN layer | Plan 06 Task 2 — 3 live calls; Carsten's mobile → +49 30 8687022345; carsten_bot captures FreeSWITCH + bridge logs in real time |
| Discord ALERT delivery | INFRA-04 (alert sink) | Webhook arrives at Discord; visual confirmation only | carsten checks legal-ops or voice-ops channel after Plan 05 Task 3 step 8; reports "1 alert seen" (not 8 — throttle works) |
| WG MTU end-to-end probe | INFRA-04 | `ping -M do -s 1352` requires both peers configured (cross-peer assertion) | Plan 01 Task 2 step 5 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are flagged as manual with rationale
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (every plan has at least one auto-verifiable task; checkpoints have manual verify with documented commands)
- [x] Wave 0 covers all MISSING references (forwarder pytest + bridge vitest)
- [x] No watch-mode flags (vitest run, pytest -x)
- [x] Feedback latency < 10s for unit tests; integration latency gated to Plan 06
- [x] `nyquist_compliant: true` set in frontmatter
- [x] SIP-05 has a covering task (Plan 02 Task 4) — closes BLOCKER #2 from 2026-04-16 review
- [x] Plan 01 Task 2 verify includes both 1352-success AND 1500-fail probes — closes WARNING #4
- [x] Plan 06 Task 2 verify pattern matches actual PASS/FAIL verdict, not template placeholder — closes WARNING #3

**Approval:** approved 2026-04-16 (auto by planner per `<deep_work_rules>`)
**Revision:** 2026-04-16 — closures for BLOCKER #1 (D-16 amendment), BLOCKER #2 (SIP-05 task added), WARNING #3 (Plan 06 verify), WARNING #4 (Plan 01 verify), WARNING #5 (Plan 04 depends_on)
