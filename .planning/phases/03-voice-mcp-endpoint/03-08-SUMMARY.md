---
phase: 03-voice-mcp-endpoint
plan: "08"
subsystem: mcp-tools
tags: [voice, ask_core, skill-loader, mtime-cache, onecli, jsonl, path-traversal]
dependency_graph:
  requires: ["03-01", "03-02"]
  provides: ["voice.ask_core MCP tool", "skill-loader module", "echo-skill file"]
  affects: ["src/mcp-tools/index.ts", "src/config.ts"]
tech_stack:
  added: ["zod slug-regex validation", "mtime-cached skill loader"]
  patterns: ["dependency injection for testability", "graceful degradation (skill_not_configured)"]
key_files:
  created:
    - src/mcp-tools/skill-loader.ts
    - src/mcp-tools/skill-loader.test.ts
    - src/mcp-tools/voice-ask-core.ts
    - src/mcp-tools/voice-ask-core.test.ts
    - data/skills/ask-core-test/SKILL.md
  modified:
    - src/config.ts
    - src/mcp-tools/index.ts
decisions:
  - "skill-loader is a separate module from flat-db-reader (different namespace, future divergence)"
  - "topic regex /^[a-z0-9_-]+$/ enforced by Zod before any filesystem access"
  - "skill_not_configured returned as ok:true answer, not 404, for graceful bot behavior"
  - "JSONL logs only lengths (request_len, answer_len), never text — PII-clean by design"
metrics:
  duration_minutes: 5
  completed_date: "2026-04-18"
  tasks_completed: 4
  files_created: 5
  files_modified: 2
  tests_added: 12
---

# Phase 03 Plan 08: voice.ask_core + Echo-Skill Summary

**One-liner:** Generic MCP fallback tool delegating to mtime-cached skill files via Claude-Sonnet inference with path-traversal protection and PII-clean JSONL.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | skill-loader.ts — mtime-cached reader + 5 tests | 67ffb9b | skill-loader.ts, skill-loader.test.ts |
| 2 | voice-ask-core.ts handler + 7 tests | f420c15 | voice-ask-core.ts, voice-ask-core.test.ts |
| 3 | Echo-skill + config + index wiring | 4e22cd4 | data/skills/ask-core-test/SKILL.md, config.ts, index.ts |
| 4 | Live-deploy + cross-host smoke | (ops only) | — |

## Smoke Evidence (4 curls)

### Smoke 1: Positive test-topic

```
POST /mcp/voice.ask_core {"arguments":{"call_id":"smoke-03-08","topic":"test","request":"sag Hallo"}}
→ HTTP 200
{"ok":true,"result":{"ok":true,"result":{"answer":"Hallo Carsten von NanoClaw.","topic":"test","citations":[]}}}
```

Claude answered "Hallo Carsten von NanoClaw." — echo-skill active, pipeline end-to-end functional.

### Smoke 2: Unknown topic

```
POST /mcp/voice.ask_core {"arguments":{"topic":"nope","request":"test"}}
→ HTTP 200
{"ok":true,"result":{"ok":true,"result":{"answer":"skill_not_configured","topic":"nope","citations":[]}}}
```

Graceful degradation: no 500, no crash — bot can react appropriately.

### Smoke 3: Empty topic (400)

```
POST /mcp/voice.ask_core {"arguments":{"topic":"","request":"test"}}
→ HTTP 400
{"error":"bad_request","field":"topic","expected":"Too small: expected string to have >=1 characters"}
```

### Smoke 4: Path-traversal attempt (400)

```
POST /mcp/voice.ask_core {"arguments":{"topic":"../etc","request":"x"}}
→ HTTP 400
{"error":"bad_request","field":"topic","expected":"topic must be a slug (a-z, 0-9, _, -)"}
```

Zod regex rejects before any filesystem access.

## JSONL PII-grep Beweis

JSONL tail after smoke run:

```json
{"ts":"2026-04-18T11:33:35.946Z","event":"ask_core_done","tool":"voice.ask_core","call_id":"smoke-03-08","topic":"test","request_len":9,"answer_len":27,"latency_ms":1418}
{"ts":"2026-04-18T11:33:41.557Z","event":"ask_core_skill_not_configured","tool":"voice.ask_core","call_id":null,"topic":"nope","request_len":4,"answer_len":0,"latency_ms":0}
```

PII-check:

```
grep "sag Hallo" data/voice-ask-core.jsonl
→ (no output) — PASS: no request text in JSONL
```

Only `request_len: 9` (length of "sag Hallo") logged, never the text itself.

## Test Results

- Baseline before plan: ~437 passed + 1 pre-existing gmail failure
- After plan: 449 passed + 1 pre-existing gmail failure
- New tests added: 12 (5 skill-loader + 7 voice-ask-core)
- tsc: clean

## Health Endpoint

`/health` now lists 9 tools including `voice.ask_core` as the 9th.

## Deviations from Plan

None — plan executed exactly as written. TDD cycle followed: RED commit (tests import non-existent module), then GREEN (implementation), then wiring.

## Caveats

- **Echo-skill is a dummy** for pipeline smoke only. Answers trivially (max 20 words).
- **v2 will add real skills** (hotel, competitor, etc.) in future plans.
- **Bridge wireup** (02-12): voice-bridge does not yet call `voice.ask_core` — that wiring follows in Plan 02-12 (ask_core + get_travel_time bridge-nachtrag).
- Zod error messages use Zod v4 format ("Too small: expected string to have >=1 characters") — verbose but correct.

## Next

Plan 02-12: Bridge-Wireup-Nachtrag for `voice.ask_core` and `voice.get_travel_time`.

## Self-Check: PASSED

- skill-loader.ts: FOUND
- voice-ask-core.ts: FOUND
- data/skills/ask-core-test/SKILL.md: FOUND
- Commits 67ffb9b, f420c15, 4e22cd4: all exist in git log
- Tests 449/450 pass
- JSONL PII-clean confirmed
