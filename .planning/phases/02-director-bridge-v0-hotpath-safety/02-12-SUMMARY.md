---
phase: 02-director-bridge-v0-hotpath-safety
plan: 12
subsystem: voice-bridge
tags: [voice-bridge, allowlist, dispatch, json-schema, ask_core, get_travel_time, tdd]

requires:
  - phase: 02-11
    provides: async MCP-forward dispatch, allowlist with 9 tools, TOOL_TO_CORE_MCP mapping
  - phase: 03-05
    provides: voice.get_travel_time core-side MCP tool live
  - phase: 03-08
    provides: voice.ask_core core-side MCP tool live

provides:
  - ask_core + get_travel_time wired into bridge allowlist (11 tools total)
  - dispatch TOOL_TO_CORE_MCP mappings for voice.ask_core + voice.get_travel_time
  - JSON schemas for both tools (draft-07, additionalProperties: false)
  - Bridge deploys with tools_count=11, all 8 core tools now dispatchable

affects: [03-pstn-test, voice-bridge-ops]

tech-stack:
  added: []
  patterns:
    - "New bridge tools follow pattern: schema JSON + allowlist ENTRY + dispatch TOOL_TO_CORE_MCP"

key-files:
  created:
    - voice-bridge/src/tools/schemas/ask_core.json
    - voice-bridge/src/tools/schemas/get_travel_time.json
  modified:
    - voice-bridge/src/tools/allowlist.ts
    - voice-bridge/src/tools/dispatch.ts
    - voice-bridge/tests/allowlist.test.ts
    - voice-bridge/tests/dispatch.test.ts
    - voice-bridge/tests/accept.test.ts

key-decisions:
  - "ask_core topic field uses ^[a-z0-9_-]+$ pattern, maxLength 64 — matches naming convention of other tools"
  - "get_travel_time mode defaults to 'driving', departure_time optional string (no date validation to keep schema simple)"
  - "accept.test.ts tool-list/count updated as part of this plan (was hardcoded at 9)"

patterns-established:
  - "Bridge tool addition checklist: schema JSON -> allowlist import+ENTRY -> dispatch TOOL_TO_CORE_MCP -> test updates (allowlist count, getEntry, dispatch happy-path, accept.test tool list)"

requirements-completed: [TOOLS-08, TOOLS-10, DIR-11, C6-02]

duration: 15min
completed: 2026-04-18
---

# Phase 02 Plan 12: Bridge-Wireup-Nachtrag ask_core + get_travel_time Summary

**ask_core + get_travel_time bridge-seitig vollstaendig verdrahtet: 2 JSON-Schemas, 2 allowlist-Eintraege, 2 dispatch-Mappings, 8 neue Tests — bridge laeuft mit tools_count=11**

## Performance

- **Duration:** 15 min
- **Started:** 2026-04-18T11:37:00Z
- **Completed:** 2026-04-18T11:41:00Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- 2 JSON-Schemas (ask_core, get_travel_time) nach draft-07, additionalProperties:false
- allowlist.ts: 9 → 11 Entries, beide mutating:false, REQ-TOOLS-09 ceiling 15 noch 4 spare
- dispatch.ts: `ask_core: 'voice.ask_core'`, `get_travel_time: 'voice.get_travel_time'` in TOOL_TO_CORE_MCP
- TDD-Zyklus: RED (10 failing) → GREEN (166 passed, 1 skipped, 0 failing), tsc clean
- Bridge deployed, service active, dist-Check bestaetigt tool_count=11

## Bridge Health nach Deploy

```
curl http://10.0.0.2:4402/health
{"ok":true,"secret_loaded":true,"uptime_s":5,"bind":"10.0.0.2","port":4402}

node dist-check: tool_count=11
tools: ask_core, check_calendar, confirm_action, create_calendar_entry,
       get_contract, get_practice_profile, get_travel_time, schedule_retry,
       search_competitors, send_discord_message, transfer_call
```

## Task Commits

1. **Task 01: JSON-Schemas anlegen** - `e79645f` (chore)
2. **Task 02 RED: Failing tests** - `05620c6` (test)
3. **Task 02 GREEN: Implementation** - `a329a81` (feat)
4. **Task 03: Deploy + Health** — ops-only, no commit needed

## Files Created/Modified

- `voice-bridge/src/tools/schemas/ask_core.json` — JSON-Schema draft-07, required [topic, request]
- `voice-bridge/src/tools/schemas/get_travel_time.json` — JSON-Schema draft-07, required [origin, destination], mode enum
- `voice-bridge/src/tools/allowlist.ts` — 2 imports + 2 ENTRIES (ask_core, get_travel_time)
- `voice-bridge/src/tools/dispatch.ts` — 2 TOOL_TO_CORE_MCP mappings
- `voice-bridge/tests/allowlist.test.ts` — count 9→11, 8 neue it()-Bloecke
- `voice-bridge/tests/dispatch.test.ts` — 2 neue happy-path Tests (ask_core, get_travel_time)
- `voice-bridge/tests/accept.test.ts` — tool-count 9→11, tool-list updated (Rule 1 fix)

## Decisions Made

- ask_core topic pattern `^[a-z0-9_-]+$` maxLength 64 — konsistent mit anderen Tool-Namen
- get_travel_time departure_time als plain string (keine ISO-Validation) — einfach halten
- accept.test.ts Hardcodes aktualisiert als direktes Artefakt dieses Plans (nicht optional)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] accept.test.ts hardcoded tool count + list updated**
- **Found during:** Task 02 GREEN (full suite run)
- **Issue:** `accept.test.ts` hatte `toBe(9)` und exakte Tool-Liste ohne ask_core + get_travel_time — 2 Tests failing nach allowlist-Erweiterung
- **Fix:** Count 9→11, tool-Liste um `ask_core` + `get_travel_time` ergaenzt (alphabetisch sortiert)
- **Files modified:** `voice-bridge/tests/accept.test.ts`
- **Verification:** Full suite 166 passed, 0 failing
- **Committed in:** `a329a81`

---

**Total deviations:** 1 auto-fixed (Rule 1 — pre-existing hardcode broken by new entries)
**Impact on plan:** Notwendig fuer gruenem CI. Kein Scope-Creep.

## Issues Encountered

- `logAllowlistCompiled()` wird nicht beim Start emittiert, nur bei `accept`-Aufrufen — tool_count=11 via dist-Direktimport verifiziert statt Logfile

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Bridge-Allowlist ist jetzt konsistent mit allen 8 Core-Tools (check_calendar, create_calendar_entry, send_discord_message, get_contract, get_practice_profile, schedule_retry, ask_core, get_travel_time)
- search_competitors, search_hotels bleiben null-stub (03-08 uebersprungen, by design)
- transfer_call + confirm_action bleiben bridge-internal stub
- **ACTION REQUIRED: Carsten PSTN-Combined-Test beauftragen** — Bot kann jetzt alle 8 Core-Tools entgegennehmen. PSTN-Combined-Test aus Briefing §7 beauftragen.

---
*Phase: 02-director-bridge-v0-hotpath-safety*
*Completed: 2026-04-18*
