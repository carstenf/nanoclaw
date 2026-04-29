---
name: voice-outbound
description: Route any outbound phone-call request to the unified voice MCP tool `voice_request_outbound_call`. Use whenever Carsten wants to reach someone by phone — restaurant reservations, doctor appointments, callbacks, generic inquiries. ONE tool covers all cases.
---

# Voice-outbound — phone-call dispatch

You have ONE MCP tool on the `nanoclaw-voice` server for triggering outbound calls: **`mcp__nanoclaw-voice__voice_request_outbound_call`**.

You dispatch — you do NOT talk on the phone yourself. A separate voice AI (Sonnet 4.6 / OpenAI Realtime) conducts the conversation autonomously and sends a summary back to this chat when the call ends.

**Never say "I cannot make calls".** You CAN and MUST use this tool.

## Tool — `mcp__nanoclaw-voice__voice_request_outbound_call`

**USE FOR: every outbound call.** Restaurants, doctors, hairdressers, callbacks, generic inquiries — everything.

| Arg | Type | Notes |
|---|---|---|
| `target_phone` | E.164 string | required exact format, e.g. `+491708036426` |
| `goal` | string ≤ 500 chars | what the bot should achieve — be specific + mention Carsten + include all booking details (date, time, party size, etc.) |
| `counterpart_label` | string ≤ 120 chars (optional) | who is being called: `"Restaurant Bella Vista"`, `"Praxis Dr. Müller"`, `"Tante Anke"`. Used by the persona to greet naturally. |
| `context` | string ≤ 2000 chars (optional) | background the bot should know |
| `report_to_jid` | string | THIS chat's JID — Discord `dc:<snowflake>` or WhatsApp E.164 |
| `lang` | `"de"` \| `"en"` \| `"it"` (optional) | persona/voice language for the call. Omit for German (default). Pick from cues — Italian restaurant, English-speaking contact, etc. |
| `lang_whitelist` | `("de"\|"en"\|"it")[]` (optional, max 5) | Allowed languages the bot may switch to mid-call when the counterpart insists on a different language. Read from Carstens current "travel-mode" Hindsight memory (e.g. in Italien → `["de","en","it"]`, in Frankreich → `["de","en"]`). Omit when in stable single-lang context. |
| `call_id` | string (optional) | UUID for idempotency if Carsten wants re-safe call |

### Goal-text guidance

The voice bot reads `goal` as its brief. **Sonnet 4.6 is fully capable of handling any conversation context out of the box** — restaurant negotiation, appointment booking, callbacks, inquiries — provided the goal text contains the necessary details.

**Format the goal precisely with all relevant facts:**

- ✅ "Tisch reservieren für Carsten am Mittwoch 30.4. um 19:00 für 4 Personen, gerne draußen"
- ✅ "Termin beim Zahnarzt buchen für Carsten, Dienstag oder Mittwoch nächste Woche, vormittags"
- ✅ "Bei Audi-Service nachfragen ob Carstens Wagen fertig ist (Bestellnummer abfragen kann der Bot)"
- ✅ "Tante Anke Bescheid sagen dass Carsten 30 Minuten später kommt"
- ❌ "Anrufen" (zu vage)
- ❌ "Reservierung" (zu vage)

**For restaurant reservations specifically:** include the date in absolute form (YYYY-MM-DD), time (HH:MM), and party size in the `goal` text. The bot handles tolerance negotiation, voicemail detection, and politeness conventions on its own.

### Picking `lang`

Default is `de` (omit the field). Set `lang` only when the called party is unlikely to speak German fluently.

- Italian-named restaurant in Germany (e.g. "Il Giardino" in Munich) → still `de`. The staff almost certainly speaks German; switching to `it` would be jarring.
- Restaurant or contact actually located abroad — Italian +39, French +33, UK +44 — → use the local language. `+39…` Italian restaurant → `lang: 'it'`. `+44…` UK contact → `lang: 'en'`.
- Carsten explicitly says "ruf auf Englisch an" / "auf Italienisch" / similar → use that language.
- When the goal text is in English/Italian, that's a strong signal — match `lang` to it.
- Unsure? Default to `de` and let Carsten correct. Wrong-lang call wastes everyone's time more than wrong-greeting.

### Picking `lang_whitelist` — IMMER setzen

In deiner Group-Memory `/workspace/group/CLAUDE.md` steht eine Zeile:

```
Voice langs: de, en, it
```

**MUSS-REGEL:** Bei JEDEM `voice_request_outbound_call` parsed du diese Zeile + setzt `lang_whitelist` als Array — immer, ohne Ausnahme. Auch wenn Carsten Multilingual nicht erwaehnt, auch wenn der Call "nur deutsch" wirkt. Begruendung: die Liste ist Carstens stehende Praeferenz, nicht eine pro-Call-Frage.

- `Voice langs: de, en, it` → `lang_whitelist: ["de","en","it"]`
- `Voice langs: de` → `lang_whitelist: ["de"]`
- Zeile fehlt komplett → `lang_whitelist: ["de"]` (sicheres Default)

**Wenn Carsten die Liste in normaler Konversation aendern moechte** — z.B. *"nur Deutsch"*, *"Italienisch raus"*, *"alle drei wieder an"*, *"setz Voice-Sprachen auf de en"* — aktualisiere die Zeile per `Write` und bestaetige knapp. Keine Reise-Modi, keine Hindsight-Eintraege, kein extra State — nur die eine Zeile.

Server-side enforcement: `voice_set_language` rejects off-list switches mit `lang_not_in_whitelist`, also kann der Call selbst bei falsch gesetztem `lang_whitelist` nicht in unsupported Sprachen driften.

The persona, all SCHWEIGEN nudges, voice tone, and whisper transcription pin to `lang` for the entire call. Goal text doesn't have to be translated — the bot speaks `lang`, the goal is just your brief.

### Routing examples (alle nutzen DAS GLEICHE Tool)

| User says | counterpart_label | goal | lang |
|---|---|---|---|
| "Rufe Restaurant Bella Vista unter +4917... an und reserviere heute 19:00 für 2" | `"Restaurant Bella Vista"` | `"Tisch reservieren für Carsten heute 2026-04-28 um 19:00 für 2 Personen"` | omit (de) |
| "Buch Tisch bei Il Giardino in Mailand +39..., Donnerstag 20:00, 4 Personen" | `"Ristorante Il Giardino"` | `"Tisch reservieren für Carsten am Donnerstag 2026-05-01 um 20:00 für 4 Personen"` | `'it'` |
| "Ruf Zahnarzt an, +49891234567, buche Dienstag 15 Uhr" | `"Zahnarztpraxis"` | `"Termin für Carsten am Dienstag 2026-04-29 um 15:00, falls möglich vormittags als Alternative"` | omit (de) |
| "Ring the London hotel +44... about my booking next week" | `"Hotel London"` | `"Carsten asks the hotel to confirm his booking for next week and any room-upgrade options"` | `'en'` |
| "Ruf das Eiscafé an und bestell Eis zum Mitnehmen" | `"Eiscafé"` | `"Carsten bestellt 4 Eis zum Mitnehmen, Abholung in 20 Minuten"` | omit (de) |
| "Frag Audi-Service ob mein Auto fertig ist" | `"Audi-Service"` | `"Bei Audi-Service nachfragen, ob Carstens Wagen abholbereit ist; bei nein nach Termin fragen"` | omit (de) |

## How to find `report_to_jid`

`report_to_jid` is where the bot posts the summary when the call ends. It's THIS chat:

- If this chat's folder name starts with `discord_` → `dc:<channel_snowflake>` (the channel ID of the current group).
- If the folder starts with `whatsapp_` or is a WhatsApp-main/DM → the group/DM's E.164-formatted JID.
- `main` (general Discord main channel) → `dc:1490365616518070407`.

If unsure, re-use the JID format you see in the conversation metadata.

## Phone-number normalisation

Strict E.164 (starts with `+`, digits only after). Users often type with spaces/dashes (`+49 170 803 6426`). Strip ALL whitespace and dashes BEFORE passing:

- `+49 170 8036426` → `+491708036426` ✓
- `0170 8036426` → reject with "Bitte gib eine internationale Nummer mit +49..." — don't guess country code
- `+1-555-123-4567` → `+15551234567` ✓

## DEPRECATED: `voice_start_case_2_call`

There is also a legacy tool `voice_start_case_2_call` for restaurant reservations. **Do NOT use it.** It's kept temporarily for backwards compatibility but is being retired (open_points 2026-04-28 #2 — Case 1+2 merge). Always prefer `voice_request_outbound_call`.

If you accidentally see Carsten say "starte Case-2" or similar — that's the legacy phrasing. Translate it to a regular `voice_request_outbound_call` with appropriate goal text.
