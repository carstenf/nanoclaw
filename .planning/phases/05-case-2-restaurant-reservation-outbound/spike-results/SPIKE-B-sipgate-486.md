---
spike: B
task: 2
phase: 05
plan: 05-00
executed: 2026-04-20
verdict: no-486-exists
verdict_confidence: high
---

# Spike-B — Sipgate REST 486 Busy Here body shape (OQ-3)

## Verdict: `no-486-exists`

**Finding that changes the Wave 2 design:** Sipgate's REST API (`POST /sessions/calls` originate endpoint) does **not** return SIP-level status codes (486, 408, etc.) synchronously. Originate returns `200 OK` once the call is submitted; the actual outcome (busy, no-pickup, answered, network-error) is only visible via the asynchronous History API. There is no 486 response body to parse because there is no 486 response.

## Evidence

| Scenario | Input | Sipgate originate response | History API result |
|----------|-------|---------------------------|---------------------|
| Target busy (mobile on another call) | `+491708036426` (carsten's phone mid-call) | `200 OK` — `outbound_originate_ok` | `status: PICKUP` (call-waiting forwarded to voicemail — bot still connected) |
| Invalid phone number format | `+999999999999` | `400 Bad Request` — body `{"message":"javax.ws.rs.BadRequestException: could not validate phonenumber 999999999999"}` | not recorded (rejected before submission) |
| Valid format, disconnected number | `+4915799999999` | `200 OK` — `outbound_originate_ok` | `status: NOPICKUP, direction: MISSED_OUTGOING, duration: 0` |

All three cases logged verbatim in bridge journal (`outbound_originate_ok` / `outbound_originate_failed` event fields preserve the body).

## What Sipgate body shapes DO exist (for the few sync-error cases)

```json
// HTTP 400 — input validation
{"message":"javax.ws.rs.BadRequestException: could not validate phonenumber <digits>"}
```

Single `message` field carrying a Java-stack-trace-style string. No `causeCode`, no `reason`, no structured SIP-status mapping. Parser for this case should match `message` contains `"could not validate phonenumber"` to classify as `invalid_number`.

Other possible 4xx codes not tested (would need targeted reproductions):
- `401` — bad SIPGATE_TOKEN (would look like our auth gateway's `{"error":"unauthorized"}` — already handled in bridge bearer middleware)
- `403` — outbound trunk disabled or CLI restriction (likely similar `{"message": "..."}` shape, unconfirmed)
- `429` — rate-limited (likely `{"message": "..."}`, unconfirmed)
- `5xx` — Sipgate outage (unknown shape; rare)

Our production code should treat the originate-path error body as **opaque** beyond a text-match for known cases; the actual call outcome comes from the History API polling, not from originate HTTP status.

## Implication for Wave 2 design (Plan 05-02)

The original plan Task 4 said:
> "Sipgate busy parser (from Spike-B — uses causeCode field)"

**This must be redesigned.** Recommended Wave 2 approach:

1. **Sipgate originate call** — submit + get `200 + session/call ref` (or `4xx + {message}` for pre-submission validation errors). Task records the call attempt in `voice_case_2_attempts` with `status: submitted`.

2. **Outcome tracking via Bridge's existing outbound-router lifecycle events** — the Bridge already hooks OpenAI `realtime.call.incoming` (connection occurred) and its own call-done logic. Use these to classify outcomes:
   - `call_accepted` fired → attempt `status: connected` → Case-2 conversation proceeds
   - No `call_accepted` within 45s of originate → poll Sipgate history API for `status` field
     - `PICKUP` (with duration > 0) → answered, but something unusual
     - `NOPICKUP` (duration = 0) → treat as no-answer → enqueue retry per D-2 ladder
     - `MISSED_OUTGOING` → same as NOPICKUP
     - No history record yet → retry history poll after 10s, then declare lost

3. **Busy-vs-no-pickup distinction** — Sipgate's history API **does not distinguish these**. Both show as `NOPICKUP`. Case-2 retry logic per D-2 can therefore treat busy and no-answer identically — same 5/15/45/120 min ladder, same 5/day cap. Simpler than originally planned.

4. **The `voice-bridge/src/sipgate-rest-client.ts` error-body logger** added in this spike (commit `59f60f8` via Wave-0 override envelope; actually already existed pre-spike) stays useful for the pre-submission 4xx cases (invalid number, auth, rate-limit).

## Closes OQ-3

OQ-3 from RESEARCH.md asked for "the exact Sipgate 486 body shape". Answer: **no 486 body exists in Sipgate's REST outbound path**. Wave 2 must not try to parse one.

## Carryforward to Wave 2 (Plan 05-02 Task 4)

- Remove the "Sipgate 486 body parser" task; replace with "Sipgate History API outcome poller" task.
- The daily-cap D-2 counter in `voice_case_2_attempts` keys on `(target_phone, calendar_date)` and counts ANY attempt whose outcome ≠ `PICKUP (answered)`. Both busy and no-answer feed the same counter.
- Unit test coverage: mock Sipgate history responses for PICKUP, NOPICKUP, MISSED_OUTGOING and verify the retry-orchestrator classifies correctly.
- Latency: history API is rate-limited (unknown exact limit; memory entry `reference_sipgate_api.md` says Basic Auth). Single poll per attempt 30s after originate should be well within any reasonable limit.
