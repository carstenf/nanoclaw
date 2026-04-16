#!/usr/bin/env bash
# voice-stack/scripts/test-outbound-smoke.sh
#
# SIP-02 outbound originate smoke test (Phase 1 Plan 04 Task 2,
# Pitfall NEW-2 in 01-RESEARCH.md).
#
# WHAT:
#   Verify FreeSWITCH can place outbound calls via the existing
#   external/sipgate.xml gateway with Carsten's CLI. Phase 1 only
#   needs a smoke test; the real /outbound endpoint ships in Phase 4.
#
# WHEN TO RUN:
#   ONLY AFTER Wave 1 (Plans 01-01 + 01-02) is PASS — that is, after:
#     - WireGuard MTU 1380 set on both peers
#     - Hetzner firewall blocks 9876 inbound from public
#     - Plan 04 dialplan deployed via rsync to vs-freeswitch
#       (commit 534ae74 lives in conf/overlay/dialplan/public/)
#     - fs_cli reloadxml + sofia profile external rescan run on Hetzner
#     - sofia status gateway sipgate shows State=REGED
#
# WHO RUNS IT:
#   carsten_bot from Lenovo1, via SSH to voice_bot@hetzner.
#
# DO NOT RUN AT COMMIT TIME. This script stages the command for
# Wave 1 follow-up; executing it now would dial a real PSTN number
# without the deploy chain ready.
#
# USAGE:
#   ./test-outbound-smoke.sh <test-target-e164>
# Examples:
#   ./test-outbound-smoke.sh +491712345678   # Carsten's mobile (manual hangup)
#   ./test-outbound-smoke.sh 10000           # Sipgate echo number (auto-rejects safely)
#
# DOCUMENT THE RESULT in:
#   ~/nanoclaw-state/.planning/phases/01-infrastructure-webhook-path/01-04-NOTES.md
#   (template stub commented at end of this file)
#
# PASS criteria (Pitfall NEW-2):
#   - fs_cli returns "+OK <uuid>"  → SIP-02 origination accepted by gateway
#   - "-ERR USER_BUSY" / "-ERR NO_ANSWER" still counts as SIP-02 PASS
#     (origination worked, far end just didn't answer)
#   - "-ERR GATEWAY_DOWN" / "-ERR GATEWAY_UNAVAIL" → FAIL, debug sipgate.xml
#
# After the originate, sanity-check the gateway is still REGED
# (some buggy stacks deregister on outbound failure).

set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "ERROR: missing target E.164 number" >&2
  echo "Usage: $0 <test-target-e164>" >&2
  exit 64
fi

# SSH alias must resolve to voice_bot@128.140.104.236 with the
# /home/carsten_bot/.ssh/voice_bot_to_hetzner key. Adjust if your
# ~/.ssh/config differs.
HETZNER="${HETZNER_SSH:-hetzner}"

echo "===> Pre-flight: gateway must be REGED before we attempt origination"
ssh "$HETZNER" 'docker exec vs-freeswitch fs_cli -x "sofia status gateway sipgate"' \
  | tee /tmp/sofia-gw-pre.txt
if ! grep -qE 'State[[:space:]]+REGED' /tmp/sofia-gw-pre.txt; then
  echo "FAIL: gateway not REGED before originate; aborting" >&2
  exit 1
fi

echo "===> Originating outbound call to $TARGET via sofia/gateway/sipgate"
echo "     (action: &echo so call self-terminates on answer)"
ssh "$HETZNER" "docker exec vs-freeswitch fs_cli -x 'originate sofia/gateway/sipgate/$TARGET &echo'" \
  | tee /tmp/originate-result.txt
ORIG_EXIT=${PIPESTATUS[0]}

echo "===> Post-flight: gateway must still be REGED after originate"
ssh "$HETZNER" 'docker exec vs-freeswitch fs_cli -x "sofia status gateway sipgate"' \
  | tee /tmp/sofia-gw-post.txt
if grep -qE 'State[[:space:]]+REGED' /tmp/sofia-gw-post.txt; then
  echo "STILL_REGED — gateway healthy after originate"
else
  echo "WARN: gateway lost REGED after originate; investigate sipgate.xml" >&2
fi

# Verdict
if grep -qE '^\+OK' /tmp/originate-result.txt; then
  echo "VERDICT: PASS (origination accepted; uuid returned)"
elif grep -qE 'USER_BUSY|NO_ANSWER|ALLOTTED_TIMEOUT' /tmp/originate-result.txt; then
  echo "VERDICT: PASS (origination accepted; far end didn't answer — still SIP-02 success)"
elif grep -qE 'GATEWAY_DOWN|GATEWAY_UNAVAIL|NORMAL_TEMPORARY_FAILURE' /tmp/originate-result.txt; then
  echo "VERDICT: FAIL (gateway-side problem; debug sipgate.xml)" >&2
  exit 2
else
  echo "VERDICT: UNCLEAR (manual review required — see /tmp/originate-result.txt)" >&2
  exit 3
fi

exit "$ORIG_EXIT"

# -----------------------------------------------------------------------------
# 01-04-NOTES.md TEMPLATE (paste into nanoclaw-state planning dir after run):
#
# # Phase 1 Plan 04 — fs_cli notes
#
# ## SIP-02 outbound smoke test (Pitfall NEW-2)
# Date: <YYYY-MM-DD HH:MM:SS UTC>
# Operator: carsten_bot from Lenovo1
# Command: ./voice-stack/scripts/test-outbound-smoke.sh <target>
# Result: <full fs_cli output>
# Verdict: PASS | FAIL — <reason>
#
# ## Sofia gateway state at end of plan
# <output of: ssh hetzner 'docker exec vs-freeswitch fs_cli -x "sofia status gateway sipgate"'>
# -----------------------------------------------------------------------------
