#!/usr/bin/env bash
# Analyze the most recent Andy/ask_core voice call from the NanoClaw log.
# Builds a timeline showing where the 90s went: container boot, inference, etc.

set -euo pipefail

LOG="${HOME}/nanoclaw/logs/nanoclaw.log"
WINDOW_MIN="${1:-30}"  # how many minutes back to look (default 30)

# Pull last block of telemetry events from the log.
# Each line is: [HH:MM:SS.mmm] LEVEL (pid): message  but pino objects are
# embedded inline in the human format. Easier path: tail -n 5000 and grep.
EVENTS=$(tail -n 5000 "$LOG" | grep -E "andy_telemetry|container_telemetry|andy_container_spawned|tool_dispatch|filler_phrase_emitted")

if [[ -z "$EVENTS" ]]; then
  echo "no telemetry events found in $LOG (check tail -5000 window or run a call)" >&2
  exit 1
fi

# Find the latest runner_start as the anchor for "most recent call".
ANCHOR_TS=$(echo "$EVENTS" | grep "phase=runner_start" | tail -1 | grep -oE '\[[0-9]+:[0-9]+:[0-9]+\.[0-9]+\]' | tr -d '[]')

if [[ -z "$ANCHOR_TS" ]]; then
  echo "no andy_telemetry runner_start found — no recent ask_core call" >&2
  exit 1
fi

echo "=== Most recent Andy/ask_core call (anchor: runner_start at $ANCHOR_TS) ==="
echo

# Print every event from anchor onwards in this log block, formatted.
echo "$EVENTS" | awk -v anchor="$ANCHOR_TS" '
  {
    line=$0
    match(line, /\[([0-9]+:[0-9]+:[0-9]+\.[0-9]+)\]/, ts)
    if (ts[1] == "" ) next
    if (ts[1] < anchor) next
    # Extract phase=...
    match(line, /phase=[a-z_]+/, p)
    match(line, /event=[a-z_]+/, e)
    match(line, /ms_since_start=[0-9]+/, m1)
    match(line, /ms_since_spawn=[0-9]+/, m2)
    label = (p[0] != "") ? p[0] : (e[0] != "") ? e[0] : "(no-tag)"
    delta = (m1[0] != "") ? m1[0] : (m2[0] != "") ? m2[0] : ""
    printf "%-15s %-50s %s\n", ts[1], label, delta
  }
'
echo
echo "Tip: column 3 is ms-since-start (andy_telemetry) or ms-since-spawn (container_telemetry)."
