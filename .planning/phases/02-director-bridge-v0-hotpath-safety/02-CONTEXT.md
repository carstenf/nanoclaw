# Phase 2: Director Bridge v0 + Hot-Path Safety - Context

**Gathered:** 2026-04-16
**Status:** Ready for planning (pending Chat review per briefing 2026-04-16 22:40)
**Source of answers:** `decisions/2026-04-16-phase2-gap-answers.md` (Chat reply to carsten_bot 22:00 ASK FOR CHAT, 8 gaps)

<domain>
## Phase Boundary

Phase 2 delivers the **load-bearing safety envelope** that every downstream case (3/4/5/6/7) will rely on: idempotency, allowlist+schema validation, two-form readback, teardown assertion, turn-timing JSONL, RAM-only audio hygiene, sideband-WS for instructions-only Slow-Brain updates, and a replay-harness that runs green in CI before any live counterpart call is made.

Phase 2 does **not** ship a counterpart-facing call, does **not** implement any Case-specific tool (TOOLS-01..08 live in Phase 3/4), and does **not** wire cost caps (INFRA-06/07, Phase 4). It finishes the Director Bridge from stub to production-safe for Case 6 MVP.

**In scope (26 REQs):** INFRA-05, VOICE-01..12, DIR-01..13, DISC-04, QUAL-05.
**Out of scope:** TOOLS-01..08, COST-01..05, QUAL-01/02/03/04, C6-*, C2-*, C3-*, C4-*, SIP-08/09, LEGAL-01..04.

</domain>

<decisions>
## Implementation Decisions

Every D-XX below traces to a Chat-confirmed gap answer or a REQUIREMENTS entry. Chat-answer references cite `decisions/2026-04-16-phase2-gap-answers.md` §Gap-N.

### Idempotency Wrapper (Gap 2 → REQ-DIR-08, REQ-DIR-10)

- **D-01:** **Location: Bridge-side wrapper**, sits between Realtime `function_call` reception and MCP dispatch. NanoClaw remains a pure MCP server — no duplication of idempotency logic (AC-07, REQ-DIR-10).
- **D-02:** **Key formula:** `sha256(call_id + turn_id + tool_name + canonical_json(arguments))`. `canonical_json` = RFC 8785-style sorted-keys, no whitespace. All four components are required; missing any → reject with synthetic `tool_error` (collision-avoidance + trace clarity).
- **D-03:** **TTL: per-call only.** Cache cleared on `session.closed` (or force-close per D-17).
- **D-04:** **Storage: in-process RAM Map** in voice-bridge. No SQLite, no Redis. Bridge restart mid-call → graceful degradation: next invocation is cache-miss, dispatched to NanoClaw; NanoClaw-side idempotency is a separate concern and NOT relied on here (that would leak Bridge logic into Core per AC-07).
- **D-05:** **Scope: mutating tools only** (REQ-DIR-08 "When OpenAI Realtime invokes a mutating tool..."). Static list maintained in voice-bridge config derived from REQ-TOOLS-01..08 `create_*`/`schedule_*`/`send_*`/`confirm_*` semantics. Read-only tools bypass the wrapper.
- **D-06:** **Cache-hit behavior:** return the previously-returned MCP result identically (no re-call, no side-effect). Log JSONL entry `{event:"idempotency_hit", call_id, turn_id, tool_name, key_hash}` for replay-harness diff verification.

### Allowlist + Schema Validation (Gap 3 → REQ-DIR-09)

- **D-07:** **Allowlist: static**, shipped as `voice-bridge/src/tools/allowlist.ts` (derived from REQ-TOOLS-01..08). Entry per tool: `{name, mutating: bool, schema: JSONSchema7}`. Regenerated only when TOOLS-* REQs change (CI checks REQ-ID coverage).
- **D-08:** **Schema validation: in Bridge, using ajv** (`ajv` + `ajv-formats`, strict mode, compiled schemas at boot). NanoClaw validates again server-side — defense-in-depth (mirrors webhook signature D-18 from Phase 1).
- **D-09:** **Failure mode:** name-not-in-allowlist OR argument-schema-fail → return synthetic `{type:"tool_error", message:"Das kann ich gerade leider nicht nachsehen.", code:"invalid_tool_call"}` to the Realtime session. Never silently drop — per Phase 2 SC-2. Log full diagnostic JSONL with offending args (for red-team replay).
- **D-10:** **Unknown-tool handling on accept:** at `/accept`, all allowlist entries (max 15 per AC-04 and REQ-C6-etc constraints) are passed as `tools:[…]` in `realtime.calls.accept()` payload. Mid-call tool-list changes are forbidden per AC-04 / REQ-DIR-11.

### Two-form Readback Enforcement (Gap 4 → REQ-DIR-13, REQ-C6-03 anchor)

- **D-11:** **Enforcement: hybrid.** Persona prompt *requires* readback; Bridge validator *verifies* before dispatch. Belt + suspenders because persona-only was too soft (per spike-E red-team observations).
- **D-12:** **Source of truth: Bridge validator.** Persona failure (missing readback) + validator pass is impossible — validator parses the transcript-stream's last counterpart or system turn for readback tokens before allowing a mutating tool-call. Persona pass + validator fail → synthetic retry prompt (D-14).
- **D-13:** **Tolerance:**
  - Time/numeric values: **exact after German normalization** (siebzehn ↔ 17, halb drei ↔ 14:30, dreiundzwanzigste ↔ 23.). Normalizer lives in `voice-bridge/src/readback/normalize.ts`.
  - Names: **Levenshtein ≤ 2** after lowercase + diacritic-fold.
  - Addresses/free-text: **fuzzy token-set ratio ≥ 0.85** (diced-coefficient or equivalent).
- **D-14:** **On mismatch:** abort tool-dispatch, inject `session.update` (instructions-only, per REQ-DIR-11) with a persona-level retry prompt "Nochmal zur Bestätigung: {spoken form}, also {numeric form}. Stimmt das?". Log JSONL `{event:"readback_mismatch", tool_name, expected, observed, tolerance_dim}`.
- **D-15:** **Scope:** mutating tools only (REQ-DIR-13 verbatim). Read-only tools (e.g. `check_calendar`) bypass readback.

### Teardown Assertion + Kill-Timer (Gap 5 → REQ-VOICE-11, Phase 2 SC-4)

- **D-16:** **Kill-timer: Bridge-side.** Started on BYE (from FS ESL event OR webhook `call.ended`), awaits OpenAI `session.closed` within 2 s.
- **D-17:** **Force-close target: sideband-WS.** On 5 s timeout, Bridge calls `ws.close(1000)` against the sideband control session. FS BYE is *independent* — FS handles its own leg teardown via mod_sofia. Bridge does not touch SIP legs (separation of concerns).
- **D-18:** **Audio ghost scan: per-call + monthly.** Per-call: after `session.closed` (or force-close), Bridge runs `find ~/nanoclaw ~/.cache /tmp -type f \( -name "*.wav" -o -name "*.mp3" -o -name "*.opus" -o -name "*.flac" \)` and asserts empty (log JSONL, alert Discord on hit). Monthly cron covers the wider filesystem per REQ-QUAL-04 (Phase 4). Phase-2 scope is the per-call check only.
- **D-19:** **RAM-buffer release assertion:** per REQ-VOICE-12, 5 s after `session.closed`, Bridge logs heap snapshot size delta vs. pre-call baseline (NodeJS `process.memoryUsage()`). No hard enforcement — observability only; Phase 4 hardens into a cap.

### RAM-only Audio (Gap 6 → REQ-VOICE-12, REQ-DISC-04)

- **D-20:** **No tmpfs, no mount.** Enforced at code level: voice-bridge never opens a file-handle with write-mode for `/tmp`, `~/.cache`, `~/nanoclaw/voice-container/runs/` except JSONL turn-timing + structured logs (which are text, never audio blobs). `voice-stack/sip-to-ai` already operates as a WS-proxy (RTP stream → PCM frames → WS); no file writes there either. OpenAI Realtime holds counterpart audio under ZDR.
- **D-21:** **FreeSWITCH recordings check:** CI assertion + per-call scan `find /usr/local/freeswitch/recordings -type f` MUST return empty. Non-empty → fail the deploy (blocks Phase 2 gate).
- **D-22:** **Obsolete code removed:** the inherited STT-Whisper sidecar stub in `voice-container/` gets deleted in this phase — dead code + potential §201 risk. Git-history preserves it.
- **D-23:** **Grep guard:** pre-commit hook (or CI step) greps voice-bridge + voice-stack for `fs.writeFile`/`createWriteStream`/`fopen("...w")` against `/tmp`/audio extensions; hit → block commit with pointer to D-20.

### Slow-Brain Cadence (Gap 7 → REQ-DIR-06, REQ-DIR-11, REQ-DIR-12, REQ-DIR-02)

- **D-24:** **Trigger: event-driven** — one signal per `response.done` (= turn-end). Bridge posts transcript delta + tool-call results to async Claude Sonnet worker via internal queue.
- **D-25:** **Cadence cap: max 1 `session.update` per 2 turns (configurable, default=2).** Protects hot-path budget; if Claude produces back-to-back updates, second is coalesced into first. Config key: `slowBrain.cadenceCap` in voice-bridge config. Phase 3 measurement data will inform whether default is too restrictive.
- **D-26:** **Update scope: instructions-only** (REQ-DIR-11, AC-04, AC-05). `tools` field is stripped before send — guard in Bridge before serialization. Violation logged as BUG-level.
- **D-27:** **Failure: graceful degradation.** Claude timeout (default 8 s), 5xx, or worker-crash → hot-path unaffected (REQ-DIR-02 + REQ-DIR-12). Log non-fatal warning JSONL `{event:"slow_brain_degraded", reason}`. Bridge proceeds with last-known instructions; persona prompt at `/accept` is the floor.
- **D-28:** **Back-pressure:** if transcript queue depth > N turns (e.g. 5) because Slow-Brain is stalled, drop oldest — never block hot-path on flush.

### Replay Harness (Gap 8 → REQ-QUAL-05, Phase 2 SC-5)

- **D-29:** **Deployment:** `voice-bridge/tests/replay/` driven by vitest. Runs on every voice-bridge commit (`npm run test:replay` + CI matrix).
- **D-30:** **Fixtures:** `spike/candidate-e/raw/turns-*.jsonl` (from H1/H2 preflight) copied into `voice-bridge/tests/fixtures/spike-e/`. Five calls: `turns-1776242557.jsonl` … `turns-1776243957.jsonl`. Golden reference lives in `tests/fixtures/golden/` with diff-tolerance.
- **D-31:** **Golden diff tolerance:**
  - Latency: **±100 ms** per turn (T0, T2, T4 deltas) — matches REQ-QUAL-05 wording.
  - Tool-calls: **exact** — name + argument bytes identical.
  - Text/persona: **SBERT cosine ≥ 0.80** (sentence-transformers `all-MiniLM-L6-v2` is lightweight enough for CI; caches model locally).
- **D-32:** **SIP path: mocked.** The harness fakes FS/sipgate — injects WS events directly at the Bridge input boundary (webhook → accept → sideband-WS events synthesized from fixture JSONL). No real socket, no Docker spin-up in CI.
- **D-33:** **Latency measurement:** `T0` = synthesized VAD-end marker from fixture. Wall-clock timer from that event until first `audio.delta` emitted by Bridge-under-test vs. fixture's original. Diff must fall inside the ±100 ms band.
- **D-34:** **CI gate:** failing replay-harness blocks merge to main. The gate is a boolean (pass/fail), not a trend — Phase 4 layers a drift alarm on top.

### Bridge-as-MCP-Proxy / AC-09 (Bonus in gap-answers → REQ-DIR-10)

- **D-35:** **Architecture boundary (PRD §7a AC-09):**
  > "The Director Bridge is a thin MCP-proxy. Tool implementations (business logic) live in NanoClaw. Idempotency wrapping, allowlist enforcement, and schema validation are Bridge-side. No tool handler duplicated between Bridge and Core."
  Trace: REQ-DIR-10, AC-07, AC-09.
- **D-36:** **Implication for this phase:** the Bridge holds a *reference* to every MCP-tool (name, mutating flag, schema) but NEVER re-implements the handler body. `dispatchTool()` in voice-bridge forwards to NanoClaw over the existing stream (Streamable HTTP MCP transport referenced in AC-07).

### Turn-Timing JSONL (REQ-VOICE-10, REQ-INFRA-05 complement)

- **D-37:** **Write-path:** voice-bridge emits per-turn JSONL to `~/nanoclaw/voice-container/runs/turns-{call_id}.jsonl`. Fields: `{ts_iso, call_id, turn_id, t0_vad_end_ms, t2_first_llm_token_ms, t4_first_tts_audio_ms, barge_in: bool}`. Same directory/format as Phase-1 `bridge-YYYY-MM-DD.jsonl` so log tooling reuses.
- **D-38:** **Barge-in flag semantics:** set when current turn cancelled the prior turn's TTS (REQ-VOICE-05, 200 ms SLA). Useful for MOS-1 audits.

### Session Config at `/accept` (REQ-VOICE-01..04, INFRA-05)

- **D-39:** **Tools:** allowlist-derived, set exactly once at `realtime.calls.accept()` call (AC-04).
- **D-40:** **Model:** `gpt-realtime-mini` (REQ-VOICE-01, decided 2026-04-15 with 635 ms P50 evidence).
- **D-41:** **VAD:** `server_vad` + `auto_create_response: true` (REQ-VOICE-04).
- **D-42:** **Language:** `de-DE` output, persona prompt German-only (REQ-VOICE-06).
- **D-43:** **Sideband-WS connect-within-1500ms assertion:** measured from `/accept` 200 response to `sideband.ready` (Phase 2 SC-5). Missed SLA → JSONL WARN, call continues.

### Claude's Discretion

- Exact ajv config (strict vs. coerce-types — default strict)
- Levenshtein library pick (`fastest-levenshtein` vs. `leven`)
- SBERT model download/cache path in CI
- Vitest fixture naming convention under `tests/fixtures/`
- JSONL field-ordering inside turn entries
- Internal Slow-Brain queue impl (Node `EventEmitter` vs. `p-queue` — pick whichever has fewer deps)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Chat-Authored Decisions (must read first)

- `voice-channel-spec/decisions/2026-04-16-phase2-gap-answers.md` — all 8 gap resolutions + AC-09 proposal (source of D-01..D-36)

### Phase-Level Spec

- `voice-channel-spec/PRD.md` §7a AC-04, AC-05, AC-06, AC-07, AC-08, AC-09 — tool-set-once, instructions-only mid-call, persona tool-first discipline, Bridge-as-service, WG-only traffic, MCP-proxy asymmetry
- `voice-channel-spec/REQUIREMENTS.md` — INFRA-05, VOICE-01..12, DIR-01..13, DISC-04, QUAL-05 (authoritative text for every REQ-ID listed in Phase 2 domain)
- `voice-channel-spec/ARCHITECTURE-DECISION.md` — split-stack topology (Bridge on Lenovo1, sip-to-ai on Hetzner, OpenAI ZDR)
- `voice-channel-spec/CONOPS.md` — persona behavior, filler-regel, silence prompts

### Phase 1 (completed) Artifacts

- `.planning/phases/01-infrastructure-webhook-path/01-CONTEXT.md` — D-01..D-27 from Phase 1 (forwarder + bridge-stub + dialplan). Phase 2 extends `voice-bridge/` and assumes Phase-1 D-05..D-10 (TS/Fastify stub, JSONL pattern, systemd unit) as given.
- `.planning/phases/01-infrastructure-webhook-path/01-05b-PLAN.md` + `01-05b-SUMMARY.md` — bridge /accept live (Phase 1 PASS 2026-04-16)
- `voice-channel-spec/decisions/2026-04-15-sideband-ws-spike.md` — webhook secret + signature + sideband-WS behavior validated; T5 = "mid-call tool update causes 0 audio-delta for 15 s" (load-bearing for AC-04)

### Research (completed)

- `.planning/research/STACK.md` — TS/Fastify for Bridge, ajv for schema validation
- `.planning/research/ARCHITECTURE.md` — MCP-proxy topology, Streamable HTTP transport
- `.planning/research/PITFALLS.md` — tool-update audio-bug (#17), signature-dedup pitfall (#15)
- `.planning/research/SUMMARY.md` — 8-phase build order rationale (Phase 2 = load-bearing safety envelope)

### Spike-E Fixtures (replay-harness input)

- `voice-channel-spec/spike/candidate-e/raw/turns-1776242557.jsonl`
- `voice-channel-spec/spike/candidate-e/raw/turns-1776242907.jsonl`
- `voice-channel-spec/spike/candidate-e/raw/turns-1776243549.jsonl`
- `voice-channel-spec/spike/candidate-e/raw/turns-1776243763.jsonl`
- `voice-channel-spec/spike/candidate-e/raw/turns-1776243957.jsonl`
- `voice-channel-spec/spike/candidate-e/PLAN.md` + `results.json` — ground-truth latency + token counts for golden bands

### Existing Code (read before modifying)

- `~/nanoclaw/voice-bridge/src/` — index.ts, webhook.ts (owns /accept stub), health.ts, heartbeat.ts, logger.ts, alerts.ts, config.ts
- `~/nanoclaw/voice-bridge/README.md` — Phase-1 scope statement (authoritative for "what is NOT yet here")
- `~/nanoclaw/voice-bridge/tests/` — existing vitest setup to extend
- `~/nanoclaw/voice-container/` — contains the inherited STT-Whisper sidecar stub marked for removal (D-22)
- `~/nanoclaw/voice-stack/sip-to-ai/` — WS-proxy, no changes expected but read to confirm no audio-write path

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **voice-bridge Fastify v5 scaffold** (Phase 1) — add new routes (`/sideband`, `/replay-health`) alongside existing `/webhook`, `/health`, `/accept`
- **voice-bridge JSONL logger** (`src/logger.ts`) — extend fields for turn-timing + idempotency-hit events, same sink
- **voice-bridge vitest config** — drop new `tests/replay/` spec directory; existing `vitest.config.ts` covers it
- **spike-E fixtures** — ready-to-use turn JSONL files, already have real latency distribution from Oct-2025 H1/H2 runs
- **OneCLI vault** — source for any future per-tool secret (none required in Phase 2 itself)

### Established Patterns

- JSONL structured logging to `voice-container/runs/*.jsonl` (Phase 1 D-10)
- systemd `--user` unit scope on Lenovo1, `Restart=on-failure` (Phase 1 D-09)
- Secrets via `.env` fronted by OneCLI (Phase 1 D-17)
- Defense-in-depth for safety-critical checks (Phase 1 signature verify on forwarder AND bridge → reused concept for allowlist+schema validation Bridge-side *and* NanoClaw-side)

### Integration Points

- `voice-bridge/src/webhook.ts` → extend `/accept` handler to register allowlist-derived tools + open sideband-WS post-accept
- New file `voice-bridge/src/sideband.ts` → OpenAI sideband-WS client, instructions-only updates, reconnect logic
- New file `voice-bridge/src/idempotency.ts` → in-memory Map + key formula
- New file `voice-bridge/src/tools/allowlist.ts` + `tools/schemas/` → tool registry (names, mutating flags, schemas)
- New file `voice-bridge/src/readback/` → normalizer + validator
- New file `voice-bridge/src/slow-brain.ts` → async worker queue for Claude Sonnet transcript processing
- `voice-bridge/tests/replay/` → vitest harness + fixtures + golden

### Constraints Surfacing From Code

- Phase 1 bridge listens on `10.0.0.2:4401` (WG-bound). Sideband-WS is *outbound* to OpenAI, not inbound — no new exposed port required.
- OpenAI SDK async-webhook-unwrap in Phase 1 `webhook.ts` → pattern extends to sideband-WS handlers (await everything).
- `/accept` already logged via JSONL; extend to include the `tools:[…]` payload size + schema-compile success/fail counts.

</code_context>

<specifics>
## Specific Ideas

- **AC-09 status:** ratified in PRD §7a on 2026-04-17 (Chat review PASS). D-35 is now the implementation-side capture of PRD AC-09.
- **Readback token for numerics:** Bridge includes the numeric form in the tool-call argument; persona speaks the German spelled-out form. Validator parses the persona's last utterance via transcript-stream text field — no re-running STT.
- **Ghost-scan path whitelist:** `~/nanoclaw/voice-container/runs/*.jsonl` is expected (structured logs, not audio) — scan must explicitly ignore `.jsonl`/`.log`/`.txt` to avoid false positives. Only audio extensions trigger alerts.
- **CI cost:** SBERT model is ~90 MB; cache across CI runs via GitHub-Actions cache (or local runner disk). Budget: first-run ~10 s extra, cached ~0.3 s.
- **Replay-harness determinism:** fix wall-clock source to monotonic (`performance.now()`) and seed any timer-driven branch — flaky latency bands are worse than failing ones.

</specifics>

<deferred>
## Deferred Ideas

- **Drift monitor on replay latency bands** — trend-analysis over 30 days, alert on P50 migration. Phase 4 (QUAL-04).
- **NanoClaw-side idempotency** — currently the wrapper lives only in Bridge. Core-level dedup would need its own key scheme and storage; defer until we see evidence of a Bridge-bypass path.
- **Audio-tamper detection** — adversarial fixtures for the red-team replay (e.g. fabricated `tool_call` injection). Phase 7 (Case 4) scope.
- **Levenshtein-tolerance tuning per locale** — currently hard-coded ≤ 2 for names. Observability + per-language calibration in Phase 5/6.
- **Runtime allowlist hot-reload** — static today; Phase 4 may want dynamic tool enable/disable for A/B.
- **Persona-level auto-retry bound** — D-14 retries once; if persona still mismatches, terminate or escalate? Revisit when we see real Case-6 data in Phase 3.

### Reviewed Todos (not folded)

None reviewed — no pending todos matched Phase 2 scope.

</deferred>

---

*Phase: 02-director-bridge-v0-hotpath-safety*
*Context gathered: 2026-04-16 (short-circuited Q&A: 8 gray areas were raised as ASK FOR CHAT and answered in `decisions/2026-04-16-phase2-gap-answers.md`; this CONTEXT.md folds those answers in per briefing 2026-04-16 22:40)*
*Awaiting Chat review before `/gsd-plan-phase 2`.*
