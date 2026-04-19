#!/usr/bin/env bash
# scripts/audit-audio.test.sh
# Shell-test harness for scripts/audit-audio.sh (REQ-QUAL-04 / REQ-LEGAL-03).
# Exercises:
#   1. Exit 1 when a .wav file is seeded inside $HOME
#   2. Exit 0 when the tree is clean
#   3. DISCORD_AUDIT_WEBHOOK_URL unset → no curl / no fatal error (graceful)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIT="$SCRIPT_DIR/audit-audio.sh"

if [ ! -x "$AUDIT" ]; then
  echo "FAIL: $AUDIT is not executable (chmod +x missing)" >&2
  exit 1
fi

TESTDIR=$(mktemp -d -t audit-test.XXXXXX)
trap 'rm -rf "$TESTDIR"' EXIT

# ---------- test case 1: seeded .wav → exit 1 ----------
mkdir -p "$TESTDIR/subdir"
touch "$TESTDIR/subdir/seeded.wav"

# Isolate HOME + TMPDIR from the real filesystem so real recordings can't skew
# the scan. Also unset the Discord webhook so the script takes the no-op path.
(
  export HOME="$TESTDIR"
  export TMPDIR="$TESTDIR/tmp"
  export DISCORD_AUDIT_WEBHOOK_URL=""
  export AUDIT_AUDIO_ROOTS_OVERRIDE="$TESTDIR"  # honored by audit-audio.sh
  mkdir -p "$TMPDIR"

  if bash "$AUDIT" > "$TESTDIR/out1.log" 2>&1; then
    echo "FAIL: audit-audio.sh did not exit 1 when seeded .wav present" >&2
    cat "$TESTDIR/out1.log" >&2
    exit 1
  fi
  # journal-friendly sanity check: findings must reference seeded.wav
  grep -q "seeded.wav" "$TESTDIR/out1.log" || {
    echo "FAIL: expected seeded.wav in findings output" >&2
    cat "$TESTDIR/out1.log" >&2
    exit 1
  }
)

# ---------- test case 2: clean tree → exit 0 ----------
rm "$TESTDIR/subdir/seeded.wav"

(
  export HOME="$TESTDIR"
  export TMPDIR="$TESTDIR/tmp"
  export DISCORD_AUDIT_WEBHOOK_URL=""
  export AUDIT_AUDIO_ROOTS_OVERRIDE="$TESTDIR"
  mkdir -p "$TMPDIR"

  if ! bash "$AUDIT" > "$TESTDIR/out2.log" 2>&1; then
    echo "FAIL: audit-audio.sh did not exit 0 on clean tree" >&2
    cat "$TESTDIR/out2.log" >&2
    exit 1
  fi
  grep -q "AUDIT PASS" "$TESTDIR/out2.log" || {
    echo "FAIL: expected AUDIT PASS in stdout" >&2
    cat "$TESTDIR/out2.log" >&2
    exit 1
  }
)

# ---------- test case 3: mp3/opus/flac extensions trigger exit 1 ----------
touch "$TESTDIR/subdir/one.mp3"
touch "$TESTDIR/subdir/two.opus"
touch "$TESTDIR/subdir/three.flac"

(
  export HOME="$TESTDIR"
  export TMPDIR="$TESTDIR/tmp"
  export DISCORD_AUDIT_WEBHOOK_URL=""
  export AUDIT_AUDIO_ROOTS_OVERRIDE="$TESTDIR"
  mkdir -p "$TMPDIR"

  if bash "$AUDIT" > "$TESTDIR/out3.log" 2>&1; then
    echo "FAIL: script did not exit 1 for mp3/opus/flac findings" >&2
    cat "$TESTDIR/out3.log" >&2
    exit 1
  fi
  grep -q "AUDIT FAIL: 3 files" "$TESTDIR/out3.log" || {
    echo "FAIL: expected AUDIT FAIL: 3 files in findings (got):" >&2
    cat "$TESTDIR/out3.log" >&2
    exit 1
  }
)

echo "audit-audio.sh test PASS"
