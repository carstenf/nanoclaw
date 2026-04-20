---
spike: A
plan: 05-00
task: Task 1 — gpt-realtime-mini function-call-first verification
purpose: OQ-1 empirical verdict
audience: Carsten (phone-side) + carsten_bot (script-side)
---

# SPIKE-A Runbook — AMD Classifier First-Turn Verification

## Overview

**What we're measuring:** Does `gpt-realtime-mini` (OpenAI Realtime SIP) emit a `response.function_call_arguments.done` event with `name=amd_result` as its FIRST output within 2000 ms of outbound pickup, with **zero** `response.audio.delta` frames preceding it?

**Why:** Research §2.4 proposes a prompt-orchestrated AMD (voicemail detection) strategy that depends on the model staying silent until the classifier tool fires. If the model "leaks" audio before the function call lands, Wave 3 must add a Bridge-side TTS-frame suppressor. Knowing the answer now saves Wave 3 a re-plan.

**Spike-A success predicate** (from 05-00-PLAN interfaces):
- `response.audio.delta` count before `amd_result` function_call = 0
- `amd_result` fires within 4000 ms of pickup
- At least 3 trials per scenario (HUMAN / VOICEMAIL / SILENCE)

**Verdict values** (from 05-00-PLAN Task 1):
- `confirmed` — 0 audio leak in all 9 trials AND correct verdict in ≥8/9
- `partial` — AUDIO_LEAKED in ≤2 trials AND correct verdict in ≥8/9 (Wave 3 needs TTS suppressor)
- `rejected` — AUDIO_LEAKED in >2 trials OR correct verdict in <6/9 (Wave 3 needs full re-design)

---

## Pre-flight Checks (carsten_bot runs, before Carsten dials)

```bash
# 1. Voice-bridge is up and healthy
curl -s http://10.0.0.2:4402/health
# Expect: {"ok":true,"secret_loaded":true,...}

# 2. Sipgate credentials are loaded and the REST path is warm
systemctl --user is-active voice-bridge.service
# Expect: active

# 3. No active call is in progress (so the outbound task dispatches immediately)
journalctl --user -u voice-bridge.service --since "30 seconds ago" | grep -E "call_accepted|outbound_originate_start"
# Expect: no recent call_accepted without a paired sideband_closed

# 4. /tmp is clean of prior spike-a traces (optional — they'll just accumulate otherwise)
ls /tmp/spike-a-trace-*.jsonl 2>/dev/null | head -5
# If anything from a prior aborted run, move aside: mkdir -p /tmp/spike-a-old && mv /tmp/spike-a-trace-*.jsonl /tmp/spike-a-old/

# 5. Audio-audit is clean right now (baseline for post-run comparison)
bash /home/carsten_bot/nanoclaw/scripts/audit-audio.sh \
  /home/carsten_bot/nanoclaw/voice-bridge \
  /home/carsten_bot/nanoclaw/data \
  /tmp 2>&1 | tail -3
# Expect: PASS (or "no violations found")
```

---

## The 9 Test Calls

### Target phone

Carsten's second phone (E.164 format, e.g. `+491708036426` — confirm with Carsten on the day).

### Call-coordination script (carsten_bot runs, one call at a time)

```bash
cd /home/carsten_bot/nanoclaw/voice-bridge
TARGET="+491708036426"   # ← Carsten's second phone

# Run ONE call at a time — outbound-router enforces single-active-outbound.
# Wait for each VERDICT=... line before triggering the next.
npx tsx scripts/spike-a-amd-classifier.ts "$TARGET"
```

Expected script output per call:
```
spike-a: targeting +4917... via http://10.0.0.2:4402
spike-a: POST /outbound with persona_override + tools_override
spike-a: enqueued task_id=<uuid> status=active
spike-a: trace file opened: /tmp/spike-a-trace-<call_id>.jsonl
VERDICT=human  ELAPSED_MS=820  AUDIO_LEAKED=false  TRACE=/tmp/spike-a-trace-rtc_xxx.jsonl
```

### Real-time observation tab (carsten_bot, optional — open in a second terminal)

```bash
journalctl --user -u voice-bridge.service -f \
  | grep -E "sideband_ready|sideband_closed|outbound_override_active|call_accepted|outbound_originate_ok|outbound_originate_failed"
```

---

## Scenario matrix

Carsten runs three scenarios, THREE times each, = 9 calls total. Coordinate call-by-call via voice/WhatsApp ("ready for HUMAN call #1"); carsten_bot triggers the script AFTER Carsten confirms he is ready on the phone-side.

### Scenario HUMAN × 3

**Carsten:**
- Phone is off-hook immediately when it rings
- Picks up within 2 seconds of first ring
- Says **"Hallo?"** clearly, 1 second after pickup
- Stays silent after that (do not say more — we're testing the classifier's FIRST-turn call)
- After VERDICT lands (or 8s timeout), hangs up

**carsten_bot expects:** `VERDICT=human ELAPSED_MS≤2000 AUDIO_LEAKED=false`

### Scenario VOICEMAIL × 3

**Carsten:**
- Does NOT pick up his second phone — let it ring through
- Sipgate's default voicemail answers with the standard German greeting ("Der Teilnehmer ist zur Zeit nicht erreichbar..." or equivalent)
- Do NOT leave a message on the mailbox (we only need the classifier to detect the greeting cue)
- Wait until VERDICT lands in carsten_bot's terminal; the script will exit and call will tear down

**carsten_bot expects:** `VERDICT=voicemail ELAPSED_MS≤4000 AUDIO_LEAKED=false`

### Scenario SILENCE × 3

**Carsten:**
- Picks up his second phone within 2 seconds of first ring
- Stays **completely silent** for the full 8 seconds — no breath, no rustle
- After 8s timeout or verdict lands, hang up

**carsten_bot expects:** `VERDICT=silence ELAPSED_MS≥4000 (classifier waits for 4s of silence) AUDIO_LEAKED=false`

---

## Post-run Analysis (carsten_bot runs, after all 9 calls done)

```bash
# 1. Confirm 9 trace files exist
ls -la /tmp/spike-a-trace-*.jsonl | wc -l
# Expect: 9

# 2. Count audio.delta frames before amd_result per file — should be 0 in ALL 9 files
for f in /tmp/spike-a-trace-*.jsonl; do
  echo -n "$f: "
  # Find the first amd_result event timestamp, count audio.delta events BEFORE it
  amd_t=$(jq -r 'select(.type == "response.function_call_arguments.done" and .name == "amd_result") | .t_ms_since_open' "$f" 2>/dev/null | head -1)
  if [ -z "$amd_t" ]; then
    echo "NO_VERDICT"
    continue
  fi
  audio_before=$(jq -r --arg amd "$amd_t" 'select(.type == "response.audio.delta" and (.t_ms_since_open | tonumber) < ($amd | tonumber)) | 1' "$f" 2>/dev/null | wc -l)
  echo "amd_t=${amd_t}ms audio_frames_before=${audio_before}"
done

# 3. Extract all verdicts for scoring
for f in /tmp/spike-a-trace-*.jsonl; do
  verdict=$(jq -r 'select(.type == "response.function_call_arguments.done" and .name == "amd_result") | .arguments' "$f" 2>/dev/null | head -1 | jq -r '.verdict' 2>/dev/null)
  echo "$f → ${verdict:-TIMEOUT}"
done

# 4. §201 StGB compliance — no audio files written anywhere
bash /home/carsten_bot/nanoclaw/scripts/audit-audio.sh \
  /home/carsten_bot/nanoclaw/voice-bridge \
  /home/carsten_bot/nanoclaw/data \
  /tmp 2>&1 | tail -5
# Expect: PASS — the JSONL traces are text-only, delta bytes already redacted to delta_bytes:<n>
```

### Compute the verdict field for SPIKE-A-amd-classifier-first.md

Fill in a score card from the output above:

| Scenario    | Trial | Verdict    | Audio frames before? | Within budget? |
|-------------|-------|------------|---------------------|----------------|
| HUMAN       | 1     | ?          | ?                   | ?              |
| HUMAN       | 2     | ?          | ?                   | ?              |
| HUMAN       | 3     | ?          | ?                   | ?              |
| VOICEMAIL   | 1     | ?          | ?                   | ?              |
| VOICEMAIL   | 2     | ?          | ?                   | ?              |
| VOICEMAIL   | 3     | ?          | ?                   | ?              |
| SILENCE     | 1     | ?          | ?                   | ?              |
| SILENCE     | 2     | ?          | ?                   | ?              |
| SILENCE     | 3     | ?          | ?                   | ?              |

Apply the rule from 05-00-PLAN Task 1:
- All 9 show 0 audio frames before amd_result AND ≥8/9 correct verdict → `verdict: confirmed`
- ≤2 trials with audio-leak AND ≥8/9 correct → `verdict: partial` (Wave 3 needs TTS suppressor)
- Otherwise → `verdict: rejected` (Wave 3 needs re-design)

---

## When done — Carsten signals back to Chat-Claude

```
spike-a-done verdict=<confirmed|partial|rejected>
```

This unlocks Task 2 (Spike-B Sipgate 486) in the continuation flow.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Script prints `VERDICT=TIMEOUT` on every call | Sipgate originate may have failed — check journalctl for `outbound_originate_failed`. Likely phone number format or Sipgate account issue. |
| `POST /outbound failed 403` | The script POSTs with `x-forwarded-for: 10.0.0.2`. If the bridge moved or peer allowlist changed, update BRIDGE_URL or patch the script's `x-forwarded-for` header. |
| Script prints `POST /outbound failed 400: bad_request` with `field=tools_override` | Something in the hardcoded tool definition violates the ^[a-zA-Z0-9_]{1,64}$ regex. Unlikely — `amd_result` matches. |
| Trace file exists but no events arrive | The sideband WS never opened for that call — check journalctl for `sideband_error` or `accept_failed` events with matching call_id. |
| Multiple trace files appear from prior runs | Script picks the first one with events. Move aside before the next scenario: `mv /tmp/spike-a-trace-*.jsonl /tmp/spike-a-old/` |
| Sipgate returns 486 (busy) on first call | Carsten's second phone was off-hook somewhere else. Hang up that other call and retry. (Note: this is also Spike-B's later test!) |
| Carsten's phone rings but nothing reaches OpenAI | Bridge may not have received the SIP bridge INVITE. Check journalctl for `realtime.call.incoming` event type. If missing, Sipgate→OpenAI SIP path has a config issue. |

---

## §201 StGB compliance reminder

Nothing in this spike persists audio. The trace JSONL redacts every `response.audio.delta` event's `delta` base64 payload to `delta_bytes: <decoded-length>` at the Bridge-side before it's written (see voice-bridge/src/sideband.ts traceEventsPath). After the 9 calls, run audit-audio.sh to confirm — it must exit PASS.

---

## Cleanup (after SPIKE-A-amd-classifier-first.md is written)

```bash
# Remove the throwaway script (it's not production code)
rm -f /home/carsten_bot/nanoclaw/voice-bridge/scripts/spike-a-amd-classifier.ts

# Optionally archive the trace files off /tmp (they're text-only, §201-safe)
mkdir -p /home/carsten_bot/nanoclaw/.planning/phases/05-case-2-restaurant-reservation-outbound/spike-results/trace-archive/
mv /tmp/spike-a-trace-*.jsonl /home/carsten_bot/nanoclaw/.planning/phases/05-case-2-restaurant-reservation-outbound/spike-results/trace-archive/
# OR delete them entirely if the SPIKE-A-amd-classifier-first.md write-up quotes the key excerpts:
# rm -f /tmp/spike-a-trace-*.jsonl
```

The override envelope (persona_override + tools_override) added in the accompanying commit STAYS in production — Wave 3 will use it to inject the Case-2 persona + tools per call without touching persona.ts or allowlist.ts.
