---
phase: "05-case-2-restaurant-reservation-outbound"
plan: "01"
subsystem: "mcp-tools / channel-routing"
tags:
  - channel-routing
  - seed-001
  - notify
  - deprecation
  - wave-1
dependency_graph:
  requires:
    - "04.5-04 (Core MCP registry, ToolHandler type, appendJsonl pattern)"
    - "03-11 (voice_request_outbound_call, BadRequestError)"
  provides:
    - "voice_notify_user Core MCP tool (port 3201)"
    - "ActiveSessionTracker module"
    - "VOICE_ACTIVE_SESSION_WINDOW_MS + VOICE_NOTIFY_LONG_TEXT_WORD_THRESHOLD config constants"
    - "deprecation-observability log on voice_send_discord_message"
  affects:
    - "05-02 (Wave 2 wires active-session-tracker.recordActivity into inbound-message loop AND uses voice_notify_user from Case-2 escalation paths)"
    - "05-03 (Wave 3 Case-2 persona escalation uses voice_notify_user directly)"
tech_stack:
  added: []
  patterns:
    - "DI factory pattern (makeVoiceNotifyUser mirrors makeVoiceSendDiscordMessage)"
    - "Three-step routing: long_text_override > active-session-lookup > fallback-to-Discord"
    - "Deprecation-observability log pre-parse (Phase 4.5 Wave 4 pattern reused)"
key_files:
  created:
    - src/mcp-tools/voice-notify-user.ts
    - src/mcp-tools/voice-notify-user.test.ts
    - src/channels/active-session-tracker.ts
    - src/channels/active-session-tracker.test.ts
  modified:
    - src/mcp-tools/index.ts
    - src/mcp-tools/voice-send-discord-message.ts
    - src/mcp-tools/voice-send-discord-message.test.ts
    - src/config.ts
decisions:
  - "Routing algorithm: long_text_override (>50 words) takes precedence over active-session state, then Discord fallback — implements feedback_long_text_discord.md as hard production rule"
  - "Tool-name regex ^[a-zA-Z0-9_]{1,64}$ validated at module load (D-4 locked)"
  - "Bridge allowlist intentionally NOT modified — voice_notify_user is Core-MCP-exposed, not Realtime-model-exposed; REQ-TOOLS-09 ceiling at 15 unchanged"
  - "Deprecation log fires pre-parse (every invocation) — same pattern as mcp_rest_request_seen in Phase 4.5 Plan 04"
  - "Active-session-tracker created in buildDefaultRegistry but NOT wired to inbound-message events — Wave 2 (Plan 05-02 Task 5) adds that wiring"
metrics:
  duration_minutes: 25
  completed: "2026-04-20T18:45:51Z"
  tasks_completed: 3
  files_changed: 8
requirements_partial:
  - "C2-04: escalation channel available (voice_notify_user registered) but not yet wired to Case-2 logic"
  - "C2-05: notification channel available but not yet wired to calendar-confirmed path"
---

# Phase 05 Plan 01: SEED-001 voice_notify_user + Active-Session Tracker Summary

Channel-agnostic `voice_notify_user` Core MCP tool with three-step routing (long-text-override > active-session-lookup > Discord-fallback), in-memory active-session tracker, and deprecation-observability log on `voice_send_discord_message`.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 (RED) | active-session-tracker failing tests | dc4eae5 | active-session-tracker.test.ts |
| 1 (GREEN) | active-session-tracker implementation | 2f4ee7c | active-session-tracker.ts, config.ts |
| 2 (RED) | voice_notify_user failing tests | ee64791 | voice-notify-user.test.ts |
| 2 (GREEN) | voice_notify_user implementation + registration | 78cbeef | voice-notify-user.ts, index.ts |
| 3 (RED) | deprecation-observability test | 0367756 | voice-send-discord-message.test.ts |
| 3 (GREEN) | deprecation-observability log | 1275cd9 | voice-send-discord-message.ts |

## Test Results

- `active-session-tracker`: 7/7 passed
- `voice-notify-user`: 10/10 passed
- `voice-send-discord-message`: 9/9 passed (8 pre-existing + 1 new)

## Tool-Count Audit

- Bridge allowlist (`voice-bridge/src/tools/allowlist.ts`): **NOT modified** — 15 tools (REQ-TOOLS-09 ceiling respected)
- Core MCP registry: gained 1 → `voice_notify_user` (port 3201, not Realtime-exposed)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

- `sendWhatsappMessage` in `buildDefaultRegistry` returns `{ok:false, error:'no_whatsapp'}` — WhatsApp channel injection into the Core MCP registry is Wave 2's job (Plan 05-02). The tool is fully functional for Discord routing now.
- `isWhatsappConnected` hardcoded to `() => false` in registry wiring — same Wave 2 scope.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes beyond what the plan's threat model covers.

## Self-Check: PASSED

- `src/mcp-tools/voice-notify-user.ts` — FOUND (200 lines, ≥100 required)
- `src/mcp-tools/voice-notify-user.test.ts` — FOUND (184 lines, ≥150 required)
- `src/channels/active-session-tracker.ts` — FOUND
- `src/channels/active-session-tracker.test.ts` — FOUND
- `VOICE_ACTIVE_SESSION_WINDOW_MS` in config.ts — FOUND
- `VOICE_NOTIFY_LONG_TEXT_WORD_THRESHOLD` in config.ts — FOUND
- `mcp_tool_voice_send_discord_message_seen` in voice-send-discord-message.ts — FOUND
- `voice_notify_user` registered in index.ts — FOUND
- Bridge allowlist unchanged — CONFIRMED
- TypeScript build: PASSED (no errors)
