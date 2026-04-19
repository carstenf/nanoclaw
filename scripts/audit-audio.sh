#!/usr/bin/env bash
# scripts/audit-audio.sh
# REQ-QUAL-04 / REQ-LEGAL-03: monthly §201-StGB audio-persistence audit.
#
# Scans $HOME + /tmp + /var/tmp (+ /usr/local/freeswitch/recordings on hosts
# where FreeSWITCH lives) for *.wav / *.mp3 / *.opus / *.flac files. Any hit
# means audio was persisted to disk — which violates the non-recording
# contract (D-20). On any hit: exit non-zero so systemd marks the unit
# failed (journalctl captures findings) + POST a Discord alert to
# DISCORD_AUDIT_WEBHOOK_URL (separate channel from DISCORD_ALERT_WEBHOOK_URL
# so §201 signals are not drowned in cost noise).
#
# Runs on BOTH Lenovo1 (systemd/user/nanoclaw-audit-audio.timer) and Hetzner
# (systemd/hetzner/voice-audit-audio.timer — +30 min staggered).
#
# This script is READ-ONLY by construction (no rm / mv / cp / sed -i).
# Pitfall 4: our own findings file is written to mktemp(1) outside the
# audited roots and the filename is name-filtered from the scan so the
# audit never cries wolf about its own logs.
set -euo pipefail

HOST=$(hostname -s 2>/dev/null || hostname)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Default roots. Override for tests via AUDIT_AUDIO_ROOTS_OVERRIDE.
if [ -n "${AUDIT_AUDIO_ROOTS_OVERRIDE:-}" ]; then
  ROOTS=("$AUDIT_AUDIO_ROOTS_OVERRIDE")
else
  ROOTS=("$HOME" "/tmp" "/var/tmp")
  # Hetzner-only extra root: FreeSWITCH recordings.
  if [ -d "/usr/local/freeswitch/recordings" ]; then
    ROOTS+=("/usr/local/freeswitch/recordings")
  fi
fi

FINDINGS=$(mktemp -t audit-audio.XXXXXX)
trap 'rm -f "$FINDINGS"' EXIT

for r in "${ROOTS[@]}"; do
  [ -d "$r" ] || continue
  # Pitfall 4: skip our own findings tempfile pattern and systemd runtime.
  find "$r" -type f \
    -not -path "$HOME/.local/share/systemd/*" \
    -not -name "audit-audio.*" \
    \( -name "*.wav" -o -name "*.mp3" -o -name "*.opus" -o -name "*.flac" \) \
    2>/dev/null >> "$FINDINGS" || true
done

COUNT=$(wc -l < "$FINDINGS" | tr -d ' ')
DISCORD_URL="${DISCORD_AUDIT_WEBHOOK_URL:-}"

if [ -n "$DISCORD_URL" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  if [ "$COUNT" -gt 0 ]; then
    FILES_LIST=$(head -20 "$FINDINGS" | awk '{printf "- %s\n", $0}')
    MSG=$(printf '§201 AUDIT FAIL on %s — %s files found (first 20):\n```\n%s```' "$HOST" "$COUNT" "$FILES_LIST")
  else
    MSG=$(printf '§201 audit pass on %s (0 audio files) at %s' "$HOST" "$TS")
  fi
  curl -fsS --max-time 5 -X POST "$DISCORD_URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg c "$MSG" '{content: $c}')" >/dev/null 2>&1 || true
fi

if [ "$COUNT" -gt 0 ]; then
  echo "AUDIT FAIL: $COUNT files found" >&2
  cat "$FINDINGS" >&2
  exit 1
fi

echo "AUDIT PASS: 0 files"
exit 0
