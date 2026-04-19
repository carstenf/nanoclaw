---
phase: 03-voice-mcp-endpoint
plan: 10
subsystem: voice-mcp / container-runner
tags: [voice, andy, container-agent, ask-core, mcp-tool]
completed: "2026-04-18"
duration_min: 75

dependency_graph:
  requires:
    - "03-08: ask_core echo-path + skill-loader"
    - "03-09: REQ-TOOLS shapes"
  provides:
    - "voice.ask_core topic=andy: real container-agent call against groups/main"
    - "runAndyForVoice: DI-injectable Andy runner"
    - "getMainGroup: DB accessor for is_main=1 group"
  affects:
    - "voice-bridge (02-14): filler phrase + persona-split (next plan)"

tech_stack:
  added:
    - "andy-agent-runner.ts: onOutput-streaming container wrapper"
    - "data/skills/ask-core-andy/SKILL.md: JSON-strict voice skill"
    - "getMainGroup() in db.ts: SELECT WHERE is_main=1"
    - "ASK_CORE_ANDY_TIMEOUT_MS, ANDY_VOICE_DISCORD_CHANNEL in config.ts"
  patterns:
    - "onOutput streaming to reset container-runner idle-timeout on cold starts"
    - "parseLastJsonBlock: backwards JSON block search in container stdout"
    - "DI pattern (AndyRunnerDeps) for unit-testable container interaction"

key_files:
  created:
    - src/mcp-tools/andy-agent-runner.ts
    - src/mcp-tools/andy-agent-runner.test.ts
    - data/skills/ask-core-andy/SKILL.md
  modified:
    - src/mcp-tools/voice-ask-core.ts
    - src/mcp-tools/voice-ask-core.test.ts
    - src/mcp-tools/index.ts
    - src/config.ts
    - src/db.ts

decisions:
  - "Use onOutput streaming callback instead of post-hoc stdout parsing: cold container starts take 60-120s; onOutput resets the container-runner's internal idle-timeout on each output marker, allowing the container to complete without false timeout"
  - "No sessionId in containerInput: voice requests must start fresh sessions; passing a new UUID caused agent-runner to attempt session resume which always fails"
  - "Use mainGroup.folder from DB (e.g. 'whatsapp_main'), NOT hardcoded 'main': folder name is channel-prefixed in this installation"
  - "ASK_CORE_ANDY_TIMEOUT_MS default 90s: serves as safety net for hang/no-output; streaming recovery handles the normal case where output arrives after 90s race fires"

metrics:
  tasks_completed: 5
  tests_added: 15
  tests_total: 472
  new_failures: 0
  rule1_fixes: 3
---

# Phase 03 Plan 10: voice.ask_core(topic='andy') Container-Agent Runner — Summary

Real container-agent call for `voice.ask_core` with `topic='andy'`. When Carsten says "frage Andy X" during a phone call, the voice-bridge calls this MCP tool, which now spawns a real Andy container against `groups/main` (full tool-set: WebSearch, WebFetch, browser, MCP-tools, full context). The container responds with strict JSON `{voice_short, discord_long}`. Voice bot gets the 3-sentence answer; long-form goes to Discord.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| 372d51d | feat | andy-agent-runner + getMainGroup + config constants |
| 3d455e8 | chore | skill-file ask-core-andy/SKILL.md |
| 3cebc17 | feat | voice-ask-core two-path refactor (topic=andy + echo) |
| 9b1ad4b | feat | wire runAndy + sendDiscord + andyDiscordChannel into voice.ask_core |
| daa73bc | fix | sessionId + groupFolder + timeout bugs in andy-agent-runner |
| 77a5044 | fix | use onOutput streaming in andy-agent-runner to survive cold starts |

## Smoke Evidence

### topic='andy' (smoke-03-10-andy-4, run after all fixes)

```
curl -X POST http://10.0.0.2:3200/mcp/voice.ask_core \
  -d '{"arguments":{"call_id":"smoke-03-10-andy-4","topic":"andy","request":"wer war der erste Mensch auf dem Mond"}}'

Response (90s real time, container cold start):
{"ok":true,"result":{"ok":true,"result":{"answer":"Der erste Mensch auf dem Mond war Neil Armstrong. Er betrat am 20. Juli 1969 als Kommandant der Apollo-11-Mission die Mondoberfläche.","topic":"andy","citations":[]}}}
```

Voice_short: 2 sentences, correct German, no emoji, no markdown. Container log: `andy_using_streamed_result_after_race_timeout` — streaming recovery worked.

### topic='test' regression (smoke-03-10-regression-2)

```
{"ok":true,"result":{"ok":true,"result":{"answer":"Hallo Carsten von NanoClaw.","topic":"test","citations":[]}}}
```

Echo path unchanged.

### Container spawn log

```
[19:22:53] INFO: Spawning container agent (containerName: nanoclaw-whatsapp-main-1776540173818)
[19:22:53] INFO: Andy container spawned for voice request (event: andy_container_spawned)
[19:24:23] INFO: Race timeout fired but streamed result available — using it (event: andy_using_streamed_result_after_race_timeout)
```

### JSONL events (last 2 relevant lines)

```json
{"ts":"2026-04-18T19:24:23.825Z","event":"ask_core_andy_done","tool":"voice.ask_core","call_id":"smoke-03-10-andy-4","topic":"andy","request_len":37,"container_latency_ms":90009,"voice_short_len":133,"discord_long_sent":false,"discord_long_len":null}
{"ts":"2026-04-18T19:24:37.865Z","event":"ask_core_done","tool":"voice.ask_core","call_id":"smoke-03-10-regression-2","topic":"test","request_len":9,"answer_len":27,"latency_ms":1092}
```

PII-clean: no request/answer text. New fields present: `container_latency_ms`, `voice_short_len`, `discord_long_sent`, `discord_long_len`.

## Deviations from Plan

### Auto-fixed Issues (Rule 1)

**1. [Rule 1 - Bug] sessionId caused session-resume failure**
- **Found during:** Task 05 smoke
- **Issue:** `runAndyForVoice` passed a new `randomUUID()` as `sessionId`. The agent-runner interpreted this as a session to resume, which failed with "No conversation found with session ID: ...". Container exited code 1 after 19s.
- **Fix:** Removed sessionId entirely from containerInput. Voice requests always start fresh conversations.
- **Files modified:** `src/mcp-tools/andy-agent-runner.ts`
- **Commit:** daa73bc

**2. [Rule 1 - Bug] Hardcoded groupFolder 'main' instead of mainGroup.folder**
- **Found during:** Task 05 smoke (same run as above)
- **Issue:** `containerInput.groupFolder` was hardcoded `'main'`. The actual main group folder in this installation is `whatsapp_main`. Wrong IPC/log paths were used.
- **Fix:** Use `mainGroup.folder` from the DB row (whatever `getMainGroup()` returns).
- **Files modified:** `src/mcp-tools/andy-agent-runner.ts`
- **Commit:** daa73bc

**3. [Rule 1 - Bug] Cold container starts exceed 30s/90s race timeout**
- **Found during:** Task 05 smoke (subsequent runs)
- **Issue:** Without `onOutput`, the container-runner's internal idle-timeout fires during cold start (docker spawn + npm compile takes 60-120s). Even with 90s race timeout, the race would fire before the container produced output.
- **Fix:** Pass `onOutput` streaming callback. `runContainerAgent` resets internal idle-timeout on each output marker. Added recovery path: if race timeout fires but `streamedResult` is populated, use it.
- **Files modified:** `src/mcp-tools/andy-agent-runner.ts`
- **Commit:** 77a5044

## Cost & Latency

- **Cold start latency:** ~90-120s (Docker spawn + npm recompile of agent-runner + Claude inference)
- **Warm start latency:** Expected 20-40s (container image cached, agent-runner pre-compiled)
- **Per-call cost:** ~$0.03-0.10 (Claude Max OAuth, no API credits for inference)
- **Daily cost at <20 calls:** Well under €3/day cap

## Known Stubs

None. The andy path is fully wired end-to-end.

## Caveats

- Cold starts take 60-120s. For production voice calls, the voice-bridge (02-14) must emit a filler phrase ("Moment, ich frage Andy...") immediately so the caller hears something while waiting.
- The `discord_long` Discord-forward was not tested in smoke (no question long enough to trigger it). Discord channel wiring is in place — tested via unit tests.
- The `ASK_CORE_ANDY_TIMEOUT_MS = 90s` race timeout is a safety net. Normal operation relies on streaming recovery. If a warm container can answer in 20-40s, the race won't fire at all.

## Next

Plan 02-14: Voice-bridge Persona-Split — filler phrase for Case-6b "frage Andy", plus persona-side "Details hab ich dir in Discord geschickt" when discord_long was sent.

## Self-Check: PASSED

- andy-agent-runner.ts: EXISTS
- andy-agent-runner.test.ts: EXISTS
- data/skills/ask-core-andy/SKILL.md: EXISTS
- voice-ask-core.ts: two-path handler with topic==='andy' branch confirmed
- voice-ask-core.test.ts: 13 tests (7 existing + 6 new)
- andy-agent-runner.test.ts: 9 tests
- Commits 372d51d, 3d455e8, 3cebc17, 9b1ad4b, daa73bc, 77a5044: all present in git log
- tsc: clean
- vitest: 472 passed, 1 pre-existing gmail failure, 0 new failures
