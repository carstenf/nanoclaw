# 02-10 SUMMARY — Sideband-WS → Slow-Brain-Push wired

**Datum:** 2026-04-17
**Plan:** 02-10-PLAN.md
**Status:** DONE — Code + Tests + Deploy + Live-PSTN-Verify PASS.
**Commits:** nanoclaw `d54e796` (wiring) + `a522d25` (SESSION_CONFIG transcription enable)

## Live-Verify (PSTN-Call rtc_u0_DVlQZLuPYyoMNFFDmIoiz, 2026-04-17 21:54)

3 User-Utterances → 3 JSONL-Eintraege:

```
{"ts":1776462866991,"event":"transcript_turn_received","call_id":"rtc_u0_DVlQZLuPYyoMNFFDmIoiz","turn_id":"item_DVlQmdNMdYUAN7iELA7ok","transcript_len":42}
{"ts":1776462882567,"event":"transcript_turn_received","call_id":"rtc_u0_DVlQZLuPYyoMNFFDmIoiz","turn_id":"item_DVlQyd6AcDU8U3Z97DwMj","transcript_len":10}
{"ts":1776462884018,"event":"transcript_turn_received","call_id":"rtc_u0_DVlQZLuPYyoMNFFDmIoiz","turn_id":"item_DVlR3h6c662eS3LS3y189","transcript_len":4}
```

Keine `slow_brain_degraded` / `sideband_message_parse_failed` / `mcp_peer_blocked` Errors. PII-Schutz haelt (nur `transcript_len`, kein Transcript-Text geloggt). Bot-Verhalten unveraendert (Stub returned null, kein session.update gepusht).

## Nachtrag — SESSION_CONFIG-Fix

Erster Post-02-10-Deploy-Call (rtc_u2_DVlOsuIvr...) zeigte: Bridge nahm an aber 0 JSONL-Eintraege. Root-Cause: OpenAI Realtime emittiert transcription-events NUR wenn `input_audio_transcription` in session explicit konfiguriert ist. Ein 4-Zeilen-Fix in `src/config.ts` (SESSION_CONFIG.audio.input.transcription = {model: 'whisper-1'}), commit `a522d25`. Beim naechsten Call kamen die Events sofort durch.

## Was behoben wurde

Plan 02-05 hatte den Slow-Brain-Worker gebaut + unit-getestet, aber nie an den Sideband-WS-Event-Strom angeschlossen. `ws.on('message')` fehlte komplett. Entdeckt 2026-04-17 21:39 beim ersten Live-Smoke nach 02-09-Deploy (Call rtc_u2_DVlCg..., kein JSONL-Eintrag).

## Aenderungen

- `src/sideband.ts`: `SidebandOpenOpts.onTranscriptTurn?` + `ws.on('message')`-Handler mit JSON-parse (try/catch → `sideband_message_parse_failed` WARN) + Buffer-utf-8-Decode + Event-Type-Filter (`conversation.item.input_audio_transcription.completed`). Alle anderen Event-Typen inklusive `delta` werden silent ignored.
- `src/call-router.ts`: `startCall` routet `onTranscriptTurn` via `router.getCall(callId).slowBrain.push({turnId, transcript})`. Post-endCall-Pushes werden mit `transcript_turn_dropped_no_ctx` WARN verworfen.

## Tests

+8 neue Cases, voice-bridge suite: 147 passed + 1 skipped (20 files).

- sideband.test.ts (+6): completed-triggers, delta-ignores, other-types-silent, broken-JSON-WARN, Buffer-decode, no-opt-noop
- call-router.test.ts (+2): wiring correct + post-endCall drop

## Deploy

```
Apr 17 21:50:23 lenovo1 voice-bridge[397413]: {"event":"bridge_listening","host":"10.0.0.2","port":4402}
```

## Erwartung fuer naechsten PSTN-Call

1. User spricht → OpenAI Realtime sendet `conversation.item.input_audio_transcription.completed` auf Sideband-WS
2. voice-bridge parst, triggered `onTranscriptTurn(item_id, transcript)` → `slowBrain.push(...)`
3. slow-brain-worker (02-09) ruft `voice.on_transcript_turn` an NanoClaw-Core-MCP
4. NanoClaw `data/voice-slow-brain.jsonl` waechst: `{event:"transcript_turn_received", call_id, turn_id, transcript_len}` pro User-Satz
5. Core antwortet `{instructions_update:null}` (Stub bis 03-02) → Bridge pushed NICHTS zurueck an OpenAI → Bot-Verhalten unveraendert

## Naechste Schritte

1. Carsten macht zweiten PSTN-Call (2-3 User-Utterances reichen)
2. Verify: `tail -5 data/voice-slow-brain.jsonl` zeigt neue Eintraege mit call_id != smoke-1
3. Dann 03-02 (Claude-Inference im Core) — verwandelt das stub-`null` in echte Slow-Brain-Logik.

## Abweichungen vom Plan

- Zusaetzlicher Buffer-utf-8-decode-Test in sideband.test.ts: die `ws`-library liefert messages als Buffer, nicht String. Test beweist dass der Handler auch damit zurecht kommt.
- Zusaetzlicher no-opt-noop-Test: stellt sicher dass sideband ohne onTranscriptTurn-Opt immer noch funktioniert (abwaertskompatibel).
- Post-endCall-drop-Test (call-router): race-condition im WS-close-Pfad abgesichert.
