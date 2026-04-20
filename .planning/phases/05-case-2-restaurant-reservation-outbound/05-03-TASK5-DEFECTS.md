---
phase: 05-case-2-restaurant-reservation-outbound
plan: 03
task: 5
status: blocked
blocks: task5-live-verification
recommended_next: /gsd-insert-phase 05-05 AMD-persona-handoff-redesign
traces_preserved: task5-traces/
created: 2026-04-20
author: carsten_bot (gsd-execute-phase Task-5 checkpoint)
---

# Plan 05-03 Task 5 — Live Verification Defect Report

## Context

Plan 05-03 Task 5 (live-call verification of 3 Case-2 outcome paths via Carsten's
iPhone) surfaced **6 structural defects** that block the spec'd test matrix.
Wave 3 code shipped to main (Tasks 1–4 complete), but live E2E is blocked.

6 outbound calls were placed against `+491708036426` during 2026-04-20 ~19:47 UTC
to ~20:23 UTC. Traces preserved in `task5-traces/` (3 representative runs).

**Carsten confirmed transcripts via chat** — the ASR output in traces is unreliable
for short German phrases; his actual utterances are reconstructed from his
confirmations, NOT from the trace alone.

## Summary

| # | Defect | Layer | Severity | Fix-Strategy |
|---|--------|-------|----------|--------------|
| 1 | AMD `CASE2_VAD_SILENCE_MS` 6s fired during ringback | Wave 3 config | ✅ fixed 59d653a (→ 30s) | — |
| 2 | Missing `TOOL_META` entries for voice_notify_user / voice_start_case_2_call / voice_case_2_schedule_retry | Wave 1+2 server | ✅ fixed 13e2e50 | — |
| 3 | whisper-1 ASR without `language` pinned → German butchered as English/Swedish | voice-bridge Phase-2 config | ✅ language=de pinned 4db252c; **but ASR quality still poor** at telephony bandwidth | Upgrade to `gpt-4o-mini-transcribe` or `gpt-4o-transcribe` (Plan 05-05) |
| 4 | `voice_case_2_schedule_retry` called with undefined args (`calendar_date`, `idempotency_key`, invalid `prev_outcome`) | Wave 3 `webhook.ts` onVoicemail | **high** | Fix call-site arg construction; add integration test for bridge→core retry path |
| 5 | Wave-2 DB `UNIQUE(target_phone, calendar_date, attempt_no=1)` breaks on 2nd same-day initial call | Wave 2 `voice-start-case-2-call.ts:176-177` | medium | Replace hardcoded `attempt_no=1` with `SELECT COALESCE(MAX(attempt_no),0)+1 WHERE phone=? AND date=?` |
| 6 | **Persona handoff broken:** after `amd_result=human`, `updateInstructions(CASE2_OUTBOUND_PERSONA)` appears to not replace the pre-verdict conversation context. Bot acts as Restaurant-Assistant (helper-mode), not as Carsten's Anrufer | Wave 3 `webhook.ts` onHuman + OpenAI Realtime session.update semantics | **critical** | See Defect #6 analysis below — likely requires conversation-reset, not just session.update |

## Defects — Detail

### Defect #1 — Silence Timer armed at /accept instead of at SIP-pickup ✅ FIXED

**Symptom:** Call v3 (task `9c22af3d`, 19:47): iPhone rang, Carsten saw
"Anruf kam war sofort weg" — Bridge hung up at t=8s before pickup was possible.

**Root cause:** `CASE2_VAD_SILENCE_MS=6000` was calibrated for "6s AFTER pickup".
But `/accept` fires at OpenAI Realtime session-ready (T+2-3s after SIP originate),
NOT at SIP 200-OK callee-pickup. The 6s Timer B elapsed during ringback window.

**Fix:** Commit `59d653a` — default raised to 30000ms. Accommodates typical
ringback (10-20s) + pickup + first utterance window. Unit tests 5b + 5c added.

**Residual risk:** None — subsequent calls v4, v5, v6 confirmed correct
behavior (Timer B no longer false-positive-fires during ring).

---

### Defect #2 — MCP server missing TOOL_META for Wave 1+2 tools ✅ FIXED

**Symptom:** First attempt at Scenario A returned
`bad_request: restaurant_name expected Invalid input: expected string, received undefined`.

**Root cause:** `src/mcp-stream-server.ts::TOOL_META` had 18 entries but Wave 1+2
added 3 new Core MCP tools (`voice_notify_user`, `voice_start_case_2_call`,
`voice_case_2_schedule_retry`) without adding TOOL_META. The MCP SDK registered
the tools via the fallback branch `mcp.tool(name, description, handler)` (no
shape) → clients saw empty inputSchema → argument validation stripped all args.

**Fix:** Commit `13e2e50` — added the 3 TOOL_META entries with their
`<Schema>.shape`. Phase 5 Wave 1+2 summaries should add a reminder.

**Preventive pattern for future plans:** Any new Core MCP tool MUST add a
TOOL_META entry as part of its plan (checklist item in `.planning/phases/.../N-PLAN.md`).

---

### Defect #3 — ASR language detection scrambled German ✅ PARTIALLY FIXED

**Symptom:** Call v4 trace `task5-traces/v4-helper-mode.jsonl`:
- User said: "Hallo, hier Restaurant Bellavista" (confirmed by Carsten)
- ASR completed: `"and talk. That's the whole bit of this talk."`
- User said: "Hier ist Hotel Bellavista" (confirmed by Carsten)
- ASR completed: `"Helt och fullt, om man vill ha visst det."` (Swedish)

**Root cause:** `SESSION_CONFIG.audio.input.transcription = { model: 'whisper-1' }`
had no `language` — whisper auto-detect fails on short, telephony-bandwidth
German utterances, falling back to English/Swedish with hallucinated content.

**Fix:** Commit `4db252c` — pinned `language: 'de'`. Unit test 5d added.

**Residual risk (HIGH):** Call v6 with the fix still produced garbage:
- "Hallo, hier Restaurant Bellavista" → "Jan-Uwe das war es von Bellevista."
- "irgendwas mit Restaurant Bellavista" → "Hier das Rüstungsaum der Register."

whisper-1 at 8kHz telephony is structurally poor. **Plan 05-05 must upgrade
ASR** to `gpt-4o-mini-transcribe` or `gpt-4o-transcribe` (both documented in
OpenAI Realtime API). This is load-bearing: `CASE2_MAILBOX_CUE_REGEX_V2` cannot
match on a garbled transcript, and the AMD model receives corrupted user input
that may confound its classification and post-verdict persona behavior.

---

### Defect #4 — voice_case_2_schedule_retry called with undefined args

**Symptom:** Bridge log from Call v3 (19:47) and v4 (20:05):
```
case_2_schedule_retry_failed err="MCP error -32602: Input validation error:
  Invalid arguments for tool voice_case_2_schedule_retry: [
    { path: ['calendar_date'], message: 'expected string, received undefined' },
    { path: ['prev_outcome'], message: 'Invalid option: expected one of
        \"no_answer\"|\"busy\"|\"voicemail\"|\"out_of_tolerance\"' },
    { path: ['idempotency_key'], message: 'expected string, received undefined' } ]"
```

**Root cause:** Wave 3 `voice-bridge/src/webhook.ts` onVoicemail handler constructs
the retry call but either (a) doesn't read `calendar_date`+`idempotency_key` from
`activeOutbound.case_payload` or (b) sends a `prev_outcome` value that doesn't
match the zod enum. Likely sends `prev_outcome: 'silence_mailbox'` or raw AMD
reason code instead of mapping to `'voicemail'`.

**Fix direction:**
1. In `onVoicemail(reason)`, map AMD reason codes → retry enum:
   - `silence_mailbox`, `cadence_cue`, `transcript_cue`, `amd_result` all → `'voicemail'`
2. Pull `calendar_date` + `idempotency_key` from `activeOutbound.case_payload` (or
   pass the full `task` object into the handler closure)
3. Add integration test: mock CoreMcpClient, assert bridge calls retry with
   valid zod-accepted args across all 4 voicemail reason codes

---

### Defect #5 — Hardcoded attempt_no=1 violates same-day-retry UX

**Symptom:** 2nd MCP call to `voice_start_case_2_call` for same phone + date
(even with different time or party_size → different idempotency_key) fails with:
```
SqliteError: UNIQUE constraint failed:
  voice_case_2_attempts.target_phone, voice_case_2_attempts.calendar_date, voice_case_2_attempts.attempt_no
```

**Root cause:** `src/mcp-tools/voice-start-case-2-call.ts` line ~176-177 hardcodes
`attempt_no = 1` for every initial call. PK is `(phone, date, attempt_no)`, so
Carsten can never issue two separate Case-2 reservations for the same restaurant
on the same day, even if the idempotency key differs.

**Workaround in testing:** Used `requested_date=2026-04-22/23/24` to bypass.

**Fix direction:** Replace the INSERT with a transactional read-then-insert:
```sql
BEGIN;
  INSERT INTO voice_case_2_attempts (..., attempt_no, ...)
  VALUES (..., (SELECT COALESCE(MAX(attempt_no),0)+1 FROM voice_case_2_attempts
                 WHERE target_phone=? AND calendar_date=?), ...);
COMMIT;
```
or use `better-sqlite3` prepared statement with subquery. Add unit test:
two distinct idempotency_keys same (phone, date) → both insert with attempt_no 1 and 2.

---

### Defect #6 — Persona handoff after amd_result=human does NOT produce caller-role behavior [CRITICAL]

**Symptom:** Call v6 (task `fb9e3079`, 20:22-20:23), trace `v6-persona-swap-failed.jsonl`.
- User Turn 1 (real): "Hallo, hier Restaurant Bellavista"
- Model at t=11.7s correctly emits `amd_result={"verdict":"human"}`
- Bridge log at t=13s: `case_2_amd_human_verdict` → `updateInstructions(CASE2_OUTBOUND_PERSONA)` + `requestResponse` scheduled
- Bot's 1st response: *"Hallo! Es klingt so, als hättest du das Restaurant erreicht. Wie kann ich dir weiterhelfen?"*
- Bot's 2nd response: *"Hallo! Schön, dass du dich meldest. Wie kann ich dir heute…"*
- Bot's 3rd response: *"Alles klar, du bist also im Restaurant angekommen. Wie kann ich dir jetzt am besten weiterhelfen?"*
- Bot's 4th (after silence): *"Bist du noch da, Carsten?"*

**Expected behavior:** After persona swap, bot should introduce itself per
`OUTBOUND_PERSONA_TEMPLATE` line 98: *"Stelle dich höflich vor als 'NanoClaw im
Auftrag von Carsten'"* and pursue the goal *"Reservierung für [Restaurant] am
[Datum] um [Uhrzeit] für [N] Personen"*.

**Observed behavior:** Bot acts as RESTAURANT-ASSISTANT (helper-mode, du-form,
knows "Carsten" by name). This is close to `CASE6B_PERSONA` behavior (Case-6b
inbound, line 77-78 "Bist du noch da, Carsten?" is a verbatim match).

**Analysis:**

Two independent hypotheses — both plausible, need verification:

**H1 — Conversation-history contamination:** OpenAI Realtime `session.update`
with `instructions` only replaces the system-prompt going forward. The
conversation history remains:
- Initial system: `CASE2_AMD_CLASSIFIER_PROMPT` (= "Du bist in Detektions-Modus, höre nur zu")
- User turn 1: (garbled ASR "Jan-Uwe das war es")
- Model turn 1: `amd_result={human}` function_call
- (system update → `CASE2_OUTBOUND_PERSONA`)
- `requestResponse` triggered

Model sees: pre-existing conversation where User "opened" the call (Restaurant-angle),
the system prompt is ambiguous (AMD-detector history + Case-2-Outbound new), and
defaults to responding as Assistant-to-User rather than as Outbound-Caller. The
instruction "rufst an im Auftrag von Carsten" is overridden by the conversational
context that already established User-As-Initiator.

**H2 — updateInstructions race with server_vad.create_response:** `SESSION_CONFIG.audio.input.turn_detection.create_response=true`. After user's
Turn 1 ended (speech_stopped at t=11.2s), OpenAI auto-triggered a response
creation — the `amd_result` function call. Model returns response.done at t=11.7s.
User possibly had Turn 2 starting concurrently. The `updateInstructions` +
`requestResponse` sequence fires at t=13s, but by then a new response may have
been auto-created from Turn 2's speech_stopped trigger, using the OLD (AMD)
instructions cached from before the update propagated.

**Evidence from trace:**
- The AMD prompt ended with "Sprich NIEMALS bis die Bridge dir neue Anweisungen gibt."
- Yet bot responded. This suggests EITHER the model disregarded AMD prompt AFTER
  emitting amd_result (treating amd_result emission as "my turn done, now free
  to converse") OR the post-swap persona somehow inherited helper-mode from
  history.

**Fix direction (Plan 05-05):** Several options, in order of robustness:
1. **Hard reset: new Realtime session after AMD verdict.** Terminate the AMD
   session, open a fresh `openai.realtime.calls.accept` with Case-2-Outbound
   as initial instructions. No history contamination, but requires re-accept
   lifecycle (latency, SIP continuity concerns).
2. **Manual conversation.item.create to inject synthetic user message.** After
   `amd_result=human`, inject `conversation.item.create` with role=user,
   content="Der Anruf wurde gerade angenommen, beginne jetzt mit der
   Reservierungs-Anfrage." Forces the model into caller-role.
3. **Prompt-engineering hardening.** Make `CASE2_OUTBOUND_PERSONA` much more
   explicit that the model is the ANRUFER, ignore anything previous about
   being a detector. Add explicit "Ignoriere was du zuvor gehört hast —
   du bist jetzt der Anrufer, NICHT der Empfänger." Fragile, probabilistic.
4. **Disable turn_detection.create_response for Case-2 entire pre-verdict
   window.** Only allow create_response after updateInstructions completes.
   Requires verifying OpenAI Realtime can suppress auto-response mid-call.

Recommended: Option 1 or 2. Option 1 is cleanest but has lifecycle complexity.
Option 2 is middle-ground — keeps SIP continuity.

**Additional finding:** Bot said "Carsten" (du-form) which is CASE6B verbiage,
not CASE2 (Sie-form expected). This suggests either:
- CASE2 persona composition pulled the wrong template at runtime
- OR `updateInstructions` didn't land at all and bot was using some default
- OR model hallucinated Carsten's name from some other context leak

Both hypotheses need verification with additional telemetry before Plan 05-05
commits to a fix strategy.

---

## Observed AMD Classifier Successes

Not all is broken. Wave 3 AMD classifier **did work** in 3 of 3 post-silence-timer-fix calls:
- Call v4: Model correctly emitted `amd_result=voicemail` (20s speech detected as mailbox)
- Call v5: Model correctly emitted `amd_result=voicemail` (iPhone sleep → direct voicemail)
- Call v6: Model correctly emitted `amd_result=human` (real pickup) — verdict correct, persona post-verdict broken

**Zero audio leak before verdict** — the §201 StGB T-05-03-01 mitigation holds.
In all 3 post-fix calls, `response.output_audio_transcript.delta` count = 0
prior to `amd_result` emission.

This means the AMD+VAD+Regex architecture is sound; the break is in the handoff
from AMD-verdict to Case-2-Outbound-Persona.

---

## Recommended Remediation Plan

**New Plan 05-05:** "Case-2 AMD-to-Persona handoff redesign + ASR upgrade + same-day-retry fix"

Proposed task breakdown (to be refined in `/gsd-plan-phase 05-05`):

1. **Task 1 (TDD):** Persona-handoff integration test harness. Mock OpenAI
   Realtime session, assert that post-verdict bot opens with
   "NanoClaw im Auftrag von Carsten" and pursues reservation goal. RED first.
2. **Task 2:** Implement H1/H2 fix — either new-session handoff (Option 1) or
   synthetic user-message injection (Option 2). GREEN Task 1.
3. **Task 3:** Upgrade ASR from `whisper-1` to `gpt-4o-mini-transcribe`. Add
   VAD-quality regression test using Spike-C corpus.
4. **Task 4:** Fix `voice_case_2_schedule_retry` arg construction in
   `webhook.ts` onVoicemail handler. Integration test: mock CoreMcpClient,
   verify all 4 AMD-reason-codes map to a valid retry invocation.
5. **Task 5:** Fix Wave-2 `attempt_no` hardcoded in
   `voice-start-case-2-call.ts`. Transactional SELECT MAX+1 INSERT.
   Unit test: 2 distinct idempotency_keys same (phone, date) → attempts 1 and 2.
6. **Task 6 (checkpoint:human-verify):** Re-run Plan 05-03 Task 5 live matrix
   with all fixes. New trace evidence required.

Estimated effort: 2–3h focused work + 1 live-test session.

## Traces Preserved

```
task5-traces/v4-helper-mode.jsonl                  — v4: Defect #3 ASR garbage
task5-traces/v5-voicemail-via-sleep-iphone.jsonl   — v5: iPhone sleep-mode routing, voicemail verdict correct
task5-traces/v6-persona-swap-failed.jsonl          — v6: Defect #6 critical — persona handoff broken despite amd_result=human
```

Each trace is raw sideband event JSONL. See `grep "type"` for event inventory;
`grep "transcription.completed"` for ASR output; `grep "audio_transcript.delta"`
for bot speech.

## Commits Associated with Task 5 Investigation

```
13e2e50 fix(05-01,05-02): add TOOL_META entries for voice_notify_user, voice_start_case_2_call, voice_case_2_schedule_retry
9b42ac9 test(05-03): RED — AMD silence timer must accommodate ringback window (Task 5 live defect)
59d653a fix(05-03): GREEN — CASE2_VAD_SILENCE_MS default 6000→30000ms (Task 5 ringback fix)
4db252c fix(05-03): pin whisper ASR language=de (Task 5 live defect — German butchered as English/Swedish)
```

Three defects remain unfixed (Defects #4, #5, #6) — tracked for Plan 05-05.
