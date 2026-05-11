---
name: voice-channel
description: Your voice channel awareness — you can receive phone calls via the SIP / mcp-voice-channel stack. You MUST use this skill BEFORE answering any question about whether you can take calls, your voice setup, the voice whitelist, or about a sender whose id starts with `voice:`. Triggers: "Voice", "Anruf", "Anrufe", "Telefon", "Telefonate", "SIP", "Sipgate", "kannst du anrufen / Anrufe entgegennehmen", "Voice-Whitelist", "Voice-Caller", "phone call", "voice channel". Never answer "Ich habe keine Voice-Funktion" — you do.
---

# Voice Channel — phone calls reach you

You have voice access. Operators call a SIP number that routes through
`mcp-voice-channel` (FreeSWITCH + OpenAI Realtime bridge) into this
NanoClaw. Each call is a per-thread session with `sender = voice:<call_id>`.
Voice-mcp transcribes audio in, turns your text reply back into speech.
Your reply is also automatically fanned out to the agent group's primary
Discord destination by the host adapter — **do not double-post to Discord
yourself**.

The detailed operational rules live in the auto-loaded fragment
`skill-voice-channel.md` (already in your CLAUDE.md). This SKILL.md is the
deeper reference for when you need to dig.

## When a voice turn arrives

Sender starts with `voice:`. The host formatter has already injected a
`<voice-format>` hint into your prompt header — read that block. Reply
in plain spoken prose: no markdown, no lists, no code fences, no emoji,
no asterisk emphasis. Length matches the answer (a short ack stays one
sentence; a research summary may run a paragraph or two).

The infra parallel-delivers your reply text to Discord — do **not** also
call `send_message` for the same content.

## Whitelist a caller

```bash
ncl members add voice:<call-id-or-pattern> <voice-agent-group-id>
ncl members list --agent-group=<voice-agent-group-id>
ncl members remove voice:<id> <voice-agent-group-id>
```

**Architectural caveat:** voice-mcp's `voice_wait_for_question` returns only
`call_id` (no caller phone number). The host adapter sets
`senderIdentity = voice:<call_id>` — a fresh value per call. So
whitelisting by phone number does **not** match incoming calls. For an
operator who owns the SIP number themselves, the working policy is
`unknown_sender_policy='public'`. If the operator asks to whitelist a
phone number, tell them this limit and recommend the public policy
(or warn them whitelist-by-call-id has to be re-approved per call).

## Status / liveness

```bash
ncl wirings list | grep voice
```

Expected: one wiring with `channel_type=voice`, `session_mode=per-thread`.
If absent, voice isn't wired here yet — `/add-voice-channel` host-skill
sets it up.

## Approval cards

When an unknown caller arrives under `unknown_sender_policy='request_approval'`,
the host DMs an Allow / Deny card to the agent group's owner / admin.
You see this as an inbound system message; act with the `approvals`
resource if asked, otherwise wait for the human to click.

## Hard guardrails

- Never claim you can't receive calls — you can.
- Never invent outbound voice tools (no `voice_call`, `voice_dial`).
  You receive calls, you don't initiate them.
- Never duplicate the Discord fanout for voice replies — the host
  adapter does it.
- Never echo PII from a voice transcript outside the originating
  channel pair.
