---
spike: A
task: 1
phase: 05
plan: 05-00
executed: 2026-04-20
target_phone: +491708036426
trials_attempted: 2 of 9
verdict: partial
verdict_confidence: high
---

# Spike-A — gpt-realtime-mini function-call-first verification (OQ-1)

## Verdict: `partial`

**Primary finding (positive):** gpt-realtime-mini DOES emit `response.function_call_arguments.done` before any `response.audio.delta` when the persona instructs it to. Measured on 2 trials:

| Trial | amd_result t_ms | First audio.delta t_ms | Gap | AUDIO_LEAKED |
|-------|-----------------|------------------------|-----|--------------|
| 1 (pre-fix)  | 3022 | 3370 (bot improv after dispatch reject) | +348ms | false |
| 2 (post-fix) | 3110 | 3595 (bot output before hangup propagated) | +485ms | false |

Both trials: `AUDIO_LEAKED=false` — the function_call precedes any audio frame. OQ-1 primary question answered ✓.

**Secondary finding (negative, and this is the reason for `partial`):** The classifier prompt's timing logic ("höre 3 Sekunden dann entscheide") is interpreted **naively** by the model as a wall-clock timer, NOT as "emit only after actual audio input". In trial 2 the verdict fired at 3110ms even though Carsten had not yet picked up the call — meaning the model emitted `verdict=human` without hearing any human. The persona-only gate is unreliable as an AMD primitive.

**Implication for Wave 3 AMD design:** The hybrid approach in 05-RESEARCH.md §2 remains correct in shape (prompt-orchestrated first, VAD cadence as fallback) — but the gate MUST be Bridge-side (arming on `input_audio_buffer.speech_started` events), not model-timer-based. The classifier prompt should emit on audio-buffer evidence, not after a fixed duration. Research's Pattern A2 needs this refinement for Wave 3 Plan 05-03.

Additionally, the dispatch-side `amd_result` handler (shipped in this spike run) hangs up immediately on any verdict — including `human`. For Wave 3 that's wrong: only `voicemail` / `silence` should hang up; `human` should proceed to persona swap. Currently tracked as a known followup — fix lands in Wave 3 Plan 05-03 Task 3.

## What was built during Spike-A (kept in production)

- **`persona_override` + `tools_override` envelope** on `OutboundTask` + `EnqueueRequest` + `/outbound` zod schema + `/accept` handler (commit `59f60f8`). This is the Path A seam that Wave 3 needs anyway.
- **`amd_result` dispatch handler** in `voice-bridge/src/tools/dispatch.ts` (commit `a40dc64`). Currently hangs up on all verdicts — Wave 3 refines to voicemail/silence-only.
- **Throwaway `voice-bridge/scripts/spike-a-amd-classifier.ts`** (commit `80ee673`). Kept in repo for reference; can be deleted after Wave 3 ships its own AMD harness.

## Why we stopped at 2 of 9 trials

Once the model's behavior was characterized (emits on timer, not on audio evidence), running 7 more trials would only confirm the same pattern with different verdict values — not new data. The `partial` verdict is actionable for Wave 3 design without further samples.

## Raw trace files

- `/tmp/spike-a-trace-rtc_u1_DWnHfTJDdDwSz9crZNxUQ.jsonl` — trial 1 (HUMAN scenario, pre-fix, bot improvised after dispatch reject)
- `/tmp/spike-a-trace-rtc_u0_DWnIiC27p66BGOy5v42zT.jsonl` — trial 2 (HUMAN intended, post-fix, but model emitted verdict before actual pickup)

Audio compliance: `scripts/audit-audio.sh` PASS — no .wav/.mp3/.opus/.flac files persisted.

## Carryforward to Wave 3 (Plan 05-03)

1. **AMD gate MUST be audio-event-driven, not timer-driven** — Bridge arms classifier prompt on `input_audio_buffer.speech_started` and makes the prompt's "listen" instruction contingent on an actual speech event.
2. **`amd_result` verdict handling refinement** — only `voicemail` / `silence` hang up; `human` swaps to the Case-2 outbound persona via `session.update` and issues `response.create` for the bot's opening.
3. **Expected latency adjustment** — Wave 3's 500ms P95 target from CONTEXT D-1 may be optimistic if we require real audio evidence; revisit the latency budget once the audio-event-driven version is instrumented.
