# Q7 Finding — session.update Atomicity

**Probed:** 2026-04-28
**Source:** Documentation research only — empirical probe deferred (no OPENAI_API_KEY in this environment)
**Verdict:** INCONCLUSIVE

## Method

1. Open Realtime WebSocket session at wss://api.openai.com/v1/realtime
2. Send initial session.update (Mode A): instructions="APFEL", tools=[tool_a_unique]
3. Send response.create, capture Mode A response + available tools
4. Send SECOND session.update (Mode B): instructions="BIRNE", tools=[tool_b_unique]
   — BOTH fields in a single client-side payload (the atomicity test)
5. Send response.create immediately after session.updated #2
6. Observe response text (BIRNE = new instructions applied; APFEL = old lingered)
   AND tool_calls (tool_b_unique = new tools applied; tool_a_unique = old lingered)

## Observations

```
session_updated_count: 0
session_updated_carried_both_fields: null
response_a_text: ""
response_b_text: ""
tool_calls_in_response_b: []
had_error: true
error_messages: ["probe timeout (30s)"]
elapsed_ms: 0
```

## Evidence Narrative

Probe could not be executed: probe timeout (30s)

## Implications for 05.2 handoff

- **If ATOMIC:** single `session.update` carrying instructions+tools is safe
  for the AMD→baseline+overlay handoff in webhook.ts onHuman closure.
  Current implementation (single-shot `updateInstructions`) is correct.
- **If NON-ATOMIC:** workaround — send `session.update({tools_only})` first,
  await `session.updated` confirmation, then `session.update({instructions_only})`.
  Alternative: send `response.cancel` between the two updates to avoid a
  response firing with mixed old/new state.
- **If INCONCLUSIVE:** default to treating as ATOMIC per OpenAI Cookbook
  "Dynamic Conversation Flow via session.updates" pattern (research §2.1
  + §6.4 Q7). Add monitoring for tool-call anomalies in 05.2-06 live-verify
  traces; re-run this probe empirically once API key is available.

## Phase 05.2 decision

- webhook.ts `updateInstructions` call: UNCHANGED. Current single-shot `session.update` (instructions-only; `tools` not re-pushed because the tool list was fixed at `/accept` and does not change post-AMD-verdict) remains correct.
- Case-2 tool list was set at `/accept` (the 13 tools including `amd_result`)
  and is NOT re-pushed by the onHuman handoff. This means Q7 is LESS load-bearing
  for the current 05.2 handoff than feared — the handoff only ever updates
  `instructions`, never tools.
- Future Phase 5 state-graph transitions MAY push both simultaneously; this
  finding applies to them directly. Revisit per-transition if behavior drifts.

## References

- OpenAI Cookbook "Realtime Prompting Guide — Dynamic Conversation Flow via session.updates":
  https://developers.openai.com/cookbook/examples/realtime_prompting_guide
- OpenAI Realtime Server Events (session.updated):
  https://developers.openai.com/api/reference/resources/realtime/server-events
- OpenAI Realtime Conversations guide:
  https://platform.openai.com/docs/guides/realtime-conversations
- Research §2.1 (Realtime official 8-section prompt structure) + §6.4 Q7 (original open question).
- CONTEXT.md canonical reference Q7 (Phase 05.2 source-of-truth).
