---
name: voice-outbound
description: Route outbound phone-call requests to the correct NanoClaw voice MCP tool. Use whenever Carsten wants to reach someone by phone, book an appointment, make a reservation, or request a callback. Picks voice_start_case_2_call for restaurant reservations, voice_request_outbound_call for everything else.
---

# Voice-outbound — phone-call dispatch

You have two MCP tools on the `nanoclaw-voice` server for triggering outbound calls. You dispatch — you do NOT talk on the phone yourself. A separate voice AI conducts the conversation autonomously and sends a summary back to this chat when the call ends.

**Never say "I cannot make calls".** You CAN and MUST use one of these two tools.

## Tool 1 — `mcp__nanoclaw-voice__voice_start_case_2_call`

**USE FOR: restaurant reservations only.** Italiener, Pizzeria, Bistro, Lokal, Steakhouse — anything where Carsten wants a table booked.

| Arg | Type | Notes |
|---|---|---|
| `restaurant_name` | string | e.g. "Bella Vista" |
| `restaurant_phone` | E.164 string | e.g. `+491708036426` — required exact format |
| `requested_date` | ISO YYYY-MM-DD | convert relative ("heute", "Donnerstag") first |
| `requested_time` | HH:MM | 24-hour, e.g. `19:00` |
| `party_size` | int | number of people |
| `time_tolerance_min` | int (default 30) | usually omit |
| `party_size_tolerance` | int (default 0) | usually omit |
| `notes` | string (optional) | "draußen", "ruhig", "Allergie: Nuss", etc. |
| `source_address` | string (optional) | Carsten's origin for travel-buffer calc |
| `report_to_jid` | string | THIS chat's JID — Discord `dc:<snowflake>` or WhatsApp E.164 |

### Why this tool for restaurants

- D-5 structured args — Zod-validated at MCP boundary
- D-7 idempotency — sha256 hash on `(restaurant_phone, requested_date, requested_time, party_size)` prevents double-booking across channels / sessions
- AMD voicemail-gate — bot detects + skips mailboxes automatically
- Retry ladder — 5/15/45/120-min schedule on no-answer / busy, 5/day cap
- Case-2-persona with tolerance negotiation built in

## Tool 2 — `mcp__nanoclaw-voice__voice_request_outbound_call`

**USE FOR: everything else.** Dentist, hairdresser, Carsten callback, any generic phone task that's not a restaurant reservation.

| Arg | Type | Notes |
|---|---|---|
| `target_phone` | E.164 string | required exact format |
| `goal` | string ≤500 chars | what the bot should achieve — be specific + mention Carsten |
| `context` | string ≤2000 chars (optional) | background the bot should know |
| `report_to_jid` | string | THIS chat's JID |
| `call_id` | string (optional) | UUID for idempotency if user wants re-safe call |

### Why this tool for non-restaurants

- Generic persona — follows the `goal` text as brief
- No specialized AMD / retry / idempotency — one-shot dispatch

## Routing examples

| User says | Tool | Why |
|---|---|---|
| "Rufe Restaurant Bella Vista unter +4917... an und reserviere heute 19 Uhr für 2" | `voice_start_case_2_call` | restaurant + booking = Case-2 |
| "Buch einen Tisch bei Il Giardino, Donnerstag 20:00, 4 Personen, draußen" | `voice_start_case_2_call` | restaurant reservation |
| "Ruf meinen Zahnarzt an, +49891234567, und buche Dienstag 15 Uhr" | `voice_request_outbound_call` | non-restaurant appointment |
| "Ruf mich nochmal an unter +49170..." | `voice_request_outbound_call` | callback |
| "Frag den Audi-Service unter +49..., ob mein Auto fertig ist" | `voice_request_outbound_call` | generic inquiry |
| "Ruf das Eiscafé an und bestell Eis zum Mitnehmen" | `voice_request_outbound_call` | NOT a reservation — delivery/takeaway, generic call |

## How to find `report_to_jid`

`report_to_jid` is where the bot posts the summary when the call ends. It's THIS chat:

- If this chat's folder name starts with `discord_` → `dc:<channel_snowflake>` (the channel ID of the current group).
- If the folder starts with `whatsapp_` or is a WhatsApp-main/DM → the group/DM's E.164-formatted JID.
- `main` (general Discord main channel) → `dc:1490365616518070407`.

If unsure, re-use the JID format you see in the conversation metadata.

## Phone-number normalisation

Both tools require strict E.164 (starts with `+`, digits only after). Users often type with spaces/dashes (`+49 170 803 6426`). Strip ALL whitespace and dashes BEFORE passing:

- `+49 170 8036426` → `+491708036426` ✓
- `0170 8036426` → reject with "Bitte gib eine internationale Nummer mit +49..." — don't guess country code
- `+1-555-123-4567` → `+15551234567` ✓

## Never mix the tools

If Carsten says "Restaurant" anywhere in the request, USE `voice_start_case_2_call`. Don't fall back to `voice_request_outbound_call` with `goal="Reserviere bei Bella Vista"` — that skips AMD, idempotency, and retry logic. The specialised tool exists for a reason.
