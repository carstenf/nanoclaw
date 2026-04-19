# Pitfalls Research — NanoClaw Voice

**Domain:** Personal German-language AI voice agent (native S2S Hot-Path + async Slow-Brain director) over Sipgate/FreeSWITCH, integrated with NanoClaw Core, under strict MOE-6 (zero unauthorized commitments), §201 StGB (no audio persistence), and cost-cap constraints.
**Researched:** 2026-04-16
**Confidence:** HIGH for items grounded in OpenAI Developer Community bug reports, FreeSWITCH GitHub issues, and published analyses of production voice-agent failures; MEDIUM for items synthesized from 2025–2026 voice-AI post-mortems without a direct NanoClaw repro; LOW (flagged explicitly) where only a single-source hypothesis exists.

**Acknowledged, not expanded (already mitigated by AC-03/04/06, Spike E, architecture decisions):**
- Pipecat orchestration (AC-03, Spike F).
- Mid-call `session.update` with `tools` field (AC-04, Sideband-WS Runde 1/2).
- Weak persona prompt (AC-06, Sideband-WS Runde 1).
- LiveKit–Sipgate REGISTER incompatibility (2026-04-12 / 2026-04-15 assessment).
- Claude in hot-path (Spike B/C, AC-02).
- Haiku 4.5 lacks prompt caching (architectural constraint).

Everything below is **new ground** — unknown-unknowns that Spike E/Sideband-WS did not cover.

---

## Critical Pitfalls

### Pitfall 1: Speculative tool calls duplicate state-mutating actions

**Severity:** Catastrophic (MOE-6 zero-tolerance violation)

**What goes wrong:**
The Director Pattern's async ergonomics make it tempting to prefetch tool results (calendar, contract, competitor offers) eagerly while the turn is still in flight. AC-009 already forbids speculative execution of write operations, but the failure mode is subtler than "pre-call a write tool." It triggers when a read-only lookup (`check_calendar`) and a mutating action (`create_calendar_entry`) share an argument hash, or when a retry path re-emits a tool-call that the Director already dispatched, or when the model retries its own function-call after a perceived no-response and the Core sees two identical `create_calendar_entry` requests 800 ms apart.

**Why it happens:**
1. OpenAI Realtime function-call emissions are not idempotent at the protocol level — the model may re-emit the same call after any perceived context gap (barge-in, filler, `response.cancel`).
2. Async director queues and the Hot-Path both hold live references to the same tool catalog; deduplication usually lives in the call site, not the tool.
3. Spike E measured `tool-turn P50 = 1598 ms` — during this window a barge-in or a silence prompt can trigger a second turn that re-invokes the same tool.

**How to avoid:**
- Every mutating tool exposed via Director Bridge **must** accept an `idempotency_key` argument and reject duplicate keys at the Core layer — not at the Director. Enforce this in the Core tool wrapper, not in voice code.
- Generate the idempotency key from `(call_id, turn_id, tool_name, argument_hash)` at the Director, not at the model.
- Keep a speculative-results shadow cache (in-memory, per-call, evicted on BYE) keyed by `(tool_name, argument_hash)` — if the model emits the same call twice, answer from cache instead of re-executing.
- Never expose `schedule_retry`, `send_discord_message`, `create_calendar_entry`, `booking_commit` as candidates for speculative pre-fetch. Mark them in the tool manifest with `idempotent=false`.

**Warning signs:**
- Core logs show two `create_calendar_entry` with identical payloads within one call_id.
- Discord receives the same escalation summary twice in < 5 s.
- User reports "I got a confirmation email twice."
- Turn-log shows `tool_call_id` repeated in consecutive `response.*` events.

**Phase to address:** Phase "Director Bridge v0" (REQ-DIR-04). Tool wrapper contract must be landed before Case 2/3 go live. Retrofitting idempotency after Cases are in prod is a rewrite.

---

### Pitfall 2: OpenAI Realtime function-call hallucination — non-existent tool names and fabricated arguments

**Severity:** Catastrophic (directly threatens MOE-6 if a hallucinated tool name returns a default-OK error the model interprets as success)

**What goes wrong:**
Independent of AC-06's "directive persona" fix, `gpt-realtime` and `gpt-realtime-mini` have been reported (OpenAI Community, multiple threads 2025–2026) to:
1. Emit function-calls for tools **not** in the session's tool list (fabricated tool names).
2. Emit correct tool names with **malformed** JSON arguments or arguments that confuse the schema (wrong types, plausible-but-wrong values).
3. Narrate tool results unnaturally ("the function returned status=ok and id=abc123"), leaking internals to the counterpart.
4. Since January 2026, a documented regression in `gpt-realtime` structured-data determinism — the model mis-quotes back facts that were in system context.

This is *orthogonal* to the AC-06 memory-hallucination failure: even a correctly prompted bot can emit an invalid function call.

**Why it happens:**
- The Realtime model's function-calling is generative, not schema-constrained server-side. The client is the last line of defense.
- Filler-phrase + `tool_choice=auto` (AC-004) makes tool-name generation a stream-of-consciousness event, not a discrete decision.
- Structured-data regression in production gpt-realtime (documented Jan–Apr 2026) hits exactly this surface.

**How to avoid:**
- At the Director, validate *every* function-call against the declared schema **and** an allowlist of tool names. Reject unknown names with a synthetic `tool_error` message that contains clear recovery guidance: *"That tool is not available. Offer a filler and ask a clarifying question."* Never auto-retry.
- For each tool, define argument-level invariants (e.g., `date` must parse as ISO-8601 after 2026-04-15, `party_size` ∈ [1,20]) and reject out-of-range values at the Director.
- Ban the model from narrating tool outputs: in persona prompt add `"Erwähne niemals Funktionsnamen, IDs oder Statuswörter wie 'status=ok' im Sprach-Output."`
- Add `verbose_tool_result_check` — before the Director commits a booking to Core, compare the model's spoken confirmation ("Ich buche also X am Freitag um 19 Uhr") to the actual tool arguments. If mismatch > tolerance, escalate and do not commit.

**Warning signs:**
- `function_call.name` in event stream is not in the declared tool list.
- JSON.parse on `arguments` throws or yields unexpected keys.
- Spoken summary and tool-args diverge (add a post-call diff check).
- Counterpart hears strings like "one moment, calling check_calendar."

**Phase to address:** Phase "Director Bridge v0" — schema validator + allowlist landed before *any* case is exposed to real counterparts. Also feeds into Phase "Persona Hardening."

---

### Pitfall 3: ASR misrecognition of German numerals and times — "17 Uhr" vs "70 Uhr", "siebzehnten" vs "siebten"

**Severity:** Severe (silent wrong-appointment creation, MOE-6 edge)

**What goes wrong:**
German spoken numerals and dates are phonetically dense and easily confused, especially over G.711 PCMU on Sipgate (narrowband, ~300–3400 Hz):
- "siebzehn" (17) ↔ "siebzig" (70) — stress pattern near-identical on poor lines.
- "siebten" (7th) ↔ "siebzehnten" (17th) — trailing syllable often clipped by VAD.
- "fünfundzwanzig" vs "fünfzig" — when the counterpart speaks quickly, the first two syllables dominate.
- Date formats: "am fünften Fünften" (5.5.), "am fünfzehnten Fünften" (15.5.) — endpointing commonly truncates.
- Phone numbers: "null drei null" (030) vs "null drei null null" (0300).

The bot confidently repeats the wrong value back, the counterpart doesn't notice (because the bot's repeat *also* sounds plausible), and a calendar entry is created for the wrong date/time.

Published 2025–2026 analyses (Hamming AI, Bluejay, Gladia, FutureAGI) explicitly call out number/time substitution as one of the top production failure modes — "substitutions sound plausible and look grammatically correct, but they reverse or distort user intent."

**Why it happens:**
- Realtime models do "voice → intent" end-to-end; there is no intermediate phoneme-level ASR you can confidence-score.
- PCMU at 8 kHz aggressively filters consonant transitions — the very features that disambiguate "siebzehn" from "siebzig."
- The model's repeat-back ("Also am siebzehnten Mai um 17 Uhr") generates plausible German from context; if the model's internal belief is wrong, the repeat reinforces the wrong value.

**How to avoid:**
- **Two-slot confirmation for all time/date/number values in verbindliche Aktionen (REQ-C2-05, C3-06, C6-03):** require the bot to say the value in *two forms* and wait for explicit agreement. E.g., *"Am Dienstag, dem siebzehnten Mai — das ist der 17.5. — um 17 Uhr, also fünf Uhr nachmittags. Korrekt?"* This makes misrecognition audible to the counterpart.
- Enforce structured post-call diff: `create_calendar_entry(date=X)` must match a transcript-search for X in both numeric and word form. If neither is present, escalate.
- For phone-number capture (Case 4 callback): always digit-by-digit readback, never block-form.
- Add a per-tool `confirmation_required: "strict" | "implicit"` flag in the tool manifest; `strict` forces the bot to obtain a verbal confirmation before committing.

**Warning signs:**
- Transcript contains no numeric form (only word form) when a number was expected.
- Confirm-repeat phrase and tool-argument differ when post-call diffed.
- Counterpart says "wie bitte?" more than twice in the same exchange.
- Post-call Discord summary shows a slot 10×, 100×, or /10 of the intended value (magnitude error).

**Phase to address:** Phase "Persona Hardening" — the two-form readback is a prompt pattern. Phase "Director Bridge v0" — the post-call diff and tool-arg validation. Pre-requisite for Case 2/3 go-live.

---

### Pitfall 4: OpenAI ZDR audit gap — the feature is off by default, not obviously visible, and has background-mode exceptions

**Severity:** Severe (direct §201 StGB / REQ-INFRA-10 violation path)

**What goes wrong:**
ZDR is not a simple toggle. In the OpenAI Developer Community (2025–2026) and Azure docs:
1. ZDR enrollment requires an MAR (Microsoft/OpenAI account review) or enterprise negotiation — not a self-service setting for most accounts.
2. ContentLogging=false at deployment level does **not** confirm full ZDR — it only disables logging, not retention for abuse monitoring.
3. Background-mode requests (non-Realtime) retain ~10 min for polling even under ZDR.
4. CSAM classifier triggers retention even with ZDR enabled.
5. No programmatic "am I actually ZDR?" endpoint — the only verification is a screenshot of Account Settings.

For NanoClaw, MOS-6 / REQ-INFRA-10 promises "0 Bytes on disk ever, forever." If ZDR is *not actually active* on `proj_4tEBz3XjO4gwM5hyrvsxLM8E`, the system silently violates §201 StGB the first time a counterpart speaks.

**Why it happens:**
- ZDR looks enabled because API accepts requests identically either way — no runtime signal of retention status.
- Setting ZDR is a one-time email negotiation; the outcome is documented only in an email thread.
- Account rotation or project re-creation silently resets ZDR.

**How to avoid:**
- Ship a `zdr_verify` operational check (script + cron) that: (a) attempts a request with `data_retention: zero` metadata flag; (b) pulls account settings via the OpenAI management API where possible; (c) compares against a pinned screenshot hash stored in `voice-channel-spec/evidence/zdr/YYYY-MM-DD.png`. Fail CI if the hash hasn't been refreshed in 30 days.
- Make ZDR status a **gate** in the monthly filesystem audit — if unverified-in-last-30-days, pause the channel.
- Never onboard a new OpenAI project without a documented ZDR confirmation email archived in the state-repo under `legal-evidence/openai-zdr/`.
- For extra-paranoid compliance: add a secondary check that `sip.api.openai.com` TLS-session is against an endpoint in the ZDR-eligible region list.

**Warning signs:**
- OpenAI dashboard shows "default retention: 30 days" for the project.
- No ZDR confirmation email in `legal-evidence/openai-zdr/`.
- Monthly audit log has an "unverified" entry.
- A counterpart asks for "Aufzeichnung zu Beweiszwecken" and system has no defensible answer.

**Phase to address:** Phase "Pre-Production Legal Gate" (before *any* real counterpart is dialed). Also gates first outbound in Case 2. Block Phase "Case 2 MVP" on completion.

---

### Pitfall 5: Counterpart on speakerphone, background third party audible — §201 StGB extension to unconsenting third party

**Severity:** Severe (criminal liability — §201 StGB applies to *any* non-public speech captured, not just the call partner's)

**What goes wrong:**
The counterpart at a hotel reception, doctor's office, or family home puts the call on speakerphone. A colleague, patient, or family member says something audible in the background — "wer ist das denn?", a medical complaint, a personal detail. The NanoBot captures that audio through its in-flight processing pipeline. German case law (BAG 23.4.2009 - 6 AZR 189/08, plus the Constitutional Court decision 1 BvR 975/25 from 2025-07-09 cited in 2025 lexicon sources) treats unnoticed speakerphone listening-in as a §201 violation — the third party never consented to being captured by the AI-processing chain.

Carsten's Disclosure-Strategy (REQ-DISC-01/02, passive — answer truthfully only if asked) *does not cover* a third party who was never a participant.

**Why it happens:**
- Speakerphone detection is not a feature in OpenAI Realtime; the audio just arrives.
- Private-use-exception (DSGVO Haushaltsausnahme) is narrowly interpreted when the *counterpart* is in a professional context with third-party presence.
- Even in-RAM-only processing constitutes "aufnehmen" under some §201 readings if it is *acted on* by automated systems.

**How to avoid:**
- **This is a legal research item, not a technical one.** Before Case 2/3 go live, obtain a written legal opinion (German telecoms lawyer specializing in AI-voice, e.g., HÄRTING or LUTZ|ABEL — both published on voice-bot compliance) on whether private-use RAM-only processing via a personal agent falls under the Haushaltsausnahme even when the counterpart is a business.
- Technical mitigation (harm reduction, not immunity):
  - If post-call transcript review detects >1 distinct voice on the counterpart leg (voice-embedding clustering, done async post-call), redact the non-primary voice segments from any persisted transcript-summary before it reaches Core memory.
  - Add a reactive script: if counterpart says *"Moment, ich stell mal auf Lauthörer"* or *"ist jemand mit?"*, the bot says *"Dann rufe ich später nochmal an, Herr Freek meldet sich selbst"* and disconnects.
- Add to persona prompt: *"Wenn im Hintergrund weitere Personen hörbar werden oder Lauthörer angekündigt wird, leite ab: 'Herr Freek meldet sich persönlich, vielen Dank.' und beende den Call."*

**Warning signs:**
- Transcript has multiple speakers tagged on the counterpart side.
- Explicit speakerphone phrases in counterpart transcript.
- Counterpart background volume/reverb signature changes mid-call (hard to detect programmatically; rely on phrase detection).
- Post-call voice clustering detects second consistent speaker.

**Phase to address:** Phase "Pre-Production Legal Gate" (legal opinion) + Phase "Persona Hardening" (reactive disconnect phrases). Must land before Case 2/3 outbound. This is the most underexplored legal edge in the spec.

---

### Pitfall 6: Warm-keepalive + IVR-hold + voicemail tree = silent cost runaway

**Severity:** Severe (cost cap bypass, MOS-2)

**What goes wrong:**
Three cost-blowup patterns, none caught by per-minute minute-based cap alone:

1. **Voicemail loop (Case 2/3 outbound, retry strategy):** NanoBot dials, reaches the restaurant's voicemail (*"Sie haben die Mailbox erreicht, bitte sprechen Sie nach dem Ton..."*), bot interprets it as a human asking a question, answers, voicemail records the answer, disconnects after 30s. Retry strategy fires 5 min later. Cycle repeats until max retries. Each call consumes 30 s of gpt-realtime-mini tokens at ~€0.006/30s = negligible *per call*, but 10 retries × 3 days × 5 restaurants = hidden €0.90 and 150 wasted minutes.

2. **IVR hold-music passive-wait (REQ-C3-02):** The requirement is *"remain passively without incurring LLM inference costs until human speech is detected."* Implementation gap: OpenAI Realtime does NOT have a "pause inference" primitive. Any audio hitting the mic triggers VAD → triggers response-generation → costs tokens. If hold music has any spectral energy in voice band (most does, royalty-free instrumental music is worst), the bot generates a response every 5–15 s while waiting.

3. **Warm-keepalive fault (Chat-Supervisor pattern AC-004):** If Spike E's keepalive strategy leaves a session alive after BYE (e.g., WebSocket not closed, session garbage collected late), the session continues to incur background inference charges until OpenAI's 60-min session cap. A single forgotten session = €0.50 (mini) to €3 (full).

**Why it happens:**
- gpt-realtime-mini VAD fires on any voiceband audio, including hold music and voicemail greetings.
- There is no "is this a human" primitive — the model must *decide* each time, which costs tokens.
- Session-teardown bugs are classic in WebSocket-based systems; the symptom is silence + unexpected invoice.

**How to avoid:**
- **Voicemail detection as first-turn gate:** The first 5 seconds of a fresh outbound call runs a classifier (either a cheap regex over the first transcript-delta, or — cheaper — a lookup of known voicemail phrases: *"Mailbox", "Sie haben", "nach dem Signalton", "ist gerade nicht erreichbar"*). On match, hang up immediately with no response. Never speak. Cost: <€0.01 per detected voicemail.
- **Hold-music detection:** If the last 30 s of audio has >15 s of "response-unaware chatter" (bot spoke and got no structured answer twice), auto-mute the bot (set `tool_choice=none` + suppress `response.create`). Resume on detected human speech features (consonant-cluster density, pitch contour).
- **Hard session-teardown check:** After every BYE, emit a `session.close` and assert in the Director that `session.closed` event arrives within 2 s. If not, escalate to a kill-timer that force-closes at 5 s. Log a monitoring metric `lingering_sessions_total`.
- **Cost cap enforcement at session level, not call level:** Track OpenAI usage per session_id in real-time via Director; if session > €0.80 (below €1 per-call cap), inject a polite-farewell prompt via `session.instructions` and hang up.

**Warning signs:**
- Call duration > 5 min with no counterpart words captured in transcript → hold music or voicemail stuck.
- Retry scheduler has >10 attempts to same number in a day.
- Daily cost climbs steeply on days with many failed outbound attempts.
- Monitoring shows active WebSocket sessions when no calls are bridged.

**Phase to address:** Phase "Case 2 MVP" (voicemail-detection first-turn gate — this gates Case 2 go-live). Phase "Case 3 MVP" (hold-music detection + pause). Phase "Director Bridge v0" (session-teardown assertion). Cost-cap per session: Phase "Observability v0".

---

## Severe Pitfalls

### Pitfall 7: FreeSWITCH ↔ sip.api.openai.com SDP/codec edge cases post-reINVITE

**Severity:** Severe (call drops mid-conversation, counterpart hears silence or disconnect)

**What goes wrong:**
Spike V8 Etappe A/C / E validated the *initial* codec negotiation (PCMU exclusive, REQ-SIP-04). Three known reINVITE edge cases have surfaced in the OpenAI community (2025–2026):
1. OpenAI sends `Contact` header without `transport=tls`; some SIP stacks reject on re-registration or refresh (fix deployed, but regression-prone).
2. Asterisk reported `200 OK` without `Content-Type: application/sdp` on certain response paths — FreeSWITCH has different parsers but the same class of bug is possible on codec renegotiation.
3. RFC 2833 DTMF payload-type mismatch is a recurring FreeSWITCH bug on B-leg with Opus (NanoClaw uses PCMU, but payload-type negotiation has analog failure modes).

If Sipgate or OpenAI sends a mid-call reINVITE (e.g., for codec change, hold/resume, or path refresh), FreeSWITCH might reject → call drops or audio stops.

**Why it happens:**
- SIP reINVITE is rare in everyday calls but fires on: hold/resume, network-path change (counterpart moves WiFi → LTE), or Sipgate-side call-parking.
- OpenAI SIP stack is young; edge-case coverage is improving but incomplete.
- PCMU payload-type 0 is stable, but negotiation extension headers vary.

**How to avoid:**
- Dedicated reINVITE-handling test in pre-prod: call the NanoBot, counterpart puts the call on hold on their phone, resumes 30 s later. Audio must resume both directions.
- FreeSWITCH verbose SIP logging (`sip_trace=on`) for the first 30 days of production. Parse and alert on any `SIP/2.0 4xx` or `5xx` during active media.
- Force `single_codec=true` and pin PCMU payload type 0 in the dialplan. Do not accept codec changes mid-call (reject with 488 Not Acceptable).
- Monitor a `reinvite_failures_total` metric.

**Warning signs:**
- Counterpart reports "suddenly went silent."
- FreeSWITCH log shows `Codec negotiation failed` after a `reINVITE`.
- Hetzner tcpdump shows SDP offers with codecs other than PCMU.

**Phase to address:** Phase "SIP Hardening" (post-Case 2 MVP, before Case 4 inbound). Not a blocker for Case 6 (internal, not dependent on counterpart mobility).

---

### Pitfall 8: WireGuard tunnel flap during active call — one-way audio or disconnect

**Severity:** Severe (counterpart hears silence, possibly unauthorized-commitment path if model "assumes" acknowledgment)

**What goes wrong:**
The Hetzner ↔ Lenovo1 WireGuard tunnel (REQ-INFRA-03) is architectural assumption A4. A tunnel flap (MTU-related re-negotiation, packet loss spike, keepalive failure on mobile carrier → Hetzner path) typically causes:
1. **One-way audio** — FreeSWITCH and OpenAI still talk, but Director Bridge (on Lenovo1) stops receiving transcript events and tool-call requests. Hot-path continues "blind" — bot answers from persona prompt alone with no tool-call ability.
2. **Full media drop** — counterpart hears 5–30 s of silence before RTP recovers or call times out.
3. Sessions documented in VoIP/WireGuard forums (Netgate, OpenWrt, GL.iNet, 3CX, FreePBX) consistently show that WireGuard one-way-audio is the top VoIP-over-WG complaint, usually MTU or NAT-mapping related.

REQ-INFRA-11 says "the Hot-Path shall continue unaffected" — but the bot's silence to the counterpart is worse than the bot saying "Einen Moment, ich muss etwas prüfen" and hanging up cleanly.

**Why it happens:**
- WireGuard default MTU is 1420; if the underlying path has lower MTU (mobile, some Hetzner paths), SIP signaling may squeak through but RTP bursts fragment and drop.
- RTP traffic path (Sipgate → Hetzner) does not traverse the tunnel, but the *control* path (Hetzner FreeSWITCH ↔ Lenovo1 Director) does. Partial failures are the common case, not total.

**How to avoid:**
- Set WireGuard MTU explicitly to 1380 on both ends. Document in `hetzner-mcp-architecture.md`.
- Add heartbeat: Director Bridge sends a no-op `session.instructions` (ping) every 3 s during active call. If no ACK for 5 s: assume tunnel down, trigger graceful hang-up with *"Die Verbindung ist instabil, Herr Freek meldet sich später — bis dann."*
- Never architect the Hot-Path to depend synchronously on Lenovo1. The AC-002 already handles Claude, but ensure `gpt-realtime-mini` has enough pre-loaded context (AC-005) to respond to 60 s of conversation without *any* tool calls, just in case.
- Build a `tunnel_down_during_call` dashboard metric; fire Discord alert on detection.

**Warning signs:**
- `wg` stats show handshake > 180 s ago during active call.
- Director Bridge logs "no transcript events for >10 s."
- Counterpart reports "I couldn't hear anything for a bit."
- RTP jitter spikes on Hetzner side.

**Phase to address:** Phase "Infra Hardening" (concurrent with Case 2 MVP — MTU fix is trivial, heartbeat is one file). Before any Case 4 exposure.

---

### Pitfall 9: DTMF / IVR "press 1 for..." — Realtime has no native DTMF, only text injection

**Severity:** Severe (Case 3 practice-IVR navigation will fail silently)

**What goes wrong:**
Case 3 (Arzt/Friseur-Termin) regularly hits IVRs: *"Für Terminvergabe drücken Sie die 1, für Rezepte die 2..."*. OpenAI Realtime does not send DTMF natively — the community-documented pattern is:
1. Client intercepts `function_call` named `send_dtmf(digit: str)` (custom tool).
2. Client converts digit to RFC 4733 RTP-events (or SIP INFO) and injects into the outbound RTP stream.
3. FreeSWITCH dialplan must support `uuid_send_dtmf` or similar, AND the SDP must have negotiated `telephone-event` payload type 101.

Known pitfalls in this chain:
- OpenAI cannot *receive* inbound DTMF either — counterpart pressing a key is inaudible to the model (not all IVRs are relevant to outbound, but Carsten might use DTMF during Case 6b to "press 1 to wake Carsten up" from a different phone).
- RFC 2833 vs RFC 4733 vs SIP INFO vs inband — Sipgate negotiates one; OpenAI+FreeSWITCH must match. Mismatch = DTMF lost.
- FreeSWITCH issue #1763 (RFC2833 payload-type) and #1937 (DTMF-when-RFC2833-enabled) are active bugs.

**Why it happens:**
- DTMF is out-of-band signaling in VoIP; S2S models don't "see" it in the audio stream.
- OpenAI Realtime was built for conversational use, not IVR traversal.
- FreeSWITCH DTMF handling has historical complexity; the default dialplan works for most cases but IVR navigation needs explicit mod_dptools setup.

**How to avoid:**
- Declare DTMF navigation **out of scope for v1** (Case 3 IVRs that require DTMF → escalate to Carsten via Discord).
- If later needed: implement `send_dtmf` function tool + test against a Sipgate IVR-echo number end-to-end. Pin `telephone-event/8000` PT=101 in SDP.
- For inbound DTMF (Case 6b hotword alternative): use a dedicated SIP leg, not through OpenAI Realtime.
- Document explicitly in REQ-SIP: "DTMF navigation deferred to v2 unless blocking."

**Warning signs:**
- Case 3 call logs show bot saying "nothing happened" after reading menu options aloud.
- Practice call ended without reaching human (IVR treadmill).
- Counterpart (IVR-recording) did not advance.

**Phase to address:** Phase "Case 3 Scoping" — decide defer or build. Defer is strongly recommended for v1.

---

### Pitfall 10: Barge-in false positives from non-speech (cough, "mhm", background noise) on PCMU narrowband

**Severity:** Moderate-to-Severe (feels like the bot cuts you off; LQI impact; can cascade into repeated mis-turns)

**What goes wrong:**
Barge-in cancels current TTS within 200 ms of VAD-detected speech (REQ-VOICE-05). `server_vad` is energy-based. On PCMU 8 kHz:
- A cough, throat-clear, "mhm" acknowledgment, a door slam, HVAC noise all trigger VAD above the default 0.3 threshold.
- Published voice-AI analyses (Hamming, AssemblyAI, LiveKit, Speechmatics, Picovoice) consistently report that default VAD is too aggressive; 0.5–0.6 is the production sweet spot.
- 2024–2026 research: background voice cancellation (Krisp) reduces false-positive triggers 3.5× on average.
- Elderly users pause 5–8 s mid-thought — REQ-VOICE-08 fires "Sind Sie noch da?" after 10 s, but if a cough triggers during that pause, the bot interrupts with a response, the counterpart now has to re-orient, compounds cognitive load.

**Why it happens:**
- OpenAI Realtime default VAD is tuned for English / wideband / headset scenarios, not PCMU narrowband over PSTN.
- Consonants that disambiguate speech from noise are the first casualties of PCMU.
- No first-class "ignore this" for utterances < 300 ms.

**How to avoid:**
- Raise `server_vad.threshold` to 0.55–0.60 in session config.
- Raise `server_vad.silence_duration_ms` to 700 ms (default typically 500). Protects against mid-sentence pauses.
- Add minimum-utterance-length gate: ignore VAD events < 250 ms (via custom Director post-processing of the `input_audio_buffer.speech_started` → `speech_stopped` pair).
- For REQ-VOICE-08 specifically: if barge-in fires during the 10 s silence window, do not reset the timer — treat the short utterance as part of the silence ("mhm" is acknowledgment, not re-engagement).
- Test protocol: record yourself coughing, saying "mhm", clearing throat, door-slam behind you. Measure false-barge rate < 5% before go-live.

**Warning signs:**
- Turn log shows `response.cancel` emitted, then same response regenerated within 1 s (bot cut itself off, resumed).
- MOS-1 latency looks fine but user reports "it keeps interrupting me."
- LQI drops after go-live despite MOS-1 green.

**Phase to address:** Phase "VAD Calibration" (concurrent with Spike E follow-up, before Case 2 go-live). Test fixture landed in Phase "Case 2 MVP."

---

### Pitfall 11: Cross-channel consistency drift — Core confirmation written, TTS announcement failed (or vice versa)

**Severity:** Severe (MOE-5 violation + counterpart gets contradictory signal)

**What goes wrong:**
Three failure modes of the tool-call → voice-confirmation chain:
1. **Tool-call succeeds, voice confirmation fails:** `create_calendar_entry` returns 200, but the model crashes before speaking the confirm phrase (rate-limit hit, connection blip). Counterpart never hears "Reservierung bestätigt für Freitag", but the calendar entry exists. Counterpart re-dials thinking it didn't work → double reservation.
2. **Voice says done, tool-call pending:** Model speaks *"So, gebucht für Sie"* while the async Director is still retrying `create_calendar_entry` after a WireGuard blip. Timeout hits, tool returns error, nothing in calendar. Counterpart thinks it's done. Carsten shows up to the restaurant.
3. **Discord notification lost or duplicated:** REQ-TOOLS-06 `send_discord_message` is fire-and-forget. Core outage = summary lost. Discord rate-limit + retry without idempotency = summary twice. Carsten doesn't trust the channel → manual double-check every time → LQI tanks.

**Why it happens:**
- Tool-call execution and TTS output are independent async streams.
- No commit-log bridging the two; no saga/transaction.
- Discord API has its own rate-limit and retry semantics.

**How to avoid:**
- **Two-phase commit pattern for verbindliche Aktionen:** (a) Model speaks *"Einen Moment, ich notiere..."* → (b) Director calls tool → (c) Director injects tool-result via `session.instructions` → (d) Model speaks confirm phrase mentioning a unique confirmation-id → (e) Post-call, Director verifies transcript contains the confirmation-id; if not, resends Discord summary with `[UNCONFIRMED]` marker.
- Every Director-side tool call logs `{tool_name, args, result, spoken_confirmation_phrase, spoken_confirmation_id}` to a tamper-evident per-call log. Monthly audit cross-checks Core state vs. voice-log.
- Discord messages include an idempotency key (`call_id + tool_result_hash`). Core `send_discord_message` wrapper deduplicates.
- Post-call reconciliation job: for every Case 2/3 call with a `create_calendar_entry`, verify entry exists + Discord notification sent + transcript mentions confirmation. Any 2-of-3 inconsistency → Carsten alert.

**Warning signs:**
- Calendar entry exists with no matching Discord summary.
- Discord summary exists with no matching calendar entry.
- User reports "I got two emails" or "I showed up but nothing was booked."
- Post-call audit finds `spoken_confirmation != tool_confirmation_id`.

**Phase to address:** Phase "Director Bridge v0" (two-phase commit). Phase "Observability v0" (reconciliation job). Before first Case 2 outbound with real counterpart.

---

### Pitfall 12: Language drift mid-call — model switches to English triggered by counterpart name, loanword, or schema field

**Severity:** Moderate (breaks conversation flow, may cause counterpart to distrust / hang up)

**What goes wrong:**
OpenAI Realtime Prompting Guide (2025–2026) explicitly documents "control language by pinning output to a target language if you see drift." Reported triggers:
- Counterpart's name sounds non-German (*"Anastasia"* → Russian; *"Amir"* → Arabic; *"Alina"* → Italian in reported cases).
- Tool JSON schema field names in English (`available: bool`, `conflicts: string[]`) leak into the model's language state.
- Tool result strings in English (e.g., competitor offer from `search_competitors` returns vendor name with English tagline).

Model suddenly speaks English or mixed language, counterpart confused, call fails.

**Why it happens:**
- Realtime models are multilingual by default; language-selection is probabilistic, not pinned.
- Tool schemas and results are strings — they enter the context and can shift language distribution.
- AC-05 (pre-load context) includes Core data that might be stored in mixed language.

**How to avoid:**
- Persona prompt: add `"Du sprichst AUSSCHLIESSLICH Deutsch. Auch wenn Tool-Ergebnisse oder Namen in anderen Sprachen enthalten sind, antwortest du immer auf Deutsch."` as first line of persona.
- Tool schemas: use German field names where possible, or document fields with German descriptions.
- Tool results: pre-translate English tool output to German at the Director layer before injecting via `session.instructions`.
- Monitoring: alert if > 3 consecutive non-German tokens detected in assistant output of an active call.

**Warning signs:**
- Transcript shows assistant tokens in English/mixed language.
- Counterpart says *"Sprechen Sie Deutsch?"* or hangs up after an English token.
- Language-drift events concentrated around tool-call turns.

**Phase to address:** Phase "Persona Hardening" + Phase "Director Bridge v0" (translate-at-Director pattern). Before Case 2 go-live.

---

## Moderate Pitfalls

### Pitfall 13: Webhook retry / duplicate `realtime.call.incoming` — dual-session race

**Severity:** Moderate (can create duplicate session but is self-limiting in cost)

**What goes wrong:**
OpenAI Realtime call incoming webhook follows Standard Webhooks semantics: retries for 72 h on non-2xx or timeout. In rare cases, OpenAI delivers duplicates. If the sip-to-ai handler responds slowly to a duplicate, two sessions accept the same SIP call leg — race on `realtime.calls.accept()`.

Additionally: INVITE → `realtime.call.incoming` delay has been reported as 3–5 s (sometimes 7 s) in the OpenAI community — this breaks REQ-SIP-03's 500 ms bridge target and may cause Sipgate to retransmit INVITE (which can trigger duplicate webhooks).

**How to avoid:**
- Idempotency on `webhook-id` header; dedupe at sip-to-ai. Reject duplicates with 200 OK (so OpenAI doesn't retry).
- Signature verification using official SDK `unwrap()` method.
- Respond to webhook within 2 s; process accept asynchronously.
- Instrument and alert on `INVITE → incoming_webhook > 2 s` — this is an OpenAI-side issue; document as AC-010 input.

**Warning signs:**
- FreeSWITCH logs two INVITE retransmits before 200 OK.
- sip-to-ai accepts same `call_id` twice.
- Ringing delay > 3 s consistently.

**Phase to address:** Phase "SIP Hardening" (webhook dedup + signature). Document Realtime-side latency for v2 Architecture Review.

---

### Pitfall 14: OpenAI Realtime mid-call rate-limit (429) — audio stops, counterpart hears silence

**Severity:** Moderate (rare for single-user low-volume, but catastrophic per-incident)

**What goes wrong:**
429 rate-limit mid-call means the model stops emitting audio_delta. Counterpart hears silence → confusion → hang up. For single-user Carsten scenarios, concurrent call limit should never hit, but TPM (tokens-per-minute) limit *can* hit during a long Case 4 negotiation (30 min × heavy function-calling).

OpenAI community reports 429s triggered by bursts that don't appear rate-abusive on the dashboard. The Realtime API uses separate rate limits from Chat Completions.

**How to avoid:**
- Pre-negotiate higher TPM for the OpenAI project; document in `voice-channel-spec/openai-account.md`.
- Monitor token-usage rate per minute; alert at 70% of limit.
- On 429 mid-call: inject via `session.instructions` a scripted closing phrase and hang up — do not retry (retry compounds the problem).
- Implement exponential backoff at the SIP layer (reject new outbound for 60 s after a 429).

**Warning signs:**
- Dashboard shows rate-limit warnings.
- Call drops with "429" in logs.
- User reports "bot went silent at minute 12."

**Phase to address:** Phase "Observability v0" (token-rate monitoring). Phase "Cost Hardening" (alerting). Not blocking for Case 2 MVP.

---

### Pitfall 15: Silence-prompt "Sind Sie noch da?" is rude to elderly or contemplative counterparts

**Severity:** Moderate (LQI / MOE-2 impact, not safety)

**What goes wrong:**
REQ-VOICE-08 fires after 10 s of silence. Production voice-agent research recommends 8–10 s for Q&A, 15–20 s for thoughtful/technical contexts. Case 3 (Arzt-Termin) and Case 4 (Vertrieb negotiation) frequently have 8–12 s "let me check the calendar" pauses — bot prompts "Sind Sie noch da?" → counterpart offended → session thematized.

Elderly counterparts (Carsten's parents calling the practice on his behalf, or a practice MFA who is 60+) routinely pause 5–10 s mid-sentence.

**How to avoid:**
- Raise REQ-VOICE-08 timeout to 15 s for Case 3/4, keep 10 s for Case 2 (quick restaurant Q&A).
- Change the prompt from "Sind Sie noch da?" to "Kein Stress, ich warte gerne" — reframes as patient, not impatient.
- Phase 2: Use conversation-state-aware dynamic timeout — after the counterpart asked "lassen Sie mich kurz schauen", extend silence threshold to 30 s.

**Warning signs:**
- Transcript shows counterpart responded to "Sind Sie noch da?" with *"Ja warten Sie doch mal!"* or similar friction marker.
- MOE-2 (thematization rate) above target despite other controls green.

**Phase to address:** Phase "Persona Hardening" (tunable per Case). Phase "Adaptive Dialog v1" (context-aware timeout).

---

### Pitfall 16: OpenAI billing reconciliation drift — per-call cost attribution gaps

**Severity:** Moderate (undermines MOS-2 enforcement, not safety)

**What goes wrong:**
OpenAI billing is:
- Aggregated per-project, not per-call.
- Usage-dashboard delay is 1–24 h.
- Audio input/output tokens billed separately from text; VAD time is not directly attributed.
- Monthly invoice may differ 5–15% from sum-of-per-call estimates due to rounding, session-keepalive overhead, and partial-token billing.

If NanoClaw's per-call cost tracking (REQ-INFRA-06 hard-cap €1/call) uses dashboard data, there's a 1–24 h lag — a runaway call can blow through €10 before the cap triggers.

**How to avoid:**
- Track cost in real-time via Realtime API's `usage` event (emitted per `response.done`) — accumulate into per-call state at Director, not dashboard.
- Reconcile monthly sum-of-per-call vs. dashboard invoice; if drift > 10%, investigate (missing sessions, forgotten keepalives).
- Document the reconciliation check as a monthly ops task in `voice-channel-spec/operations.md`.

**Warning signs:**
- Dashboard shows €15 for a month but sum-of-call-logs shows €8.
- Hard-cap never trips despite dashboard showing €1+ per call.

**Phase to address:** Phase "Observability v0" (usage-event accumulator). Phase "Ops v1" (monthly reconciliation).

---

## Minor Pitfalls

### Pitfall 17: Filler-phrase cost and unnaturalness
`gpt-realtime-1.5` has been reported to speak tool-call parameters unnaturally ("the function check_calendar returned..."). Persona prompt must include: "Never verbalize tool names, parameters, or statuses. Use natural filler like 'Einen Moment...' only." Phase: "Persona Hardening."

### Pitfall 18: Realtime API SDK "sorry state" — conflicting docs, schema changes
OpenAI community thread "The sorry state of the Realtime SDK" documents schema churn (2025–2026). Pin SDK version in container lockfile; update only with regression-test pass. Phase: "Director Bridge v0."

### Pitfall 19: OpenAI voice selection drift
Model can occasionally switch voice mid-call if `session.update` is issued imprecisely. Always set voice once at `calls.accept` and never mutate. Phase: "Persona Hardening."

### Pitfall 20: Session-expiry boundary at 60 min (new limit) — Case 4 negotiations can approach it
60-min hard limit (OpenAI raised from 30 min in Sept 2025). Case 4 Telekom-negotiations typically 20–40 min but edge cases exist. Plan a graceful wrap-up at 50 min. Phase: "Case 4 MVP."

### Pitfall 21: FreeSWITCH DTMF when RFC2833 enabled silently drops digits (Issue #1937)
If DTMF is ever needed, verify FreeSWITCH version is not affected. Phase: only if DTMF in-scope.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip idempotency keys on mutating tools in MVP | Faster Case 2 launch | First duplicate booking = MOE-6 incident, manual refund | **Never** — write side MUST be idempotent from day 1 |
| Rely on OpenAI dashboard for cost-cap | Skip building usage accumulator | Runaway call costs 10–20× cap before detection | Never for hard cap; acceptable for monthly reporting |
| Single-phase commit (speak confirmation before tool-call returns) | Feels snappier | Unauthorized commitment on tool-failure | Never for Case 1/2/3/4 verbindliche Aktionen; OK for Case 6 conversational confirmations |
| Skip legal opinion on speakerphone/third-party §201 | Unblocks Case 2/3 | Criminal liability if counterpart has bystander | **Never** — written opinion before first real outbound |
| Default OpenAI VAD threshold 0.3 | Works in Spike E | Barge-in storms in production | Acceptable only for Spike F-style internal tests |
| Plain `send_discord_message` without dedup | Ship sooner | Duplicate/lost summaries erode LQI | OK for debug channel; never for user-facing |
| Single-voice detection (ignore speakerphone cue phrases) | No code needed | §201 third-party risk | **Never** for Case 2/3/4 with business counterparts |
| Skip ZDR verification screenshot archive | Saves 30 min/mo | Defenseless if audited | **Never** for monthly audit |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| OpenAI Realtime | Using `tool_choice=required` for filler | Use `tool_choice=auto` + persona filler prompt (AC-004) |
| OpenAI Realtime | Mutating tool list mid-call | Set once at `calls.accept`, never touch (AC-04) |
| OpenAI Realtime | Assuming function-call names are valid | Validate against allowlist at Director (Pitfall 2) |
| OpenAI Realtime | Trusting dashboard for real-time cost | Accumulate from `usage` events (Pitfall 16) |
| OpenAI Realtime | Auto-retry on 429 mid-call | Graceful hang-up, no retry (Pitfall 14) |
| OpenAI Realtime SIP | No signature verification on webhook | Use SDK `unwrap()` (Pitfall 13) |
| OpenAI Realtime SIP | Accepting codec renegotiation mid-call | `single_codec=true`, reject reINVITE with 488 (Pitfall 7) |
| Sipgate | Assuming DTMF passthrough | DTMF needs explicit `telephone-event` PT=101 in SDP (Pitfall 9) |
| FreeSWITCH | Default `sip_trace=off` in prod | Enable for first 30 days; alert on 4xx/5xx during media |
| WireGuard | Default MTU 1420 | Set to 1380 explicitly both ends (Pitfall 8) |
| Core (NanoClaw) | Fire-and-forget Discord notification | Idempotency key on `send_discord_message` (Pitfall 11) |
| Core (NanoClaw) | Not logging `spoken_confirmation_id` | Persist for post-call reconciliation (Pitfall 11) |
| ZDR | Trust account-level setting | Pin screenshot + programmatic verify monthly (Pitfall 4) |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Warm-session not torn down on BYE | `lingering_sessions_total` > 0, invoice spike | Assert `session.closed` within 2 s; kill-timer at 5 s | Any hung WebSocket across Hetzner/Lenovo1 |
| VAD too sensitive on PCMU | LQI drops, "it keeps interrupting me" | Threshold 0.55+; min-utterance 250 ms | Any realistic acoustic environment |
| Silence-prompt timer fires during filler-thinking | Counterpart friction, MOE-2 up | 15 s threshold in Case 3/4; reframe prompt | Elderly or contemplative counterparts |
| Hold-music triggers inference loop | Per-call cost spikes 3–5× | Auto-mute on response-unaware-chatter pattern | Any IVR wait > 60 s |
| Voicemail detected as human | Retry loop, cost accumulation | First-turn voicemail-phrase gate | Restaurant/practice voicemails outside business hours |
| Tool-call loop during tunnel flap | Director retries, Core overloaded | Tunnel heartbeat + graceful hang-up | Any WireGuard re-handshake |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Trusting `Caller-ID` for Case 6 routing (REQ-SIP-08) | CLI spoofing → attacker gets NanoBot Core access | Additional voice-codeword step for Case 6 from non-whitelisted network paths |
| Whitelisted Case 4 inbound accepts any caller claiming whitelisted provider | Phishing — fake "Telekom" calls, NanoBot discloses data | Cross-check counterpart ID claims against Core contract repo before any data disclosure (already in REQ-C4-08/09 — keep rigorous) |
| Session-tokens or OpenAI API key in FreeSWITCH dialplan variables (logged) | Credential leak via verbose SIP trace | Never expose API keys in dialplan; use env-only; redact tokens in `sip_trace` output |
| Discord-summary contains PII from counterpart | §9 DSGVO violation if Discord account compromised | Redact counterpart PII (name, DOB, account numbers) from summaries unless explicitly needed for follow-up |
| Transcript log persists counterpart audio-derived text beyond consent scope | §201 + DSGVO scope-creep | Transcript retention matches P5 parking-lot decision (default: 90 days or case-close + karenz, tightest per case) |
| No kill-switch for the voice channel in Carsten's phone | Can't stop a misbehaving session if Carsten is offline | Hardcoded Discord slash-command `/voice-kill` that pauses the channel instantly |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Bot says "Ich habe das notiert" before tool-call returns | Counterpart trusts it; Carsten shows up; no entry exists | Two-phase commit (Pitfall 11) |
| Bot reads long JSON back ("status=ok, id=cal_abc123") | Counterpart thinks they're being recorded or scammed | Persona: never verbalize tool internals (Pitfall 17) |
| Bot repeats "Sind Sie noch da?" to a contemplative counterpart | Rude, breaks rapport, triggers MOE-2 | Reframe + context-aware timeout (Pitfall 15) |
| Bot cut off by its own barge-in (cough) and retries from scratch | Counterpart confused by repetition | Raise VAD threshold + min-utterance-length (Pitfall 10) |
| Bot confirms "17 Uhr" but means "70 Uhr" silently | Wrong appointment | Two-form readback (Pitfall 3) |
| Bot switches to English when it hears an English word | Counterpart distrust, hangs up | Language pin in persona (Pitfall 12) |
| Bot speaks during voicemail greeting | Records bot's voice onto restaurant's mailbox | Voicemail-phrase gate, silent hang-up (Pitfall 6) |

---

## "Looks Done But Isn't" Checklist

- [ ] **Case 2 MVP:** Often missing voicemail-detection first-turn gate — verify with a test outbound to a voicemail-only number.
- [ ] **Case 2 MVP:** Often missing idempotency key on `create_calendar_entry` — verify by manually firing the same tool-call twice and confirming Core rejects duplicate.
- [ ] **Case 2 MVP:** Often missing two-form readback of date/time — verify by misrecognition test (say "siebzehn" and confirm bot repeats "17 Uhr, also fünf Uhr nachmittags").
- [ ] **Director Bridge v0:** Often missing tool-name allowlist validator — verify by injecting a fabricated tool-call name into the event stream.
- [ ] **Director Bridge v0:** Often missing two-phase-commit spoken-vs-tool diff — verify via a synthetic tool-failure injection.
- [ ] **Case 3 MVP:** Often missing DTMF scope-decision — verify the deferral is documented in REQ-SIP, or DTMF test fixture exists.
- [ ] **Infra:** Often missing WireGuard MTU 1380 setting — verify on both sides.
- [ ] **Infra:** Often missing tunnel heartbeat — verify by `ip link set wg0 down` during an active test call and confirming graceful hang-up.
- [ ] **Legal Gate:** Often missing third-party/speakerphone §201 opinion — verify written legal opinion is in `legal-evidence/`.
- [ ] **Legal Gate:** Often missing ZDR screenshot + confirmation email — verify in `legal-evidence/openai-zdr/`.
- [ ] **Cost:** Often missing real-time `usage`-event accumulator — verify per-call hard-cap trips in a synthetic 30-min test call.
- [ ] **Cost:** Often missing session-teardown assertion — verify `lingering_sessions_total = 0` after a batch of test calls.
- [ ] **VAD:** Often missing threshold override — verify `server_vad.threshold >= 0.55` in session config.
- [ ] **Observability:** Often missing reconciliation job (calendar-entry ↔ transcript ↔ Discord summary) — verify synthetic 3-way cross-check runs nightly.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Duplicate booking via missed idempotency (Pitfall 1) | MEDIUM | Manual refund/apology via Carsten; add idempotency key; Discord public post-mortem; MOE-6 incident log |
| Hallucinated tool-call passed validation (Pitfall 2) | HIGH (if it caused unauthorized commitment) | Same as MOE-6 incident; additionally pin schema allowlist; reproduce in regression test before any go-live-after-incident |
| Number-misrecognition caused wrong appointment (Pitfall 3) | MEDIUM | Reschedule, apologize; add two-form readback; add regression transcript to persona test suite |
| ZDR unverified + counterpart audio arguably retained (Pitfall 4) | HIGH (legal) | Halt channel; legal opinion; if breach, consider DSB-notification; verify ZDR and document |
| Third-party background voice captured (Pitfall 5) | HIGH (legal) | Halt channel for affected case-type; legal opinion; post-call transcript redaction; update persona to detect speakerphone cues |
| Voicemail loop cost spike (Pitfall 6) | LOW | Monthly-cap auto-pause already triggers; add detection gate |
| Session lingered past BYE (Pitfall 6.3) | LOW | Force-close via OpenAI API; kill-timer PR |
| FreeSWITCH reINVITE drop (Pitfall 7) | LOW | Call was short; counterpart will redial; log and fix SDP pin |
| WireGuard tunnel flap (Pitfall 8) | LOW-MEDIUM | Call ended gracefully; fix MTU; heartbeat PR |
| DTMF-required IVR failed (Pitfall 9) | LOW | Escalate to Carsten via Discord; Case 3 retry manually |
| Barge-in storm (Pitfall 10) | LOW | Raise VAD threshold; re-test |
| Cross-channel inconsistency (Pitfall 11) | MEDIUM | Reconciliation job identifies; manual follow-up; Discord correction |
| Language drift (Pitfall 12) | LOW | Pin persona harder; mid-call `session.instructions` inject to re-anchor German |
| Webhook duplicate accept (Pitfall 13) | LOW | Dedup at sip-to-ai; reject second accept |
| 429 mid-call silence (Pitfall 14) | MEDIUM | Graceful hang-up; counterpart redial; negotiate higher TPM |
| "Sind Sie noch da?" rude (Pitfall 15) | LOW | Adjust timer + prompt; apologize in same call if still connected |
| Billing drift (Pitfall 16) | LOW | Monthly reconciliation flags; investigate and fix accumulator |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1. Speculative duplicate mutations | Director Bridge v0 | Inject duplicate tool-call, Core rejects second |
| 2. Function-call hallucination | Director Bridge v0 + Persona Hardening | Synthetic bad-tool-name test, validator rejects |
| 3. German numeral/time misrecognition | Persona Hardening + Director Bridge v0 | Two-form readback regression test |
| 4. ZDR audit gap | Pre-Production Legal Gate | Screenshot + confirmation email archived + monthly cron |
| 5. Speakerphone / third-party §201 | Pre-Production Legal Gate + Persona Hardening | Written legal opinion filed; speakerphone-cue-phrase unit test |
| 6. Voicemail loop / hold-music / session cost | Case 2 MVP + Case 3 MVP + Observability v0 | Synthetic voicemail test; hold-music pause test; `lingering_sessions_total=0` |
| 7. SIP reINVITE edge cases | SIP Hardening | Counterpart hold/resume test with logged RTP |
| 8. WireGuard tunnel flap | Infra Hardening | Tunnel-down-during-call graceful hang-up test |
| 9. DTMF/IVR navigation | Case 3 Scoping | Defer documented in REQ-SIP OR end-to-end DTMF echo test |
| 10. Barge-in false positives | VAD Calibration | Cough/mhm/door-slam false-barge rate < 5% |
| 11. Cross-channel inconsistency | Director Bridge v0 + Observability v0 | Synthetic tool-failure-mid-turn test; reconciliation job flags |
| 12. Language drift | Persona Hardening | Non-German-name counterpart test, no English tokens |
| 13. Webhook duplicate | SIP Hardening | Webhook replay test, second accept rejected |
| 14. 429 mid-call | Observability v0 + Cost Hardening | TPM monitoring visible; 429-simulation graceful hang-up |
| 15. Silence prompt rude | Persona Hardening + Adaptive Dialog v1 | LQI check after first month of Case 3/4 calls |
| 16. Billing drift | Observability v0 + Ops v1 | Monthly dashboard-vs-accumulator diff < 10% |
| 17–21. Minor | Persona Hardening + Case-specific | Per-pitfall checklist above |

**Recommended phase ordering (based on pitfall severity):**
1. **Pre-Production Legal Gate** (ZDR #4 + Speakerphone #5) — blocks first outbound
2. **Director Bridge v0** (Idempotency #1, Schema validation #2, Two-phase commit #11) — blocks any verbindliche Aktion
3. **Persona Hardening** (Two-form readback #3, Language pin #12, Speakerphone reaction #5, Filler #17) — blocks Case 2 go-live
4. **Infra Hardening** (WireGuard MTU #8, Heartbeat #8) — parallel with Director Bridge
5. **Case 2 MVP** (Voicemail gate #6) — first real-counterpart exposure
6. **VAD Calibration** (Barge-in #10) — co-develop with Case 2 test fixtures
7. **Observability v0** (Session teardown #6, Usage accumulator #16, Reconciliation #11, TPM #14)
8. **Case 3 Scoping + MVP** (DTMF #9, Hold-music #6, Silence timer #15)
9. **SIP Hardening** (reINVITE #7, Webhook dedup #13)
10. **Case 4 MVP** (60-min wrap-up #20)

---

## Sources

**OpenAI Developer Community — direct production failure reports:**
- [Realtime API Session Timeout (Post GA)](https://community.openai.com/t/realtime-api-session-timeout-post-ga/1357331)
- [Realtime API hallucinations and tool misuse](https://community.openai.com/t/openai-gpt-realtime-halucinates-like-crazy-and-dont-uses-tools-properly/1358535)
- [gpt-realtime-1.5 unnaturally speaks tool parameters](https://community.openai.com/t/gpt-realtime-1-5-speaks-unnaturally-about-tool-call-parameters-and-output/1375220)
- [Regression in Realtime API structured data](https://community.openai.com/t/regression-in-realtime-api-model-behavior-loss-of-determinism-with-structured-data/1376392)
- [SIP Trunking + Realtime API greeting delay & language mismatch](https://community.openai.com/t/sip-trunking-realtime-api-call-flow-initial-greeting-delay-language-mismatch/1366626)
- [INVITE → realtime.call.incoming delay 3–5 s](https://community.openai.com/t/consistently-3-5s-sometimes-7s-invite-realtime-call-incoming-delay-on-sip-realtime-accept-is-1s-any-guidance/1366874)
- [DTMF trigger pattern in Realtime API](https://community.openai.com/t/how-do-i-trigger-a-trigger-a-response-after-dtmf-keys-have-been-pressed/1098984)
- [SIP/RTP compatibility and security issues](https://community.openai.com/t/sip-rtp-compatibility-and-security-issues/1361852)
- [Realtime API with SIP missing header Asterisk](https://community.openai.com/t/realtime-api-with-sip-missing-header-in-sip-asterisk/1355552)
- [Realtime API issues - good practices](https://community.openai.com/t/realtime-api-issues-good-practices/1031546)
- [Realtime — what events should be handled (call centers)](https://community.openai.com/t/realtime-api-what-events-should-be-handled-e-g-for-call-centers/968177)
- [The sorry state of the Realtime SDK](https://community.openai.com/t/the-sorry-state-of-the-realtime-sdk/1356942)
- [Zero Data Retention information thread](https://community.openai.com/t/zero-data-retention-information/702540)

**OpenAI Official documentation:**
- [Realtime API with SIP](https://platform.openai.com/docs/guides/realtime-sip)
- [Realtime Prompting Guide — language drift](https://developers.openai.com/cookbook/examples/realtime_prompting_guide)
- [Webhooks — retries, duplicates, signatures](https://platform.openai.com/docs/guides/webhooks)
- [Webhooks and server-side controls](https://platform.openai.com/docs/guides/realtime-server-controls)
- [Data controls and ZDR eligibility](https://platform.openai.com/docs/guides/your-data)

**Production voice-agent failure analyses (2025–2026):**
- [Hamming AI — 7 Voice Agent ASR Failure Modes in Production](https://hamming.ai/blog/7-voice-agent-asr-failure-modes-in-production)
- [Hamming AI — 7 Common Voice AI Edge Cases and How to Test Them](https://hamming.ai/resources/7-common-voice-ai-edge-cases-and-how-to-test-them)
- [Bluejay — 7 Reasons Voice Agents Fail in Production](https://getbluejay.ai/resources/voice-agent-production-failures)
- [Gladia — Voice AI Hallucinations and Guardrails](https://www.gladia.io/blog/voice-ai-hallucinations)
- [FutureAGI — Why Your Voice Agent Fails in Production](https://futureagi.substack.com/p/why-your-voice-agent-fails-in-production)

**VAD / Barge-in:**
- [Notch — Turn Detection in Voice AI](https://www.notch.cx/post/turn-detection-in-voice-ai)
- [Krisp — Background Voice Cancellation for Turn-Taking](https://krisp.ai/blog/improving-turn-taking-of-ai-voice-agents-with-background-voice-cancellation/)
- [AssemblyAI — Voice Agent Turn Detection](https://www.assemblyai.com/blog/voice-agent-turn-detection)
- [LiveKit — Adaptive Interruption Handling](https://livekit.com/blog/adaptive-interruption-handling)
- [Picovoice — VAD Complete Guide 2026](https://picovoice.ai/blog/complete-guide-voice-activity-detection-vad/)
- [Speechmatics — Your AI Assistant Keeps Cutting You Off](https://www.speechmatics.com/company/articles-and-news/your-ai-assistant-keeps-cutting-you-off-im-fixing-that)

**SIP / FreeSWITCH / WireGuard:**
- [FreeSWITCH DTMF documentation](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Configuration/DTMF_9634268/)
- [FreeSWITCH Issue #1763 — RFC2833 payload-type with Opus](https://github.com/signalwire/freeswitch/issues/1763)
- [FreeSWITCH Issue #1937 — DTMF dropped with RFC2833 enabled](https://github.com/signalwire/freeswitch/issues/1937)
- [FreeSWITCH RTP issues troubleshooting](https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Troubleshooting-Debugging/RTP-Issues_1048973/)
- [OpenWrt — VoIP one-way audio through WireGuard](https://forum.openwrt.org/t/voip-one-way-audio-through-wireguard/158820)
- [Netgate — VoIP one-way via Wireguard](https://forum.netgate.com/topic/93587/one-way-audio-on-voip-but-why)
- [3CX — one-way audio via WireGuard](https://www.3cx.com/community/threads/only-one-way-audio-working-via-wireguard-vpn.121574/)

**Speculative tool calling / idempotency:**
- [GetStream — Speculative Tool Calling for Voice Gaps](https://getstream.io/blog/speculative-tool-calling-voice/)
- [Inferable — Reliable Tool Calling with Message Queues](https://www.inferable.ai/blog/posts/distributed-tool-calling-message-queues)
- [Idempotency for Agents — Production-Safe Pattern](https://levelup.gitconnected.com/idempotency-for-agents-the-production-safe-pattern-youre-missing-a94ef0db20a9)

**German legal framework (§201 StGB / DSGVO):**
- [anwalt.org — §201 StGB Vertraulichkeit des Wortes](https://www.anwalt.org/201-stgb/)
- [unternehmensstrafrecht.de — KI-Transkription und §201 StGB](https://www.unternehmensstrafrecht.de/ki-transkription-und-%C2%A7-201-stgb/)
- [HÄRTING — VoiceBots rechtssicher einsetzen](https://haerting.ch/wissen/voicebots-rechtssicher-einsetzen-datenschutz-ki-und-urheberrecht/)
- [LUTZ|ABEL — KI-Transkription rechtssicher ohne Einwilligung](https://www.lutzabel.com/en/article/?tx_hphlawyers_articledetail%5Baction%5D=show&tx_hphlawyers_articledetail%5Barticle%5D=1036)
- [Gründer.de — KI-Telefonassistent DSGVO Grauzonen](https://www.gruender.de/kuenstliche-intelligenz/ki-telefonassistent-dsgvo/)
- [CrossChannelLawyers — Covert Recordings illegal in Germany](https://www.crosschannellawyers.co.uk/covert-audio-recordings-are-illegal-in-germany/)
- [BAG 23.4.2009 - 6 AZR 189/08 — Mithören am Telefon](https://www.uni-trier.de/fileadmin/fb5/prof/eme001/AP_Anmerkung_Mithoeren_am_Telefon.pdf)
- [§ 201 StGB Gesetzestext](https://www.gesetze-im-internet.de/stgb/__201.html)

**Internal project context:**
- `/home/carsten_bot/nanoclaw-state/.planning/PROJECT.md`
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/CONOPS.md` (Scenes, Edge Cases, External)
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/REQUIREMENTS.md` (REQ-SIP/VOICE/CASE/DIR/TOOLS/INFRA/DISC)
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/ARCHITECTURE-DECISION.md` (AC-001..AC-009)
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/PARKING-LOT.md` (P5, P11 context)

---
*Pitfalls research for: Personal AI phone agent (native S2S Hot-Path + async Slow-Brain director) integrated into NanoClaw under §201 StGB / DSGVO / MOE-6 zero-tolerance constraints*
*Researched: 2026-04-16*
