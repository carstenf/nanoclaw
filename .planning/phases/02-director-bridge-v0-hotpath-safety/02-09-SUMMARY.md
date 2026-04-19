# 02-09 SUMMARY — Slow-Brain Retrofit bridge-seitig LIVE

**Datum:** 2026-04-17
**Plan:** `.planning/phases/02-director-bridge-v0-hotpath-safety/02-09-PLAN.md`
**Status:** DONE — alle 7 Tasks ausgefuehrt, Bridge deployed, strukturelle Test-Evidence PASS.
**Commit:** nanoclaw `94ffb63`

## Was gebaut wurde

| Komponente | Datei | Rolle |
|---|---|---|
| MCP-Client | `voice-bridge/src/core-mcp-client.ts` | fetch + AbortController, CoreMcpError + CoreMcpTimeoutError |
| Slow-Brain-Worker | `voice-bridge/src/slow-brain.ts` | komplett refactored: coreClient-DI statt anthropic-client; cadence/backpressure/timeout unveraendert |
| Config | `voice-bridge/src/config.ts` | +CORE_MCP_URL/TIMEOUT/TOKEN, -getAnthropicKey, -SLOW_BRAIN_MODEL |
| call-router Test | `voice-bridge/tests/call-router.test.ts` | Regression-Case fuer retrofit-signature |
| Dep-Cleanup | `voice-bridge/package.json` | @anthropic-ai/sdk entfernt |

## Deployment

- `.env` (shared, gitignored): `CORE_MCP_URL=http://10.0.0.2:3200/mcp` hinzugefuegt.
- `systemctl --user restart voice-bridge` → aktiv, Log `bridge_listening 10.0.0.2:4402`, kein Restart-Loop.
- Core-MCP-Server aus 03-01 antwortet vom selben Host (Allowlist seit `207361e` inkludiert 10.0.0.2).

## Test-Evidence

- 13 neue + refactored Tests in voice-bridge (5 core-mcp-client + 8 slow-brain + 1 call-router-regression)
- `npx tsc --noEmit` clean
- `npx vitest run` voice-bridge suite: 139 passed + 1 skipped (20 test-files)

## REQ-Impact

| REQ | Vorher (02-05) | Nachher (02-09) | Status |
|---|---|---|---|
| REQ-DIR-06 | Bridge Claude Sonnet direct | Bridge MCP→Core Claude | ✅ semantisch erfuellt |
| REQ-DIR-11 | instructions-only session.update | unveraendert | ✅ |
| REQ-DIR-12 | Claude-timeout → Bridge WARN + last-known | MCP-timeout/5xx → Bridge WARN + last-known | ✅ |
| REQ-INFRA-12 | LLM-Inference in Voice-Stack | Core-only, Bridge ist Transport | ✅ REPARIERT |
| AC-09 | Business-Logik in Bridge | Bridge ist MCP-Proxy | ✅ REPARIERT |

## Abweichungen vom Plan

- Task 01 env-cleanup: kein `ANTHROPIC_API_KEY` zu entfernen (war nie gesetzt, Bridge lief in no-op-Fallback seit `042ab2c`).
- Task 03 Response-Shape: slow-brain akzeptiert `instructions_update` sowohl flat als auch wrapped (`{ok, result:{ok, instructions_update}}`) — weil der 03-01 MCP-Server den Tool-Output in `{ok, result}` wrappt. Zwei Test-Cases decken beide Shapes.

## Live-PSTN-Smoke pending

Chat-Instruction: "post-deploy End-to-End-Call verifiziert dass Kette funktioniert". Erfordert Carsten-Anruf → wird beim naechsten PSTN-Test verifiziert. Erwartung pro Turn (mit 03-01-Stub):

- Bridge logged `slow_brain_degraded`? Nein — Core-MCP antwortet 200 mit `instructions_update:null`.
- Bridge sendet `session.update`? Nein — weil `instructions_update` null ist. Korrekt bis 03-02 landet.
- JSONL in NanoClaw `data/voice-slow-brain.jsonl` waechst pro Turn (call_id/turn_id/transcript_len).

## Nachfolger

Plan 03-02 (Core-Agent Slow-Brain-Logik) — Chat-Entscheidung Option C aus Authority-Briefing (commit 1788873). Separater Autonomer Plan.
