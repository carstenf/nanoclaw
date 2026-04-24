#!/usr/bin/env bash
# Phase 05.4 Block-5: trace retention sweeper.
#
# - gzip .jsonl files older than 7 days (in place)
# - delete .jsonl + .jsonl.gz files older than 90 days
#
# Contract: voice-channel-spec/tracing-contract.md
# Trigger:  systemd user timer (systemd/voice-trace-sweep.timer) OR cron.
# Safe to run multiple times per day — idempotent.
#
# Exit 0 on success (including "nothing to do"). Non-zero on unexpected errors
# (missing dir, permission denied).
set -euo pipefail

TRACE_DIR="${VOICE_TRACE_DIR:-$HOME/nanoclaw/voice-container/runs}"
GZIP_AFTER_DAYS="${TRACE_GZIP_AFTER_DAYS:-7}"
DELETE_AFTER_DAYS="${TRACE_DELETE_AFTER_DAYS:-90}"

if [[ ! -d "$TRACE_DIR" ]]; then
  # First run, no traces yet. Nothing to sweep.
  exit 0
fi

# Count-only dry-run mode for observability / testing.
DRY_RUN="${TRACE_SWEEP_DRY_RUN:-0}"

gzip_count=0
delete_count=0

# Gzip .jsonl files older than GZIP_AFTER_DAYS (not already .gz).
while IFS= read -r -d '' f; do
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] gzip: $f"
  else
    gzip -q "$f" || true
  fi
  gzip_count=$((gzip_count + 1))
done < <(find "$TRACE_DIR" -maxdepth 1 -name 'turns-*.jsonl' -mtime "+${GZIP_AFTER_DAYS}" -print0 2>/dev/null || true)

# Delete .jsonl and .jsonl.gz files older than DELETE_AFTER_DAYS.
while IFS= read -r -d '' f; do
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] delete: $f"
  else
    rm -f "$f"
  fi
  delete_count=$((delete_count + 1))
done < <(find "$TRACE_DIR" -maxdepth 1 \( -name 'turns-*.jsonl' -o -name 'turns-*.jsonl.gz' \) -mtime "+${DELETE_AFTER_DAYS}" -print0 2>/dev/null || true)

echo "{\"ts\":$(date -u +%s),\"event\":\"trace_sweep_done\",\"dir\":\"$TRACE_DIR\",\"gzipped\":$gzip_count,\"deleted\":$delete_count,\"dry_run\":$DRY_RUN}"
