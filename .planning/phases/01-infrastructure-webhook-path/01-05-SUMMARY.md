---
phase: 01-infrastructure-webhook-path
plan: 05
subsystem: voice-bridge
tags: [bridge, typescript, fastify, systemd, heartbeat, tdd]
dependency_graph:
  requires: ["01-01", "01-02", "01-03"]
  provides: ["voice-bridge-stub", "webhook-signature-recheck", "wg-heartbeat", "jsonl-audit-log"]
  affects: ["01-06"]
tech_stack:
  added:
    - fastify@5.8.x
    - openai@6.34.x (webhooks.unwrap — async, returns Promise)
    - pino@10.3.x + pino-roll@4.x (daily JSONL rotation)
  patterns:
    - TDD RED→GREEN (scaffold → implementation)
    - buildApp() exported for vitest inject (no port binding in tests)
    - lazy getSecret() to avoid process.exit at module import time
    - env read at call time in alerts.ts + heartbeat.ts for test isolation
key_files:
  created:
    - voice-bridge/src/index.ts
    - voice-bridge/src/config.ts
    - voice-bridge/src/logger.ts
    - voice-bridge/src/webhook.ts
    - voice-bridge/src/health.ts
    - voice-bridge/src/heartbeat.ts
    - voice-bridge/src/alerts.ts
    - voice-bridge/tests/synthetic-webhook.test.ts
    - voice-bridge/tests/heartbeat.test.ts
    - voice-bridge/systemd/voice-bridge.service
    - voice-bridge/README.md
    - voice-bridge/package.json
    - voice-bridge/tsconfig.json
    - voice-bridge/vitest.config.ts
  modified: []
decisions:
  - "webhooks.unwrap() is async (returns Promise) — must await in route handler; try/catch alone does not catch async rejections"
  - "config.ts uses lazy getSecret() not module-level SECRET constant — avoids process.exit during vitest module imports"
  - "alerts.ts + heartbeat.ts read env vars at call time — enables beforeEach overrides in tests"
  - "systemd ExecStart uses nvm node path (/home/carsten_bot/.nvm/versions/node/v22.22.2/bin/node) — /usr/bin/node absent on Lenovo1"
  - "valid-signature test stays .skip — requires SDK round-trip with real secret; covered by Plan 06 integration test (RESEARCH Assumption A2)"
metrics:
  duration_minutes: 62
  completed: "2026-04-16T16:51:00Z"
  tasks_completed: 3
  files_created: 14
---

# Phase 01 Plan 05: voice-bridge stub Summary

TypeScript + Fastify v5 Director Bridge stub on Lenovo1 — re-verifies OpenAI webhook signatures (defense-in-depth), writes JSONL audit log, exposes /health, runs HTTP canary heartbeat with throttled Discord ALERTs, systemd unit template in repo.

## vitest Results

```
Test Files  2 passed (2)
Tests       5 passed | 1 skipped (6)
Duration    ~420ms
```

The skipped test (`POST /webhook valid signature → 200 + JSONL entry`) is intentional per RESEARCH Assumption A2 — exact HMAC round-trip requires a real secret; covered by Plan 06 integration test.

## Source LOC

| File | Lines |
|------|-------|
| src/index.ts | 80 |
| src/heartbeat.ts | 80 |
| src/webhook.ts | 46 |
| src/logger.ts | 37 |
| src/config.ts | 29 |
| src/health.ts | 18 |
| src/alerts.ts | 21 |
| **Total** | **311** |

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 (RED) | 7f7e4b2 | test(01-05): RED scaffold — package + vitest tests |
| Task 2 (GREEN) | a8d4200 | feat(01-05): GREEN — voice-bridge implementation |
| Task 3 | 19fa9df | chore(01-05): systemd unit template + README |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `webhooks.unwrap()` is async — try/catch insufficient**
- **Found during:** Task 2 GREEN phase, first vitest run
- **Issue:** RESEARCH Template 4 shows synchronous `openai.webhooks.unwrap()` call. The actual openai@6.34 Node SDK returns a `Promise` that rejects on bad signature. A `try/catch` without `await` does not intercept the async rejection — the test saw 200 instead of 401.
- **Fix:** Added `await` before `openai.webhooks.unwrap(...)` in `src/webhook.ts`
- **Files modified:** `src/webhook.ts`
- **Commit:** a8d4200

**2. [Rule 1 - Bug] `config.ts` module-level `SECRET` evaluation caused `process.exit` during vitest import**
- **Found during:** Task 2 GREEN phase
- **Issue:** Heartbeat tests don't set `OPENAI_WEBHOOK_SECRET` — they only test the heartbeat logic. But importing `src/heartbeat.ts` → `src/alerts.ts` → `src/config.ts` triggered the IIFE that calls `process.exit(1)` if the env var is missing.
- **Fix:** Replaced the module-level `SECRET` constant with a lazy `getSecret()` function. Updated `index.ts` and `webhook.ts` to call it inside `buildApp()` only.
- **Files modified:** `src/config.ts`, `src/index.ts`, `src/webhook.ts`
- **Commit:** a8d4200

**3. [Rule 1 - Bug] `DISCORD_ALERT_WEBHOOK_URL` and `WG_PEER_URL` frozen at module load**
- **Found during:** Task 2 GREEN phase
- **Issue:** Both were read as module-level constants from `config.ts`. Tests set them in `beforeEach`, but by then the module was already cached with empty/default values, causing tests to see stale values.
- **Fix:** Changed `alerts.ts` and `heartbeat.ts` to read `process.env.*` at call time.
- **Files modified:** `src/alerts.ts`, `src/heartbeat.ts`
- **Commit:** a8d4200

**4. [Rule 2 - Missing critical functionality] `OpenAI()` requires `apiKey` even for webhook-only use**
- **Found during:** Task 2 GREEN phase
- **Issue:** `new OpenAI({ webhookSecret: SECRET })` throws "Missing credentials. Please pass an apiKey" even when no API calls are made — only `webhooks.unwrap()` is used.
- **Fix:** Added `apiKey: 'not-used'` to the constructor options in `buildApp()`. Webhook verification does not use the API key.
- **Files modified:** `src/index.ts`
- **Commit:** a8d4200

**5. [Rule 3 - Blocking] Node path is `/home/carsten_bot/.nvm/versions/node/v22.22.2/bin/node`, not `/usr/bin/node`**
- **Found during:** Task 3 (systemd unit)
- **Issue:** RESEARCH Template 6 uses `/usr/bin/node`. On Lenovo1, `command -v node` returns the nvm-managed path. Using `/usr/bin/node` in the ExecStart would silently fail on service start.
- **Fix:** Used the actual nvm path in `systemd/voice-bridge.service`. Added note in unit file header to update if nvm version changes.
- **Files modified:** `voice-bridge/systemd/voice-bridge.service`
- **Commit:** 19fa9df

## Pitfalls Acknowledged in Code Comments

| Pitfall | File | Comment |
|---------|------|---------|
| NEW-4: addContentTypeParser global JSON override | src/index.ts | Top-of-file + inline comment |
| NEW-5: pino-roll + journald level discipline | src/logger.ts | Top-of-file comment |
| D-16 HTTP canary over ICMP rationale | src/heartbeat.ts | Top-of-file comment citing RESEARCH |

## systemd Unit Status

Unit file at `voice-bridge/systemd/voice-bridge.service` — **NOT installed** per execution context constraint. Linger confirmed `yes` on Lenovo1. Deployment steps in README.md.

## Known Stubs

- `/webhook` returns `{ok: true}` 200 with no downstream action — Phase 1 scope by design (D-07). Phase 2 will add `/accept` call.
- Heartbeat state (`wg_ok`) not surfaced in `/health` — Phase 1 deferred per D-07. Phase 2 will add.

## Threat Flags

None — all new surface is accounted for in the plan's threat model (T-05-01 through T-05-08).

## Self-Check: PASSED

All 14 files exist. All 3 commits verified in git log. vitest: 5 passed, 1 skipped (by design).
