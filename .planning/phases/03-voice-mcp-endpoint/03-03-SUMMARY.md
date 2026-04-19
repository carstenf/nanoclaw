---
phase: 03-voice-mcp-endpoint
plan: "03"
subsystem: mcp-tools/calendar
tags:
  - mcp-tools
  - google-calendar
  - voice-tools
  - case-6
dependency_graph:
  requires:
    - "03-01"
    - "03-02"
  provides:
    - voice.check_calendar MCP tool
    - voice.create_calendar_entry MCP tool
  affects:
    - src/mcp-tools/index.ts (buildDefaultRegistry)
    - src/config.ts (GCALENDAR_* constants)
tech_stack:
  added:
    - zod (^3.x, input validation)
  patterns:
    - OAuth2 auto-refresh with atomic tmp+rename token persistence
    - AbortController timeout (10s) for Google API calls
    - PII-free JSONL logging (no summary/description/attendees in log)
key_files:
  created:
    - src/mcp-tools/calendar-client.ts
    - src/mcp-tools/calendar-client.test.ts
    - src/mcp-tools/voice-check-calendar.ts
    - src/mcp-tools/voice-check-calendar.test.ts
    - src/mcp-tools/voice-create-calendar-entry.ts
    - src/mcp-tools/voice-create-calendar-entry.test.ts
  modified:
    - src/config.ts (GCALENDAR_* constants)
    - src/mcp-tools/index.ts (registry wiring)
decisions:
  - "Throw BadRequestError (not return ok:false) for validation errors — mcp-server.ts maps to 400"
  - "Force refreshAccessToken() when access_token empty/expiry_date=0 (token file post-initial-auth state)"
  - "Register oauth tokens listener BEFORE refreshAccessToken() call so new tokens are persisted"
  - "zod installed as new dependency (not in package.json before 03-03)"
metrics:
  duration: "~40 minutes (incl. OAuth re-auth gate)"
  completed_date: "2026-04-17"
  tasks_completed: 5/5
  files_created: 6
  files_modified: 2
  tests_added: 17
---

# Phase 03 Plan 03: calendar-client + voice.check_calendar + voice.create_calendar_entry

**One-liner:** Google Calendar MCP tools (check + create) with OAuth2 auto-refresh, zod validation, JSONL audit log — E2E smoke PASS from Hetzner.

**Status:** DONE — alle 5 Tasks ausgefuehrt, E2E-Smoke PASS.

**Commits (nanoclaw repo):**
- `320f972` — feat(03-03): calendar-client.ts — OAuth2 + auto-refresh + atomic token persistence
- `e063a9b` — feat(03-03): voice-check-calendar.ts — zod validation + events.list + JSONL + tests
- `188abde` — feat(03-03): voice-create-calendar-entry.ts — zod validation + events.insert + JSONL + tests
- `d482afa` — feat(03-03): wire calendar tools into config + buildDefaultRegistry
- `868d7e0` — fix(03-03): calendar-client — force refresh when access_token empty/stale

---

## Was gebaut wurde

| Modul | Datei | Zweck |
|---|---|---|
| Calendar-Client | `src/mcp-tools/calendar-client.ts` | `getCalendarClient()` — OAuth2 init, setCredentials, atomic token persistence via `on('tokens')`, force-refresh when token stale |
| Check-Handler | `src/mcp-tools/voice-check-calendar.ts` | `makeVoiceCheckCalendar()` — zod validation, `events.list`, AbortController timeout, JSONL `calendar_check_done` |
| Create-Handler | `src/mcp-tools/voice-create-calendar-entry.ts` | `makeVoiceCreateCalendarEntry()` — zod validation, `events.insert`, JSONL `calendar_create_done` |
| Config | `src/config.ts` | 5 neue GCALENDAR_* Konstanten (CREDS_PATH, TOKENS_PATH, DEFAULT_TZ, DEFAULT_CAL_ID, TIMEOUT_MS) |
| Registry | `src/mcp-tools/index.ts` | `voice.check_calendar` + `voice.create_calendar_entry` in `buildDefaultRegistry` |

---

## Test-Matrix (17 neue Tests, alle gruen)

| Suite | Cases | Inhalt |
|---:|---:|---|
| `calendar-client.test.ts` | 5 | happy, tokens-listener, atomic-tmp+rename, creds-missing, tokens-missing |
| `voice-check-calendar.test.ts` | 6 | happy, invalid-dates, end<=start, timeout, jsonl-pii, null-call_id |
| `voice-create-calendar-entry.test.ts` | 6 | happy, empty-summary, end<=start, invalid-attendee, jsonl-pii, optional-fields |

`npx tsc --noEmit` clean. Full suite: 388 passed / 1 failed (pre-existing gmail, unrelated).

---

## Live Smoke-Evidence (Task 5, von Hetzner 10.0.0.1)

### Pre-Check (busy count = 0)

```bash
curl -s -X POST http://10.0.0.2:3200/mcp/voice.check_calendar \
  -H 'Content-Type: application/json' \
  -d '{"arguments":{"call_id":"smoke-03-03","timeMin":"2026-04-17T22:52:35Z","timeMax":"2026-04-18T22:52:35Z"}}'
```
```json
{"ok":true,"result":{"ok":true,"result":{"busy":[]}}}
```

### Create Entry

```bash
curl -s -X POST http://10.0.0.2:3200/mcp/voice.create_calendar_entry \
  -H 'Content-Type: application/json' \
  -d '{"arguments":{"call_id":"smoke-03-03","summary":"NanoClaw-Smoke 03-03","start":"2026-04-18T00:52:41Z","end":"2026-04-18T01:52:41Z"}}'
```
```json
{"ok":true,"result":{"ok":true,"result":{"eventId":"69quqkt444i5e6rptcnlgiqn38","htmlLink":"https://www.google.com/calendar/event?eid=NjlxdXFrdDQ0NGk1ZTZycHRjbmxnaXFuMzggY2Fyc3Rlbi5mcmVlazJAbQ"}}}
```

**eventId:** `69quqkt444i5e6rptcnlgiqn38`

### Re-Check (busy count = 1, +1 delta)

```json
{"ok":true,"result":{"ok":true,"result":{"busy":[{"eventId":"69quqkt444i5e6rptcnlgiqn38","start":"2026-04-18T00:52:41Z","end":"2026-04-18T01:52:41Z","summary":"NanoClaw-Smoke 03-03"}]}}}
```

### JSONL Log (tail -5 data/voice-calendar.jsonl)

```
{"ts":"2026-04-17T22:52:36.794Z","event":"calendar_check_done","call_id":"smoke-03-03","tool":"voice.check_calendar","latency_ms":326,"result_count":0,"calendar_id":"primary"}
{"ts":"2026-04-17T22:52:42.733Z","event":"calendar_create_done","call_id":"smoke-03-03","tool":"voice.create_calendar_entry","latency_ms":761,"event_id":"69quqkt444i5e6rptcnlgiqn38","calendar_id":"primary"}
{"ts":"2026-04-17T22:52:49.262Z","event":"calendar_check_done","call_id":"smoke-03-03","tool":"voice.check_calendar","latency_ms":336,"result_count":1,"calendar_id":"primary"}
```

**Latencies:** check_calendar 326ms, create_calendar_entry 761ms, re-check 336ms.

**Smoke-Event-Cleanup:** `69quqkt444i5e6rptcnlgiqn38` ist ein Dummy-Termin (NanoClaw-Smoke 03-03, 2026-04-18 00:52-01:52 UTC). Kann manuell via Google Calendar Web geloescht werden — kein neues Tool noetig.

---

## OAuth-Refresh-Nachtrag (Auth-Gate)

**Was passierte:** `tokens.json` enthielt einen revoked `refresh_token` (1//03phBWM...). `invalid_grant` beim ersten Auto-Refresh-Versuch. Task 5 blockiert.

**Ursache:** Google revoked den Refresh-Token wegen Inaktivitaet der OAuth-App (> 6 Monate kein Zugriff) oder weil der App-Consent zurueckgezogen wurde.

**Loesung:** Manueller OOB-OAuth-Flow (Authorization-Code-Exchange im Browser, Token-File via tmp+rename atomar geschrieben).

**Caveat fuer Betrieb:**
- `tokens.json` muss periodisch geprueft werden: `cat ~/.gcalendar-mcp/google-calendar-mcp/tokens.json | python3 -m json.tool`
- Google kann Refresh-Tokens jederzeit revoken (App-Inaktivitaet, Passwortaenderung, Consent-Entzug, max. 50 Tokens pro User/App)
- Wenn `invalid_grant` auftritt: neuer Browser-OAuth-Flow noetig (Schritte aus der alten SUMMARY stehen im Auth-Gate-Dokument)
- Empfehlung: Monitoring-Skript, das woechentlich einen kleinen `events.list`-Call macht und bei `invalid_grant` einen Discord-Alert sendet

---

## Abweichungen vom Plan

### [Rule 1 - Bug] Token-File hat leeren access_token + expiry_date=0
- **Found during:** Task 05 (Live-Deploy Smoke)
- **Issue:** `tokens.json` enthielt `access_token: ""`, `expiry_date: 0`. googleapis erkennt das Token nicht als abgelaufen und sendet den leeren String direkt -> `invalid_grant`
- **Fix:** `calendar-client.ts` prueft auf `!access_token || expiry_date === 0` und ruft `refreshAccessToken()` explizit vor dem Return. Listener wird VOR dem Refresh registriert damit neue Tokens persistiert werden.
- **Files modified:** `src/mcp-tools/calendar-client.ts`
- **Commit:** `868d7e0`

### [Rule 3 - Blocking] zod nicht in package.json
- **Found during:** Task 02 implementation
- **Issue:** Plan sagte "zod verwenden" aber zod war kein Dependency
- **Fix:** `npm install zod` — neue Dependency hinzugefuegt
- **Files modified:** `package.json`, `package-lock.json`
- **Commit:** `e063a9b`

### Auth-Gate: Google OAuth refresh_token revoked (resolved)
- **Found during:** Task 05 (Live-Deploy Smoke)
- **Type:** `human-action` — Browser-OAuth-Flow notwendig
- **Resolution:** Carsten fuehrte OOB-Flow manuell aus, neues `access_token` + `refresh_token` in `tokens.json` geschrieben, nanoclaw restartet, Smoke PASS.

---

## Self-Check

- `src/mcp-tools/calendar-client.ts` — EXISTS
- `src/mcp-tools/voice-check-calendar.ts` — EXISTS
- `src/mcp-tools/voice-create-calendar-entry.ts` — EXISTS
- `src/config.ts` GCALENDAR_* constants — EXISTS
- `src/mcp-tools/index.ts` voice.check_calendar + voice.create_calendar_entry — EXISTS
- Commits 320f972, e063a9b, 188abde, d482afa, 868d7e0 — ALL IN nanoclaw repo
- Smoke check_calendar pre: busy=0, post: busy=1 (delta +1) — VERIFIED
- eventId 69quqkt444i5e6rptcnlgiqn38 in both create response and re-check busy list — VERIFIED
- JSONL: calendar_check_done + calendar_create_done with latency_ms set, call_id=smoke-03-03 — VERIFIED

## Self-Check: PASSED (all 5 tasks)

---

## Next: Plan 03-04

Plan 03-04: `voice.send_discord_message` MCP tool — sendet Nachrichten via Discord-MCP an einen konfigurierten Channel (z.B. fuer Gespraechszusammenfassungen nach dem Call).
