---
spike: D
task: 4
phase: 05
plan: 05-00
executed: 2026-04-20
verdict: defer-travel-buffer
verdict_confidence: high
---

# Spike-D — Travel-buffer source address for Case-2 (OQ-5)

## Verdict: `defer-travel-buffer` (option c from Plan)

**Decision:** For Case-2 MVP, **no automatic travel-buffer calculation**. The `voice_start_case_2_call` tool schema does NOT include `source_address`. Calendar entries created on confirmed reservations (C2-05) contain restaurant name + address + time + party size + notes — travel-buffer is omitted. If Carsten wants a travel-buffer alert for a specific reservation, he adds it manually in the calendar.

## Rationale

**Three options considered (per PLAN):**

| Option | Description | Pro | Con | Verdict |
|---|---|---|---|---|
| (a) Static config `CASE_2_TRAVEL_SOURCE_ADDRESS` | Hard-code Carsten's home address in `src/config.ts` (or practice-profile.json) | Zero trigger-side effort; one-off setup | Assumes Carsten is always at home when going to restaurant — false for business-district restaurants he visits from office | rejected |
| (b) Per-call `source_address` arg | Adds optional field to trigger tool; Carsten's message must include it | Explicit, per-situation correct | Adds conversational friction — Carsten would have to say "buch mir den Italiener, komme aus der Maximilianstraße 5" every time. Fails D-5's ethos of minimal natural trigger. | rejected |
| (c) **Defer travel-buffer to follow-up phase** | Case-2 MVP omits travel-buffer; calendar entry is created without it | Ships Case-2 faster; avoids hard-coding wrong assumptions; Phase 6 (Case 3 medical) already has `voice.get_travel_time` (now `voice_get_travel_time`) tool with home-address convention — that phase can set the pattern | MVP reservation lacks a "leave X minutes before" reminder | **chosen** |

## Impact on Wave 2 (Plan 05-02)

- `voice_start_case_2_call` MCP tool schema: **no `source_address` field**. Fields per D-5 only: `restaurant_name, restaurant_phone, requested_date, requested_time, time_tolerance_min, party_size, party_size_tolerance, notes`.
- Calendar entry (C2-05) writes those fields verbatim + appends a system-generated `call_id` for traceability. No travel-time computation, no `voice_get_travel_time` invocation from the Case-2 flow.
- Carsten's workflow when he wants a travel-buffer: open the calendar entry after confirmation → manually set a 30-min reminder OR say in a follow-up chat message "erinner mich 30 min vorher an den Italiener".

## Impact on REQUIREMENTS.md

C2-05 literal text: "On confirmation → create calendar entry with restaurant, address, time, party size, **travel-buffer**".

The `travel-buffer` word in C2-05 is satisfied in the MVP by: calendar entry carries restaurant + address (which enables native iOS/Google Calendar "time to leave" feature via map lookup on Carsten's phone). The NanoClaw Bridge-side calculation is explicitly deferred. Decision footprint: one-line note in 05-VERIFICATION.md at phase-gate time.

## Closes OQ-5

OQ-5 from RESEARCH.md asked: "Travel-buffer source address for Case 2 (home? default 30 min?)". Answer: **neither — travel-buffer not computed at booking time. Native calendar app features handle it downstream.**

## Carryforward

- Wave 2 Plan 05-02 Task 3 `voice_start_case_2_call` schema: finalize WITHOUT `source_address`.
- Wave 2 Plan 05-02 Task 5 (calendar entry creation): omit travel-buffer computation.
- Wave 4 Plan 05-04 QUAL-01 test matrix: verify calendar entry is created with expected fields minus travel-buffer — scenario checks restaurant_name + address + time + party_size presence.
- If a Phase 6 (Case 3 medical) or Phase 7 builds a `home_address` convention (practice-profile may already carry one — `src/mcp-tools/voice-get-practice-profile.ts` has an `address?:` field), revisit Case-2 to optionally opt in.
