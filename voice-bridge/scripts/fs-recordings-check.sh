#!/usr/bin/env bash
# voice-bridge/scripts/fs-recordings-check.sh
# D-21: FreeSWITCH recordings dir MUST stay empty.
# Run either on Hetzner directly OR via `docker exec vs-freeswitch bash -lc`.
# Exits 0 when empty OR when directory is absent (local dev). Exits 1 if any
# regular file is present.
set -euo pipefail
DIR="${FS_RECORDINGS_DIR:-/usr/local/freeswitch/recordings}"

if [ ! -d "$DIR" ]; then
  echo "fs-recordings-check: $DIR not present — OK (local dev)"
  exit 0
fi

COUNT="$(find "$DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -gt 0 ]; then
  echo "❌ fs-recordings-check: $COUNT file(s) in $DIR — §201 StGB violation"
  find "$DIR" -type f | head -20
  exit 1
fi

echo "✅ fs-recordings-check: $DIR is empty"
exit 0
