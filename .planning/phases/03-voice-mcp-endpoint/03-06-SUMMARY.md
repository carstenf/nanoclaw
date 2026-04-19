---
phase: 03-voice-mcp-endpoint
plan: "06"
subsystem: mcp-tools/flat-db-readers
tags:
  - mcp-tools
  - flat-db
  - voice-tools
  - case-2
  - case-3
  - case-4
  - case-5
  - pii-clean
dependency_graph:
  requires:
    - "03-01"  # MCP server + registry
  provides:
    - voice.get_contract MCP tool (flat JSON lookup by id/provider)
    - voice.get_practice_profile MCP tool (flat JSON key lookup or list)
    - flat-db-reader (mtime-cached JSON loader, shared utility)
  affects:
    - src/mcp-tools/index.ts (buildDefaultRegistry)
    - src/config.ts (CONTRACTS_PATH, PRACTICE_PROFILE_PATH)
    - .gitignore (precise data/ rules replacing blanket exclusion)
tech_stack:
  added: []
  patterns:
    - mtime-based cache (Map<path, {content, mtimeMs}>) — live-edit without restart
    - DI via opts.fs for test isolation
    - FlatDbNotFound / FlatDbParseError typed errors — graceful handler fallback
    - Always-registered tools (not_configured fallback when file absent)
    - JSONL event logging (query_key slug only — no contract/profile content)
    - Path-traversal guard: id/key used only as Map lookup key, never as file path
key_files:
  created:
    - src/mcp-tools/flat-db-reader.ts
    - src/mcp-tools/flat-db-reader.test.ts
    - src/mcp-tools/voice-get-contract.ts
    - src/mcp-tools/voice-get-contract.test.ts
    - src/mcp-tools/voice-get-practice-profile.ts
    - src/mcp-tools/voice-get-practice-profile.test.ts
    - data/contracts.example.json
    - data/practice-profile.example.json
  modified:
    - src/config.ts
    - src/mcp-tools/index.ts
    - .gitignore
decisions:
  - "Always-register both tools — not_configured fallback is cleaner than conditional registration for read-only tools with no side-effects"
  - "Shared voice-lookup.jsonl for both tools (vs separate files) — one stream to tail for all lookup events"
  - "id slug regex [a-z0-9_-]+ as path-traversal guard (T-03-06-03)"
  - ".gitignore reworked from blanket data/ to precise rules — enable tracking .example.json without exposing live data"
  - "mtime-cache with no TTL — safe because stat() is O(1) and live-edit support is a Carsten UX requirement"
metrics:
  duration: 15 min
  completed: "2026-04-18T08:40:00Z"
  tasks_completed: 5
  files_created: 8
  files_modified: 3
  tests_added: 17
---

# Phase 03 Plan 06: voice.get_contract + voice.get_practice_profile Summary

**One-liner:** Two read-only MCP tools backed by mtime-cached flat JSON files — contract lookup by id/provider, practice-profile lookup by key or list — with graceful not_configured fallback, path-traversal guard, and PII-clean JSONL logging.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| `9bc9ee9` | feat | flat-db-reader: mtime cache, ENOENT/parse-error guards, DI fs, 5 tests |
| `f188576` | feat | voice.get_contract: id/provider lookup, BadRequest, JSONL, 6 tests |
| `9823e46` | feat | voice.get_practice_profile: key lookup + list, graceful empty, JSONL, 6 tests |
| `39ba17b` | chore | wiring: config.ts paths, index.ts registry, .example.json files, .gitignore fix |

## Smoke Evidence (5 cross-host curls from Hetzner → Lenovo1 10.0.0.2:3200)

**1. get_contract positive (id match)**
```
POST /mcp/voice.get_contract {"arguments":{"call_id":"smoke-03-06","id":"example-provider-2024"}}
HTTP 200 → {"ok":true,"result":{"ok":true,"result":{"contract":{"id":"example-provider-2024","provider":"Example AG",...}}}}
```

**2. get_contract negative (no match)**
```
POST /mcp/voice.get_contract {"arguments":{"id":"nope"}}
HTTP 200 → {"ok":true,"result":{"ok":true,"result":{"contract":null}}}
```

**3. get_contract BadRequest (no id/provider)**
```
POST /mcp/voice.get_contract {"arguments":{}}
HTTP 400 → {"error":"bad_request","field":"missing_query","expected":"id or provider required"}
```

**4. get_practice_profile list keys**
```
POST /mcp/voice.get_practice_profile {"arguments":{"call_id":"smoke-03-06"}}
HTTP 200 → {"ok":true,"result":{"ok":true,"result":{"keys":["example-practice"]}}}
```

**5. get_practice_profile lookup by key**
```
POST /mcp/voice.get_practice_profile {"arguments":{"key":"example-practice"}}
HTTP 200 → {"ok":true,"result":{"ok":true,"result":{"profile":{"name":"Example Praxis","type":"doctor",...}}}}
```

## JSONL PII-Check

`data/voice-lookup.jsonl` after smoke — 4 events (BadRequest dropped before DB read, no log entry — expected):

```jsonl
{"ts":"2026-04-18T08:39:11.942Z","event":"contract_lookup_done","tool":"voice.get_contract","call_id":"smoke-03-06","query_key":"example-provider-2024","found":true,"latency_ms":3}
{"ts":"2026-04-18T08:39:19.441Z","event":"contract_lookup_done","tool":"voice.get_contract","call_id":null,"query_key":"nope","found":false,"latency_ms":1}
{"ts":"2026-04-18T08:39:28.935Z","event":"practice_profile_lookup_done","tool":"voice.get_practice_profile","call_id":"smoke-03-06","query_key":"list","found":true,"latency_ms":2}
{"ts":"2026-04-18T08:39:32.906Z","event":"practice_profile_lookup_done","tool":"voice.get_practice_profile","call_id":null,"query_key":"example-practice","found":true,"latency_ms":0}
```

**PII-clean:** Fields logged = `ts, event, tool, call_id, query_key (slug), found, latency_ms`. No `contract`, `monthly_cost_eur`, `provider`, `address`, `phone`, `email`, or profile content. T-03-06-01 mitigated.

## Caveats

- **Schema v0:** Both JSON schemas are minimal. `contracts.json` and `practice-profile.json` contain only example/dummy data from `.example.json`. Carsten must replace with real data — outside the scope of this plan.
- **Live-edit verified by mtime-cache design:** mtime-cache re-reads on every `stat()` showing a newer mtime. Not manually live-tested during smoke (optional step — adding a new entry and re-querying). Implementation is unit-tested (cache-miss on mtime change, 3 tests in flat-db-reader.test.ts).
- **Double response envelope:** MCP server wraps handler result in `{ok, result}`, and handlers also return `{ok, result}`. Result is `{ok:true, result:{ok:true, result:{...}}}`. This is pre-existing behavior from all voice tools (03-03..03-05). Not introduced here.
- **Threat T-03-06-04 (file-lock race):** Atomic read via `fs.readFile` is blocking at OS level. Carsten should use vim (atomic-write default) or similar when editing live JSON files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] .gitignore blanket data/ replaced with precise rules**
- **Found during:** Task 4
- **Issue:** `.gitignore` had `data/` which would prevent committing `.example.json` files. Plan requires tracking example files while excluding live JSON.
- **Fix:** Replaced blanket `data/` with precise rules: `data/env/`, `data/ipc/`, `data/sessions/` (subdirs), `data/*.jsonl` (logs), `data/contracts.json` + `data/practice-profile.json` (explicit live files). Example files now tracked.
- **Files modified:** `.gitignore`
- **Commit:** `39ba17b`

## Test Results

- Baseline: 412 passed, 1 pre-existing gmail failure
- After 03-06: **429 passed** (+17 new), 1 pre-existing gmail failure unchanged
- tsc: clean (no errors)
- New tests: flat-db-reader (5) + voice-get-contract (6) + voice-get-practice-profile (6) = 17

## Known Stubs

- `data/contracts.json` — contains example dummy data only. Carsten fills with real contracts.
- `data/practice-profile.json` — contains example dummy data only. Carsten fills with real profiles.

Both stubs are intentional. Tools work correctly with any valid data in these files. The plan's goal (tools operational, schema defined, graceful empty handling) is achieved.

## Next

Plan **03-07** — `voice.schedule_retry`: retry scheduling for outbound call attempts.

## Self-Check: PASSED

- `src/mcp-tools/flat-db-reader.ts` — FOUND
- `src/mcp-tools/voice-get-contract.ts` — FOUND
- `src/mcp-tools/voice-get-practice-profile.ts` — FOUND
- `data/contracts.example.json` — FOUND
- `data/practice-profile.example.json` — FOUND
- Commit `9bc9ee9` — FOUND
- Commit `f188576` — FOUND
- Commit `9823e46` — FOUND
- Commit `39ba17b` — FOUND
