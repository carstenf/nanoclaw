# Phase 05.6 Plan 02 — Live PSTN Cutover Log

**Phase-split rationale:** D-28 (explicit checkpoints between each cutover step). All tests use REASONING_MODE=container-agent runtime-ENV only — config.ts default flag is NOT touched in this plan.

## Pre-cutover gate
- Timestamp: 2026-04-25T14:55:00Z
- Carsten signal: "Run 05.6-02 now (live cutover)" — selected via AskUserQuestion at 2026-04-25 14:55 UTC. Wave 1 complete, all tests green, AGENT_NOT_WIRED zero in production code, gateway wired (3-grep PASS).

## Step 1 — Synthetic 2-turn re-run
- Status: PASS
- Timestamp: 2026-04-25T15:00:42Z
- Trace: /tmp/synth-cutover-1777129240.log
- Result: All 4 tests green under REASONING_MODE=container-agent + NANOCLAW_VOICE_MCP_URL=http://127.0.0.1:3201/. Du/Sie axis exercised (case_6b Du-form, case_2 Sie-form). FALLBACK_PERSONA path proven on simulated agent timeout. NanoclawMcpClient.transcript end-to-end via real MCP wire works after the mcp-stream-server fix (fa1d27d).
- Carsten verdict: AUTO-PASS (synthetic)

## Step 2 — Carsten inbound PSTN
- Status: **PASS (architecture verified, D-29 strict deferred — see notes)**
- Timestamp: 2026-04-25T16:13:11Z (final verification call)
- Trace path: ~/nanoclaw/voice-container/runs/turns-rtc_u7_DYZuvJhjvZKifjXgHQW45.jsonl
- call_id: rtc_u7_DYZuvJhjvZKifjXgHQW45
- Demonstrated Case-6b functionality (D-29 strict — at least ONE of these): [ ] Kalender   [ ] Fahrzeit   [ ] Memory-Lookup
- Carsten verdict: **PASS** (Du-Form bestätigt, persona-render-architektur verifiziert)

### Architecture verification — primary cutover goal achieved
- Bridge log: `voice_render_init_ok` (was `container_agent_init_failed err: agent_unavailable` before)
- Render latency: ~3ms (smoke-tested locally, render is pure-template now)
- Persona output: case_6b Du-axis correctly applied — bot's first greeting was literally "Moin Carsten! Schön, dass du dran bist." — case_6b inbound overlay text rendered through the new path.
- No FALLBACK_PERSONA used.
- No `{{...}}` placeholder leaks.
- Inbound SCHWEIGEN_LADDER picked, outbound block dropped.

### Architecture pivot summary (this plan)
- Plan 05.6-01 wired voice_triggers_* → runContainerAgent (whatsapp_main / main group). Live test: container cold-start + Claude Agent SDK init >> 5000ms /accept budget. Always fell to FALLBACK_PERSONA. Symptom: Sie-Form persistente Erscheinung trotz case_6b.
- Plan 05.6-02 attempt 1 (Option A, commit b491156): direct Anthropic API render via OneCLI proxy. Live-tested 2026-04-25: even Haiku-4-5 takes 10-18s for a 1500-token persona render. Still overshoots /accept budget. Same Sie-form symptom.
- Plan 05.6-02 final (Option E, commit de72c11): pure-template TypeScript render — fs.readFileSync skill files + regex placeholder substitution + SCHWEIGEN block picker + Du/Sie derivation. Render time 3ms, deterministic. THIS commit fixed the cutover.

### Pre-pivot bug fixes also landed
- `fa1d27d`: mcp-stream-server skip synthetic IDs for voice_triggers_* (Pitfall-8 was overwriting real call_id/turn_id, Zod-rejecting transcript trigger)
- `76b4c26`: mcp-stream-server peer allowlist: add 127.0.0.1 / ::1 (was rejecting Bridge → NanoClaw loopback)
- `35aa1df`: feat: WhatsApp channel removed (cleanup, decoupling)

### D-29 strict not formally satisfied — deferred
The D-29 strict checkboxes (Kalender / Fahrzeit / Memory-Lookup) require a demonstrated working tool. The verification call exercised Memory-Lookup via `ask_core` — bot followed the case_6b overlay correctly ("Moment, ich frage Andy mal..." → ask_core tool call) — but the **ask_core tool itself** returned an error ("Das funktioniert gerade nicht"). This is a **separate tool-layer bug**, not a persona/architecture issue:
- The persona pathway (THIS plan's scope) works correctly.
- ask_core is a delegation tool from voice → Andy/slow-brain. It may be wired to the legacy slow-brain endpoint that Plan 06-03 cleanup will delete. **Investigation required before Plan 06-03.**

### Carsten decision (2026-04-25)
- Step 2 marked PASS based on architecture verification.
- Step 3 (Case-2 outbound) and Plan 06-03 (cleanup) DEFERRED to next session.
- ask_core wiring must be analysed BEFORE Plan 06-03 cleanup — risk that cleanup breaks ask_core or other tools that still reference slow-brain.

### Open follow-ups (next session)
1. Investigate `voice_ask_core` / `ask_core` MCP-tool wiring: which endpoint does it hit? slow-brain (going away in 06-03) or independent path?
2. If slow-brain-dependent → fix plan first; if independent → proceed to 06-03 unchanged.
3. Step 3 (Case-2 outbound PSTN test) once 06-03 dependency cleared.

## Step 3 — Case-2 outbound PSTN
- Status: PENDING
- Trace path: ~/nanoclaw/voice-container/runs/turns-${call_id}.jsonl
- call_id: <FILLED>
- Demonstrated Case-2 dialog (D-29 strict — at least ONE of these): [ ] Counterpart-question handling   [ ] Hold-music tolerance   [ ] Readback
- Carsten verdict: <FILLED>

## Final cutover decision
- All three PASS? <FILLED>
- Proceed to Plan 06-03 (default flip + cleanup)? <FILLED>
