---
id: SEED-001
status: dormant
planted: 2026-04-20
planted_during: Phase 4.5 close (MCP Universal Consolidation)
trigger_when: planning Phase 5 outbound refactor or any voice-path refactor
scope: medium
---

# SEED-001: Channel-agnostic voice MCP responses

## Why This Matters

Today `voice_send_discord_message` is a hard-coded channel in the MCP tool surface. Andy (NanoClaw core) is the rightful owner of channel routing — it already knows the active WhatsApp session, Discord presence, Telegram, etc. via the channel registry, plus has the existing rule "long text (>50 words) → Discord" (see memory `feedback_long_text_discord.md`).

Hard-coded Discord in a voice tool means every new channel (WhatsApp, Telegram, Slack) needs its own voice-side tool — that scales badly and duplicates routing logic that already lives in Andy. The cleaner design: replace `voice_send_discord_message` with a generic `voice_notify_user(text, urgency)` — the voice path returns the payload on the MCP channel, Andy inspects it + routes per channel-registry state.

Surfaced by Carsten after Phase 4.5 iOS-unblock made the universal MCP channel real — now there's actually "one MCP channel" to return things on, which wasn't the architectural reality before.

## When to Surface

**Trigger:** Planning Phase 5 (Case 2 — Restaurant Outbound) or any follow-up phase that refactors the outbound call path or voice-tool surface.

This seed should be presented during `/gsd-new-milestone` or `/gsd-discuss-phase 5` when the milestone/phase scope matches:
- Outbound call flow changes
- Voice-tool surface refactor
- Channel-routing / Andy-router rule changes
- New channel addition (Telegram, Slack) that would otherwise need its own voice-side tool

## Scope Estimate

**Medium** — a phase or two. Mechanical parts (rename tool, update 6 bridge callers, remove hard-coded Discord client import) ≈ 1-2 days. Harder parts: Andy router rule for `voice_notify_user` output, latency budget check during live calls, preservation of idempotency keys across the routing layer. Likely 1 dedicated plan inside Phase 5 or a Phase 4.6 mini-phase if the current Phase 5 scope is already full.

## Tradeoff to Revisit

**Latency during live voice call:** direct Discord-POST from a voice tool takes ~200 ms; async Andy-routing could add 50-200 ms depending on channel-registry lookup. Measure before committing — for non-live notifications (post-call summary) latency is irrelevant.

## Breadcrumbs

Related code in current codebase:
- `src/mcp-tools/voice-send-discord-message.ts` — the hard-coded sink to replace
- `src/mcp-tools/voice-send-discord-message.test.ts` — existing test coverage
- `src/mcp-tools/index.ts` — registration point (line 219 area)
- `voice-bridge/src/tools/dispatch.ts` — bridge-side caller
- `src/router.ts` — Andy's current router logic (inspect for content-length rule hook point)
- `src/channels/registry.ts` — channel registry, source of truth for active channels

Related memory entries:
- `feedback_long_text_discord.md` — existing rule (>50 words → Discord)
- `feedback_inbound_outbound_separate.md` — constraint: don't touch inbound when doing outbound
- `project_mcp_tool_name_regex.md` — any new tool name must follow `^[a-zA-Z0-9_]{1,64}$` (learned in Phase 4.5)

Related decisions:
- `.planning/decisions/2026-04-20-mcp-universal-consolidation.md` — the Phase 4.5 consolidation that made this seed possible

## Notes

Carsten's framing (verbatim, 2026-04-20 ~14:00 UTC): "wenn wir jetzt dieses recht universelle mcp tool haben, macht es dann noch sinn die antwort hart auf den discord zu senden? oder ist es besser es einfach auf dem mcp kanal zurück zu geben und dann kann der nanoclaw agent entscheiden welches der prio 1 kanal ist und es dort ausgeben?"

Agreed direction: merge into Phase 5 scope when the outbound flow is already being touched, rather than a standalone mini-phase — avoid churning voice-bridge twice in rapid succession.
