---
phase: 03-voice-mcp-endpoint
plan: "09"
subsystem: mcp-tools
tags: [refactor, req-tools, schema-contract, calendar, discord, contract, practice-profile, schedule-retry, tdd]
dependency_graph:
  requires: [03-03, 03-04, 03-06, 03-07]
  provides: [REQ-TOOLS-01, REQ-TOOLS-02, REQ-TOOLS-03, REQ-TOOLS-04, REQ-TOOLS-06, REQ-TOOLS-07]
  affects: [voice-bridge, mcp-server]
tech_stack:
  added: []
  patterns: [REQ-TOOLS schema contract, content-hash dedup, Europe/Berlin TZ window, idempotency via list+match]
key_files:
  created: []
  modified:
    - src/mcp-tools/voice-check-calendar.ts
    - src/mcp-tools/voice-check-calendar.test.ts
    - src/mcp-tools/voice-create-calendar-entry.ts
    - src/mcp-tools/voice-create-calendar-entry.test.ts
    - src/mcp-tools/voice-send-discord-message.ts
    - src/mcp-tools/voice-send-discord-message.test.ts
    - src/mcp-tools/voice-get-contract.ts
    - src/mcp-tools/voice-get-contract.test.ts
    - src/mcp-tools/voice-get-practice-profile.ts
    - src/mcp-tools/voice-get-practice-profile.test.ts
    - src/mcp-tools/voice-schedule-retry.ts
    - src/mcp-tools/voice-schedule-retry.test.ts
    - src/mcp-tools/index.ts
    - data/contracts.example.json
    - data/practice-profile.example.json
decisions:
  - "REQ-TOOLS schemas are the contract: Bridge shapes accepted as-is, Core handlers adapted"
  - "check_calendar available logic: v0 simple — 1440 - sum(event_durations) >= duration_minutes"
  - "travel_buffer inserts are non-atomic: main event insert OK but buffer crash leaves orphan main (documented caveat)"
  - "content-hash dedup for discord: in-memory Map, module-level singleton, 5min TTL"
  - "schedule_retry idempotency: getAllTasks() scan for active task with same (case_type, target_phone, not_before_ts) via prompt-text match"
  - "get_contract + get_practice_profile: null-safe on real data files missing new REQ-TOOLS fields — returns null gracefully"
metrics:
  duration: "~70 min"
  completed_date: "2026-04-18"
  tasks_completed: 7
  files_changed: 15
---

# Phase 03 Plan 09: REQ-TOOLS-01..07 Schema Contract Conformance Summary

6 Core MCP handlers refactored to exactly match REQ-TOOLS-01..07 schema contracts, healing the systematic drift that caused 400-errors in PSTN-Test 1 (call_id `rtc_u0_DW3DxfuDEr7U4FUjghq6X`).

## Commits

| Task | Commit  | Description                                               |
|------|---------|-----------------------------------------------------------|
| 01   | d719776 | refactor(03-09): voice-check-calendar to REQ-TOOLS-01     |
| 02   | 3c1f4f7 | refactor(03-09): voice-create-calendar-entry to REQ-TOOLS-02 |
| 03   | 8ec6536 | refactor(03-09): voice-send-discord-message to REQ-TOOLS-03 |
| 04   | a6632e4 | refactor(03-09): voice-get-contract to REQ-TOOLS-04       |
| 05   | b9e0e40 | refactor(03-09): voice-get-practice-profile to REQ-TOOLS-06 |
| 06   | 35ee023 | refactor(03-09): voice-schedule-retry to REQ-TOOLS-07     |

## Schema Changes (Root Cause Fix)

| Tool                   | Bridge sends (spec)              | Core before      | Core after           |
|------------------------|----------------------------------|------------------|----------------------|
| check_calendar         | `{date, duration_minutes}`       | `{timeMin,timeMax}` | `{date, duration_minutes}` |
| create_calendar_entry  | `{title,date,time,duration,...}` | `{summary,start,end}` | `{title,date,time,duration,...}` |
| send_discord_message   | `{channel, content}`             | `{channel_id, text}` | `{channel, content}` |
| get_contract           | `{provider_name}`                | `{id?, provider?}` | `{provider_name}` |
| get_practice_profile   | `{name}`                         | `{key?}`         | `{name}`             |
| schedule_retry         | `{case_type, target_phone, not_before_ts}` | `{retry_at, prompt}` | `{case_type, target_phone, not_before_ts}` |

## Smoke Evidence (all loopback 10.0.0.2:3200)

### 1. check_calendar
```
POST /mcp/voice.check_calendar {"arguments":{"date":"2026-04-20","duration_minutes":60}}
→ 200 {"ok":true,"result":{"ok":true,"result":{"available":true,"conflicts":[]}}}
```

### 2. create_calendar_entry (new)
```
POST /mcp/voice.create_calendar_entry {"arguments":{"title":"03-09 Smoke","date":"2026-04-20","time":"15:00","duration":30}}
→ 200 {"ok":true,"result":{"ok":true,"result":{"id":"3la9q19tfg1qahb7lsr1gg6p4s","was_duplicate":false}}}
```

### 3. create_calendar_entry (idempotent — same args)
```
→ 200 {"ok":true,"result":{"ok":true,"result":{"id":"3la9q19tfg1qahb7lsr1gg6p4s","was_duplicate":true}}}
```
Idempotency confirmed: same id returned, `was_duplicate:true`.

### 4. send_discord_message (first)
```
POST /mcp/voice.send_discord_message {"arguments":{"channel":"1490365616518070407","content":"03-09 smoke dedup-test"}}
→ 200 {"ok":true,"result":{"ok":true,"result":{"ok":true}}}
```

### 5. send_discord_message (dedup — same content within 5min)
```
→ 200 {"ok":true,"result":{"ok":true,"result":{"ok":true}}}
JSONL: {"event":"discord_message_deduplicated","content_hash":"73a4c2f0",...}
```
Dedup confirmed: no Discord API call on second send.

### 6. get_contract
```
POST /mcp/voice.get_contract {"arguments":{"provider_name":"Example AG"}}
→ 200 {"ok":true,"result":{"ok":true,"result":{"current_conditions":null,"expiry_date":null,"last_review":null}}}
```
Note: nulls expected — real `contracts.json` predates new REQ-TOOLS-04 fields. No 400 error.

### 7. get_practice_profile
```
POST /mcp/voice.get_practice_profile {"arguments":{"name":"Example Praxis"}}
→ 200 {"ok":true,"result":{"ok":true,"result":{"phone":"+491234567890","patient_id":null,...,"authorized_data_fields":[]}}}
```
Phone returned, other new fields null — graceful.

### 8. schedule_retry (first)
```
POST /mcp/voice.schedule_retry {"arguments":{"case_type":"test","target_phone":"+491708036426","not_before_ts":"2026-04-18T17:25:36.061Z"}}
→ 200 {"ok":true,"result":{"ok":true,"result":{"scheduled":true}}}
```

### 9. schedule_retry (idempotent — same triple)
```
→ 200 {"ok":true,"result":{"ok":true,"result":{"scheduled":true}}}
JSONL: {"event":"retry_scheduled_deduplicated","existing_task_id":"33cd4be7-..."}
```
Dedup confirmed: no second DB insert.

## Test Suite

- 457 passed, 1 pre-existing gmail failure (unrelated to this plan, known baseline)
- tsc: clean
- 6 handler test files, 9+8+8+7+7+9 = 48 new/refactored tests

## Caveats

### travel_buffer non-atomic
When `travel_buffer_before_min > 0` or `travel_buffer_after_min > 0`, the buffer blocker events are inserted as separate Google Calendar API calls after the main event. If a buffer insert crashes, the main event remains without the buffer. This is a known V0 limitation (accepted in threat model). V2 should use a transactional pattern.

### check_calendar v0-simple availability logic
`available` is computed as: `1440 - sum_of_all_event_durations >= duration_minutes`. This does NOT guarantee a contiguous free slot exists — a day with fragmented 15-min gaps could report `available=true` for a 60-min request. Accepted for V0; Bot can ask "wann genau?" for edge cases.

### get_contract / get_practice_profile real data
The real `contracts.json` and `practice-profile.json` files predate the new REQ-TOOLS fields. They return null gracefully. Carsten should update the real data files to add `current_conditions`, `expiry_date`, `last_review` to contracts entries and `patient_id`, `insurance_type`, `last_visit`, `authorized_data_fields` to profile entries for full value.

## Deviations from Plan

None — plan executed exactly as written. All 6 tools refactored, all idempotency variants implemented, all test minimums met.

## ACTION REQUIRED: 2. PSTN-Combined-Test

The schema drift that caused 400-errors in Test 1 is now fixed. Carsten should run the second PSTN-Combined-Test using the same three test scenarios as the first:

**Test Scenario 1 — Calendar check:**
- Call in, say: "Habe ich am Montag Zeit für einen einstündigen Termin?"
- Expected: Bot checks calendar, reports availability

**Test Scenario 2 — Calendar create + Discord:**
- Call in, say: "Trag mir Montag 15 Uhr einen Zahnarzt-Termin ein und schreib Andy auf Discord"
- Expected: Calendar entry created (id returned), Discord message sent

**Test Scenario 3 — Schedule retry:**
- Call in, say: "Ruf das Restaurant morgen früh nochmal an"
- Expected: schedule_retry scheduled, Bot confirms

**Verification:** Check `data/voice-calendar.jsonl`, `data/voice-discord.jsonl`, `data/voice-scheduler.jsonl` for `available`, `was_duplicate:false`, `discord_message_sent`, `retry_scheduled` events respectively.

## Self-Check: PASSED
