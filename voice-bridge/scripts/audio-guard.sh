#!/usr/bin/env bash
# voice-bridge/scripts/audio-guard.sh
# D-23: Pre-commit / CI guard blocking audio-file writes under §201 StGB.
# Flags fs.writeFile / createWriteStream / fopen(,'w') against audio
# extensions or /tmp. Whitelists .jsonl / .log / .txt per D-20.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"

SCAN_DIRS=(
  "$REPO_ROOT/voice-bridge/src"
  "$REPO_ROOT/voice-bridge/tests"
  "$REPO_ROOT/voice-stack/sip-to-ai"
  "$REPO_ROOT/voice-container"
)

AUDIO_EXT='(wav|mp3|opus|flac|pcm|ogg|m4a|aac|webm)'

# Audio extensions next to a write call = hit.
PATTERN_AUDIO_EXT="(createWriteStream|writeFile|writeFileSync).*\\.${AUDIO_EXT}"
# /tmp writes on the same line (text-sink exceptions filtered further below).
PATTERN_TMP_WRITE="(createWriteStream|writeFile|writeFileSync).*[\"']/tmp/"
# C/Python fopen write/append mode (STT-Whisper D-22 regression guard).
PATTERN_FOPEN_WRITE='fopen\([^)]*,[[:space:]]*["'\''][wa]'

HITS=0
TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE" "${TMPFILE}.filtered"' EXIT

echo "🛡 audio-guard: scanning for §201 StGB violations..."

for dir in "${SCAN_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  grep -rnE "$PATTERN_AUDIO_EXT|$PATTERN_TMP_WRITE|$PATTERN_FOPEN_WRITE" "$dir" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.py' \
    --include='*.c' --include='*.cc' --include='*.cpp' \
    --exclude='audio-guard*' 2>/dev/null >> "$TMPFILE" || true
done

# Filter out documented text-sink exceptions (JSONL / .log / .txt) and this
# script's own regex-definition lines (which match their own patterns).
grep -vE '\.jsonl|\.log|\.txt|audio-guard\.sh|PATTERN_|AUDIO_EXT=' "$TMPFILE" \
  > "${TMPFILE}.filtered" || true

if [ -s "${TMPFILE}.filtered" ]; then
  echo "❌ audio-guard: FAILED — audio-write candidates found:"
  cat "${TMPFILE}.filtered"
  echo ""
  echo "If this is a legitimate text-output path (.jsonl/.log/.txt), the line should"
  echo "already match the whitelist. Otherwise: audio persistence violates §201 StGB"
  echo "(D-20..D-23). Route audio through the OpenAI Realtime ZDR channel only."
  exit 1
fi

echo "✅ audio-guard: clean across ${#SCAN_DIRS[@]} scan targets"
exit 0
