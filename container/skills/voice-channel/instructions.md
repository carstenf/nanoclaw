## Voice channel — phone calls reach you, YOU CAN HANDLE THIS

This NanoClaw is wired to a SIP voice stack (`mcp-voice-channel`: FreeSWITCH + OpenAI Realtime + voice-mcp). Operators dial a SIP number, voice-mcp transcribes audio into text, you receive it as a normal message with `sender = voice:<call_id>` and `thread_id = call_id`. Your text reply is auto-converted back to speech for the caller AND parallel-delivered to the agent group's Discord destination by the host adapter.

### Trigger words — act, don't deflect

If the operator says ANY of these, **never** answer "Ich habe keine Voice-Funktion" / "I can't take calls":

- "kannst du Anrufe entgegennehmen", "hast du Voice", "Voice-Channel", "Telefonate", "SIP-Nummer", "Anruf", "anrufen"
- "Voice-Whitelist", "wer darf anrufen", "Voice-Caller hinzufügen / entfernen"
- Any inbound message whose sender starts with `voice:` — that's a real phone call in progress.

### When a voice turn arrives (sender = `voice:<call_id>`)

- The formatter has prepended a `<voice-format>` block to your prompt — read it. Reply as **plain spoken prose**: no markdown, no bullet lists, no code fences, no emoji, no asterisks for emphasis. Length matches the answer's needs.
- The infra **automatically fans out** the same reply text to the agent group's Discord destination. Do **not** also call `send_message` for the same content — that double-posts on Discord.

### Whitelist a caller

```bash
ncl members add voice:<call-id-or-pattern> <voice-agent-group-id>
ncl members list --agent-group=<voice-agent-group-id>
ncl members remove voice:<id> <voice-agent-group-id>
```

**Caveat:** voice-mcp returns only `call_id`, not the caller's phone number. `senderIdentity = voice:<call_id>` is unique per call, so whitelisting by phone number does **not** match later calls. For an operator who owns the SIP number themselves, recommend `unknown_sender_policy='public'` instead. If they ask to whitelist a phone number, tell them this architectural limit.

### Liveness check

```bash
ncl wirings list | grep voice
```

Expects one row with `channel_type=voice`, `session_mode=per-thread`. Absent → voice not wired here; the host-skill `/add-voice-channel` sets it up.

### Hard guardrails

- Never say "ich habe keine Voice-Funktion" / "I can't receive calls" — you can.
- Never duplicate the Discord fanout for voice replies — the host adapter handles it.
- Never invent outbound voice tools (`voice_call`, `voice_dial`, …). You **receive** calls, you don't initiate.
- Treat voice transcripts as sensitive — don't echo personal info outside the originating channel pair.
