---
phase: 02-director-bridge-v0-hotpath-safety
plan: 04
subsystem: voice-bridge
tags: [readback, german-nlp, levenshtein, dice-coefficient, tolerance, sc-3]

requires:
  - phase: 02-director-bridge-v0-hotpath-safety
    provides: "allowlist.ToolEntry.mutating flag from Plan 02-01 (validator is invoked for mutating tools only by the 02-07 wiring)"
provides:
  - "foldDiacritics, germanWordToNumber, normalizeGermanTime, normalizeGermanDate pure normalizer"
  - "validateReadback(toolArgs, lastUtterance, log, callId, turnId, toolName) → ReadbackResult"
  - "Dimension dispatch: time > date > name > freetext based on tool-arg field presence"
  - "Tolerance constants NAME_LEVENSHTEIN_MAX=2, FREETEXT_DICE_MIN=0.85"
  - "readback_mismatch JSONL event for 02-05 sideband retry-prompt consumer"
affects: [02-05, 02-07]

tech-stack:
  added: ["fastest-levenshtein@^1.0.16", "ws@^8.20.0", "@anthropic-ai/sdk@^0.89.0", "@types/ws@^8.5.10"]
  patterns:
    - "AM|PM ambiguity encoded as 'HH1:MM|HH2:MM' pipe-separated string — validator splits and tests each candidate"
    - "Dimension priority (time > date > name > freetext) keeps validator deterministic even for tools with multiple string fields"

key-files:
  created:
    - voice-bridge/src/readback/normalize.ts
    - voice-bridge/src/readback/validator.ts
    - voice-bridge/tests/readback-normalize.test.ts
    - voice-bridge/tests/readback-validator.test.ts
  modified:
    - voice-bridge/package.json

key-decisions:
  - "AM|PM ambiguity: 'halb drei' returns '02:30|14:30' rather than forcing one interpretation. Validator splits on '|' and accepts a match on either side. This keeps the normalizer stateless (no clock / no config / no time-of-day heuristic) while letting the validator make the binary pass/fail call against the schema-typed tool arg. Spec text suggested a default-afternoon rule — rejected because calendar entries can be morning slots and the rule would silently fail AM meetings."
  - "Pre-installed Wave-2 Plan 02-05 deps (ws, @anthropic-ai/sdk, @types/ws) in this same package.json edit to prevent a same-wave package.json merge collision when 02-05 starts. Zero runtime cost; 02-05 just consumes what's already present."
  - "Tolerance constants exported as named exports (NAME_LEVENSHTEIN_MAX / FREETEXT_DICE_MIN). Future phase-3 recalibration can import+override in tests to A/B scoring without source edits."
  - "empty-args / null toolArgs → {ok:true}. Rationale: schema-validation (Plan 02-01) already vetted shape; if there's no readback-relevant field, don't double-gate. Documented in validator.ts comment."
  - "Validator is scope-unaware. It does NOT check toolEntry.mutating. Caller (Plan 02-07 /accept wiring) MUST gate on mutating flag before calling validateReadback — documented in validator.ts header."

patterns-established:
  - "Pure-function normalizer module (no class, no instantiation) aligned with webhook.extractCaller convention"
  - "Dimension-result union `{ok:true} | {ok:false, dimension, expected, observed}` — 02-05 consumer can branch on dimension for retry-prompt copy"
  - "Dice-coefficient over foldDiacritics-tokenized words for freetext dimension — no new dep, zero allocation on the happy path"

requirements-completed:
  - DIR-13

duration: 25min
completed: 2026-04-17
---

# Phase 02 / Plan 04: Two-Form Readback Normalizer + Validator

**The canonical "seventeen-vs-seventy" misrecognition is now catchable: `validateReadback({time:'17:00'}, 'siebzig Uhr', ...)` returns `{ok:false, dimension:'time'}` and emits a `readback_mismatch` JSONL event for the 02-05 sideband to prompt a retry.**

## Outcome

Every mutating-tool dispatch path (wired in 02-07) will now:

1. Pull `lastUtterance` from the current turn's `response.audio_transcript.done`.
2. Call `validateReadback(toolArgs, lastUtterance, log, callId, turnId, toolName)`.
3. On `{ok:true}` → proceed to `dispatchTool()`.
4. On `{ok:false, dimension, expected, observed}` → abort dispatch, emit persona-level retry prompt via sideband `session.update` (02-05).

The validator runs in ~1ms (no regex compilation, no syscalls, no network).

## Supported German Forms

### Numerals (germanWordToNumber)
- `null` / `ein` / `eins` / `zwei` … `zwölf` (0–12)
- `dreizehn` … `neunzehn` (13–19)
- `zwanzig`, `dreißig`/`dreissig`, `vierzig`, `fünfzig`, `sechzig`, `siebzig`, `achtzig`, `neunzig`
- Compounds: `dreiundzwanzig` → 23, `einundvierzig` → 41, `neunundneunzig` → 99 (also "drei und zwanzig" with spaces)
- Raw digits `"17"` → 17

### Time (normalizeGermanTime)
- `17:00`, `12:30`, `09:05` (explicit HH:MM)
- `siebzehn Uhr` / `17 Uhr` → `17:00`
- `halb drei` → `02:30|14:30` (AM|PM)
- `viertel nach drei` → `03:15|15:15`
- `viertel vor drei` → `02:45|14:45`

### Date (normalizeGermanDate)
- Ordinals: `erste` → `01`, `dreiundzwanzigste` → `23`, `siebzehnte` → `17`
- Cardinals: `dreiundzwanzig` → `23`
- Digit + trailing dot: `17.` → `17`
- Out-of-range (0, 32+) → `null`

### Diacritic fold
- `ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`, case-insensitive

## Tolerance Thresholds

| Dimension | Rule | Constant | Rationale |
|-----------|------|----------|-----------|
| time | exact after normalization (pipe-split accepts either AM/PM) | — | numeric mishearings are safety-critical |
| date | exact DD after normalization | — | ditto |
| name | Levenshtein ≤ 2 after foldDiacritics | `NAME_LEVENSHTEIN_MAX = 2` | umlaut fold + 1-char typos |
| freetext | token-set dice coefficient ≥ 0.85 | `FREETEXT_DICE_MIN = 0.85` | paraphrase-tolerant |

Per DIR-13 v1.1 clause: tolerances **will be recalibrated after Phase 3 Case-6 live-test data** based on false-positive vs false-negative rates.

## Artifacts

| Path | Lines | Purpose |
|------|-------|---------|
| `voice-bridge/src/readback/normalize.ts` | 180 | Pure German normalizer |
| `voice-bridge/src/readback/validator.ts` | 120 | Dimension dispatch + tolerance + log |
| `voice-bridge/tests/readback-normalize.test.ts` | 15 cases | numerals / time / date / diacritic fold |
| `voice-bridge/tests/readback-validator.test.ts` | 14 cases | time / date / name / freetext + empty-args + null-args |

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/readback-normalize.test.ts tests/readback-validator.test.ts` — 29 / 29 passed.
- Full suite — 74 passed / 1 skipped.

## SC-3 Gate Evidence

```
validateReadback({ time: '17:00' }, 'siebzig Uhr', log, 'c', 't', 'create_calendar_entry')
→ { ok: false, dimension: 'time', expected: '17:00', observed: 'siebzig Uhr' }
→ log.warn({ event: 'readback_mismatch', tolerance_dim: 'time', ... })
```

## Out of Scope (Deferred)

- **Swiss-German forms** (e.g. `zwöi` for `zwei`): deferred to Phase 5/6 localization pass.
- **Year ordinals** (`neunzehnhundertsiebzehn` → 1917): no calendar-entry path needs it in Phase 2 (tool args are ISO YYYY-MM-DD).
- **Phone-number readback**: transfer_call target is E.164 via schema (covered by allowlist additionalProperties:false). Readback-of-phone-number is a future Case-4 concern.

## Threat-model Disposition

| Threat ID | Status | Evidence |
|-----------|--------|----------|
| T-02-04-01 Tampering (wrong confirmation) | mitigated | validator exact-match + Levenshtein + dice gates |
| T-02-04-02 Spoofing (skip readback) | mitigated | persona prompt (02-06) + Bridge validator (this plan) = hybrid |
| T-02-04-03 Info disclosure (expected in logs) | accepted | JSONL log is access-controlled; needed for red-team replay |
| T-02-04-04 EoP (non-mutating tool bypass) | n/a | scope check lives in 02-07 /accept wiring |

## Git

- nanoclaw: commit `fd28bdc` on `main` — `feat(02-04): two-form readback normalizer + validator`

## Next

Wave 2 continues with **02-05** — sideband-WS + Slow-Brain worker + config (D-24..D-28, D-43). The readback validator's `readback_mismatch` event is the trigger for 02-05's retry-prompt emission.
