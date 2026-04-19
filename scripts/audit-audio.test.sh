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

# ---------- test case 4: dev-artefact paths are excluded ----------
# node_modules, _archive*, spike/, voice-stack/runs/ are legitimate dev
# artefact locations that hold test fixtures / POC data. Production call
# recordings never land there, so excluding them prevents the §201 audit
# from drowning in known false positives.
rm -f "$TESTDIR/subdir/one.mp3" "$TESTDIR/subdir/two.opus" "$TESTDIR/subdir/three.flac"
mkdir -p \
  "$TESTDIR/node_modules/node-wav" \
  "$TESTDIR/_archive-2025/vault" \
  "$TESTDIR/spike/candidate-a" \
  "$TESTDIR/voice-stack/runs"
touch \
  "$TESTDIR/node_modules/node-wav/fixture.wav" \
  "$TESTDIR/_archive-2025/vault/old.wav" \
  "$TESTDIR/spike/candidate-a/sample.wav" \
  "$TESTDIR/voice-stack/runs/test.wav"

(
  export HOME="$TESTDIR"
  export TMPDIR="$TESTDIR/tmp"
  export DISCORD_AUDIT_WEBHOOK_URL=""
  export AUDIT_AUDIO_ROOTS_OVERRIDE="$TESTDIR"
  mkdir -p "$TMPDIR"

  if ! bash "$AUDIT" > "$TESTDIR/out4.log" 2>&1; then
    echo "FAIL: dev-artefact paths were not excluded (expected exit 0):" >&2
    cat "$TESTDIR/out4.log" >&2
    exit 1
  fi
  grep -q "AUDIT PASS" "$TESTDIR/out4.log" || {
    echo "FAIL: expected AUDIT PASS when only dev-artefact audio present" >&2
    cat "$TESTDIR/out4.log" >&2
    exit 1
  }
)

# ---------- test case 5: real finding alongside excluded paths still fails ----------
# Exclusions must not let a real production recording slip through if it
# happens to coexist with dev artefacts.
touch "$TESTDIR/subdir/real-recording.wav"

(
  export HOME="$TESTDIR"
  export TMPDIR="$TESTDIR/tmp"
  export DISCORD_AUDIT_WEBHOOK_URL=""
  export AUDIT_AUDIO_ROOTS_OVERRIDE="$TESTDIR"
  mkdir -p "$TMPDIR"

  if bash "$AUDIT" > "$TESTDIR/out5.log" 2>&1; then
    echo "FAIL: real .wav was not reported despite dev-artefact coexistence" >&2
    cat "$TESTDIR/out5.log" >&2
    exit 1
  fi
  grep -q "real-recording.wav" "$TESTDIR/out5.log" || {
    echo "FAIL: expected real-recording.wav in findings" >&2
    cat "$TESTDIR/out5.log" >&2
    exit 1
  }
  grep -q "AUDIT FAIL: 1 files" "$TESTDIR/out5.log" || {
    echo "FAIL: expected exactly 1 finding (only real-recording.wav, excluded dirs skipped)" >&2
    cat "$TESTDIR/out5.log" >&2
    exit 1
  }
)

echo "audit-audio.sh test PASS"
