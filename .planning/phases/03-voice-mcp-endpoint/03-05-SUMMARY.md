---
phase: 03-voice-mcp-endpoint
plan: "05"
subsystem: mcp-tools/maps
tags:
  - mcp-tools
  - google-maps
  - voice-tools
  - case-6
  - pii-clean
dependency_graph:
  requires:
    - "03-01"  # MCP server + registry
    - "03-03"  # handler pattern for single-API-call tools
  provides:
    - voice.get_travel_time MCP tool (Google Maps Distance Matrix)
  affects:
    - src/mcp-tools/index.ts (buildDefaultRegistry)
    - src/config.ts (GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_TIMEOUT_MS)
tech_stack:
  added: []
  patterns:
    - Raw fetch + URLSearchParams (no SDK — zero new deps)
    - AbortController timeout (6000ms default) for distance matrix calls
    - PII-free JSONL logging (no origin/destination — mode/duration/distance/latency only)
    - Fail-safe conditional registration (deny-all when key absent)
    - duration_in_traffic preferred for driving+departure_time
key_files:
  created:
    - src/mcp-tools/maps-client.ts
    - src/mcp-tools/maps-client.test.ts
    - src/mcp-tools/voice-get-travel-time.ts
    - src/mcp-tools/voice-get-travel-time.test.ts
  modified:
    - src/config.ts
    - src/mcp-tools/index.ts
decisions:
  - "Raw fetch over @googlemaps/google-maps-services-js SDK — zero dep footprint, API is one GET call"
  - "departure_time only applied to driving mode (Google API requirement)"
  - "JSONL never logs origin/destination — Carsten-Privacy-Default for home/work addresses"
  - "Fail-safe deny: tool not registered when GOOGLE_MAPS_API_KEY is absent"
  - "duration_in_traffic preferred when available (more accurate for driving with traffic)"
metrics:
  duration: 10 min
  completed: "2026-04-18T08:17:58Z"
  tasks_completed: 4
  files_created: 4
  files_modified: 2
  tests_added: 16
---

# Phase 03 Plan 05: voice.get_travel_time MCP Tool (Google Maps Distance Matrix) Summary

**One-liner:** Google Maps Distance Matrix tool via raw fetch — TDD, PII-free JSONL, fail-safe key guard, cross-host smoke PASS.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 03-05-01 | maps-client.ts — Distance Matrix fetch + tests | 96f7516 | maps-client.ts, maps-client.test.ts |
| 03-05-02 | voice-get-travel-time.ts — handler + Zod + JSONL | c8473f8 | voice-get-travel-time.ts, voice-get-travel-time.test.ts |
| 03-05-03 | Wiring — config.ts + mcp-tools/index.ts + full suite | 26075bf | config.ts, mcp-tools/index.ts |
| 03-05-04 | Live deploy + cross-host smoke | (ops only) | — |

## Deviations from Plan

None — plan executed exactly as written.

## Smoke Evidence

### POSITIV: driving — München Hauptbahnhof → München Flughafen

```
curl -s -X POST http://10.0.0.2:3200/mcp/voice.get_travel_time \
  -H 'Content-Type: application/json' \
  -d '{"arguments":{"call_id":"smoke-03-05-driving","origin":"München Hauptbahnhof","destination":"München Flughafen","mode":"driving"}}'

→ HTTP 200
{
  "ok": true,
  "result": {
    "ok": true,
    "result": {
      "duration_seconds": 2047,
      "distance_meters": 38837,
      "duration_text": "34 mins",
      "distance_text": "38.8 km",
      "origin_resolved": "München Hauptbahnhof, Bayerstraße 10A, 80335 München, Germany",
      "destination_resolved": "85356 Oberding-München-Flughafen, Germany",
      "mode": "driving",
      "used_traffic": false
    }
  }
}
```

### POSITIV: transit — same route

```
curl -s -X POST http://10.0.0.2:3200/mcp/voice.get_travel_time \
  -H 'Content-Type: application/json' \
  -d '{"arguments":{"call_id":"smoke-03-05-transit","origin":"München Hauptbahnhof","destination":"München Flughafen","mode":"transit"}}'

→ HTTP 200
{
  "ok": true,
  "result": {
    "ok": true,
    "result": {
      "duration_seconds": 2919,
      "duration_text": "49 mins",
      "distance_text": "41.5 km",
      "mode": "transit",
      "used_traffic": false
    }
  }
}
```

Transit 49 min > driving 34 min as expected.

### NEGATIV: absurd origin/destination (ZERO_RESULTS / NOT_FOUND)

```
curl -s -X POST http://10.0.0.2:3200/mcp/voice.get_travel_time \
  -d '{"arguments":{"origin":"XXXXXXXXXNOTAPLACE123456","destination":"YYYYYYYNOTAPLACE654321"}}'

→ HTTP 200
{"ok": true, "result": {"ok": false, "error": "not_found"}}
```

Note: Google returns element status NOT_FOUND for gibberish strings (mapped to `not_found` code). ZERO_RESULTS is covered in unit tests.

### NEGATIV: BadRequest — empty origin

```
curl -s -X POST http://10.0.0.2:3200/mcp/voice.get_travel_time \
  -d '{"arguments":{"origin":"","destination":"München Flughafen"}}'

→ HTTP 400
{"error":"bad_request","field":"origin","expected":"Too small: expected string to have >=1 characters"}
```

## JSONL Evidence

File: `/home/carsten_bot/nanoclaw/data/voice-maps.jsonl`

```jsonl
{"ts":"2026-04-18T08:17:15.015Z","event":"travel_time_done","tool":"voice.get_travel_time","call_id":"smoke-03-05-driving","mode":"driving","duration_seconds":2047,"distance_meters":38837,"used_traffic":false,"latency_ms":205}
{"ts":"2026-04-18T08:17:20.953Z","event":"travel_time_done","tool":"voice.get_travel_time","call_id":"smoke-03-05-transit","mode":"transit","duration_seconds":2919,"distance_meters":41493,"used_traffic":false,"latency_ms":485}
{"ts":"2026-04-18T08:17:26.793Z","event":"travel_time_failed","tool":"voice.get_travel_time","call_id":"smoke-03-05-zero","mode":"driving","latency_ms":204,"error":"not_found"}
```

**PII-check:** `grep -E '"origin"|"destination"' voice-maps.jsonl` → no matches. Clean.

## Test Coverage

| Suite | Tests | Result |
|-------|-------|--------|
| maps-client.test.ts | 8 | PASS |
| voice-get-travel-time.test.ts | 8 | PASS |
| Full suite delta | +16 tests | 412 total passing, 1 pre-existing gmail failure |

## Caveats

1. **Dynamic IP / no IP-whitelist in v0:** Lenovo1 has a DTAG dynamic IPv4. The Google API key has Application-Restriction=None (blast-radius kept small via API-restriction to Distance Matrix only). If Lenovo1 gets a static IP or traffic is routed through Hetzner, add an IP whitelist in Google Cloud Console.

2. **Key restriction:** API key is restricted to Distance Matrix API only in Google Cloud Console. Any leaked key cannot be used for other Google services.

3. **Cost estimate:** Distance Matrix Standard = $5/1000 requests. At realistic Case-6 usage (<50 calls/day), cost is ≤$0.25/day. Google-side quota acts as backstop. No rate limiting in v0.

4. **No caching in v0:** Each call hits Google API fresh. If call cadence becomes an issue, a simple `Map<origin|dest|mode, {result, ts}>` RAM-cache with 5-min TTL can be added later.

5. **departure_time only for driving:** Google Distance Matrix API ignores departure_time for non-driving modes. Handler only passes it when mode=driving.

## Known Stubs

None.

## Threat Flags

None beyond plan's threat model.

## Next

Plan 03-06: `get_contract` + `get_practice_profile` tools (contact/practice lookup for voice context).

## Self-Check: PASSED

- `/home/carsten_bot/nanoclaw/src/mcp-tools/maps-client.ts` — FOUND
- `/home/carsten_bot/nanoclaw/src/mcp-tools/maps-client.test.ts` — FOUND
- `/home/carsten_bot/nanoclaw/src/mcp-tools/voice-get-travel-time.ts` — FOUND
- `/home/carsten_bot/nanoclaw/src/mcp-tools/voice-get-travel-time.test.ts` — FOUND
- Commit 96f7516 — FOUND
- Commit c8473f8 — FOUND
- Commit 26075bf — FOUND
