# Feature Research — NanoClaw Voice

**Domain:** Personal AI phone agent (German, private use, single user) — outbound (restaurants, medical/hair, hotels), whitelisted inbound (sales negotiation), hands-free user↔assistant voice channel
**Researched:** 2026-04-16
**Confidence:** MEDIUM-HIGH (production patterns well-documented for commercial voice agents; private-use specifics partly extrapolated; legal framing verified against Art. 50 AI Act and §201 StGB)

---

## Domain Scope Note

This research treats NanoClaw Voice as a **single-user personal AI phone assistant**, not a commercial contact-center product. That changes the feature calculus significantly:
- "Table stakes" = features without which the bot fails the **counterpart credibility test** (MOE-2 ≤15% bot-thematization) or the **autonomy test** (Carsten can delegate without supervising).
- "Differentiators" = features that make NanoClaw Voice noticeably better than just routing OpenAI Realtime through Sipgate — they exploit the fact that this is a personal assistant with persistent Core memory, not a stateless inbound bot.
- "Anti-features" = patterns the commercial market promotes that are wrong for private use, illegal in DE, or breach the spec's hard constraints (MOE-6 zero unauthorized commitments, §201 no audio persistence, no impersonation).

Case mapping legend: **C1**=Hotel, **C2**=Restaurant, **C3**=Medical/Hair, **C4**=Inbound negotiation, **C6**=Carsten↔NanoClaw direct.

---

## Feature Landscape

### Table Stakes (Without These, Cases Fail)

These are non-negotiable — counterparts detect the bot, calls fail, or commitments leak.

| Feature | Why Table Stakes | Complexity | Cases | Dependencies |
|---------|------------------|------------|-------|--------------|
| **Sub-1s turn latency (P50 ≤900ms VAD-end → first audio byte)** | Above ~800ms counterparts notice unnatural pause; primary driver of bot-detection rate. Production benchmark consensus: 500-800ms feels human, >1.2s feels robotic. (Twilio core-latency guide; Deepgram Eager-EOT guide) | M (already validated, Spike E 635ms) | All | Native S2S, no STT+LLM+TTS serial pipeline |
| **Barge-in with <200ms TTS cancellation** | Counterparts interrupt; if bot keeps talking over them, the call breaks down within 1-2 turns. CallBotics 2026 guide: "interruption handling is the single biggest natural-conversation marker." | M (validated V9-Gate-H) | All | server_vad with auto_create_response, queue flush on VAD |
| **Filler phrases during tool-call latency >500ms** | Silence longer than ~700ms during a turn is the second-strongest bot tell. German fillers needed: "Mhm, einen Moment.", "Lass mich kurz nachsehen.", "Sekunde." Must trigger within 1000ms of tool-call start. | S | All (esp. C2, C3, C4) | Director Bridge tool-cycle visibility |
| **Voicemail / Anrufbeantworter detection (AMD)** | Without it, the bot will deliver a reservation request to a voice mailbox or "burn" tokens talking to a recording. Industry AMD accuracy: 90-99% for keyword + cadence detection. Telltales in DE: "Sie haben den Anrufbeantworter von … erreicht", "Bitte hinterlassen Sie eine Nachricht nach dem Signalton". | M | C1, C2, C3 | Realtime instructions + early-turn cadence detector OR provider AMD |
| **IVR detection + DTMF support** | Practices/restaurants often have IVR menus ("Drücken Sie 1 für Termine"). Without DTMF, the bot is stuck at the menu. OpenAI Realtime supports DTMF over SIP natively. | M | C2, C3 | `send_dtmf` tool + IVR menu hint in instructions |
| **IVR hold-music passive listening (no LLM cost burn)** | Practices put callers on hold for minutes. If the model keeps inferring on hold music it burns budget AND may "respond to" the music. Need: VAD-only mode while hold music plays, re-activate on speech. | L | C3 (critical), C2 | Provider VAD-only mode OR custom audio classifier (music vs speech) |
| **Silence timeout with prompt and graceful hangup** | Spec REQ-VOICE-08/09 already defines: prompt at 10s, terminate at 20s. Industry default 500ms-2s endpointing for normal turns; 10s+ for global silence. Without this, dead calls accumulate cost. | S | All | Realtime session config |
| **Polite German farewell phrase on every termination** | Even for retries, voicemail, or silence-timeout. "Vielen Dank, ich versuche es später erneut. Auf Wiederhören." Hangups without farewell are a major bot tell (silent hangup = bot signature). | S | All | Pre-terminate hook before BYE |
| **Server VAD with proper turn-end detection** | Mis-detected end-of-turn = bot interrupts mid-sentence (sounds rude/bot-like) OR waits forever. OpenAI server_vad with `auto_create_response=true` is industry standard for this provider. | S | All | gpt-realtime-mini config |
| **G.711 PCMU codec negotiation** | Sipgate-mandated; without it no audio. Already validated V8-E. | S | All (infrastructure) | FreeSWITCH SDP-Fix |
| **Truthful disclosure on direct "Sind Sie ein Bot?" question** | Legal requirement (passive-honest disclosure per spec). Industry: nearly all production voice bots either declare upfront (commercial) or answer truthfully on direct ask. Refusing or lying is reputation-destroying and Art. 50 / OpenAI usage-policy breach. | S | All external (C1, C2, C3, C4) | Persona prompt directive (REQ-DISC-02) |
| **Generic AI voice (not cloned real person)** | OpenAI usage policy + impersonation protection. Spec mandates "kein Real-Person-Impersonation". Hard table stakes — any cloned voice = legal/ethical kill. | S | All | TTS voice selection |
| **Per-call cost cap with hard-kill termination** | Without it: stuck-call loops or hostile counterpart can drain budget. Spec: €1/call hard cap. | S | All | Cost meter + Director Bridge kill-switch |
| **Calendar read+write for booking confirmation** | C2/C3 fail without calendar. Calendar entry with travel-time buffer is the artefact that proves the call worked. | M | C2, C3, C6 | Google Calendar MCP (existing) + travel-buffer logic (X8 partial) |
| **No persistent audio anywhere (RAM-only)** | §201 StGB hard requirement, non-negotiable. Industry trend: ZDR modes (OpenAI ZDR available, validated). | M | All | Provider ZDR + filesystem audit (REQ-QUAL-04) |
| **Identification on outbound to Carsten (Case 6b)** | Without it Carsten doesn't know who's calling. Spec REQ-C6-04: "Hi Carsten, kurz wegen …" within 2s. | S | C6 | Outbound Case-6b mode flag |
| **Carsten-CLI-based routing for inbound (C6 vs C4 vs reject)** | Without CLI-match, every inbound is treated identically. Spec: Carsten-CLI → C6, whitelist → C4, else → Sipgate voicemail. | S | C4, C6 | FreeSWITCH dialplan + Director Bridge classifier |
| **Structured post-call summary written to Core within 60s** | Without it, the call leaves no trace and Carsten cannot review. Spec REQ-C4-10 / REQ-DIR-07. | S | All | Director Bridge BYE-handler |

### Differentiators (Things That Make NanoClaw Voice Genuinely Better)

These exploit the personal-assistant context. Commercial bots cannot do these because they lack persistent user state.

| Feature | Value Proposition | Complexity | Cases | Dependencies |
|---------|-------------------|------------|-------|--------------|
| **Pre-loaded per-call context (calendar state, contract terms, practice profile, restaurant prefs) injected at call accept** | Bot "knows everything" before first turn → no awkward "moment, ich schaue nach" on basic facts. Validated pattern (V2-Preload + Spike E). Counterparts experience this as "well-prepared caller". | M | C1, C2, C3, C4 | Director Bridge `session.update` at accept; Core MCP-tools for calendar/contracts/profiles |
| **Two-brain architecture (Hot S2S + async Slow Director)** | Hot path stays sub-1s while heavy reasoning (compare offers, audit transcript for unauthorized-commit, draft summary) runs in parallel. Counterparts never wait for "thinking". Validated AC-01/02. | L | All | Director Bridge spec |
| **Live competitor research mid-call (C4)** | Bot quotes "Bei 1&1 sehe ich aktuell 39,99 €" with live data → flips negotiation power asymmetry. Most commercial sales bots are static-script; this is uniquely valuable for inbound counter-negotiation. | L | C4 | Web search MCP + tool-result injection within 30s of call start |
| **Multi-channel artefact persistence (calendar + Discord + transcript)** | Every call ends with calendar entry + Discord summary + searchable transcript. Carsten never has to "remember what was said". Cross-channel consistency MOE-5 ≥95%. | M | All | Existing Discord+Calendar MCP, new transcript persistence |
| **Carsten-takeover hotword (live handoff during C4)** | Bot is in the middle of a Telekom negotiation, Carsten wants to take over. Hotword (e.g. "Ich übernehme") triggers SIP REFER or audio-bridge handoff. No commercial product offers this for sales-call defense. | L | C4 | SIP REFER / audio-bridge + hotword detector in transcript stream |
| **Proactive callback (Case 6b — bot calls user when decision needed)** | NanoClaw calls Carsten in the car when a hotel offer is ready or a calendar conflict needs resolution. Mercedes "Hey Mercedes" proactive pattern ported to phone. Major UX win for hands-free use. | M | C6 | Outbound trigger from Core events (hotel research done, conflict detected) + brief identification preamble |
| **Tolerance-window-based autonomous decisions (C2)** | Carsten pre-configures "Freitag 20 Uhr ±60 min, 2 Personen, Tisch egal". Bot accepts any offer within window without escalation; outside → escalate. Reduces back-and-forth roundtrips by 70-80%. | M | C2, C3 | Tolerance config schema in Core; per-booking parameter loading |
| **Travel-time-aware slot selection (C3)** | Bot evaluates offered medical slots against calendar + Maps travel time from home AND Audi-Standort. Picks slot that minimizes commute disruption. No commercial scheduling bot does this — they pick "first available". | L | C2, C3 | Google Maps API tool (REQ-TOOLS-09) + multi-origin travel calc |
| **Authorized-disclosure schema (C3, C4)** | Per practice/contract, Core lists exactly which fields the bot may disclose (Geburtsdatum: yes; symptoms: only if pre-authorized). Bot refuses other queries with "das bespreche ich vor Ort". Privacy-by-design, not retrofit. | M | C3, C4 | Per-counterpart disclosure-list in Core; persona directive to consult before disclosing |
| **Phishing/identity-mismatch detection (C4)** | Bot cross-checks counterpart claim ("Hier Telekom, Vertragsverlängerung") against Core's contract repository. Mismatch (e.g. caller claims Vodafone but Carsten has no Vodafone contract) → terminate without disclosure. Counter to social-engineering attacks. | M | C4 | Contract repo + mismatch heuristic in directional persona |
| **Per-case persona switching with directional prompt** | C2 = friendly customer, C3 = patient, C4 = collected negotiator, C6 = familiar assistant. All from the same model, switched at call accept. Validated by Sideband-WS Runde 2 (directive prompt = tool-first behavior). | S-M | All | Case detector (CLI + outbound trigger) + per-case prompt template |
| **Retry scheduler with backoff (C2 restaurant, C3 reception)** | Restaurants don't always answer first try. Spec: 5/15/45/120 min escalation. Without retry, 30-40% of restaurant calls fail in v1 commercial deployments. | M | C2, C3 | Core scheduler + retry-state per target_phone (REQ-TOOLS-08) |
| **Voicemail-leave-no-message policy (C1, C2, C3)** | Specifically: when AMD detects voicemail, hang up silently (after 1s of detection certainty) — do NOT leave a message. Reasoning: leaving a robocall-style message damages Carsten's number reputation; restaurant call-back wouldn't reach Carsten anyway. (Counter to commercial AMD-leave-message pattern.) | S | C1, C2, C3 | AMD hook → immediate BYE without farewell |
| **Mid-call instructions update (NOT tool update) for context drift** | Director can push new context ("Carsten just messaged: also okay for 19:30") via `session.update` instructions. Validated AC-05 (183-212ms RT, no audio interruption). Tool list stays frozen (AC-04). | M | C4, C6 | Sideband-WS already implemented |
| **Backchanneling cues ("Mhm", "Verstehe", "Ja, genau") at natural break-points** | Industry consensus 2026: backchanneling is the strongest naturalness marker beyond latency. Without it, the bot sounds attentive-but-robotic. With it, conversations flow. | S | All external | Persona prompt instructions; gpt-realtime handles natively if prompted |
| **Dynamic identification level by case** | C6b: "Hi Carsten, kurz wegen …" (informal, named); C2: "Guten Tag, ich möchte gern reservieren" (no name volunteered until asked); C4 inbound: "Carsten Freek, hallo?" (first-person, owner of CLI). Single-pattern bots get this wrong. | S | All | Per-case opening template |
| **Anfahrtszeit-Puffer in calendar entries** | Termin um 14:00 → Kalender: 13:30-15:00 (with 30min buffer before+after). Carsten never books two adjacent meetings without commute slack. Differentiator vs. plain calendar tools. | S | C2, C3 | `create_calendar_entry(travel_buffer_before_min, travel_buffer_after_min)` (REQ-TOOLS-02) |
| **Eager end-of-turn detection (Deepgram Flux pattern) — optional later** | Smart EOT model detects turn-end faster than fixed silence threshold → reduces P50 by 100-200ms. Worth piloting after Case 2/3 prove out; not required for MVP. | M | All | Deepgram Flux or similar EOT model |

### Anti-Features (Do NOT Build — Even If Suggested)

These appear in commercial voice-agent product menus but are wrong, dangerous, or illegal in this private-use German context.

| Anti-Feature | Why Requested | Why Problematic | What to Do Instead |
|--------------|---------------|-----------------|---------------------|
| **Persistent audio recording for "training" or "QA"** | Commercial vendors push this for ML retraining. Vendor dashboards default-on. | **§201 StGB criminal offense** (Vertraulichkeit des Wortes — two-party-consent jurisdiction). Cross-Channel-Lawyers: covert audio recording is criminal in DE. ZDR mode is non-negotiable. | RAM-only audio (REQ-INFRA-10), monthly filesystem audit (REQ-QUAL-04), OpenAI ZDR mode. Transcript persistence is OK; raw audio is not. |
| **Voice cloning of Carsten or family ("personalized voice")** | "Sounds more like you" marketing pitch. ElevenLabs/OpenAI offer it. | OpenAI usage policy explicitly prohibits cloning real persons without consent. Even for self-clone: enables impersonation by anyone with API access. Spec REQ-DISC-03 hard-prohibits real-person impersonation. | Use generic AI voice (OpenAI's standard voices). Same persona ≠ same voice. |
| **Proactive bot-self-identification at call start ("Hi, this is an AI calling on behalf of …")** | EU AI Act Art. 50 transparency reading; commercial CYA pattern. | (a) Spec is explicit: passive disclosure only. (b) Art. 50 is **not applicable** in private non-professional context (DSGVO Haushaltsausnahme parallel; AI-Act Deployer-definition excludes purely personal use). (c) Aggressive opening = counterpart hangs up = Case fails. | Truthful answer ONLY on direct "Sind Sie ein Bot?" question (REQ-DISC-02). Verify with lawyer before first live external call (Q-ConOps-6). |
| **Voicemail message-leaving (commercial AMD-leave-message pattern)** | Commercial AMD pipelines auto-leave a customized message: "Hi, this is X, please call back at …". | (a) Robocall-style damage to Carsten's number reputation. (b) Restaurant/practice call-back to Carsten wouldn't reach NanoClaw (Sipgate routes inbound to whatever rules are set; private callback is unreachable). (c) Recipient hears robotic message = trust destruction. | AMD detected → hang up silently (no farewell, no message), schedule retry. |
| **Verbal contract commitment for negotiation outcomes (C4)** | Sales bots are designed to "close deals on the call". Counterparts pressure for verbal agreement. | **MOE-6 zero tolerance** = single violation is critical incident. German contract law gives verbal agreements legal weight; Carsten could be bound. Enables phishing exploitation (fake-Telekom records "ja" → contract). | Hard-coded persona directive: "Ich entscheide nichts am Telefon — schicken Sie mir das schriftlich." Never accept time-pressure ("nur heute"). Spec REQ-C4-07. |
| **Credit card / payment data via voice (C1 hotel)** | Hotels often ask for card to guarantee booking. Easy to "just read out the number". | Spec hard constraint REQ-C1-08: kategorisch verboten. Voice transcript could be persisted by counterpart's system; OpenAI processing path; phishing surface. Card data is the highest-impact leak. | Always defer to online booking by Carsten. If hotel insists telephone-only: escalate to Carsten via Discord with explanation; let Carsten decide manually. |
| **Disclose personal/sensitive data without authorization check** | Commercial bots often pre-load "all customer data" and answer freely. | Phishing surface (C4): caller pretends to be Telekom, harvests data. Medical privacy (C3): MFA asks "Welche Symptome?" — bot improvises and breaches authorization scope. | Per-counterpart authorized-disclosure schema; default to "Das bespreche ich vor Ort" or "Das müsste ich mit Herrn Freek klären". |
| **Volunteered claim that bot is a specific named human ("Hier Carsten Freek")** | Identification feels "natural" if bot says "Carsten Freek, hallo?" | Spec REQ-DISC-03: never claim to be a specific named human. The bot may use Carsten's CLI (Sipgate identity) and may say "im Auftrag von Carsten Freek", but must not assert "I am Carsten." On C4 inbound, the persona is "ich antworte für Herrn Freek". | Use indirect formulations: "Hier Anschluss Freek" / "Carsten Freek's Anschluss, ich nehme Anrufe für ihn entgegen" — neutral, not a personal claim. (Final wording is a Q-ConOps-6 lawyer-review item.) |
| **Mid-call tool definition updates (add/remove tools during call)** | Looks like flexibility: "the bot adapts its capabilities mid-conversation". | **Validated bug** (Sideband-WS T5, AC-04): mid-call tool update = 0 audio-delta events for 15s = call hangs. Hard architectural exclusion. | Tools declared once at `realtime.calls.accept()`; instructions only may be updated mid-call (AC-05). |
| **STT + LLM + TTS serial pipeline for "best of each model"** | Marketing pitch: pick the best STT, the best LLM, the best TTS. Pipecat-style. | Spike B/F measured 1533-5455ms P50 (1.7-6× over budget). MOS-1 unattainable. Hard exclusion AC-01/03. | Native S2S only (gpt-realtime-mini). |
| **Pipecat or other heavy orchestration frameworks** | Industry-standard for "production voice agents". | Spike F: ~5455ms median, 8.6× too slow. Hard exclusion AC-03. | Direct OpenAI Realtime SIP integration via FreeSWITCH; sideband WS for control. |
| **"Hold on, let me check" with no actual filler audio** | Some implementations rely on silence during tool calls. | >700ms silence = bot tell. Restaurant MFA hangs up assuming dropped call. | Generated filler within 1000ms of tool-call start (REQ-VOICE-07). |
| **Unconditional inbound forwarding (Variante 4-B)** | "Always answer with the bot, never miss a call" appeal. | Spec hard exclusion: private callers (family, friends) end up at the bot → embarrassment + privacy breach. Variant 4-B is explicitly killed. | Whitelist-only inbound (4-C); everything else → Sipgate voicemail. |
| **Aggressive negotiation tactics by the bot (C4)** | Sales-bot literature recommends counter-pressure, anchoring exploitation. | (a) Bot is defending, not selling — single counter-offer is enough (REQ-C1-04 analog). (b) Aggressive bot interactions damage Carsten's reputation with legitimate vendors. (c) Sophisticated counterparts will try to game the bot's negotiation logic (Inject+Voss pattern from arXiv 2503.06416). | Calm, factual responses. One polite counter-offer per call. Refuse time-pressure with "Wenn das Angebot heute gut ist, ist es morgen auch gut" (spec REQ-C4-06). Defer all binding decisions to Carsten in writing. |
| **Multi-call parallelism for restaurant/hotel inquiries** | "Call all 5 hotels at once for fastest research" appeal. | (a) Multiple Sipgate concurrent legs may breach AGB (private-use profile). (b) Cost cap (€3/day) blown instantly. (c) Reputation: Carsten's number calling 5 hotels in 30s looks like spam. | Sequential calls (spec C1 setzung). Parallel is "Architektur-Option für E1/GSD" but explicitly deferred. |
| **"Smart voicemail" where bot greets all unknown inbound (Case 5)** | Tempting once IVR/AMD work. | Spec §4 explicit exclusion. Persona-conflict with C4-mode (negotiation persona vs. assistant-greeting persona on the same Sipgate number). Re-spec required. | iPhone Sipgate voicemail handles unknowns; revisit only after Cases 2/3/4/6 stable in production. |
| **Continuous mid-call transcription stream to Discord ("watch the bot work")** | Cool factor: Carsten watches live transcript in Discord while bot is on the call. | Privacy bleed (counterpart transcript visible to Carsten in real-time, fine for personal use but cognitively distracting). Bandwidth/cost. Likely enables Carsten to interrupt productively (good) but more often causes misguided takeovers (bad). | Post-call summary only. If live monitoring is wanted, gate it behind explicit Carsten-trigger ("zeig mir den Live-Transkript für diesen Anruf"). |
| **Sentiment analysis to "auto-escalate angry callers"** | Standard contact-center feature. | Carsten is the only escalation target; angry counterpart in C2/C3 should just be politely ended (spec edge case). Adds latency + cost without value. | Simple keyword/abuse-pattern check at end-of-turn → polite hangup. No sentiment ML. |
| **Multi-language switching (English fallback if German fails)** | Some platforms offer auto-detect-and-switch. | Confuses German counterparts. Bot should stay in German; if STT/comprehension fails, ask "Können Sie das wiederholen?" up to 2× then politely end. | German-only (REQ-VOICE-06); polite Wiederholung-bitte; escalate to Carsten on repeated failure. |
| **Endless retry loops without per-day cap** | Commercial dialers retry until contact. | Sipgate cost runaway; restaurant reputation damage; might trigger Sipgate AGB review. | Hard cap retries per target per day (spec C2: max N attempts/day); after exhaustion → Discord escalation. |
| **Auto-accept long medical wait times ("frühestens in 4 Monaten")** | Bot might "succeed" by booking anything available. | Carsten loses control over commitment timing; may book during conflicts spec didn't anticipate. | Document, escalate to Carsten with options; do not autonomously accept slots beyond a configurable horizon (e.g. 8 weeks). |

---

## Feature Dependencies

```
Foundation Layer (must come first):
─────────────────────────────────
[SIP G.711 + Sipgate REGISTER]
       └──> [OpenAI Realtime SIP bridge]
                └──> [Native S2S Hot-Path with VAD]
                          └──> [Barge-in <200ms]
                          └──> [Server-VAD + auto_create_response]
                          └──> [Silence timeout + polite farewell]

Director Layer (Case-enabling):
───────────────────────────────
[Sideband WS per-call control channel]
       └──> [Pre-load context at session.accept()]
                └──> [Frozen tool definitions per call]
                          └──> [Mid-call instructions updates]
       └──> [Tool routing to Core MCP]
                └──> [Calendar tools] ────> [Anfahrtszeit-Puffer logic]
                └──> [Discord push] ─────> [Post-call summary]
                └──> [Filler-phrase trigger on tool latency]

Case-Specific (built on Director):
──────────────────────────────────
[Case 6 — Carsten direct]
   ├── [CLI-based routing]
   ├── [Verbal-confirm-before-execute (MOE-6)]
   └── [Outbound 6b: identification preamble]
        └──enables──> [Proactive callback on Core events]

[Case 2 — Restaurant]
   ├── [Tolerance-window config schema]
   ├── [Retry scheduler] ─────────────> requires AMD
   ├── [Restaurant address book]
   └── [Voicemail-leave-no-message]

[Case 3 — Medical/Hair]
   ├── [Practice profile + patient data]
   ├── [Medical disclosure authorization schema]
   ├── [IVR hold-music passive listening] ── critical for cost
   ├── [Travel-time-aware slot selection]
   │       └── requires [Google Maps API] + [multi-origin calc]
   └── [DTMF for IVR menus]

[Case 4 — Inbound negotiation]
   ├── [Whitelist-based inbound routing]
   ├── [Contract repository in Core]
   ├── [Live competitor web-search tool]
   ├── [Phishing/identity-mismatch detector] ── requires contract repo
   ├── [Carsten takeover hotword] ── requires SIP REFER or audio bridge
   └── [Structured result document writer]

[Case 1 — Hotel (deferred v2+)]
   ├── [Hotel research tool (web + scraping)]
   ├── [Multi-call campaign orchestrator]
   ├── [Sequential-only enforcement]
   ├── [Discord comparison-table renderer]
   └── [Online-booking-link path] (NOT credit-card-via-voice)

Compliance Layer (cross-cutting, all cases):
────────────────────────────────────────────
[ZDR mode + RAM-only audio]
   └──> [Monthly filesystem audit]
[Truthful disclosure on direct ask]
   └──> [Persona prompt directive — passive disclosure]
[No real-person impersonation]
   └──> [Generic TTS voice + phrasing rules]
[Cost caps per call/day/month]
   └──> [Hard-kill termination + Discord alert]
[Verbal-confirm before binding actions]
   └──> [Per-call audit for unauthorized commitments]
```

### Dependency Notes (load-bearing edges)

- **AMD enables retry scheduler:** without voicemail detection, the retry scheduler will pile up duplicate "messages" on answering machines. AMD must precede C2/C3 retry rollout.
- **Contract repo enables phishing detector AND live-competitor compare:** the same data structure feeds both C4 cardinal features. Build it once, well.
- **Frozen-tools constraint (AC-04) shapes Director Bridge:** all case-required tools must be declared at call accept; the Director cannot "add the right tool" mid-call. This means per-case tool-bundles are needed (not a single union of all tools).
- **Travel-time slot selection requires Maps API + multi-origin (home + Audi-Standort):** Q-ConOps-Sprint open. Without it, C3 falls back to "first available" (commercial-bot quality).
- **Carsten-CLI routing enables Case 6 entirely:** no CLI match = no Case 6 (or Case 6 conflated with Case 4). Foundational.
- **Sideband WS conflicts with mid-call tool updates:** validated bug. Sideband WS must restrict itself to instructions updates only (AC-05); any feature that wants "tool changes during a call" must be redesigned to use a different mechanism (e.g. multi-call sequencing).
- **Whitelist routing precedes C4:** without whitelist, every inbound is treated identically and private callers can land on the negotiation persona = embarrassment. Variant 4-C is the gate to C4.
- **Disclosure persona directive depends on directional-prompt baseline:** the spec already validates the "directional persona prompt" concept (Sideband-WS Runde 2). All disclosure rules become persona-prompt items, not tool-checks.

### Conflicts (avoid combining in same phase)

- **Smart voicemail (Case 5) conflicts with whitelist-only inbound (4-C):** Case 5 requires accepting all inbound; 4-C only accepts whitelisted. Spec resolved this by killing Case 5.
- **Live transcript streaming conflicts with hot-path latency budget:** continuous transcript egress to Discord during call adds load and may distract Carsten into inappropriate takeovers. Defer.
- **Aggressive negotiation conflicts with passive disclosure:** an aggressive bot is more likely to be probed ("are you human?"); the passive-disclosure stance assumes the bot stays under the radar. Aligned design: bot stays calm, sounds well-prepared, doesn't pressure → fewer probes.

---

## MVP Definition

Maps directly to spec §4 (v1 Must-haves). Restated here from a feature-research lens.

### Launch With (v1 — "Case 6 first" per ConOps §4a.3 Stufe 1+2)

Minimum viable feature set to prove Carsten can use NanoClaw Voice productively.

- [ ] **SIP G.711 + Sipgate REGISTER + RTP** — without this nothing connects (already validated)
- [ ] **Native S2S Hot-Path (gpt-realtime-mini) with P50 ≤900ms** — without this every call sounds robotic (already validated)
- [ ] **Server VAD + barge-in <200ms** — natural turn-taking foundation (validated)
- [ ] **Filler phrases on tool-call >500ms** — masks Director latency
- [ ] **Silence timeout (10s prompt → 20s polite hangup)** — prevents dead-call cost burn
- [ ] **Polite German farewell on every termination path** — universal anti-bot-tell
- [ ] **CLI-based inbound routing (Carsten=C6, whitelist=C4, else=Sipgate VM)** — gates Case 6 + safe inbound
- [ ] **Sideband WS for instructions updates** — Director context push (validated)
- [ ] **Pre-load Core context at call accept** — bot knows current state before first turn
- [ ] **Frozen tool definitions per call** — architectural constraint, must be enforced (AC-04)
- [ ] **Calendar check + create with travel buffer** — required for C2/C3/C6 binding actions
- [ ] **Discord push for summaries + escalations** — Carsten visibility loop
- [ ] **Post-call structured summary written to Core within 60s** — auditability + MOE-5
- [ ] **Cost cap enforcement (€1/call, €3/day, €25/month) with hard-kill** — runaway protection
- [ ] **ZDR mode + RAM-only audio + monthly filesystem audit** — §201 compliance non-negotiable
- [ ] **Generic AI voice (no cloning)** — usage-policy compliance
- [ ] **Truthful "bin Bot"-answer on direct ask** — disclosure compliance
- [ ] **Verbal-confirm-before-execute for Case 6 binding actions** — MOE-6 protection
- [ ] **Directional persona prompt (no domain-data-from-memory)** — validated AC-06
- [ ] **No-credit-card-via-voice hard rule** — even before Case 1 launches, the rule must be in persona

### Add After Case 6 Validated (v1.1 — Stufe 3 Case 2 Restaurant)

- [ ] **Voicemail / Anrufbeantworter detection (AMD) with silent hangup** — required before retry rollout
- [ ] **Retry scheduler with backoff** (5/15/45/120 min, max N/day)
- [ ] **Restaurant address book in Core**
- [ ] **Tolerance-window config per booking**
- [ ] **Per-case persona switching (C2 = "möchte gern reservieren")**
- [ ] **Discord-mediated escalation when offer outside tolerance**

### Add After Case 2 Validated (v1.2 — Stufe 4 Case 3 Medical/Hair)

- [ ] **Practice/salon profile schema with patient data**
- [ ] **Medical disclosure authorization schema (per-appointment scope)**
- [ ] **DTMF send tool for IVR menu navigation**
- [ ] **IVR hold-music passive listening (no LLM cost burn while on hold)** — biggest non-trivial item
- [ ] **Google Maps travel-time tool with multi-origin (home + Audi-Standort)**
- [ ] **Travel-time-aware slot selection logic in Director**
- [ ] **Fallback: politely terminate + Discord-escalate when practice insists on online portal**

### Add After Case 3 Validated (v1.3 — Stufe 5 Case 4 Inbound Negotiation)

- [ ] **Inbound whitelist (Telekom, Vodafone, major insurers — initial list pending Q-Sprint)**
- [ ] **Contract repository in Core with current conditions + history**
- [ ] **Live competitor web-search tool** (~30s budget within call)
- [ ] **Phishing/identity-mismatch heuristic** (counterpart claim vs. contract repo)
- [ ] **Authorized-disclosure list per counterpart category**
- [ ] **Calm-pressure-response phrase bank** ("Wenn das Angebot heute gut ist…")
- [ ] **Carsten takeover hotword (Q-Sprint: which word?)** with SIP REFER or audio-bridge
- [ ] **Structured result document (counterpart, offer, comparison, recommendation)**

### Add After Case 4 Validated (v2 — Stufe 6 Case 1 Hotel, deferred)

- [ ] **Web research tool for hotel candidates (top 3-5)**
- [ ] **Hotel-preference profile**
- [ ] **Multi-call campaign orchestrator with rate limit (max 1 inquiry+1 booking per hotel/day)**
- [ ] **Discord comparison-table renderer**
- [ ] **Outbound-to-Carsten (Case 6b) for go/no-go decision**
- [ ] **Online-booking link path (default; no credit-card-via-voice)**

### Future Consideration (v2+)

- [ ] **Eager EOT detection (Deepgram Flux pattern)** — pilot for further latency reduction
- [ ] **Smart voicemail (Case 5)** — explicitly deferred per spec, requires re-spec
- [ ] **Parallel multi-call campaigns (C1)** — currently sequential by spec; may revisit
- [ ] **LQI questionnaire automation (X9)** — defer until 1+ months production data
- [ ] **Privatnutzungs-heuristik flags (X10)** — defer

---

## Feature Prioritization Matrix

P1 = MVP (v1 must); P2 = next-case enabler; P3 = differentiator after stable; P4 = deferred / out-of-scope.

| Feature | User Value | Implementation Cost | Priority | Case |
|---------|------------|---------------------|----------|------|
| Native S2S Hot-Path P50 ≤900ms | HIGH | M (validated) | P1 | All |
| Barge-in <200ms | HIGH | M (validated) | P1 | All |
| Filler phrases on tool latency | HIGH | S | P1 | All |
| Silence timeout + polite farewell | HIGH | S | P1 | All |
| CLI-based inbound routing | HIGH | S | P1 | C4, C6 |
| Sideband WS context injection | HIGH | M (validated) | P1 | All |
| Frozen tool definitions per call | HIGH (avoid bug) | S (constraint) | P1 | All |
| Calendar tools with travel buffer | HIGH | M | P1 | C2, C3, C6 |
| Cost cap hard-kill | HIGH | S | P1 | All |
| ZDR + monthly audio audit | HIGH (legal) | M | P1 | All |
| Truthful "bin Bot" on direct ask | HIGH (legal) | S (persona) | P1 | All ext |
| Verbal-confirm before binding (C6) | HIGH (MOE-6) | S | P1 | C6 |
| Directional persona prompt | HIGH | S | P1 | All |
| Discord summary push | HIGH | S | P1 | All |
| Voicemail / AMD detection | HIGH | M | P2 | C1, C2, C3 |
| Voicemail-leave-no-message | HIGH | S | P2 | C1, C2, C3 |
| Retry scheduler with backoff | HIGH | M | P2 | C2, C3 |
| Tolerance-window config | HIGH | M | P2 | C2 |
| Per-case persona switching | HIGH | S-M | P2 | All |
| IVR DTMF support | MEDIUM | M | P2 | C2, C3 |
| IVR hold-music passive listening | HIGH (cost) | L | P2 | C3 |
| Travel-time-aware slot selection | HIGH | L | P2 | C3 |
| Authorized-disclosure schema | HIGH (privacy) | M | P2 | C3, C4 |
| Whitelist inbound routing | HIGH | S | P3 | C4 |
| Contract repository | HIGH | M | P3 | C4 |
| Live competitor web-search | HIGH (diff.) | L | P3 | C4 |
| Phishing/identity-mismatch | HIGH (safety) | M | P3 | C4 |
| Carsten takeover hotword | MEDIUM | L | P3 | C4 |
| Calm-pressure phrase bank | MEDIUM | S | P3 | C4 |
| Structured negotiation result doc | HIGH | M | P3 | C4 |
| Proactive callback (Case 6b) | HIGH (UX) | M | P3 | C6 |
| Hotel research tool | MEDIUM | L | P4 | C1 |
| Multi-call campaign orchestrator | MEDIUM | L | P4 | C1 |
| Eager EOT detection | LOW (incremental) | M | P4 | All |
| Smart voicemail (Case 5) | — | — | OUT | — |
| Parallel multi-call (C1) | LOW | L | OUT | C1 |
| Voice cloning Carsten | — (anti-feature) | — | OUT | All |
| Persistent audio recording | — (anti-feature) | — | OUT | All |
| Verbal contract commitment (C4) | — (anti-feature) | — | OUT | C4 |

---

## German-Language Voice Specifics (called out per quality gate)

### Politeness register (Sie-Form)

- **Default register: Sie** for all external counterparts (C1, C2, C3, C4). German business and service-context standard. Du-form to a strange MFA or Kellner = bot tell + rude.
- **Du-form only:** Case 6 (Carsten ↔ NanoClaw). Bot + user are familiar; Sie would feel artificial.
- **Switching:** if a counterpart proactively offers Du ("Sag du!"), the bot may switch — but should not initiate. Persona prompt directive: stay Sie unless explicitly invited otherwise.

### Persona conventions

- **Restaurant (C2):** friendly customer, no name dropped until staff asks. "Guten Tag, ich möchte gern einen Tisch reservieren …" is the canonical opener. (Spec Szene 2 step 3.)
- **Medical practice / hair salon (C3):** patient/customer, name + reason upfront because MFA always asks. "Guten Tag, hier Carsten Freek, ich brauche einen Termin für …" (spec Szene 3 step 3).
- **Hotel inquiry (C1):** efficient, precise about dates/room type. "Guten Tag, ich erkundige mich nach einem Doppelzimmer für …" (spec Szene 1 step 4).
- **Inbound negotiation (C4):** respond as the called party — first person, neutral. "Carsten Freek, hallo?" (spec Szene 4 step 1) — note this is identification of the line, not impersonation. Lawyer-review item Q-ConOps-6.
- **Carsten direct (C6):** intimate, brief. "Ja, Carsten?" (spec REQ-C6-01), "Hi Carsten, kurz wegen …" (REQ-C6-04). Du-form, name use OK.

### Filler vocabulary (German)

- **Acknowledgement / backchanneling:** "Mhm.", "Ja, genau.", "Verstehe.", "Ach so."
- **Stalling for tool latency:** "Einen Moment, ich schaue kurz nach.", "Sekunde bitte.", "Lass mich kurz prüfen."
- **Repeat-request (low STT confidence):** "Können Sie das bitte nochmal wiederholen?", "Habe ich Sie richtig verstanden …?"
- **Polite-decline (offer outside tolerance):** "Vielen Dank, das passt leider nicht — ich melde mich nochmal.", "Da muss ich nochmal Rücksprache halten."
- **Polite-farewell:** "Vielen Dank, einen schönen Tag noch. Auf Wiederhören.", "Danke, bis dann. Auf Wiedersehen."
- **Pressure-deflection (C4):** "Wenn das Angebot heute gut ist, ist es morgen auch gut." (spec REQ-C4-06). "Schicken Sie mir das bitte schriftlich, dann entscheide ich."
- **Bot-disclosure (on direct ask):** "Ja, ich bin ein KI-Assistent von Herrn Freek und führe dieses Gespräch für ihn." (spec PRD §8.3).

### Regional considerations

- **Hochdeutsch baseline** is fine. Most counterparts (German-speaking restaurants, practices, sales) speak business-Standard.
- **Bavarian / regional dialect from counterpart:** STT confidence may drop. Mitigation: polite "Können Sie das wiederholen?" up to 2× (spec Szene 2 edge case); after that, escalate to Carsten via Discord.
- **Munich-specific (Carsten's region):** Bavarian "Servus" greeting from counterpart is common; bot should NOT mirror with "Servus" (would feel forced for a Hochdeutsch-baseline bot). Stay with "Guten Tag" / "Auf Wiederhören".
- **Switzerland / Austria:** out of scope — Carsten's targets are German Sipgate-reachable numbers.

### Number / date / time pronunciation

- Numbers: bot must produce German-native ("zwanzig Uhr" not "20:00 Uhr" verbatim). gpt-realtime-mini handles this natively if prompted in German.
- Dates: "Freitag, der zweiundzwanzigste April" or "am Freitag, 22. April". Prefer named-day + day-of-month for restaurants/practices.
- Times: 24h ("zwanzig Uhr") for restaurants/medical (German convention), 12h-with-Uhrzeit for casual ("acht Uhr abends") in Case 6. Persona prompt should specify per-case.
- Phone numbers / IDs: pause-grouped ("null-vier-null, drei-zwei-eins …") not run-on. Practice patient-IDs are typically 5-7 digits.

### Disclosure phrasing (legal-sensitive)

The exact disclosure sentence is a Q-ConOps-6 lawyer-review item (PRD §9 open question). Two candidate forms surfaced from the spec:

1. **PRD §8.3 (active form):** "Ja, ich bin ein KI-Assistent von Herrn Freek und führe dieses Gespräch für ihn."
2. **Spec REQ-DISC-02 (delegating form, Case 2 example):** "Ja, ich bin ein KI-Assistent von Herrn Freek und reserviere für ihn."

Both meet truthfulness + non-impersonation. Final wording before first live external call.

---

## §201 StGB / EU AI Act Art. 50 Compliance Implications (called out per quality gate)

### §201 StGB (Vertraulichkeit des Wortes) — operational consequences

- **§201 is satisfied by architecture, not policy.** The legal mitigation is that no audio is recorded (RAM-only, released within 5s of session end). This must be enforced in code and verified monthly (REQ-QUAL-04).
- **Transcripts are OK** under DSGVO Haushaltsausnahme + berechtigtes Eigeninteresse (Gedächtnisstütze) — but only as text, never as audio (CONOPS §3.4).
- **OpenAI ZDR mode** is the provider-side enforcement that audio doesn't persist on OpenAI infrastructure. Validated as available (PROJECT.md "ZDR mode available on OpenAI Realtime"). Activation pending.
- **Implication for features:** ANY feature that would persist audio (call-recording for QA, voice-fingerprint authentication, audio re-listening for transcript correction) is hard-prohibited. Use STT confidence scores + transcript alone for auditability.

### EU AI Act Art. 50 — applicability & operational consequences

- **Art. 50 transparency obligations apply from 2 August 2026** (cross-checked: artificialintelligenceact.eu/article/50, ai-act-service-desk).
- **Spec position (CONOPS §3.4):** Art. 50 is **not applicable** in the private non-professional context (Deployer-definition Art. 3 Nr. 4 excludes purely personal activities; parallel to DSGVO Haushaltsausnahme).
- **Verification confidence:** MEDIUM — this is the spec's interpretation, supported by the Deployer-definition reasoning. Carsten's PRD §9 explicitly flags Q-ConOps-6 (lawyer plausibility check) before first live external call. **Treat as not-applicable until lawyer confirms; meanwhile, the architecture is Art. 50-friendly anyway** (passive disclosure + truthful answer on direct ask covers the "obvious from circumstances" exception in Art. 50).
- **Implication for features:** the passive-disclosure stance is the binding system behaviour regardless of Art. 50 applicability. If Art. 50 is ruled applicable for personal use, the only delta is: bot must **proactively** disclose at call start. Architecturally trivial (persona prompt change), but a UX/MOE-2 hit (counterparts may hang up more often).
- **Re-spec trigger:** any expansion to commercial use (calls on behalf of third parties, paid service, etc.) immediately invokes Art. 50 in full + DSGVO-pipeline. Spec is explicit about this hard boundary.

### Features that materially support compliance

- **No-audio-persistence enforcement** (REQ-INFRA-10) — §201 critical
- **Monthly filesystem audit for audio files** (REQ-QUAL-04) — §201 verification
- **OpenAI ZDR mode activation** — §201 provider-side
- **Truthful disclosure on direct ask** (REQ-DISC-02) — Art. 50-friendly + ethical baseline
- **Generic AI voice (no cloning)** (REQ-DISC-03) — OpenAI usage-policy + impersonation defense
- **Whitelist-only inbound (Variante 4-C)** — privacy of unintended callers (private callers don't accidentally talk to bot)
- **Per-counterpart authorized-disclosure schema** (C3, C4) — DSGVO data-minimization
- **Cost caps + monthly review** — operational accountability
- **No real-person impersonation phrasing** ("im Auftrag von Herrn Freek" not "ich bin Herr Freek") — Art. 50-friendly + consumer-protection law

---

## Sources

### Primary Spec Documents (load-bearing)

- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/CONOPS.md` v0.5 (E0 approved 2026-04-14)
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/REQUIREMENTS.md` v1.0 (approved 2026-04-15)
- `/home/carsten_bot/nanoclaw-state/voice-channel-spec/PRD.md` v1.0 (approved 2026-04-15)
- `/home/carsten_bot/nanoclaw-state/.planning/PROJECT.md` (initialized 2026-04-16)

### Production Voice-Agent Patterns (HIGH confidence — multiple converging sources)

- [Voice agents | OpenAI API](https://developers.openai.com/api/docs/guides/voice-agents) — DTMF over SIP, server_vad, auto_create_response
- [Introducing gpt-realtime — OpenAI](https://openai.com/index/introducing-gpt-realtime/) — production voice-agent updates
- [OpenAI Realtime VAD docs](https://platform.openai.com/docs/guides/realtime-vad) — server_vad config
- [Inside the Brain of a Voice AI: OpenAI Realtime and baresip — Sipfront, Jan 2026](https://sipfront.com/blog/2026/01/baresip-openai-realtime-voicebot-deepdive/) — SIP integration deep-dive
- [Twilio: Core Latency in AI Voice Agents](https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents) — sub-1s benchmarks
- [Deepgram: Optimize Voice Agent Latency with Eager End of Turn](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot) — smart EOT pattern
- [12 Ways to Reduce Voice Agent Latency — getbluejay.ai](https://getbluejay.ai/blog/12-ways-to-reduce-voice-agent-latency)
- [Voice Agents in 2026 — Retell AI](https://www.retellai.com/blog/ai-voice-agents-in-2026) — barge-in, backchanneling, filler phrases
- [AI Voice Agent Interruption Handling Guide 2026 — CallBotics](https://callbotics.ai/blog/ai-voice-agent-interruption-handling)
- [2026 Guide to Outbound Voice AI Calling — Telnyx](https://telnyx.com/resources/outbound-voice-ai)
- [AI Outbound Calling in 2026 — OneAI](https://oneai.com/learn/ai-outbound-calling-guide)

### Voicemail / AMD (MEDIUM-HIGH confidence)

- [Demystifying AMD — Regal AI](https://www.regal.ai/blog/demystifying-amd-how-answering-machine-detection-algorithms-actually-work) — algorithm detail
- [Twilio Answering Machine Detection](https://www.twilio.com/docs/voice/answering-machine-detection) — production reference
- [What is Voicemail Detection in AI Voice Agents — Vaanix](https://vaanix.ai/blog/what-is-voice-mail-detection-in-ai-voice-agents)
- [How AMD Speed and Accuracy Boost Contact Rates — Convoso](https://www.convoso.com/blog/voicemail-detection-boosts-contact-rates/)

### Healthcare / Appointment-Booking Patterns (MEDIUM confidence)

- [Voice AI for Healthcare Appointment Scheduling — Droidal](https://droidal.com/blog/voice-ai-healthcare-appointment-scheduling-guide/)
- [AI Voice Agents in Healthcare — Parloa](https://www.parloa.com/blog/ai-voice-agents-in-healthcare/)
- [Top 8 AI Voice Agents for Appointment Scheduling — Retell AI](https://www.retellai.com/blog/top-8-ai-voice-agents-for-appointment-scheduling-in-clinics-and-healthcare)
- [Medical Voice AI Agents 2026 — Greetmate](https://www.greetmate.ai/blog/medical-voice-ai-agents-2026-state-of-market)

### Negotiation / Sales-Bot Patterns + Counter-Tactics (MEDIUM confidence)

- [Advancing AI Negotiations — arXiv 2503.06416](https://arxiv.org/html/2503.06416v2) — Inject+Voss exploitation pattern
- [16 Negotiation Tactics Buyers Use — Rain Sales Training](https://www.rainsalestraining.com/blog/16-negotiation-tactics-buyers-use-and-how-to-respond) — anchoring, scarcity, time-pressure
- [AI Negotiation Agents: What Actually Works — Medium / Fabio Herle](https://medium.com/@fabioherle/building-autonomous-negotiations-that-actually-work-lessons-from-180-098-ai-negotiations-805a2f8798a4) — 180k production negotiations
- [Secondus Real-Time Negotiation Copilot — Devpost](https://devpost.com/software/secondus-real-time-negotiation-copilot) — pressure-tactic detection

### Failure Modes / Hallucinations (MEDIUM confidence)

- [Gladia: Safety, hallucinations and guardrails](https://www.gladia.io/blog/safety-voice-ai-hallucinations) — voice-AI grounding
- [7 AI Agent Failure Modes — Galileo](https://galileo.ai/blog/agent-failure-modes-guide)
- [Voice agents and Conversational AI 2026 trends — ElevenLabs](https://elevenlabs.io/blog/voice-agents-and-conversational-ai-new-developer-trends-2025)
- [Voice Agent Evaluation Metrics — Hamming AI](https://hamming.ai/resources/voice-agent-evaluation-metrics-guide)

### Legal / DE Compliance (MEDIUM-HIGH confidence — sources are authoritative legal-info sites)

- [Article 50: Transparency Obligations — EU AI Act](https://artificialintelligenceact.eu/article/50/) — official text
- [AI Act Service Desk Article 50](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50) — EC reference
- [Limited-Risk AI: Deep Dive into Article 50 — WilmerHale](https://www.wilmerhale.com/en/insights/blogs/wilmerhale-privacy-and-cybersecurity-law/20240528-limited-risk-ai-a-deep-dive-into-article-50-of-the-european-unions-ai-act)
- [Germany Recording Laws — RecordingLaw.com](https://recordinglaw.com/germany-recording-laws/) — §201 StGB two-party consent
- [Covert Audio Recordings are illegal in Germany — Cross Channel Lawyers](https://www.crosschannellawyers.co.uk/covert-audio-recordings-are-illegal-in-germany/)
- [Telephone call recording laws — Wikipedia](https://en.wikipedia.org/wiki/Telephone_call_recording_laws) — DE country entry
- [Die Haushaltsausnahme der DSGVO — dr-datenschutz.de](https://www.dr-datenschutz.de/die-haushaltsausnahme-der-dsgvo/)
- [Wann gilt die DSGVO für Privatpersonen? — dr-datenschutz.de](https://www.dr-datenschutz.de/wann-gilt-die-dsgvo-fuer-privatpersonen/)
- [Anwendbarkeit der DSGVO — Reichweite und Grenzen der Haushaltsausnahme — Aigner](https://aigner-business-solutions.com/blog/anwendbarkeit-der-datenschutzgrundverordnung-reichweite-und-grenzen-der-haushaltsausnahme/)

### German Voice / Persona (MEDIUM confidence)

- [German AI Voice Agents — Autocalls](https://autocalls.ai/language/german)
- [Voice AI Agent in German — Zudu](https://zudu.ai/language/voice-ai-agent-in-german/)
- [German Voice AI Testing — Hamming](https://hamming.ai/language/german) — Du/Sie register validation
- [German Phone Call Vocabulary — Transparent Language](https://blogs.transparent.com/german/german-phone-call-vocabulary/)
- [Mastering German Telephone Conversation — Talkpal](https://talkpal.ai/mastering-german-telephone-conversation-essential-phrases-for-clear-communication/)

### Proactive / Hands-Free Patterns (MEDIUM confidence)

- [Mercedes-Benz "Hey Mercedes" — IEEE Spectrum](https://spectrum.ieee.org/ai-enabled-vehicle-assistant) — proactive vehicle assistant
- [Lindy AI Voice Assistants 2026](https://www.lindy.ai/blog/best-ai-voice-assistants) — proactive notifications pattern
- [Vocalis (GitHub)](https://github.com/shaakz/vocalis) — open-source S2S with AI-initiated follow-ups

---

## Confidence Caveats

- **HIGH confidence:** Production voice-agent table-stakes patterns (latency, barge-in, filler phrases, AMD, IVR DTMF, silence timeout, polite hangup). Multiple converging commercial sources + OpenAI Realtime official docs.
- **MEDIUM-HIGH confidence:** German legal framing — §201 StGB two-party-consent is well-established (Wikipedia, Cross-Channel-Lawyers, RecordingLaw.com). DSGVO Haushaltsausnahme broadly understood (multiple DE-legal sources). EU AI Act Art. 50 personal-use exemption is the spec's interpretation; lawyer review pending (Q-ConOps-6).
- **MEDIUM confidence:** Negotiation counter-tactics — research sources are mixed (commercial sales-bot vendors + arXiv research). Translatable to NanoClaw because the spec mandates a defensive (not offensive) bot stance.
- **MEDIUM confidence:** Personal-use-specific patterns (proactive callback, hands-free assistant) — primary signal is Mercedes-style automotive assistants and Lindy/Copilot, not direct phone-agent products. Extrapolation reasonable but not directly proven for the C6b pattern.
- **LOW-to-MEDIUM confidence:** IVR hold-music passive listening — implementation details are platform-specific and not well-documented in public sources. Likely needs phase-specific research / spike when Case 3 lands.
- **LOW confidence (flagged for phase-specific research):** Sipgate-specific AMD reliability for German voicemail systems; SIP REFER vs. audio-bridge for C4 takeover hotword; Google Maps multi-origin travel-time API quotas.

---

*Feature research for: NanoClaw Voice — personal AI phone agent (DE, private use)*
*Researched: 2026-04-16*
