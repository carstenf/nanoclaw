---
researched: 2026-04-21
author: claude-opus research agent
scope: voice-agent persona + call-flow architecture for NanoClaw (OpenAI Realtime + Sipgate)
confidence:
  section_1_current_state: HIGH   # read all referenced source files directly
  section_2_frameworks: HIGH      # primary docs from OpenAI, Pipecat, LiveKit, Vapi, ElevenLabs, Retell, Deepgram
  section_3_call_opening: MEDIUM  # OpenAI docs explicit on VAD + response.create; telephony ringback numbers derived from SIP RFC + vendor notes
  section_4_silence_detection: HIGH  # OpenAI server-event names quoted from public reference; LiveKit + Pipecat defaults quoted from docs
  section_5_turn_discipline: MEDIUM  # OpenAI cookbook has concrete rules; role-lock language mostly from community + vendor guides (fewer hard numbers)
  section_6_recommendation: HIGH  # concrete draft, directly applicable
---

# Voice Persona Architecture — Research

## Executive Summary

1. **Adopt the OpenAI Realtime Cookbook's 8-section prompt structure as the NanoClaw baseline** (Role & Objective, Personality & Tone, Context, Reference Pronunciations, Tools, Instructions / Rules, Conversation Flow, Safety & Escalation). This is the *official* OpenAI pattern, it is what `gpt-realtime` is trained against, and Vapi + ElevenLabs independently converged on the same sectioned structure. NanoClaw's current persona files already contain every one of these sections — they are just not labelled and are duplicated across three different monoliths (`CASE6B_PERSONA`, `OUTBOUND_PERSONA_TEMPLATE`, `PHASE2_PERSONA`). [CITED: https://developers.openai.com/cookbook/examples/realtime_prompting_guide]

2. **Split `persona` into `identity` (set once) + `task/state` (swapped per case).** This is Pipecat Flows' `role_messages` / `task_messages` split and the OpenAI Cookbook's "Dynamic Conversation Flow via session.updates" pattern. NanoClaw is already doing the mechanics of this (the AMD → persona swap in `webhook.ts:431-475`) — it just doesn't have the vocabulary yet, so each case re-states identity, turn-discipline, language, and disclosure rules. [CITED: https://reference-flows.pipecat.ai/en/latest/api/pipecat_flows.types.html][CITED: https://developers.openai.com/cookbook/examples/realtime_prompting_guide]

3. **The "per-case persona explosion" Carsten fears is the WRONG direction; the OpenAI-native direction is a state graph with one identity at the top and tiny per-state `task_messages` + per-state `tools` lists.** Empirical evidence (abovo.co multi-prompt vs single-prompt study): multi-prompt designs improve goal completion from 50-60% to 65-80% and drop hallucination rates from 5-25% to <2-8%. But the multi-prompt "agents" share a baseline; they do not clone it. [CITED: https://www.abovo.co/sean@symphony42.com/136639]

4. **Outbound wait-for-speech IS natively supported** via `turn_detection.create_response: false` + manual `response.create`. No audio will be emitted by the model until the bridge explicitly pushes `response.create` — which it does NOT do until a `speech_started` event fires. Defaults: `silence_duration_ms: 500ms`, `prefix_padding_ms: 300ms`. NanoClaw currently uses `create_response: true` for outbound, which is why the bot tries to speak first. [CITED: https://platform.openai.com/docs/guides/realtime-vad]

5. **Inbound self-greet is correctly implemented via `response.create` after a delay**, per OpenAI team member juberti's confirmation on the forums: "response.create is the right mechanism" for initial greetings. NanoClaw already uses `requestResponse(ctx.sideband.state, log)` after `GREET_TRIGGER_DELAY_MS=1000ms`. For the user's "1-2s self-greet" spec, that value is already in range. [CITED: https://community.openai.com/t/sip-trunking-realtime-api-call-flow-initial-greeting-delay-language-mismatch/1366626]

6. **The silence-monitor bug is a state-machine bug, not a prompt bug.** The timer arms on caller `speech_stopped` and does not track bot audio. OpenAI Realtime exposes exactly the events needed to fix this: `output_audio_buffer.started` / `output_audio_buffer.stopped` / `response.done`. Arm the silence timer ONLY on `output_audio_buffer.stopped` (the bot just finished speaking) and reset on `input_audio_buffer.speech_started`. Industry defaults for the silence window: **LiveKit 12.5s (example) or 15s (default), Pipecat configurable with a 10-30s typical range, OpenAI cookbook silent on exact timing**. Recommend **8s** post-bot-turn for NanoClaw (matches user's ear-test expectation of "not too fast"). [CITED: https://developers.openai.com/api/reference/resources/realtime/server-events]

7. **Re-prompt ladder: 2 attempts is the floor; LiveKit's own inactive_user.py example uses 3; Pipecat's UserIdleProcessor canonically uses 3-with-retry-count.** User's requirement of "2 attempts then hangup" is valid but on the aggressive end; recommend default=2 with env override so we can tune if German etiquette feedback says otherwise. [CITED: https://github.com/livekit/agents/blob/main/examples/voice_agents/inactive_user.py]

8. **Role-hallucination ("bot plays both sides") is a persona-authoring failure, not solely a model-capability failure.** `gpt-realtime` (non-mini) jumped from 20.6% → 30.5% on MultiChallenge Audio instruction following and from 49.7% → 66.5% on ComplexFuncBench — measurably more stable but NOT immune. The missing rule in NanoClaw's `OUTBOUND_PERSONA_TEMPLATE` is an explicit "Du spielst NUR deine Rolle" clause. OpenAI Cookbook has three rules that NanoClaw can adapt verbatim: "Do not repeat the same sentence twice. Vary your responses so it doesn't sound robotic", "If the user's audio is not clear … ask for clarification", and the language-lock "Do not respond in any other language even if the user asks". [CITED: https://www.infoq.com/news/2025/09/openai-gpt-realtime/]

## 1. Current State Analysis

### 1.1 What NanoClaw ships today (verified from source, 2026-04-21)

**Three monolith personas, one classifier prompt, two SESSION_CONFIGs (not really — one, but passed separately from the persona body):**

| Constant | File:line | Length (chars) | Use |
|---|---|---|---|
| `CASE6B_PERSONA` | `voice-bridge/src/persona.ts:14-90` | ~3400 | Inbound from Carsten's CLI — Du-Form |
| `OUTBOUND_PERSONA_TEMPLATE` | `voice-bridge/src/persona.ts:94-118` | ~900 | Generic outbound baseline — Sie-Form |
| `PHASE2_PERSONA` | `voice-bridge/src/persona.ts:275-307` | ~1700 | Inbound non-Carsten fallback — Sie-Form |
| `CASE2_TOLERANCE_DECISION_BLOCK` | `voice-bridge/src/persona.ts:179-191` | ~650 | Case-2 overlay |
| `CASE2_HOLD_MUSIC_CLARIFYING_BLOCK` | `voice-bridge/src/persona.ts:197-212` | ~900 | Case-2 overlay |
| `CASE2_AMD_CLASSIFIER_PROMPT` | `voice-bridge/src/amd-classifier.ts:31-41` | ~800 | AMD gate before Case-2 persona activates |

**`buildCase2OutboundPersona()` stacks three blocks** (persona.ts:239-273):
```
OUTBOUND_PERSONA_TEMPLATE (with {{goal}} and {{context}} substituted)
  + "\n\n"
  + CASE2_TOLERANCE_DECISION_BLOCK (with {time_tolerance_min} substituted)
  + "\n\n"
  + CASE2_HOLD_MUSIC_CLARIFYING_BLOCK (static)
```

Final Case-2 outbound instruction length is ~2050 chars ≈ 586 tokens (measured in a code comment). The hard ceiling referenced in the same comment is "1500 tokens" (source: Research §3.5 — not located in the current research/ folder but referenced in-code).

**Duplicated rules across the three monoliths** (grep count from the three files):
- "WERKZEUG-ZUERST" block: in all 3 monoliths, almost identical wording, ~150 chars each
- "ZWEI-FORM BESTAETIGUNG": in all 3, ~170 chars each
- "FUELL-PHRASEN": in all 3, ~80 chars each
- "OFFENLEGUNG": in all 3 (Carsten gets a 3-line version, others a 3-line version, all functionally identical)
- "SCHWEIGEN": in CASE6B and PHASE2 (not in OUTBOUND — outbound has no silence-nudge rules in the persona)
- "ABSCHIED": in CASE6B and PHASE2 (not in OUTBOUND)

**Token duplication ≈ 600-800 chars per monolith that could be shared.** If Cases 3 (medical), 4 (hotel), 5 (negotiation) are added as planned in ROADMAP, each new case adds ~2000 chars of duplicated baseline. At 6 cases × ~3000 chars = ~18k chars = ~5100 tokens just on duplicated identity/tool-rules/disclosure.

### 1.2 The AMD → persona handoff pattern (Plan 05.1-01)

`voice-bridge/src/webhook.ts:431-475` already implements what OpenAI Cookbook calls "Dynamic Conversation Flow via session.updates":

```
1. Initial /accept instructions = CASE2_AMD_CLASSIFIER_PROMPT (listen-only mode)
2. AMD classifier verdict="human" arrives via amd_result function-call
3. updateInstructions(sideband, buildCase2OutboundPersona(...))  // session.update
4. conversation.item.create role=user synthetic directive (defect #6 mitigation)
5. setTimeout(GREET_TRIGGER_DELAY_OUTBOUND_MS=2500ms, requestResponse)
```

**This is the correct pattern** — it matches the OpenAI Cookbook's "Dynamic Conversation Flow" example exactly. The only thing wrong with it today is that step 3 concatenates the same identity+rules as every other persona instead of just pushing the *task* block on top of an already-set baseline. And step 2's classifier prompt also re-states identity in a conflicting way ("Du bist in einem Detektions-Modus") — the model sees two conflicting identity claims when it reads the transcript of both prompts in chronological order.

### 1.3 Live-call observations Carsten reported (2026-04-21)

1. On `gpt-realtime-mini` during a Case-1 outbound, the bot hallucinated both caller and restaurant-staff sides and "booked" with itself. Upgrading to `gpt-realtime` is in `config.ts:278` (committed 2026-04-21) but the persona was not changed to add a role-lock clause.
2. "Bist du noch da, Carsten?" fires too fast — right after the bot finishes its own sentence. Root cause in code: `silence-monitor.ts:155-159` arms the timer on caller `speech_stopped` with no awareness of whether the bot is currently speaking. If the bot starts speaking, no event resets the timer; if the bot finishes speaking, no event starts it. The timer is purely caller-VAD-based, which is wrong for a bidirectional conversation. (See §4 for the event-level fix.)
3. Outbound opening: bot speaks immediately on /accept. User wants it to wait for the callee to say "Hallo" first, then respond. Fix is a `turn_detection.create_response: false` flip plus a bridge-side "first speech detected → push response.create" trigger. (See §3.1.)

### 1.4 Test fixtures available for regression

`voice-bridge/tests/fixtures/spike-e/turns-*.jsonl` — 5 turn-log fixtures. Format is one JSON object per turn with timing markers (T0/T2/T4 per VOICE-10). These are raw event streams suitable for driving a replay test of a new silence-monitor or a new persona that must produce the same observable behavior for human turns.

## 2. Framework Survey (Section A)

### 2.1 OpenAI Realtime — official 8-section prompt structure

Source: Realtime Prompting Guide, OpenAI Cookbook. [CITED: https://developers.openai.com/cookbook/examples/realtime_prompting_guide]

The official section list (verbatim headings):

1. **Role & Objective** — "who you are and what 'success' means"
2. **Personality & Tone** — "the voice and style to maintain"
3. **Context** — retrieved context, relevant info (RAG)
4. **Reference Pronunciations** — "phonetic guides for tricky words"
5. **Tools** — "names, usage rules, and preambles"
6. **Instructions / Rules** — "do's, don'ts, and approach"
7. **Conversation Flow** — "states, goals, and transitions"
8. **Safety & Escalation** — "fallback and handoff logic"

Sample Role & Objective (customer support):
> "You are a high-energy game-show host guiding the caller to guess a secret number from 1 to 100 to win 1,000,000\$."

Sample Personality & Tone:
> Personality: "Friendly, calm and approachable expert customer service assistant."
> Tone: "Warm, concise, confident, never fawning."
> Length: "2–3 sentences per turn."

**Per-state structure** (from the "Conversation Flow as State Machine" section):
```
{
  "id": "3_get_and_verify_phone",
  "description": "Request phone number and verify by repeating it back.",
  "instructions": [...],
  "examples": [...],
  "transitions": [{"next_step": "4_authentication_DOB", "condition": "Once phone number is confirmed"}]
}
```

**Dynamic flow pattern via `session.update`** — verbatim:
> "When the end conditions for a state are met, you use session.update to transition, replacing the prompt and tools"

Corresponding code from the guide:
```python
TRANSITIONS: Dict[State, List[State]] = {
    "verify": ["resolve"],
    "resolve": []  # terminal
}
# build_state_change_tool exposes only allowed transitions
# build_session_update pushes new instructions+tools per state
```

**Safety & Escalation thresholds** (verbatim):
> "When to escalate (no extra troubleshooting): Safety risk (self-harm, threats, harassment) / User explicitly asks for a human / **2** failed tool attempts on the same task **or** **3** consecutive no-match/no-input events"

This is load-bearing for NanoClaw: the "2 failed tool attempts" and "3 no-input events" are the OpenAI-recommended defaults that map directly onto Carsten's "2 nudges then hangup" spec (on the more-aggressive end).

**Unclear audio / no-speech** (verbatim):
> "If the user's audio is not clear (e.g. ambiguous input/background noise/silent/unintelligible) or if you did not fully hear or understand the user, ask for clarification"

**Variety rule** (verbatim):
> "Do not repeat the same sentence twice. Vary your responses so it doesn't sound robotic."

**Language lock** (verbatim, adapted from the English-only example — this exact pattern should be used for German):
> "The conversation will be only in English. Do not respond in any other language even if the user asks."

### 2.2 Pipecat Flows — `role_messages` + `task_messages` pattern

Source: Pipecat Flows NodeConfig types docs. [CITED: https://reference-flows.pipecat.ai/en/latest/api/pipecat_flows.types.html]

Pipecat Flows is Pipecat's state-graph library. Each conversation state is a `NodeConfig`:

| Field | Purpose | When set |
|---|---|---|
| `name` | Node identifier | Every node |
| `role_messages` | "message dicts defining the bot's role/personality" | **Typically set once in the initial node** |
| `task_messages` | "message dicts defining the current node's objectives" | Every node (changes per state) |
| `functions` | Tools available in this state | Per node |
| `pre_actions` / `post_actions` | Side effects on entry/exit | Per node (optional) |
| `context_strategy` | How much chat history to keep | Per node (optional) |

> "role_messages: A list of message dicts defining the bot's role/personality. Typically set once in the initial node."
> "task_messages: A list of message dicts defining the current node's objectives."

This is the canonical baseline-vs-per-case split in the open-source voice-agent world.

Pipecat's multi-scenario blog post describes this as "selective capability exposure" — at each state, the bot sees only the tools + task relevant to that state, while role/identity stays stable. [CITED: https://www.daily.co/blog/beyond-the-context-window-why-your-voice-agent-needs-structure-with-pipecat-flows/]

### 2.3 LiveKit Agents — `Agent.instructions` + `ChatContext` handoff

Source: LiveKit docs. [CITED: https://docs.livekit.io/agents/logic/sessions/]

LiveKit uses a different split: each "Agent" has its own `instructions` string (fully self-contained — no baseline/task split), and `ChatContext` (the chat history) is passed explicitly between agents on handoff.

```python
# Each agent has its own full instructions
agent = Agent(instructions="You are a helpful voice assistant. Be concise and conversational.")
# ChatContext preserves conversation across handoffs
new_agent = SomeOtherAgent()
await session.handoff(new_agent, chat_ctx=session.chat_ctx)
```

This looks closer to NanoClaw's current "per-case full persona" than to Pipecat's baseline+task split. But note: LiveKit assumes agents are coarse-grained (one agent handles an entire business function), not fine-grained per-case variants of the same logical assistant. For NanoClaw, where all cases share one "NanoClaw" identity, the Pipecat split is the better fit.

### 2.4 Vapi — Sectioned prompt + Squads for multi-assistant

Source: Vapi Prompting Guide + Squads docs. [CITED: https://docs.vapi.ai/prompting-guide][CITED: https://docs.vapi.ai/squads]

Vapi's prompting guide recommends literal markdown-section headers (the most prescriptive of any vendor):

```
[Identity]
You are a [role].

[Style]
Warm, concise, no filler.

[Response Guidelines]
2-3 sentences per turn. Use Sie-Form.

[Task & Goals]
1. Greet and confirm identity
2. Gather appointment details
3. Confirm and end
```

Vapi also uses "Squads" = multiple specialist assistants with silent handoff, each with its own full prompt. Similar to LiveKit — coarse-grained agents. Vapi's observation (verbatim):
> "Squads solve this by splitting complex prompts into focused assistants with specific tools and clear goals, while maintaining full conversation context across handoffs."

Relevant rules from Vapi's guide:
> "Do not invent information not drawn from the context."
> "Never say the word 'function' nor 'tools' nor the name of the Available functions"

### 2.5 ElevenLabs Conversational AI — `# Personality` / `# Environment` / `# Tone` / `# Goal` / `# Guardrails` / `# Tools`

Source: ElevenLabs Prompting Guide. [CITED: https://elevenlabs.io/docs/conversational-ai/best-practices/prompting-guide]

Very similar to Vapi's sectioning, but with one extra section — `# Environment` — which describes deployment context (e.g., "You are deployed over the telephone; the user cannot see you; audio may be noisy"). This is a useful addition for NanoClaw because the same identity might later run on WhatsApp-voice vs Sipgate-PSTN and needs to know which.

**Token budget** (verbatim):
> "Prompts over 2000 tokens increase latency and cost. Focus on conciseness: every line should serve a clear purpose."

This is the only hard guidance any vendor gives. 2000 tokens = ~7000 characters. NanoClaw's current Case-2 outbound is ~586 tokens (well under). The risk is growth: if Cases 3/4/5 each add an 1800-char overlay block on top of a 900-char base, we reach ~2700 chars per case for just the overlay, and that's without the state machine exposing multiple overlays per call.

**Anti-hallucination** (verbatim):
> "Emphasize 'never guess or make up information' in the guardrails section. Repeat this instruction in tool-specific error handling sections."

### 2.6 Retell AI — Conversation Flow Agent = state machine

Source: Retell blog + docs. [CITED: https://www.retellai.com/blog/unlocking-complex-interactions-with-retell-ais-conversation-flow]

Retell offers three agent types:
- Single-Prompt Agent (monolith — simplest)
- Multi-Prompt Agent (tagged transitions inside one prompt)
- **Conversation Flow Agent** (graph of nodes, each with own LLM + prompt + tools)

> "Multi-prompt agents, especially those built in the Conversation Flow editor, behave more like a state machine that is AI-powered at each state."

> "Retell's multi-prompt framework allows each node to have explicit transition criteria – typically simple conditional checks on variables or user input, adding reliability because the AI isn't left to decide when to change topics; the designer defines it."

This directly answers one of Carsten's concerns: "will I have to manage explosion of per-case prompts?" — Retell's answer is no, you don't duplicate, you compose in a graph editor where each node is a mini-prompt focused on its exit criteria.

### 2.7 Deepgram Voice Agent API — `UpdatePrompt` mid-session message

Source: Deepgram docs. [CITED: https://developers.deepgram.com/docs/voice-agent-update-prompt]

Deepgram's API directly supports sending an `UpdatePrompt` message with a new prompt string at any point during an active conversation:

```json
{
  "type": "UpdatePrompt",
  "prompt": "You are now a helpful travel assistant. Help users plan their trips..."
}
```

> "UpdatePrompt lets developers push prompt updates or agent messages at any point in the session, without restarting the stream or reinitializing downstream logic."

This is the exact equivalent of OpenAI Realtime's `session.update` with an `instructions` field. Both frameworks assume the developer WILL swap the prompt mid-call when the task changes.

### 2.8 Twilio AI Assistants / ConversationRelay

Twilio's ConversationRelay is primarily a WebSocket-transport for bringing your own LLM (or OpenAI Realtime). Prompt structure is not opinionated at the Twilio layer. However, Twilio's AMD (Answering Machine Detection) is the industry reference for the outbound "wait for callee" gate — two modes:

- `MachineDetection=Enable`: returns `AnsweredBy` verdict as soon as it knows (for predictive dialers)
- `MachineDetection=DetectMessageEnd`: waits until voicemail greeting ends with silence/beep before returning (for leave-a-message use cases)

> "AMD uses an algorithm that isolates human speech audio and measures periods between speech and silence in the greeting, and then uses this data to determine the answering party."

NanoClaw already has this — see `amd-classifier.ts` — so the framework-level primitive exists. The only open question is whether the "wait for speech then greet" pattern for humans (not just voicemail) lives in the AMD path or in a separate wait-for-speech primitive. Recommendation: same state, with two exit branches ("verdict: human" → proceed, "verdict: voicemail" → hang up). This is already how the code is structured.

[CITED: https://www.twilio.com/docs/voice/answering-machine-detection]

### 2.9 Summary table: persona composition patterns by framework

| Framework | Baseline + task split? | Mechanism | Mid-call update |
|---|---|---|---|
| OpenAI Realtime (cookbook) | Yes — 8 sections, sections 3+6+7 change per state | `session.update` with new instructions+tools | Native |
| Pipecat Flows | Yes — `role_messages` once, `task_messages` per node | NodeConfig graph | Native |
| LiveKit Agents | No — each Agent has full instructions | `session.handoff()` with `ChatContext` | Via handoff |
| Vapi | Partial — sections, but Squads clone | `[Identity][Style][Task]` + handoff tool | Via Squads |
| ElevenLabs | Partial — sections, not explicit split | `# Personality` etc. as markdown | Via tools/agent-swap |
| Retell | Yes — Conversation Flow graph | Nodes w/ own prompts + transitions | Native |
| Deepgram | Partial — API supports swap but no pattern | `UpdatePrompt` message | Native |
| Twilio | N/A — delegates to LLM | — | Delegated |

**NanoClaw's current pattern (three self-contained monoliths) most closely resembles LiveKit's full-instruction-per-agent.** To move to a state-machine architecture, the Pipecat `role_messages + task_messages` split combined with OpenAI Cookbook's section labels is the recommended target. Both work with the `session.update` mechanism NanoClaw already uses in `webhook.ts:432`.

## 3. Call-Opening Patterns (Section B)

### 3.1 Outbound wait-for-speech

**OpenAI Realtime native support** (verbatim from VAD docs): [CITED: https://platform.openai.com/docs/guides/realtime-vad]
> "If you want to keep VAD mode enabled while retaining the ability to manually decide when a response is generated, you can set `turn_detection.interrupt_response` and `turn_detection.create_response` to false with the session.update client event."
> "If both `create_response` and `interrupt_response` are set to false, the model will never respond automatically but VAD events will still be emitted."
> "Set turn_detection.create_response to false via the session.update event. VAD detects the end of speech but the server doesn't generate a response until you send a response.create event."

**Defaults for `server_vad`** (verbatim): [CITED: https://developers.openai.com/api/docs/guides/realtime-vad]
- `threshold`: 0.5 (documented example; NanoClaw uses 0.55)
- `prefix_padding_ms`: 300 (documented default)
- `silence_duration_ms`: 500 (documented example; NanoClaw uses 700)

**Telephony ringback-to-hello reality:**
- German landline/mobile pickup: anecdotal 1-3s after 180 Ringing → 200 OK. No authoritative public dataset; search did not surface one.
- SIP 180 Ringing → 200 OK: "SS_SIP_TIMEOUT_RINGING - 120s" upper bound per VOS3000; typical pickup well under 10s.
- What matters for NanoClaw: once SIP 200 OK fires and the Sipgate two-leg bridge settles, expect 1500-2500ms of RTP/audio-path stabilization (NanoClaw already accounts for this via `GREET_TRIGGER_DELAY_OUTBOUND_MS=2500`).

**Number of nudges before hangup:**
- OpenAI Cookbook escalation rule: **"3 consecutive no-match/no-input events"** → escalate (verbatim).
- LiveKit example: **3 reprompts** with 10s intervals.
- Pipecat UserIdleProcessor docs show 3-stage pattern: "first: gentle reminder, second: direct, third: end".
- Carsten's spec: **2 nudges then hangup**. This is more aggressive than industry norm but defensible for unattended outbound — you don't want to pester a stranger's number.

**Recommended outbound timing ladder for NanoClaw:**

| Step | Trigger | Action | Time from /accept |
|---|---|---|---|
| T0 | /accept 200 + SIP 200 OK | Bridge opens sideband WS; `turn_detection.create_response=false` set | 0 |
| T1 | Audio path stabilizes | No action (listening only) | T0 + 2500ms (existing `GREET_TRIGGER_DELAY_OUTBOUND_MS`) |
| T2 | `input_audio_buffer.speech_started` from callee | Arm "callee is speaking" flag; wait for `speech_stopped` | varies (typical 1-5s after SIP 200) |
| T3 | `input_audio_buffer.speech_stopped` | Push `response.create` → bot responds to callee's "Hallo" | T2 + ~700ms silence_duration_ms |
| T3-alt | **No** `speech_started` within N seconds | Push nudge #1 via `response.create` with instructions "Sage kurz: 'Hallo? Ist da jemand?'" | T1 + N_nudge1_ms |
| T4-alt | Still no `speech_started` after N more seconds | Push nudge #2 "Sage kurz: 'Hallo? Hoeren Sie mich?'" | T3-alt + N_nudge2_ms |
| T5-alt | Still no speech | Push farewell "Entschuldigung, ich erreiche Sie nicht, ich melde mich spaeter" + `openai.realtime.calls.hangup(callId)` | T4-alt + N_nudge2_ms |

Recommended values for N_nudge1_ms and N_nudge2_ms: **6000ms each** (so total outbound wait = 2500 + 6000 + 6000 + 6000 = 20500ms before hangup). This aligns with OpenAI's MachineDetection "typical" windows and with LiveKit's 10s interval — but slightly shorter because you've already burned 2500ms on audio-path settle.

**Note on CASE2_AMD branch:** Case-2 already has this primitive via the AMD classifier Timer B (`CASE2_VAD_SILENCE_MS=30000ms`) which fires if no speech is detected at all. But AMD's job is "voicemail vs human" not "nudge the human" — the two should be different states: State A = AMD (listen-only, max 6s), State B = wait-for-hello (can nudge), State C = persona (normal turn-taking). Currently NanoClaw collapses A and B into one 30s AMD timer that will not nudge.

### 3.2 Inbound self-greet

**OpenAI recommendation** (from community thread, OpenAI team member juberti): [CITED: https://community.openai.com/t/sip-trunking-realtime-api-call-flow-initial-greeting-delay-language-mismatch/1366626]
> "response.create is the right mechanism"

This is what NanoClaw already does in `webhook.ts:718-726` with `setTimeout(requestResponse, GREET_TRIGGER_DELAY_MS=1000ms)`.

**For the user's spec** ("nach 1-2 sec selbst melden"):
- Current `GREET_TRIGGER_DELAY_MS=1000ms` is at the low end
- User's spec says "1-2s" — the current 1s value satisfies the minimum
- Recommendation: leave unchanged. 1s after /accept+RTP settle is a natural feel for the callee.

**Fallback ladder (user's spec: if silence, nudge twice, hangup):**

After the self-greet completes, the same "bot stopped speaking" → arm silence timer → nudge ladder applies. This is the same code path as §4 — the two paths converge.

**Trigger signal for self-greet:**
- **Bad:** SIP 200 OK alone — RTP path may not be settled; first word clips.
- **Currently used:** fixed 1000ms timeout after /accept (OK for most cases but brittle on slow PSTN legs).
- **Better:** wait for first `output_audio_buffer.started` OR first RTP packet from caller side. But this adds complexity and the current 1000ms is good enough per Carsten's complaint (which is specifically about the re-prompt, not the self-greet).

### 3.3 Re-prompt ladder phrasing for German etiquette

German phone etiquette expects:
- First nudge: polite, tentative ("Hallo? Sind Sie noch da?" or for Carsten: "Carsten, bist du noch da?")
- Second nudge: slightly more direct but not impatient ("Hallo? Hoeren Sie mich?")
- Farewell: apologetic, not blaming ("Ich erreiche Sie momentan nicht, ich melde mich spaeter" — NOT "Ich lege jetzt auf, es ist niemand mehr da", which is what NanoClaw currently says and sounds passive-aggressive).

**Current NanoClaw farewell** (silence-monitor.ts:61):
> "Ich lege jetzt auf, es ist niemand mehr da."

**Recommended replacement** (more neutral, less accusatory):
> "Ich lege jetzt auf, bitte melden Sie sich gerne wieder." (Sie-Form)
> "Ich lege jetzt auf — melde mich nachher nochmal, Carsten." (Du-Form / Carsten)

Variety rule (OpenAI Cookbook): nudges should be reworded, not identical repeats. Current monitor has this right (`round1` and `round2` use different phrasing).

## 4. Silence / Turn-End Detection (Section C)

### 4.1 The bug, event-level

Current `silence-monitor.ts`:
- Arms timer on caller `speech_stopped` (L155-159: `onSpeechStop() → schedule()`)
- Cancels timer on caller `speech_started` (L132-154)
- **No awareness of bot speaking/not-speaking state**

Consequence: immediately after the bot finishes a sentence, the caller might also be silent (normal — the caller is listening to the bot's next thing or expecting another turn). If the caller stays silent for `silenceMs=10000ms`, the round-1 "Bist du noch da?" fires. But the 10s window was armed by whatever `speech_stopped` event came before — which might include a `speech_stopped` that fired WHILE the bot was still talking (VAD on the input buffer is indifferent to output buffer state).

Carsten's observation matches this: "kaum hat er seinen satz beendet, kommt schon 'carsten bist du noch da'" — the bot finished speaking and the caller was in the normal 2-3s "thinking before answering" phase, and the timer was already counting from an earlier `speech_stopped`.

### 4.2 Realtime server events needed for the fix

Verified event names from the OpenAI Realtime server-events reference: [CITED: https://developers.openai.com/api/reference/resources/realtime/server-events]

| Event | Fires when |
|---|---|
| `input_audio_buffer.speech_started` | Caller VAD detects speech onset |
| `input_audio_buffer.speech_stopped` | Caller VAD detects speech end |
| `response.output_audio.delta` | Each bot audio chunk (noisy) |
| `output_audio_buffer.started` | **Bot begins emitting audio** |
| `output_audio_buffer.stopped` | **Bot audio buffer fully drained (server-side — truly finished speaking)** |
| `output_audio_buffer.cleared` | Bot audio interrupted (barge-in) |
| `response.done` | Model response complete (all audio + text) |
| `response.cancelled` | Response aborted before completion |

Per the docs: `output_audio_buffer.stopped` is "returned after the full response data has been sent to the client via the response.done event" — so the conservative "bot definitely finished speaking" signal is `output_audio_buffer.stopped`, not `response.done`. On live PSTN with ~20-50ms RTP jitter buffers, the difference is small; prefer `output_audio_buffer.stopped` to avoid the rare case where `response.done` fires but a final audio chunk is still in flight.

### 4.3 Correct silence-monitor state machine

```
States:
  A. IDLE — call accepted, no audio either direction yet
  B. BOT_SPEAKING — output_audio_buffer.started received, not yet .stopped
  C. WAITING_FOR_CALLER — bot just finished; silence window armed
  D. CALLER_SPEAKING — input_audio_buffer.speech_started received, not yet .stopped

Transitions (events → new state + timer action):

  IDLE:
    output_audio_buffer.started → BOT_SPEAKING (no timer)
    input_audio_buffer.speech_started → DISABLE MONITOR (caller spoke first, no nudge needed)

  BOT_SPEAKING:
    output_audio_buffer.stopped → WAITING_FOR_CALLER (arm timer = POST_BOT_SILENCE_MS)
    output_audio_buffer.cleared → WAITING_FOR_CALLER (barge-in interrupted bot; treat like end)

  WAITING_FOR_CALLER:
    input_audio_buffer.speech_started → DISABLE MONITOR (reset timer)
    output_audio_buffer.started → BOT_SPEAKING (bot re-prompts or chains; cancel timer)
    [timer fires] → push nudge N, increment round, if round<2 go back to WAITING_FOR_CALLER armed, else farewell+hangup

  CALLER_SPEAKING:
    input_audio_buffer.speech_stopped → WAITING_FOR_CALLER (arm timer — standard turn-end silence)
    output_audio_buffer.started → BOT_SPEAKING (bot responds, cancel timer)
```

**Key difference vs current code:** the timer is ONLY armed from `output_audio_buffer.stopped` (bot-just-finished) or `input_audio_buffer.speech_stopped` (caller-just-finished). Never armed at construction time. And the timer is ALWAYS cancelled when the bot starts speaking — current code has no such guard.

### 4.4 Framework-level primitives

**Pipecat UserIdleProcessor** [CITED: https://docs.pipecat.ai/server/utilities/user-idle-processor]
- `timeout` param — seconds before idle
- Retry callback signature `callback(processor, retry_count) → bool` (return True to keep monitoring)
- Canonical 3-stage pattern documented in the API page
- **Note:** deprecated in favor of the newer `UserIdleController` integrated into `LLMUserAggregator`/`UserTurnProcessor` via `user_idle_timeout` parameter (same semantics, cleaner composition)

**LiveKit** [CITED: https://docs.livekit.io/agents/logic/sessions/]
- `AgentSession(user_away_timeout=15)` — default 15s
- Emits `UserStateChangedEvent` when state becomes `away`
- Example `inactive_user.py` uses `user_away_timeout=12.5` + `for _ in range(3): generate_reply(...); await asyncio.sleep(10)` → `session.shutdown()`

**OpenAI Realtime** — no native primitive. The cookbook mentions "3 consecutive no-match/no-input events" in the Safety & Escalation section but does not prescribe how to count them. The bridge must implement this.

### 4.5 Recommended NanoClaw values

| Parameter | Current | Recommended | Rationale |
|---|---|---|---|
| Post-bot-turn silence window (round 1 arm) | N/A (always 10s from caller speech_stopped) | **8000ms** | Between Pipecat typical (10s) and Vapi fast (5s). German etiquette allows slightly longer pause than US English. |
| Post-caller-turn silence window (round 1 arm) | 10000ms | **10000ms** (unchanged) | Caller finished speaking then went silent — standard Pipecat default is a fair floor |
| Round 1 → Round 2 delay | 10000ms | **8000ms** | One nudge per 8s feels attentive, not pushy |
| Round 2 → Farewell delay | 10000ms (but never reached in user's "2 rounds" spec) | N/A — collapse Round 3 into farewell | Per user spec |
| Nudge text round 1 (inbound Carsten) | "Bist du noch da, Carsten?" | Unchanged | Current text is fine |
| Nudge text round 2 (inbound Carsten) | "Hallo? Carsten? Hoerst du mich noch?" | Unchanged | Current text is fine |
| Farewell (inbound Carsten) | "Ich lege jetzt auf, es ist niemand mehr da." | **"Ich melde mich spaeter nochmal, Carsten — tschau!"** | Less passive-aggressive |
| Nudge text round 1 (outbound Sie-Form) | N/A (not in persona) | **"Hallo? Ist da jemand?"** | Matches user spec verbatim |
| Nudge text round 2 (outbound Sie-Form) | N/A | **"Hallo? Hoeren Sie mich?"** | Standard German phone-call second attempt |
| Farewell (outbound Sie-Form) | N/A | **"Ich erreiche Sie gerade nicht, ich versuche es spaeter nochmal."** | Apologetic, not blaming |

## 5. Turn-Discipline Prompting (Section D)

### 5.1 What the bug actually is

Carsten observed on `gpt-realtime-mini` that the bot played both caller and restaurant-staff sides. Two plausible root causes, not mutually exclusive:

1. **Model-capability:** `gpt-realtime-mini` has weaker role persistence than `gpt-realtime`. Per OpenAI: MultiChallenge Audio instruction-following improved from 20.6% (prior models) → 30.5% (gpt-realtime). ComplexFuncBench: 49.7% → 66.5%. Big Bench Audio: 65.6% → 82.8%. [CITED: https://www.infoq.com/news/2025/09/openai-gpt-realtime/]

2. **Prompt-authoring:** `OUTBOUND_PERSONA_TEMPLATE` does not explicitly state "du spielst NUR deine Rolle; erfinde NICHT, was der andere sagt; warte auf eine echte Antwort vom Gegenueber". Without that rule, the model's default roleplay tendency can fill in counterpart dialog when VAD hasn't settled yet or when the caller's audio is unclear.

The 2026-04-21 upgrade to `gpt-realtime` addresses cause #1. But the prompt still doesn't address cause #2. **Both fixes should ship together.**

### 5.2 Proven role-lock language patterns

**OpenAI Cookbook** (verbatim, adaptable): [CITED: https://developers.openai.com/cookbook/examples/realtime_prompting_guide]
> "Do not repeat the same sentence twice. Vary your responses so it doesn't sound robotic."
> "If the user's audio is not clear (e.g. ambiguous input/background noise/silent/unintelligible) or if you did not fully hear or understand the user, ask for clarification"
> "When reading numbers or codes, speak each character separately, separated by hyphens"

**Vapi role-lock** (verbatim): [CITED: https://docs.vapi.ai/prompting-guide]
> "Do not invent information not drawn from the context."
> "Answer only questions related to the context."
> "Never say the word 'function' nor 'tools' nor the name of the Available functions"

**ElevenLabs guardrails** (verbatim): [CITED: https://elevenlabs.io/docs/conversational-ai/best-practices/prompting-guide]
> "Emphasize 'never guess or make up information' in the guardrails section. Repeat this instruction in tool-specific error handling sections."

**Community-reported anchoring patterns** (from OpenAI dev forum role-persistence thread): [CITED: https://community.openai.com/t/issues-with-role-persistence-and-debugging-in-the-realtime-model/1313445]
- "Behavior anchoring" — store core rules as pinned system content, use trigger phrases to re-anchor mid-call
- "Truth Trigger Directive" — prefix commands with `Data/real:` to override emotional-modeling drift

For NanoClaw (German), the role-lock clause should be added to the baseline persona:

```
ROLLE (KRITISCH):
  - Du SPRICHST NUR deine Rolle (NanoClaw). Du SPIELST NIEMALS den Gegenueber.
  - Du ERFINDEST NIEMALS, was der Gegenueber sagt. Warte auf eine ECHTE Antwort
    bevor du weiterredest.
  - Wenn du die Antwort des Gegenuebers nicht verstanden hast oder keine Antwort
    gekommen ist: frage nach ("Entschuldigung, ich habe Sie nicht verstanden,
    koennten Sie das wiederholen?"). Raten ist NICHT erlaubt.
  - Du MACHST KEINE Geraeusche, Atem-Laute, oder 'Hmm...'-Fuellungen, wenn die
    Leitung still ist.
```

This mirrors all three patterns (OpenAI's clarification rule, Vapi's don't-invent, ElevenLabs' guardrail-repetition).

### 5.3 Model-capability vs prompt-authoring — which is it?

**Evidence for model-capability:**
- OpenAI published instruction-following benchmark delta (20.6% → 30.5%) is real and significant
- Sprinklr benchmarking report: "when swapping a customer persona to gpt-realtime, accuracy jumps 17 points to 63%" [CITED: https://www.sprinklr.com/blog/voice-bot-gpt-realtime/]
- Carsten's own ear-test: role-hallucination on mini, not seen (yet) on full

**Evidence for prompt-authoring:**
- OpenAI cookbook SPECIFICALLY calls out "Small wording changes can make or break behavior" [CITED: https://simonwillison.net/2025/Sep/1/introducing-gpt-realtime/]
- Example from the cookbook: changing "inaudible" to "unintelligible" improved noisy-audio handling
- The current `OUTBOUND_PERSONA_TEMPLATE` is conspicuously missing a role-lock clause that every other vendor guide recommends

**Verdict:** both. Upgrade to gpt-realtime was necessary but not sufficient. The persona needs the role-lock clause regardless. And since the model change drops the role-hallucination rate but doesn't eliminate it, the prompt-side defense must be added to prevent the remaining failures.

## 6. Recommendation for NanoClaw (Section E)

### 6.1 Target architecture — Baseline + Task overlay with state transitions

**Target structure (Pipecat Flows + OpenAI Cookbook hybrid):**

```
  BASELINE PERSONA (set once at /accept via openai.realtime.calls.accept instructions)
  ├── 1. Role & Objective     (identity: "NanoClaw, Assistent von Carsten Freek")
  ├── 2. Personality & Tone   (German, warm, 1-2 sentences, Sie- OR Du-Form parameterized)
  ├── 3. Reference Pronunciations (Carsten, Freek, Sipgate, Audi, etc — shared)
  ├── 4. Instructions / Rules — sub-sections:
  │        4a. Rolle (role-lock)
  │        4b. Werkzeug-zuerst
  │        4c. Keine Halluzinationen bei Aktionen
  │        4d. Zwei-Form Bestaetigung
  │        4e. Fuell-Phrasen
  │        4f. Schweigen (mirror of bridge behavior — persona also reinforces)
  │        4g. Abschied
  │        4h. Offenlegung (passive disclosure)
  └── 5. Safety & Escalation  (Bot-Frage, Notfall, Takeover-Hotword)

  TASK OVERLAY (pushed via session.update when state transitions)
  ├── Role-specific goal     (e.g., "Reservierung fuer Bellavista am ... Uhr")
  ├── Decision rules         (e.g., Case-2 tolerance ±30min, party-size exact)
  ├── Clarifying-question answers (e.g., Case-2 Allergien/Anlass/Name)
  └── State-specific tools   (subset of allowlist per state)

  PER-CALL CONTEXT (injected at /accept as literal values in baseline)
  ├── caller_role            ("carsten" | "unknown" → switches Du/Sie)
  ├── call_direction         ("inbound" | "outbound")
  └── session_mode           ("listen" | "greet" | "converse")
```

**Mechanics:**
- `persona.ts` exports ONE `buildBaselinePersona({callerRole, callDirection})` that produces the 5-section identity+rules block (~1500 chars / ~430 tokens).
- Each case exports a small `buildCase2TaskOverlay({restaurantName, date, time, ...})` that produces the 4-section task block (~800 chars / ~230 tokens).
- State graph: `LISTEN_FOR_SPEECH` → `GREET` → `AMD` (outbound only) → `CONVERSE` → `CONFIRM` → `END`. Each state has its own overlay pushed via `session.update`.

### 6.2 Worked example — NanoClaw Baseline Persona (German, verbatim draft)

```
### ROLE & OBJECTIVE
Du bist NanoClaw, der persoenliche Sprach-Assistent von Carsten Freek.
Deine Aufgabe: {{task_description}}.
Erfolg = Aufgabe erledigt ODER wahrheitsgemaesse Meldung warum nicht.

### PERSONALITY & TONE
Persoenlichkeit: freundlich, ruhig, kompetent. Nie unterwuerfig, nie pedantisch.
Ton: warm, praezise, selbstsicher.
Laenge: 1-2 Saetze pro Antwort. Keine Fuellphrasen am Satzende.
Sprache: Deutsch (de-DE). Sprich NIEMALS eine andere Sprache, auch wenn der
Gegenueber es verlangt. Bei fremdsprachigem Gegenueber sage:
"Entschuldigung, ich kann nur Deutsch sprechen."
Anrede: {{anrede_form}}  // "Du" oder "Sie" je nach caller_role

### REFERENCE PRONUNCIATIONS
- "Carsten" → Kars-ten (kurzes a, scharfes s)
- "Freek" → mit langem e wie in "See", NICHT "Frick"
- "Sipgate" → englisch: Sipp-geit
- "Bellavista" → italienisch: Bell-a-vi-sta

### INSTRUCTIONS / RULES

Rolle (KRITISCH):
- Du SPRICHST NUR deine Rolle (NanoClaw). Du SPIELST NIEMALS den Gegenueber.
- Du ERFINDEST NIEMALS, was der Gegenueber sagt. Warte auf eine ECHTE Antwort
  bevor du weiter sprichst.
- Wenn du die Antwort nicht verstanden hast oder nichts gekommen ist: frage
  EINMAL nach ("Entschuldigung, ich habe {{Sie|dich}} nicht verstanden,
  koennten {{Sie|du}} das bitte wiederholen?"). Raten ist verboten.
- Keine Geraeusche, keine Atem-Laute, keine "Hmm..."-Fuellungen.

Werkzeug-zuerst:
- Du nennst NIEMALS Termine, Vertraege, Adressen oder Fachwerte aus dem
  Gedaechtnis. Fuer JEDE solche Anfrage rufst du ein Werkzeug.

Keine Halluzinationen bei Aktionen:
- Du DARFST NIEMALS sagen "ich trage ein" / "ist eingetragen" / "ist
  abgeschickt" / "ist gebucht" OHNE ein Werkzeug aufgerufen UND eine
  erfolgreiche Antwort (id oder ok:true) erhalten zu haben.
- Sequenz: (1) Werkzeug rufen, (2) Antwort abwarten, (3) Erfolg pruefen,
  (4) ERST DANN Vollzug melden.
- Werkzeug fehlgeschlagen? Sag ehrlich: "Das hat nicht funktioniert."

Zwei-Form Bestaetigung (vor veraendernden Werkzeugen):
- Uhrzeiten in Wort UND Ziffer: "siebzehn Uhr, also 17 Uhr."
- Daten in Wort UND Ziffer: "am dreiundzwanzigsten Mai, also 23.5."
- Namen woertlich + buchstabieren bei Unklarheit.
- Frage "Korrekt?" und warte auf explizites "Ja".

Fuell-Phrasen (vor Werkzeugen > 500ms):
- Sage "Einen Moment bitte..." vor JEDEM Werkzeug-Aufruf.

Schweigen:
- Wenn der Gegenueber nicht antwortet: die Bruecke wird dich prompten. Sprich
  DANN exakt den vorgegebenen Satz und NICHTS anderes.

Abschied:
- Auf "Tschuess" / "Auf Wiedersehen" / "Ciao" / "Bye" antwortest du kurz
  und rufst SOFORT end_call mit reason='farewell'.
- NICHT weiterschwafeln, NICHT "Falls Sie noch was brauchen...". Erkannt = Ende.

Offenlegung:
- Du identifizierst dich NICHT proaktiv als KI.
- Auf "{{Sind Sie|Bist du}} ein Bot?" antwortest du wahrheitsgemaess:
  "Ja, ich bin eine KI."
- Du gibst dich NIEMALS als eine namentlich genannte Person aus.

### SAFETY & ESCALATION
- 2 fehlgeschlagene Werkzeug-Aufrufe auf dieselbe Aufgabe → sag: "Das
  funktioniert gerade nicht, ich melde mich spaeter nochmal" und rufe
  end_call mit reason='tool_failure'.
- Wenn der Gegenueber bedrohlich wird oder einen Notfall meldet: sag "Ich
  leite das sofort weiter" und rufe voice_notify_user mit urgency='alert'.
- Wenn Carsten das Takeover-Hotword sagt (nur inbound, nur Carsten): rufe
  transfer_call.
```

**Token count estimate:** ~1800 chars / ~515 tokens. Substantially smaller than any of the three current monoliths, because duplicated rules are no longer tripled.

### 6.3 Per-case task overlay (Case-2 example)

```
### TASK
Reservierung fuer {{restaurant_name}} am {{date_wort}}, also {{date}},
um {{time_wort}}, also {{time}}, fuer {{party_size_wort}} Personen.
Besondere Wuensche: {{notes | "keine"}}.
Toleranz auf die Uhrzeit: ±{{time_tolerance_min}} Minuten. Personenzahl exakt.

### DECISION RULES
- Gegenangebot innerhalb ±{{time_tolerance_min}} Min → ZUSAGE (Zwei-Form
  Readback, dann create_calendar_entry).
- Gegenangebot ausserhalb Toleranz → HOEFLICH ABLEHNEN: "{{time}} passt
  leider nicht. Wir versuchen es nochmal."
- Andere Personenzahl → ABLEHNEN.
- Counterpart kann an diesem Tag nicht → ABLEHNEN + voice_notify_user
  (urgency=decision).
- Counterpart will zurueckrufen → ABLEHNEN: "Bitte geben Sie mir jetzt
  eine direkte Antwort."

### CLARIFYING-QUESTION ANSWERS
- "Allergien?" → Notes ODER "Nein, danke."
- "Anlass?" → Notes ODER "Nein, einfach ein schoener Abend."
- "Kinderstuehle?" → Notes ODER "Nein, danke."
- "Name?" → "Carsten Freek, Freek mit zwei Es."
- "Telefon fuer Rueckfragen?" → NIEMALS Handynummer. Sage: "Die
  Sipgate-Nummer von der Sie angerufen wurden."
- "Vorauszahlung?" → NIEMALS zusagen.
- Unbekannt → "Dazu kann ich gerade nichts Verbindliches sagen."

### HOLD-MUSIC HANDLING
- "Moment bitte" + Musik → schweige bis zu 45s. Dann einmal: "Hallo? Sind
  Sie noch da?" Bei 60s kumulativ: "Ich versuche es nochmal spaeter" +
  end_call.
```

**Token count: ~700 chars / ~200 tokens.** Combined with baseline: ~715 tokens total for Case-2 — 22% lower than the current ~586 → wait, current is already smaller. Let me re-check.

Actually current Case-2 measured at ~586 tokens (code comment persona.ts:140). New baseline+overlay = ~715 tokens. Slightly larger for one case alone. But:
- Case-6b currently ~970 tokens vs new baseline-only ~515 tokens → **47% smaller**
- Case-2 currently ~586 tokens vs new ~715 tokens → 22% larger
- Case-3/4/5 each add ~200 tokens (task overlay only) vs current full-clone adding ~800+ tokens each

**Net savings grow with each new case.** With 5 cases (2+3+4+5+inbound-Carsten+inbound-stranger), current total duplicated content ≈ 4500 tokens. New baseline(515)+5 overlays(200 each)=1515 tokens. **~66% reduction** at 5 cases.

### 6.4 What's essential vs stylistic in current Case-2 overlay

| Current block | Essential to Case-2? | Recommendation |
|---|---|---|
| Goal (restaurant + date + time + tolerance) | YES — unique per call | Keep in overlay |
| Tolerance decision rules (±min → accept/decline) | YES — unique case logic | Keep in overlay |
| Hold-music 45s-then-60s | YES — Case-2-specific (restaurants use hold) | Keep in overlay |
| Clarifying-question answers (Allergien, Anlass, etc.) | YES — specific to reservation domain | Keep in overlay |
| ZWEI-FORM BESTAETIGUNG | NO — shared with all cases | **Move to baseline** |
| WERKZEUG-ZUERST | NO — shared | **Move to baseline** |
| FUELL-PHRASEN | NO — shared | **Move to baseline** |
| OFFENLEGUNG | NO — shared (LEGAL-04) | **Move to baseline** |
| "NanoClaw im Auftrag von Carsten" introduction | HALF — outbound-only but not case-specific | **Move to baseline, parameterize by call_direction** |

### 6.5 Migration plan — staged, not big-bang

**Phase 0 — Quick wins** (1 plan, <2 days work, independent of architecture refactor):
- Fix silence-monitor VAD bug: re-arm only on `output_audio_buffer.stopped` + `input_audio_buffer.speech_stopped` combo; cancel on `output_audio_buffer.started` + `input_audio_buffer.speech_started`. Add unit tests using the spike-e fixtures.
- Add role-lock clause to `OUTBOUND_PERSONA_TEMPLATE` and `CASE6B_PERSONA` and `PHASE2_PERSONA` (one copy each — it's a 5-line insert, not a refactor).
- Reduce silence round-1 interval from 10s to 8s (one const change).
- Replace `CASE2_AMD_CLASSIFIER_PROMPT` role-language ("Du bist in einem Detektions-Modus") with something that doesn't conflict with the baseline identity; e.g. prefix with "[System-Anweisung: Du bleibst NanoClaw, aber du bist gerade in einer Hoer-Phase. Sprich nicht. Emittiere nur amd_result.]"

**Phase 1 — Extract baseline** (1 plan, ~3 days):
- Add `buildBaselinePersona({callerRole, callDirection})` alongside existing constants.
- New constant is not yet used — existing Case-2 and Case-6b paths continue to work.
- Tests compare new-baseline output byte-for-byte with a concatenation of the shared sections from the three old monoliths.

**Phase 2 — Migrate Case-2 to baseline+overlay** (1 plan, ~2 days):
- Replace `buildCase2OutboundPersona` internals to assemble `buildBaselinePersona(...) + "\n\n###" + buildCase2TaskOverlay(...)`.
- Existing integration tests in `voice-bridge/tests/fixtures/spike-e/` drive golden regression.
- `webhook.ts` Case-2 branch unchanged (still calls `buildCase2OutboundPersona` with same args).

**Phase 3 — Migrate Case-6b and Phase2 to baseline** (1 plan, ~2 days):
- Same pattern — internal refactor, external API unchanged.

**Phase 4 — New cases (3/4/5) built on baseline** (per-case plans):
- Each new case ships ONLY a task overlay. No case-specific persona file.

**Phase 5 — State-graph runtime** (research phase first, then plan):
- Replace the single `openai.realtime.calls.accept(instructions=…)` at call start with an initial `accept` + a `session.update` on each state transition.
- New state machine: `LISTEN → GREET → [AMD outbound only →] CONVERSE → CONFIRM → END`.
- Per-state tool subsets (e.g., `create_calendar_entry` only available in `CONFIRM` state, not `CONVERSE`).
- Follows OpenAI Cookbook's "Dynamic Conversation Flow via session.updates" pattern with `set_conversation_state` tool.

**Regression-test fixtures to reuse:**
- `voice-bridge/tests/fixtures/spike-e/turns-*.jsonl` — 5 turn-log fixtures for replay testing.
- Existing `voice-bridge/tests/` unit tests for `silence-monitor`, `amd-classifier`, `webhook`, `persona`.
- Add a new fixture type: "silence-fixtures" with synthetic event streams (`output_audio_buffer.started`, `.stopped`, `speech_started`, `speech_stopped`) to drive §6.5 Phase 0 bug fix.

### 6.6 Open questions Carsten should answer before coding

1. **Re-prompt attempt count — 2 vs 3?** User spec says 2. Industry default is 3. Should it be tunable per-case (e.g., outbound restaurant = 2, inbound Carsten = 3 since Carsten might be distracted)?

2. **Farewell phrasing — apologetic-Sie vs casual-Du?** Current "Ich lege jetzt auf, es ist niemand mehr da" is neutral-accusatory. Proposed "Ich erreiche Sie gerade nicht, ich versuche es spaeter nochmal" is apologetic. For inbound Carsten, Du-form "Ich melde mich spaeter nochmal, Carsten — tschau!" OK?

3. **State-graph depth — are we going to Phase 5 (full state machine) or stopping at Phase 4 (baseline+overlay with a single `session.update` per call)?** Phase 5 is strictly better for large case counts but adds runtime complexity. Phase 4 gets ~66% of the benefit at ~30% of the cost.

4. **Per-call parameterization of Sie/Du** — current code picks persona based on caller number whitelist. If the baseline is parameterized by `{{anrede_form}}`, does that value come from the caller-number lookup (current behavior) or from an explicit per-call field on the outbound task / inbound webhook?

5. **gpt-realtime cost vs gpt-realtime-mini cost.** Upgrade to full happened 2026-04-21 but cost-cap gate behavior with the new per-minute rate has not been verified. Pitfall 3 in the current `webhook.ts` comment flags this. Resolve before persona refactor ships, because a cost-cap regression will mask any persona improvements.

6. **Inbound self-greet signal.** Currently a fixed 1000ms `setTimeout` after /accept. Option A: keep. Option B: wait for first RTP packet from caller side (needs new bridge signal). User's spec says "1-2 sec selbst melden" — Option A satisfies this. Decide whether Option B is worth it before persona refactor (it's orthogonal).

7. **Is `session.update` with BOTH instructions AND tools atomic on the OpenAI side?** The cookbook says "replacing the prompt and tools" but is that one atomic update or two? If not atomic, there's a brief window where the new persona sees the old tools or vice versa. This affects Phase 5 design. Verify before Phase 5 plan writes.

## References

### OpenAI (official docs + cookbook)
- Realtime Prompting Guide (the authoritative 8-section pattern): https://developers.openai.com/cookbook/examples/realtime_prompting_guide
- Realtime Server Events reference: https://developers.openai.com/api/reference/resources/realtime/server-events
- Voice Activity Detection (VAD) guide: https://platform.openai.com/docs/guides/realtime-vad + https://developers.openai.com/api/docs/guides/realtime-vad
- Realtime Conversations guide: https://platform.openai.com/docs/guides/realtime-conversations
- Voice Agents guide: https://platform.openai.com/docs/guides/voice-agents + https://developers.openai.com/api/docs/guides/voice-agents
- Realtime SIP integration: https://developers.openai.com/api/docs/guides/realtime-sip
- gpt-realtime announcement: https://openai.com/index/introducing-gpt-realtime/
- Realtime Calls API reference: https://platform.openai.com/docs/api-reference/realtime-calls

### OpenAI community / benchmarks
- gpt-realtime mini vs full difference: https://community.openai.com/t/what-is-main-difference-between-gpt-realtime-and-gpt-realtime-mini/1364101
- Role persistence in Realtime: https://community.openai.com/t/issues-with-role-persistence-and-debugging-in-the-realtime-model/1313445
- SIP initial greeting delay: https://community.openai.com/t/sip-trunking-realtime-api-call-flow-initial-greeting-delay-language-mismatch/1366626
- Simon Willison's gpt-realtime review: https://simonwillison.net/2025/Sep/1/introducing-gpt-realtime/
- InfoQ gpt-realtime benchmarks: https://www.infoq.com/news/2025/09/openai-gpt-realtime/
- Sprinklr gpt-realtime customer-support benchmark: https://www.sprinklr.com/blog/voice-bot-gpt-realtime/

### Pipecat
- UserIdleProcessor API: https://docs.pipecat.ai/server/utilities/user-idle-processor
- Pipecat Flows Types (NodeConfig): https://reference-flows.pipecat.ai/en/latest/api/pipecat_flows.types.html
- Beyond the Context Window (Flows architecture blog): https://www.daily.co/blog/beyond-the-context-window-why-your-voice-agent-needs-structure-with-pipecat-flows/
- Speech Input & Turn Detection: https://docs.pipecat.ai/pipecat/learn/speech-input

### LiveKit
- Agent session docs: https://docs.livekit.io/agents/logic/sessions/
- Events and error handling: https://docs.livekit.io/agents/build/events/
- Sequential Pipeline Architecture (blog): https://livekit.com/blog/sequential-pipeline-architecture-voice-agents
- Inactive user example: https://github.com/livekit/agents/blob/main/examples/voice_agents/inactive_user.py
- OpenAI Realtime VAD integration: https://docs.livekit.io/agents/openai/customize/turn-detection/

### Vapi
- Prompting guide: https://docs.vapi.ai/prompting-guide
- Squads overview: https://docs.vapi.ai/squads
- Handoff tool: https://docs.vapi.ai/squads/handoff

### ElevenLabs
- Conversational AI prompting guide: https://elevenlabs.io/docs/conversational-ai/best-practices/prompting-guide

### Retell AI
- Conversation Flow overview: https://www.retellai.com/blog/unlocking-complex-interactions-with-retell-ais-conversation-flow
- Single-Prompt vs Multi-Prompt research report (abovo.co): https://www.abovo.co/sean@symphony42.com/136639

### Deepgram
- Voice Agent UpdatePrompt: https://developers.deepgram.com/docs/voice-agent-update-prompt
- Voice Agent configuration: https://developers.deepgram.com/docs/configure-voice-agent

### Twilio
- Answering Machine Detection: https://www.twilio.com/docs/voice/answering-machine-detection
- AMD best practices: https://www.twilio.com/docs/voice/answering-machine-detection-faq-best-practices

### SIP / telephony background
- SIP 180 vs 183 vs early media (FreeSWITCH): https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Codecs-and-Media/Early-Media/vs-183-vs-Early-Media_7143480/
- RFC 3666 (SIP PSTN call flows): https://www.rfc-editor.org/rfc/rfc3666.txt

### Academic / research
- RoleBreak: Character Hallucination in Role-Playing Systems (arxiv): https://arxiv.org/html/2409.16727v1

## RESEARCH COMPLETE
