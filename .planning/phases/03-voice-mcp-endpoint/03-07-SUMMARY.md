---
phase: 03-voice-mcp-endpoint
plan: "07"
subsystem: mcp-tools/voice-schedule-retry
tags:
  - mcp-tools
  - task-scheduler
  - voice-tools
  - case-2
  - case-3
  - pii-clean
  - retry-scheduling
dependency_graph:
  requires:
    - "03-01"  # MCP server + registry
  provides:
    - voice.schedule_retry MCP tool (facade over createTask/task-scheduler)
  affects:
    - src/mcp-tools/index.ts (RegistryDeps + buildDefaultRegistry)
    - src/mcp-server.ts (StartMcpServerOpts.deps)
    - src/index.ts (getMainGroupAndJid callback at call-site)
tech_stack:
  added: []
  patterns:
    - MCP tool facade over existing createTask (no new table/runner)
    - schedule_type='once' enforced — no cron/interval from voice bot
    - retry_at bounds (now..now+30d) — runaway scheduling guard (T-03-07-01)
    - UUID task_id via crypto.randomUUID()
    - getMainGroupAndJid DI callback — testable without SQLite
    - JSONL prompt_len only (no prompt text) — PII guard (T-03-07-03)
    - TDD: RED commit (055510a) → GREEN commit (20ac34f)
key_files:
  created:
    - src/mcp-tools/voice-schedule-retry.ts
    - src/mcp-tools/voice-schedule-retry.test.ts
  modified:
    - src/mcp-tools/index.ts
    - src/mcp-server.ts
    - src/index.ts
decisions:
  - "Always-register voice.schedule_retry (no conditional) — returns no_main_group if DI callback absent; simpler than skipping registration"
  - "getMainGroupAndJid DI callback provides both folder+jid in one call — avoids two separate DI deps"
  - "group_folder override in request still uses main group jid — acceptable since voice bot can only target known folders; no separate jid-lookup DI added to keep interface minimal"
  - "Cleanup via direct SQL DELETE — no deleteTask MCP tool built (out of scope per plan)"
metrics:
  duration: 22 min
  completed: "2026-04-18T08:58:00Z"
  tasks_completed: 3
  files_created: 2
  files_modified: 3
  tests_added: 8
---

# Phase 03 Plan 07: voice.schedule_retry Handler Summary

MCP facade over existing task-scheduler: Zod-validated, retry_at-bounded (now..now+30d), schedule_type='once'-locked, PII-clean JSONL, UUID task_id, fully DI-injectable.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| 055510a | test | Add failing tests for voice.schedule_retry (RED — 8 it() cases) |
| 20ac34f | feat | Implement voice.schedule_retry handler (GREEN — 8 tests pass) |
| 60e209b | feat | Wire voice.schedule_retry into registry + call-site |

## Smoke Evidence

### Positive Smoke (Lenovo1 → 10.0.0.2:3200)

```
retry_at: 2026-04-18T09:01:18Z
POST /mcp/voice.schedule_retry
{"ok":true,"result":{"ok":true,"result":{"task_id":"6b897125-084a-4de5-99f1-230ba30e3934","scheduled_for":"2026-04-18T09:01:18Z"}}}
```

### Negative Smoke — 3 Tests

**NEG-1: retry_at in past**
```
{"error":"bad_request","field":"retry_at","expected":"retry_at_in_past"}
```

**NEG-2: retry_at too far (60d)**
```
{"error":"bad_request","field":"retry_at","expected":"retry_at_too_far"}
```

**NEG-3: empty prompt**
```
{"error":"bad_request","field":"prompt","expected":"prompt_too_short"}
```

### DB Query (store/messages.db)

```json
[
  {
    "id": "6b897125-084a-4de5-99f1-230ba30e3934",
    "schedule_type": "once",
    "next_run": "2026-04-18T09:01:18Z",
    "status": "active",
    "context_mode": "isolated",
    "group_folder": "whatsapp_main"
  }
]
```

### JSONL Entry (data/voice-scheduler.jsonl)

```json
{
  "ts": "2026-04-18T08:56:18.212Z",
  "event": "retry_scheduled",
  "tool": "voice.schedule_retry",
  "call_id": "smoke-03-07",
  "task_id": "6b897125-084a-4de5-99f1-230ba30e3934",
  "scheduled_for": "2026-04-18T09:01:18Z",
  "prompt_len": 93,
  "group_folder": "whatsapp_main",
  "latency_ms": 8
}
```

No `prompt` field — PII-clean confirmed.

### /health

`voice.schedule_retry` present in `tools[]` array confirmed.

### Cleanup

```
cleaned, changes: 1
remaining smoke tasks: 0
```

Smoke task deleted via `DELETE FROM scheduled_tasks WHERE prompt LIKE '%03-07 smoke%'`.

## Deviations from Plan

### Automatically Handled

**1. [Rule 3 - Blocking] Cross-host curl from Hetzner not possible — SSH unavailable**
- **Found during:** Task 3
- **Issue:** `~/.ssh/voice_bot_to_hetzner` key exists but SSH port 22 is refused on 10.0.0.1 (Hetzner). No other SSH port available.
- **Fix:** Ran smoke curls from Lenovo1 (10.0.0.2) directly. 10.0.0.2 is in the MCP peer allowlist, so the peer-allowlist middleware is still exercised. Coverage is equivalent for functional testing.
- **Impact:** Curl origin is Lenovo1 instead of Hetzner. Peer allowlist tested (10.0.0.2 is an allowed peer). No coverage gap for the tool itself.

## Caveats

- **Scheduler execution not live-verified** — the smoke task was deleted before the 5-min fire time. Per plan: "Wenn Zeit knapp: Caveat 'scheduler-execution nicht live-verified'". Container-run spawning on task fire requires a separate observation window.
- **Cleanup via SQL DELETE** — no `deleteTask` MCP tool was built (explicitly out of scope per plan).
- **Double-wrapped result** — the positive smoke response shows `{"ok":true,"result":{"ok":true,"result":{...}}}`. This is the existing mcp-server.ts behavior: `res.status(200).json({ ok: true, result })` wraps whatever the handler returns (which itself returns `{ok:true, result:{...}}`). Pre-existing pattern, not introduced by this plan.

## Next

Plan 03-08 (search_hotels + search_competitors) — then STOP per Briefing §6.

## Self-Check: PASSED

- src/mcp-tools/voice-schedule-retry.ts: FOUND
- src/mcp-tools/voice-schedule-retry.test.ts: FOUND
- Commit 055510a: FOUND
- Commit 20ac34f: FOUND
- Commit 60e209b: FOUND
