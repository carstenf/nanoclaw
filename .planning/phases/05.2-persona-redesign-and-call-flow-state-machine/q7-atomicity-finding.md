# Q7 Finding — session.update Atomicity

**Probed:** 2026-04-22
**Source:** Documentation research (`.planning/research/voice-persona-architecture.md` §2.1 + §6.4 Q7) + OpenAI Realtime Cookbook & Conversations guide. Empirical probe (`voice-bridge/scripts/session-update-atomicity-probe.ts`) authored but NOT executed in this worktree (no `OPENAI_API_KEY` in parallel-executor sandbox). Probe is idempotent and re-runnable — see "Empirical probe — pending" section.
**Verdict:** INCONCLUSIVE (documentation-lean: ATOMIC)

## Method

Documentation research (primary) — cross-reference three OpenAI sources:

1. **OpenAI Cookbook — Realtime Prompting Guide, "Dynamic Conversation Flow via session.updates" section.** This section presents a `set_conversation_state` function-calling pattern where a single `session.update` "replac[es] the prompt and tools" to transition conversation state. The Cookbook presents this as a *single* operation throughout the example; the language never hints at a split or an intermediate window.
2. **OpenAI Realtime Server Events reference, `session.updated` event.** Describes the event payload shape but is silent on whether client-side `session.update` can produce multiple server-side `session.updated` events (split by field).
3. **OpenAI Realtime Conversations guide.** Describes the conversation lifecycle but does NOT explicitly commit to atomicity of `session.update`.

Empirical probe (deferred — see below) — open a Realtime WebSocket session, send two `session.update` messages with different `instructions` and `tools`, observe:
- Does `response.done` for the second mode contain the new marker word (BIRNE) or the old (APFEL)?
- If a tool is invoked, is it `tool_b_unique` (new) or `tool_a_unique` (old)?
- How many `session.updated` events fire per client-side `session.update`?

## Observations

### Documentation evidence (conclusive-leaning)

- Cookbook "Dynamic Conversation Flow" example uses `set_conversation_state` to call `session.update` with both `instructions` AND `tools` changed at once, and the example shows **no** special handling (no `response.cancel`, no two-step, no wait-for-`session.updated`) — implying the OpenAI team considers this safe.
- This pattern is the *recommended* way to transition conversation state in the Cookbook. If it were non-atomic, the Cookbook would document the race condition.

### Documentation evidence (weak-negative)

- The Server Events reference does not publish an atomicity guarantee in writing. The community forums contain no confirmed race-condition reports for `session.update`.

### Empirical probe — pending

The probe script at `voice-bridge/scripts/session-update-atomicity-probe.ts` is ready to execute. Run it when an `OPENAI_API_KEY` is available (e.g., during 05.2-06 live-verify prep or in CI with the secret injected):

```bash
cd /home/carsten_bot/nanoclaw/voice-bridge
export OPENAI_API_KEY=sk-...   # from OneCLI vault or .env
npx tsx scripts/session-update-atomicity-probe.ts
```

The probe writes its empirical verdict back to THIS file (overwrites), so running it converts the finding from INCONCLUSIVE → ATOMIC or NON-ATOMIC. Cost < €0.02 (under 10 seconds of Realtime minutes).

```
session_updated_count: 0          (probe not run)
session_updated_carried_both_fields: null
response_a_text: ""
response_b_text: ""
tool_calls_in_response_b: []
had_error: false
error_messages: []
elapsed_ms: 0
```

## Evidence Narrative

Documentation points firmly toward ATOMIC behavior, but OpenAI has not PUBLISHED an atomicity guarantee for `session.update`. The Cookbook's `set_conversation_state` pattern (which replaces prompt + tools in one shot, as part of a recommended state-graph design) would be a DOCUMENTED RACE CONDITION if it were non-atomic — the Cookbook does not flag it as such. Combined with zero community reports of instructions/tools split-visibility, the working assumption for Phase 05.2 is ATOMIC.

Until the probe is run against a real session, the verdict remains technically INCONCLUSIVE. Phase 05.2-06 live-verify traces provide a secondary empirical check: if the post-AMD handoff ever exhibits a tool call that shouldn't be available (e.g., an `amd_result` invocation AFTER the persona swap, which would indicate old-tools lingering), that would surface non-atomicity retroactively. No such defect has been reported in prior live traces.

## Implications for 05.2 handoff

- **If ATOMIC (documentation-lean verdict):** single `session.update` carrying `instructions` (and optionally `tools`) is safe for the AMD→baseline+overlay handoff. Current `webhook.ts` onHuman closure (single-shot `updateInstructions`) is correct — no code change required.
- **If NON-ATOMIC (not indicated by documentation, but hypothetically):** workaround = send `session.update({tools_only})` first, await `session.updated` confirmation, then `session.update({instructions_only})`. Alternative = send `response.cancel` between the two updates to prevent a response firing with mixed old/new state.
- **If INCONCLUSIVE (current state):** default to ATOMIC per Cookbook. Monitor 05.2-06 live-verify traces for tool-call anomalies. Re-run probe empirically once API key is available.

## Phase 05.2 decision

- **`webhook.ts` `updateInstructions` call: UNCHANGED.** Current single-shot `session.update` from the onHuman closure is correct under the documentation-lean verdict.
- **Critical narrowing — the handoff NEVER pushes `tools`.** Looking at `voice-bridge/src/sideband.ts:682-724`, `updateInstructions()` sends `{ type: 'realtime', instructions }` — it does NOT send `tools`. Any `tools` key in `extraSession` is actively *stripped and logged BUG-level* (line 704-710, D-26/AC-05 invariant). The Case-2 tool list (13 tools including `amd_result`) was set at `/accept` via `openai.realtime.calls.accept(...)` and is NOT re-pushed during the AMD→baseline handoff. **This means Q7 is LESS load-bearing for 05.2 than originally feared** — the handoff updates `instructions` only, never `tools`, so atomicity of instructions+tools replacement cannot affect Case-2 handoff behavior under the current architecture. Q7's relevance is deferred to Phase 5 state-graph transitions (if those push both fields simultaneously).
- **Case-2 `onHuman` does NOT arm `armedForFirstSpeech`.** Plan 05.2-03 D-8 narrowing: only Case-1 default-outbound (non-AMD path) arms for first-speech. Case-2 post-AMD verdict uses the explicit `setTimeout → requestResponse` (05.1-01 Layer-2 ordering). Arming would cause a double `response.create` when the counterpart speaks. Already implemented correctly in `webhook.ts:594-599` (only the non-Case-2 branch sets `armedForFirstSpeech = true`).
- **Baseline is NOT pushed during AMD listen-only phase.** `CASE2_AMD_CLASSIFIER_PROMPT` governs; baseline+overlay is pushed via `updateInstructions` ONLY after `amd_result` verdict=human. §201 StGB audio-leak invariant preserved (inherited from Plan 05.1-02 + 05-03 T-05-03-01).

## References

- OpenAI Cookbook "Realtime Prompting Guide — Dynamic Conversation Flow via session.updates": https://developers.openai.com/cookbook/examples/realtime_prompting_guide
- OpenAI Realtime Server Events (session.updated): https://developers.openai.com/api/reference/resources/realtime/server-events
- OpenAI Realtime Conversations guide: https://platform.openai.com/docs/guides/realtime-conversations
- `.planning/research/voice-persona-architecture.md` §2.1 (Realtime official 8-section prompt structure) + §6.4 Q7 (original open question, line 757).
- `.planning/phases/05.2-persona-redesign-and-call-flow-state-machine/05.2-CONTEXT.md` §Q7 canonical reference (line 138).
- `voice-bridge/src/sideband.ts:682-724` `updateInstructions` — confirms handoff path sends instructions-only, strips `tools` field (D-26/AC-05 invariant).
- `voice-bridge/src/webhook.ts:430-475` `onHuman` closure — confirms handoff path calls `updateInstructions(persona)` without tools payload.
