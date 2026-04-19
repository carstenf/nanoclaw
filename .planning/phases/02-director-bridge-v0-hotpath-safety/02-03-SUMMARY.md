---
phase: 02-director-bridge-v0-hotpath-safety
plan: 03
subsystem: ci-guards
tags: [audio-hygiene, 201-stgb, dsgvo, ci, regression-guard, stt-whisper-tombstone]

requires:
  - phase: 01-infrastructure-webhook-path
    provides: "voice-bridge vitest harness, existing .github/workflows/ci.yml"
provides:
  - "voice-bridge/scripts/audio-guard.sh — §201 StGB repo-wide write guard"
  - "voice-bridge/scripts/fs-recordings-check.sh — FS recordings-dir assertion (Phase-4 cron ready)"
  - "CI step 'Audio write guard' wired into .github/workflows/ci.yml"
  - "4 vitest regression cases that exercise the guard against seeded violations"
  - "D-22 STT-Whisper tombstone: Python fopen write-mode regex blocks re-introduction"
affects: [02-06, 04-*]

tech-stack:
  added: []
  patterns:
    - "bash -euo pipefail guard scripts launched from CI + (future) pre-commit"
    - "Text-sink exception list (.jsonl/.log/.txt) to avoid false-positives on turn-timing JSONL"

key-files:
  created:
    - voice-bridge/scripts/audio-guard.sh
    - voice-bridge/scripts/fs-recordings-check.sh
    - voice-bridge/tests/audio-guard.test.ts
  modified:
    - .github/workflows/ci.yml

key-decisions:
  - "Pre-commit vs CI: chose CI-only for now. No .husky or .pre-commit-config.yaml exists in the repo, so adding husky would introduce an unrelated dep chain. CI is authoritative for PR-merge gates; a pre-commit wrapper can be added later by pointing husky at the same script."
  - "Whitelist strategy: line-level substring check for '.jsonl', '.log', '.txt' is cheap and covers every known text-sink case (turn-timing JSONL, pino log rotation, test notes). False-negative risk is negligible because every audio extension is still caught by the dedicated audio-extension regex regardless of line content."
  - "Self-exclusion: the script exempts its own regex-definition lines (PATTERN_/AUDIO_EXT=) and any file named audio-guard*. Otherwise the guard would trip on itself."
  - "D-22 resolution: voice-container/ currently holds only runs/ (bridge logs). No Python/Whisper stub files exist to remove. Instead of deleting nothing, we installed the Python `fopen(..., 'w|a')` regex as a permanent regression anchor. If anyone reintroduces a Whisper sidecar with file-based audio persistence, CI trips on the first PR."
  - "fs-recordings-check.sh is absent-dir-safe (exit 0 when /usr/local/freeswitch/recordings doesn't exist) so local dev boxes don't fail; on Hetzner the dir exists and the guard asserts emptiness."

patterns-established:
  - "Guard scripts live in voice-bridge/scripts/ rather than repo-root scripts/ — keeps the concern colocated with the subsystem it protects"
  - "vitest temp-repo fixture pattern (mkdtempSync + cpSync + execFileSync) for shell-script regression tests"
  - "ESM-safe __dirname via fileURLToPath(import.meta.url) for NodeNext test files"

requirements-completed:
  - DISC-04

duration: 15min
completed: 2026-04-17
---

# Phase 02 / Plan 03: Audio-Hygiene Guard — CI + FS Recordings + D-22 Tombstone

**§201 StGB violations are now impossible to merge without CI override: every audio-write candidate (extensions, /tmp writes, Python fopen) trips a named CI step. The D-22 STT-Whisper code was already absent; the guard now makes its absence permanent.**

## Outcome

Three tripwires protect zero-audio-persistence posture:

1. **Repo-scan (audio-guard.sh)** — greps `voice-bridge/{src,tests}`, `voice-stack/sip-to-ai/`, `voice-container/` for audio writes + Python fopen write-mode. Exits 1 on hit. Whitelists `.jsonl` / `.log` / `.txt` per D-20.
2. **FS recordings check (fs-recordings-check.sh)** — absent-dir-safe locally; on Hetzner, asserts `/usr/local/freeswitch/recordings` stays empty. Ready for the Phase-4 monthly cron.
3. **CI wiring** — `.github/workflows/ci.yml` adds `Audio write guard (§201 StGB — D-23)` after the Tests step. PR fails if the guard trips.

## Patterns Caught

| Pattern | Hits on | Rationale |
|---------|---------|-----------|
| `(createWriteStream\|writeFile\|writeFileSync).*\.(wav\|mp3\|opus\|flac\|pcm\|ogg\|m4a\|aac\|webm)` | Any audio extension | Direct write of raw audio |
| `(createWriteStream\|writeFile\|writeFileSync).*["']/tmp/` | /tmp writes (filtered by whitelist) | Prevents the classic "/tmp/call.wav" accident |
| `fopen\(..., 'w\|a')` | Python/C open-for-write | D-22 STT-Whisper regression guard |

## Explicit Whitelist (D-20)

Lines containing `.jsonl`, `.log`, or `.txt` are stripped from the hit list before exit evaluation. This preserves:

- `turn-timing.ts` JSONL sinks (Plan 02-06)
- pino-roll `.log` rotation
- test scratch `.txt` outputs

## Artifacts

| Path | Lines | Purpose |
|------|-------|---------|
| `voice-bridge/scripts/audio-guard.sh` | 50 | Repo-scan + exception filter |
| `voice-bridge/scripts/fs-recordings-check.sh` | 21 | FS recordings-dir assertion |
| `voice-bridge/tests/audio-guard.test.ts` | 4 cases | clean-tree pass, .wav fail, Python fopen fail, .jsonl/.log/.txt pass |
| `.github/workflows/ci.yml` | +3 lines | "Audio write guard" step |

## Verification

- `bash voice-bridge/scripts/audio-guard.sh` → exit 0, "clean across 4 scan targets"
- `bash voice-bridge/scripts/fs-recordings-check.sh` → exit 0, directory absent (local dev)
- `npx vitest run tests/audio-guard.test.ts` → 4 / 4 passed
- Full suite: 45 passed / 1 skipped
- YAML parse (`python3 -c "import yaml..."`) succeeds; steps = `['', '', '', 'Format check', 'Typecheck', 'Tests', 'Audio write guard (§201 StGB — D-23)']` (first three are unnamed checkout/setup-node/npm-ci steps — untouched)

## D-22 Status Update

The decision-record flagged "STT-Whisper sidecar code should be removed from voice-container/". Inspection confirmed:

```
voice-container/
  runs/
    bridge.2026-04-17.1.log
    bridge.2026-04-16.1.log
```

No Python files, no Whisper binaries, no audio-handling code exist. D-22 is ratified as "already absent" and the Python `fopen` regex in audio-guard.sh is the permanent regression anchor. Any future PR that reintroduces a file-based STT stub will trip on the first CI run.

## Threat-model Disposition

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-03-01 Info disclosure via persisted audio | mitigated | audio-guard.sh in CI + fs-recordings-check.sh ready for cron |
| T-02-03-02 Extension-rename bypass | accepted | Determined bypass requires intent; monthly FS audit is defense-in-depth |
| T-02-03-03 Repudiation | mitigated | CI preserves guard-pass evidence per PR; ghost-scan JSONL (02-06) adds per-call audit |

## Git

- nanoclaw: commit `4a23527` on `main` — `feat(02-03): audio-hygiene guard — CI + vitest + FS recordings check`

## Next

Wave 1 complete. Ready for Wave 2:
- **02-04** — readback normalizer + validator (D-11..D-15)
- **02-05** — sideband-WS + Slow-Brain worker + config (D-24..D-28, D-43)
