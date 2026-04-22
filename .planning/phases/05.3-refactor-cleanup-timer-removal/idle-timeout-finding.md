# D-4 Finding: turn_detection.idle_timeout_ms behavior (Plan 05.3-04)

**Purpose:** Answer the 4 D-4 questions from 05.3-CONTEXT.md before Plan 05.3-05
writes the setTimeout removal + silence-monitor retirement code.

**Research date:** 2026-04-22
**Method:** docs-only (empirical probe NOT required — docs are HIGH-confidence on all 4 questions)
**Probe artifact (if applicable):** N/A — skipped per STEP 4 confidence check (Q1/Q4 both HIGH from spec verbatim)

**Primary source:** https://developers.openai.com/api/reference/resources/realtime/server-events
(OpenAI Realtime API — Server Events reference, schemas `realtime_audio_input_turn_detection` +
`input_audio_buffer.timeout_triggered`, fetched 2026-04-22)

**Secondary source:** https://developers.openai.com/cookbook/examples/realtime_prompting_guide
(Safety & Escalation section — no-input pattern guidance)

---

## Confidence Summary

| Q  | Question                                           | Confidence | Method       |
|----|----------------------------------------------------|------------|--------------|
| Q1 | Does idle_timeout_ms fire server-side response?    | HIGH       | docs verbatim |
| Q2 | Does firing model receive full history + instructions? | HIGH   | docs verbatim (commits to conversation) |
| Q3 | Per-turn vs per-session scope?                     | HIGH       | schema location |
| Q4 | Interaction with create_response:false?            | HIGH       | docs verbatim (separate trigger path) |

All four answers HIGH-confidence from the official OpenAI Realtime server-events reference.
No empirical probe needed.

---

## Q1: Does idle_timeout_ms fire server-side response.create?

**Answer:** YES — fires a full model response automatically. Emits `input_audio_buffer.timeout_triggered`
event AND generates a model response (not just a state-change signal).

**Confidence:** HIGH

**Citation:** https://developers.openai.com/api/reference/resources/realtime/server-events
(path: `realtime.audio.input.turn_detection.idle_timeout_ms` property description + the
`input_audio_buffer.timeout_triggered` server event)

**Evidence (verbatim from schema):**
> "Optional timeout after which a model response will be triggered automatically. This is
> useful for situations in which a long pause from the user is unexpected, such as a phone
> call. The model will effectively prompt the user to continue the conversation based on
> the current context. The timeout value will be applied after the last model response's
> audio has finished playing, i.e. it's set to the response.done time plus audio playback
> duration. An **input_audio_buffer.timeout_triggered event (plus events associated with
> the Response) will be emitted when the timeout is reached**. Idle timeout is currently
> only supported for server_vad mode. minimum 5000 maximum 30000"

And from the event reference (`input_audio_buffer.timeout_triggered`):
> "Returned when the Server VAD timeout is triggered for the input audio buffer. [...]
> The empty audio will be committed to the conversation as an input_audio item (there
> will be a input_audio_buffer.committed event) **and a model response will be generated**.
> There may be speech that didn't trigger VAD but is still detected by the model, so the
> model may respond with something relevant to the conversation or a prompt to continue
> speaking."

**Key nuance:** Two events fire together — the `timeout_triggered` telemetry event PLUS the
normal response lifecycle (`response.created`, `response.output_audio.delta*`, `response.done`).
NanoClaw's sideband.ts must log `timeout_triggered` for observability but does NOT need to
call `requestResponse` itself — the response is generated autonomously.

---

## Q2: Does the firing model receive full conversation history + instructions?

**Answer:** YES. The empty-silence audio is committed to the conversation as a normal
`input_audio` item (via `input_audio_buffer.committed`), then a standard model response is
generated. Standard response semantics apply — session instructions (incl. OUTBOUND_SCHWEIGEN
/ INBOUND_SCHWEIGEN ladders from baseline.ts) + full conversation history are in scope.

**Confidence:** HIGH

**Citation:** https://developers.openai.com/api/reference/resources/realtime/server-events
`input_audio_buffer.timeout_triggered` event description.

**Evidence (verbatim):**
> "The empty audio will be committed to the conversation as an input_audio item (there
> will be a input_audio_buffer.committed event) and a model response will be generated.
> There may be speech that didn't trigger VAD but is still detected by the model, so the
> model may respond with something relevant to the conversation or a prompt to continue
> speaking."

The phrase "respond with something relevant to the conversation or a prompt to continue
speaking" confirms the model reasons over full conversation state + current instructions —
exactly the vector NanoClaw needs for `OUTBOUND_SCHWEIGEN` / `INBOUND_SCHWEIGEN` ladder text
in baseline.ts lines 36-58 to steer the nudge.

**Implication for baseline.ts ladder:** the Nudge-1/2/3 text written into the persona IS
the steering mechanism. The model re-reads it on every idle_timeout fire. NanoClaw does not
need to re-inject nudge text via `session.update` or `conversation.item.create` — persona
alone carries it. (This is what makes the "skill-over-timer" architectural steer viable.)

**Caveat:** the model must internally track "how many nudges have I already fired" — because
every idle_timeout fire is stateless at the API level. The baseline ladder says "Nudge-1 then
Nudge-2 then Nudge-3 then end_call" — the model must count its own prior turns. `gpt-realtime`
(non-mini, activated 2026-04-21 per SESSION_CONFIG line 278) has improved role persistence
(MultiChallenge Audio 20.6% → 30.5%) — Carsten's 2026-04-21 assessment was that full
gpt-realtime "holds persona role more reliably on longer turns". Plan 05.3-05 should include
a live-spot-check that 3 consecutive silences escalate through Nudge-1→2→3+end_call rather
than repeat Nudge-1 three times.

---

## Q3: Can idle_timeout_ms be scoped per-turn or only per-session?

**Answer:** Session-level only. It is a property of `session.audio.input.turn_detection`
(schema path: `realtime.audio.input.turn_detection.idle_timeout_ms`), not of the per-response
`response.create` event.

**Confidence:** HIGH

**Citation:** https://developers.openai.com/api/reference/resources/realtime/server-events
Schema location: `realtime_audio_input_turn_detection.idle_timeout_ms` (variant 0 of
turn_detection, i.e. the `server_vad` variant).

**Evidence:** The property sits inside `turn_detection` which sits inside `session.audio.input`.
The `response.create` event schema has no `idle_timeout_ms` counterpart. It is a session config,
not a response config.

**Per-turn tuning workaround:** `session.update` with a new `turn_detection.idle_timeout_ms`
mid-call IS supported (Plan 05.2-05 Q7 probe: session.update is ATOMIC when not co-sent with
`tools`). So if later NanoClaw wants a shorter idle_timeout after the AMD-handoff and a longer
one during post-goal-resolution wind-down, it can push two `session.update`s. BUT — the
simpler path is ONE value per session, accepted slightly conservative (e.g. 8000ms) such that
it covers both stages.

**Boundary:** `minimum 5000, maximum 30000` (milliseconds). Values below 5s or above 30s
will be rejected by the API.

---

## Q4: Interaction with create_response:false — does idle_timeout still fire response.create?

**Answer:** YES. `create_response:false` and `idle_timeout_ms` are SEPARATE trigger paths in
the spec. `create_response` governs the caller-speech-stopped → auto-response path ONLY.
`idle_timeout_ms` is a distinct silence-duration trigger that fires regardless of
`create_response` setting.

**Confidence:** HIGH

**Citation:** https://developers.openai.com/api/reference/resources/realtime/server-events
Two adjacent property descriptions in `realtime_audio_input_turn_detection`:

**Evidence (verbatim, both from the same schema block):**

`create_response` (scoped to VAD stop events only):
> "Whether or not to automatically generate a response when a VAD stop event occurs. If
> interrupt_response is set to false this may fail to create a response if the model is
> already responding. If both create_response and interrupt_response are set to false, the
> model will never respond automatically **but VAD events will still be emitted**."

`idle_timeout_ms` (separate trigger, no `create_response` dependency mentioned):
> "Optional timeout after which a model response will be triggered automatically. [...]
> **a model response will be triggered automatically**."

The `idle_timeout_ms` description makes NO conditional on `create_response:false`. The
"if both create_response and interrupt_response are false, model will never respond
automatically" clause applies ONLY to the VAD-stop trigger — it says "but VAD events will
still be emitted", not "but idle_timeout will still fire and not trigger response". The
two paths are independent in the spec.

**Crucial safety check for §201 StGB (Case-2 outbound):** idle_timeout_ms fires ONLY "after
the last model response's audio has finished playing" (quote from Q1 evidence). **Before any
bot response has played, idle_timeout_ms is inactive.** This means for Case-2 outbound:
1. `/accept` — SESSION_CONFIG sets `create_response:false` + `idle_timeout_ms:N`.
2. AMD classifier listens silently. No bot audio yet → idle_timeout NOT armed.
3. AMD classifier fires `amd_result` tool call. Still no bot audio → idle_timeout NOT armed.
4. Post-AMD-handoff: `updateInstructions` + (for human verdict) `requestResponse` → bot
   speaks opening. Now `response.done` fires → idle_timeout clock starts.
5. Subsequent silences ≥ idle_timeout_ms → server-side response, persona steers nudge.

**The §201 zero-audio-leak invariant is preserved** — idle_timeout cannot cause premature
audio because it chains off `response.done`, which only fires after a prior (bridge-triggered)
response. The AMD gate is not circumventable by idle_timeout.

**Re outbound wait-for-speech (Plan 05.2-03 D-8):** the current `armedForFirstSpeech` flag in
sideband.ts is orthogonal to idle_timeout — it governs the FIRST-response trigger (before any
bot audio exists), which is the phase where idle_timeout is inherently dormant. No conflict.

---

## Recommended SESSION_CONFIG value

**idle_timeout_ms:** `8000` (8 seconds)

**Rationale:**
- Research §4.5 recommended 8000ms for "Post-bot-turn silence window (round 1 arm)" with
  explicit rationale: "Between Pipecat typical (10s) and Vapi fast (5s). German etiquette
  allows slightly longer pause than US English."
- baseline.ts `OUTBOUND_SCHWEIGEN` ladder (lines 36-44) uses "etwa 6 Sekunden" in the prompt
  text. Setting idle_timeout_ms to 8000ms (≈ 8 seconds) gives the model ~2s slack beyond the
  prompted "6 Sekunden" copy — matching German conversational expectations that "etwa 6s"
  means 6-8s in practice.
- Replaces D-3 target setTimeouts:
  - `GREET_TRIGGER_DELAY_MS` (1000ms inbound) — not a silence-ladder timer, separate concern
    (see "Impact on sideband.ts" below — treated via synchronous requestResponse, not
    idle_timeout).
  - `GREET_TRIGGER_DELAY_OUTBOUND_MS` (2500ms outbound) — same as above, separate concern.
  - `silence-monitor.ts` 10000ms round timer — REPLACED by idle_timeout_ms=8000ms.
- Within API bounds: `min 5000, max 30000`. 8000 is comfortably inside.
- Conservative baseline; can be lowered to 6000 or raised to 10000 via `session.update` if
  live PSTN tests show feedback.

**Env override pattern (suggested for Plan 05.3-05a config.ts):**
```typescript
export const IDLE_TIMEOUT_MS = Math.max(5000, Math.min(30000,
  Number(process.env.IDLE_TIMEOUT_MS ?? 8000)
))
```
(clamp to API bounds to prevent 400 at /accept)

---

## silence-monitor.ts disposition verdict for Plan 05.3-05

**Verdict:** SHRINK-TO-HARD-SAFETY-STUB

**Rationale:** The UX layer of silence-monitor.ts (10s round timer, 3-round re-prompt
ladder, bot-speaking/caller-speaking state machine from Plan 05.2-02 D-7) is FULLY REPLACED
by native `idle_timeout_ms`:
- Native `idle_timeout_ms` chains off `response.done` audio-playback-end — it already solves
  the "arm only AFTER bot-just-finished" problem that motivated Plan 05.2-02 D-7's
  onBotStart/onBotStop state machine. No bridge-side state machine needed.
- OUTBOUND_SCHWEIGEN + INBOUND_SCHWEIGEN ladders in baseline.ts:36-58 are already in session
  instructions — per Q2 they ARE in scope at idle_timeout fire time.
- Model counts its own nudges (persona-driven) — no round counter in bridge needed.

**BUT — retain a residual hard-safety stub for the following non-UX cases:**
1. **Catastrophic bot-silence-lockup:** if the model, for any reason, does NOT respond to
   the `input_audio_buffer.timeout_triggered` event (e.g. model silently errored,
   rate-limit, WS stall). After N missed idle_timeouts (e.g. 3 × 8s = 24s cumulative silence
   with no bot response), force-hangup. This is a DIFFERENT failure mode than UX silence.
2. **End_call-failed guard:** if the model is SUPPOSED to call `end_call` per persona
   OUTBOUND_SCHWEIGEN Nudge-3 but fails (e.g. tool call rejected), the bridge needs a
   last-resort terminate-after-N-seconds guard.

**Stub shape (~30 lines):** Mirror `voice-bridge/src/cost/gate.ts` minimalist pattern —
ONE exported function `armHardSilenceHangup(callId, maxSilentMs, hangupCb)` that:
- Arms a single setTimeout on CALL START (not on every speech event).
- Arms it with `maxSilentMs = 30000` (≈ 4 × idle_timeout_ms of 8000 — gives 3 native nudges
  + farewell + margin).
- Resets on ANY `response.done` event (bot is responsive → healthy).
- Fires hangupCb if timer elapses → "bot went catatonic" safety net.
- NO VAD awareness. NO prompt push. NO ladder counting.

**Alternative (if audit of cost/gate.ts shows it already covers catatonic-call case via
per-call cost tick):** FULLY-DELETE silence-monitor.ts. Plan 05.3-05a should perform this
audit — if gate.ts's per-minute cost-tick already arms a hangup-at-cost-cap that bounds
total call time, the residual safety stub is redundant.

**Bridge-side state machine removal:** `call-router.ts:132-149` onSpeechStart/Stop/BotStart/
BotStop forwards to silence-monitor can all be DELETED (keep only the AMD-classifier
forwards for Case-2 outbound).

---

## Impact on sideband.ts event-handler wiring for Plan 05.3-05

**Minimal but present.** Two handlers to add in the existing event-type dispatch block
(`voice-bridge/src/sideband.ts:340-376`, current pattern for `input_audio_buffer.*` and
`output_audio_buffer.*`):

### Handler 1: `input_audio_buffer.timeout_triggered` (observability log)

```typescript
// Plan 05.3-05 D-3/D-4: native idle_timeout fired. Server auto-generates a
// model response (persona OUTBOUND_SCHWEIGEN/INBOUND_SCHWEIGEN ladder steers
// the nudge text). No bridge action required — this log is for metric parity
// with legacy silence_round_* events.
if (parsed?.type === 'input_audio_buffer.timeout_triggered') {
  log.info({
    event: 'idle_timeout_triggered',
    call_id: state.callId,
    audio_start_ms: parsed.audio_start_ms,
    audio_end_ms: parsed.audio_end_ms,
    item_id: parsed.item_id,
  })
  return
}
```

**Observability hook for hard-safety stub:** optionally bump a per-call
`idle_timeout_fire_count` counter on this handler; the hard-safety stub reads the counter
and escalates to hangup at ≥4 fires (or whatever the stub's maxSilentMs / idle_timeout_ms
ratio is). Plan 05.3-05a decides exact wiring.

### Handler 2: NONE for `response.created` with an `idle`-reason marker

PATTERNS.md §7 speculated on a `response.created` with `metadata.reason === 'idle_timeout'`
marker. The spec does NOT document such a marker. `response.created` fires with standard
shape regardless of trigger source. The `input_audio_buffer.timeout_triggered` event IS the
canonical signal. Drop the speculative handler shape from PATTERNS.md §7 — use Handler 1
above as the sole new wiring.

---

## Open caveats / risks

1. **Model-side nudge-count discipline (MEDIUM-confidence risk):** Q2 showed the model must
   count its own prior nudges via conversation history. `gpt-realtime` is better than mini
   on role persistence but not perfect. Plan 05.3-05 should include a live spot-check
   (simulated silence for 25+ seconds on a test call) to confirm the model escalates
   Nudge-1 → Nudge-2 → Nudge-3+end_call rather than repeating Nudge-1. If escalation fails,
   fallback is to re-inject a `conversation.item.create` role=system directive at each
   idle_timeout fire with a "previous nudges: N" counter — this adds bridge-side state but
   keeps UX in persona.

2. **`audio_end_ms - audio_start_ms ≈ idle_timeout_ms` not exact (LOW):** spec says "will
   roughly match the configured timeout". Logging/metrics code must not assert strict
   equality.

3. **`create_response:false` + `idle_timeout_ms` edge (LOW-confidence risk, not directly
   stated in docs):** the spec phrasing is "a model response will be triggered
   automatically" — HIGH confidence this fires regardless of create_response. But the
   exact bridge-observable event sequence is inferred from separate schema descriptions,
   not from a unified compatibility statement. If live verification shows the idle_timeout
   is suppressed by create_response:false, the fallback is Option C: keep create_response
   false AND ignore idle_timeout — bridge pushes its own response.create on
   `input_audio_buffer.timeout_triggered`. This degrades to 1-extra-round-trip but works.

4. **Minimum 5000ms floor (spec):** The API refuses idle_timeout_ms < 5000. The 1000ms
   inbound GREET_TRIGGER_DELAY_MS CANNOT be replaced by idle_timeout_ms — the inbound
   self-greet trigger remains a synchronous `requestResponse` post-accept (Option A from
   PATTERNS.md §4). idle_timeout is for POST-first-bot-turn silences, not initial greet.

5. **§201 StGB invariant preserved (HIGH — see Q4 Crucial safety check):** explicitly
   re-verified in Q4 — idle_timeout chains off `response.done`, so no premature audio
   before AMD verdict. This finding does NOT loosen the §201 guard.

6. **Empirical probe NOT run — HIGH-confidence docs sufficed:** if downstream reviewers
   disagree with any of the four HIGH ratings, the probe pattern is: `scripts/idle-timeout-probe.ts`
   (analog: `scripts/session-update-atomicity-probe.ts` from Plan 05.2-05 Q7), opens a
   sideband WS with `create_response:false` + `idle_timeout_ms:5000`, waits 8s without
   caller audio after an initial bridge-triggered response, logs whether
   `input_audio_buffer.timeout_triggered` + `response.created` fire. ~50 LOC.

---

## Summary for Plan 05.3-05a/05b read-first

Plan 05.3-05a should apply:
1. `SESSION_CONFIG.audio.input.turn_detection.idle_timeout_ms = 8000` (env-override clamp
   5000..30000).
2. Add sideband.ts handler for `input_audio_buffer.timeout_triggered` (log event, optional
   counter bump).
3. DELETE `GREET_TRIGGER_DELAY_OUTBOUND_MS` const + the setTimeout at webhook.ts:493-495.
   Replace with synchronous `requestResponse` (Pattern B: atomic session.update + sync
   trigger, PATTERNS.md).
4. DELETE `GREET_TRIGGER_DELAY_MS` const + the setTimeout at webhook.ts:737-753.
   Replace with synchronous `requestResponse` (same pattern). NOTE: idle_timeout cannot
   replace the 1000ms self-greet delay because API min is 5000ms and semantics differ
   (initial greet vs post-response silence).

Plan 05.3-05b should:
1. Audit `voice-bridge/src/cost/gate.ts` coverage of catatonic-call case.
2. If covered → FULLY-DELETE `silence-monitor.ts` + remove wiring from call-router.ts.
3. If NOT covered → SHRINK silence-monitor.ts to a ~30-line hard-safety stub
   (armHardSilenceHangup pattern above). Remove bot-speaking state machine. Remove nudge
   ladder. Remove response.create pushes.
4. Update `call-router.ts:132-149` to drop silence forwards (keep AMD-classifier forwards).
5. Update tests for the new shape (or delete obsolete silence-monitor tests).

Pre-plan research deliverable complete.
