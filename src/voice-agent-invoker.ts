// src/voice-agent-invoker.ts
//
// Phase 05.6 Plan 01 Task 1 — real container-runner integration for the
// voice-channel reasoning triggers shipped as no-op stubs in Phase 05.5-01.
//
// Replaces the Phase-05.5 placeholder `defaultInvokeAgent` (which returned
// the literal sentinel `AGENT_NOT_WIRED`) with a real `runContainerAgent`
// invocation against the main NanoClaw group container. The container-agent
// loads the `voice-personas` skill (D-13/D-27), derives Du/Sie per case_type
// (D-25), substitutes every `{{...}}` placeholder, and returns the rendered
// persona string between fence markers.
//
// Defense-in-depth for REQ-DIR-17 (read-only mid-call):
//   1. Agent prompt explicitly forbids mutating tools mid-call (THIS file).
//   2. NanoClaw-side gateway rejects mutating tools at dispatch path
//      (`src/voice-mid-call-gateway.ts` — Task 4).
//   3. `__MUTATION_ATTEMPT__` sentinel gate at handler boundary in
//      `src/mcp-tools/voice-triggers-transcript.ts` (Phase 05.5-01).
//
// D-26 sketch source:
//   .planning/phases/05.6-container-agent-integration-cutover/05.6-CONTEXT.md
//
// REQ-DIR-20: Bridge MCP timeout is 5000ms; the agent timeout here defaults
// to 4500ms so the Bridge sees a well-formed `agent_unavailable` result
// rather than a transport timeout.
//
// REQ-DIR-16: full turn-history (counterpart + assistant turns) is forwarded
// to the agent on every transcript trigger via `buildPersonaTurnPrompt`.

import { runContainerAgent } from './container-runner.js';
import type { ContainerOutput } from './container-runner.js';
import { getMainGroup } from './db.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';
import type { VoiceTriggersInitInput } from './mcp-tools/voice-triggers-init.js';
import type { VoiceTriggersTranscriptInput } from './mcp-tools/voice-triggers-transcript.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// D-26 sketch: 4500ms agent timeout leaves 500ms headroom inside Bridge's
// 5000ms MCP timeout (REQ-DIR-20). Bridge then logs warn + falls back to
// last-known instructions per REQ-DIR-12.
const VOICE_AGENT_TIMEOUT_MS_DEFAULT = 4500;

// Output fences — agent is instructed to wrap the rendered persona between
// these on lines of their own. Chosen to be unmistakable in agent free-text
// output and never appear in German persona content.
export const INSTRUCTIONS_FENCE_START = '---NANOCLAW_INSTRUCTIONS_START---';
export const INSTRUCTIONS_FENCE_END = '---NANOCLAW_INSTRUCTIONS_END---';
export const NULL_SENTINEL = 'NULL_NO_UPDATE';

// ---------------------------------------------------------------------------
// DI seam
// ---------------------------------------------------------------------------

export interface VoiceAgentInvokerDeps {
  /** Override runContainerAgent (for tests). */
  runContainer?: typeof runContainerAgent;
  /** Override getMainGroup (for tests). */
  loadMainGroup?: () => (RegisteredGroup & { jid: string }) | null;
  /** Per-call agent timeout in ms. Default: 4500 (D-26). */
  timeoutMs?: number;
  /** Clock override for latency metrics in tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Prompt builders (exported for unit-test verification)
// ---------------------------------------------------------------------------

/**
 * Build the agent prompt for `voice_triggers_init` — initial persona
 * rendering at /accept time.
 *
 * The prompt explicitly:
 * - names the `voice-personas` skill so SKILL.md trigger discovery matches
 *   D-13 (skill auto-load by trigger description).
 * - passes the typed inputs (`case_type`, `call_direction`, `counterpart_label`).
 * - quotes the Du/Sie derivation rule (D-25 — defense-in-depth; the skill
 *   carries the rule but we restate it here so the agent always sees it).
 * - mandates the strict output fence contract.
 * - forbids mutating tool calls during persona rendering (REQ-DIR-17 layer 1).
 */
export function buildPersonaRenderPrompt(input: VoiceTriggersInitInput): string {
  return [
    'You are NanoClaw rendering a voice-channel persona for the OpenAI Realtime',
    'session.update.instructions field. Use the voice-personas skill.',
    '',
    '## Inputs',
    `- call_id: ${input.call_id}`,
    `- case_type: ${input.case_type}`,
    `- call_direction: ${input.call_direction}`,
    `- counterpart_label: ${input.counterpart_label}`,
    '',
    '## Steps',
    '1. Load `container/skills/voice-personas/SKILL.md` (already mounted at',
    '   `~/.claude/skills/voice-personas/`).',
    '2. Read `baseline.md`.',
    `3. Read \`overlays/${input.case_type}-*.md\` if it exists; if missing, baseline only.`,
    '4. Concatenate baseline + overlay.',
    '5. Du/Sie derivation (D-25) — anrede_form derived from case_type:',
    '   - case_6b → anrede_form="Du", anrede_pronoun="dir", anrede_disclosure="dich"',
    '   - case_2 / any other case → anrede_form="Sie", anrede_pronoun="Ihnen", anrede_disclosure="Sie"',
    '6. Substitute every {{...}} placeholder. NO {{...}} tokens may remain in output.',
    '7. Pick the SCHWEIGEN_LADDER block matching `call_direction`.',
    '',
    '## Output format (STRICT)',
    'Wrap the rendered persona between these fences, on lines of their own:',
    INSTRUCTIONS_FENCE_START,
    '<rendered persona text — multi-line OK, ASCII umlauts ae/oe/ue/ss>',
    INSTRUCTIONS_FENCE_END,
    'Do NOT add explanation outside the fences.',
    '',
    '## Hard rules (REQ-DIR-17 — read-only)',
    '- DO NOT invoke any mutating tools while rendering the persona.',
    '- DO NOT make Discord/Calendar/etc. mutating calls during this rendering.',
    '- ONLY load the skill files, render, and return the fenced string.',
  ].join('\n');
}

/**
 * Build the agent prompt for `voice_triggers_transcript` — per-turn FIFO
 * mid-call decision (update instructions vs. no-op).
 *
 * Forwards the FULL turn-history (REQ-DIR-16) so the agent has complete
 * context. Prohibits mutating tool calls (REQ-DIR-17 layer 1) — mutating
 * actions must be deferred to the post-end_call execution path.
 */
export function buildPersonaTurnPrompt(
  input: VoiceTriggersTranscriptInput,
): string {
  const turnsBlock = input.transcript.turns
    .map((t, i) => `${i + 1}. [${t.role}, ${t.started_at}] ${t.text}`)
    .join('\n');

  return [
    'You are NanoClaw deciding whether to update the voice-channel persona',
    `mid-call (turn ${input.turn_id}). Use the voice-personas skill.`,
    '',
    '## Call context',
    `- call_id: ${input.call_id}`,
    `- turn_id: ${input.turn_id}`,
    '',
    '## Full turn history (REQ-DIR-16)',
    turnsBlock,
    '',
    '## Fast-brain hints (optional)',
    JSON.stringify(input.fast_brain_state ?? {}),
    '',
    '## Decision',
    'Inspect the latest counterpart turn. Decide:',
    `- If no instruction change is warranted, output: ${INSTRUCTIONS_FENCE_START}\n${NULL_SENTINEL}\n${INSTRUCTIONS_FENCE_END}`,
    '- If an updated persona/instructions block is warranted, render the full new',
    '  persona (NOT a diff) using the voice-personas skill, with the same Du/Sie',
    '  rule as init, and wrap it in fences.',
    '',
    '## Hard rules (REQ-DIR-17 — read-only mid-call, mutating tools FORBIDDEN)',
    '- Read-only tools allowed: RAG queries, calendar-check, memory-lookup.',
    '- Mutating tools FORBIDDEN mid-call: do NOT call calendar-create, message-send,',
    '  payment, voice_send_discord_message, etc. They will be queued for end_call.',
    '- If the counterpart asks for a verbindliche Aktion, the rendered persona',
    '  must direct the bot to obtain Readback confirmation first; do NOT execute',
    '  the action here.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output extractor
// ---------------------------------------------------------------------------

export interface ExtractedRender {
  /** Body between fence markers (or trimmed full text on graceful fallback). */
  instructions: string;
  /** True if an unsubstituted `{{...}}` token was detected in the body. */
  placeholderLeak: boolean;
  /** True if both fence markers were found and the body is the inner slice. */
  fenced: boolean;
}

/**
 * Extract the rendered persona body from the agent's container output.
 *
 * Happy path: both fences present → body is the trimmed slice between them.
 * Fallback: no fences → body is the trimmed full text (caller logs a warn).
 * Always reports whether any unsubstituted `{{...}}` tokens leaked through.
 */
export function extractRenderedString(
  containerResult: string | null,
): ExtractedRender {
  const text = (containerResult ?? '').toString();
  const startIdx = text.indexOf(INSTRUCTIONS_FENCE_START);
  const endIdx = text.indexOf(INSTRUCTIONS_FENCE_END);
  let body: string;
  let fenced: boolean;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    body = text
      .slice(startIdx + INSTRUCTIONS_FENCE_START.length, endIdx)
      .trim();
    fenced = true;
  } else {
    body = text.trim();
    fenced = false;
  }
  // Detect placeholder leak (any unsubstituted `{{xxx}}` token).
  const placeholderLeak = /\{\{[a-z_]+\}\}/i.test(body);
  return { instructions: body, placeholderLeak, fenced };
}

// ---------------------------------------------------------------------------
// Real defaultInvokeAgent — Phase 05.5 stub replacement
// ---------------------------------------------------------------------------

/**
 * Real `defaultInvokeAgent` for the `voice_triggers_init` MCP-tool.
 *
 * Spawns the main-group NanoClaw container and instructs it to load the
 * `voice-personas` skill, render the persona for the given call inputs,
 * and return the rendered string between fence markers. Falls back to
 * a typed `agent_unavailable` Error on container error or no-main-group;
 * the MCP-tool factory's catch maps that to `{ ok: false, error: 'agent_unavailable' }`.
 */
export async function defaultInvokeAgent(
  input: VoiceTriggersInitInput,
  deps: VoiceAgentInvokerDeps = {},
): Promise<{ instructions: string }> {
  const _runContainer = deps.runContainer ?? runContainerAgent;
  const _loadMainGroup = deps.loadMainGroup ?? getMainGroup;
  const timeoutMs = deps.timeoutMs ?? VOICE_AGENT_TIMEOUT_MS_DEFAULT;
  const now = deps.now ?? (() => Date.now());

  const main = _loadMainGroup();
  if (!main) {
    const err = new Error('agent_unavailable: no main group');
    (err as { code?: string }).code = 'agent_unavailable';
    logger.warn({
      event: 'voice_agent_invoker_no_main_group',
      call_id: input.call_id,
    });
    throw err;
  }

  const prompt = buildPersonaRenderPrompt(input);
  const containerInput = {
    prompt,
    groupFolder: main.folder,
    chatJid: main.jid,
    isMain: true as const,
    isScheduledTask: false as const,
  };

  const start = now();
  let streamedResult: string | null = null;

  const output = await Promise.race([
    _runContainer(
      main,
      containerInput,
      () => {
        /* onProcess noop */
      },
      async (chunk: ContainerOutput) => {
        if (chunk.status === 'success' && chunk.result) {
          streamedResult = chunk.result;
        }
      },
    ),
    new Promise<ContainerOutput>((resolve) =>
      setTimeout(
        () => resolve({ status: 'error', result: null, error: 'timeout' }),
        timeoutMs,
      ),
    ),
  ]);

  const latency = now() - start;

  if (output.status === 'error' && !streamedResult) {
    const err = new Error(
      `agent_unavailable: ${output.error ?? 'unknown'}` +
        (output.error === 'timeout' ? ' (timeout)' : ''),
    );
    (err as { code?: string }).code =
      output.error === 'timeout' ? 'timeout' : 'agent_unavailable';
    logger.warn({
      event: 'voice_agent_invoker_init_failed',
      call_id: input.call_id,
      latency_ms: latency,
      container_error: output.error,
    });
    throw err;
  }

  const resultText = streamedResult ?? output.result ?? '';
  const { instructions, placeholderLeak, fenced } =
    extractRenderedString(resultText);

  if (!fenced) {
    logger.warn({
      event: 'voice_agent_invoker_no_fence',
      call_id: input.call_id,
      latency_ms: latency,
      result_len: resultText.length,
    });
  }
  if (placeholderLeak) {
    logger.warn({
      event: 'voice_agent_invoker_placeholder_leak',
      call_id: input.call_id,
      latency_ms: latency,
    });
  }
  return { instructions };
}

// ---------------------------------------------------------------------------
// Real defaultInvokeAgentTurn — per-turn mid-call decision
// ---------------------------------------------------------------------------

/**
 * Real `defaultInvokeAgentTurn` for the `voice_triggers_transcript` MCP-tool.
 *
 * Same container-spawn shape as `defaultInvokeAgent` but uses the per-turn
 * prompt (full turn-history per REQ-DIR-16) and decodes the agent's
 * decision: a fenced `NULL_SENTINEL` body means "no update" → returns
 * `{ instructions_update: null }`; any other body becomes the update string.
 */
export async function defaultInvokeAgentTurn(
  input: VoiceTriggersTranscriptInput,
  deps: VoiceAgentInvokerDeps = {},
): Promise<{ instructions_update: string | null }> {
  const _runContainer = deps.runContainer ?? runContainerAgent;
  const _loadMainGroup = deps.loadMainGroup ?? getMainGroup;
  const timeoutMs = deps.timeoutMs ?? VOICE_AGENT_TIMEOUT_MS_DEFAULT;
  const now = deps.now ?? (() => Date.now());

  const main = _loadMainGroup();
  if (!main) {
    const err = new Error('agent_unavailable: no main group');
    (err as { code?: string }).code = 'agent_unavailable';
    logger.warn({
      event: 'voice_agent_invoker_turn_no_main_group',
      call_id: input.call_id,
      turn_id: input.turn_id,
    });
    throw err;
  }

  const prompt = buildPersonaTurnPrompt(input);
  const containerInput = {
    prompt,
    groupFolder: main.folder,
    chatJid: main.jid,
    isMain: true as const,
    isScheduledTask: false as const,
  };

  const start = now();
  let streamedResult: string | null = null;

  const output = await Promise.race([
    _runContainer(
      main,
      containerInput,
      () => {
        /* onProcess noop */
      },
      async (chunk: ContainerOutput) => {
        if (chunk.status === 'success' && chunk.result) {
          streamedResult = chunk.result;
        }
      },
    ),
    new Promise<ContainerOutput>((resolve) =>
      setTimeout(
        () => resolve({ status: 'error', result: null, error: 'timeout' }),
        timeoutMs,
      ),
    ),
  ]);

  const latency = now() - start;

  if (output.status === 'error' && !streamedResult) {
    const err = new Error(
      `agent_unavailable: ${output.error ?? 'unknown'}` +
        (output.error === 'timeout' ? ' (timeout)' : ''),
    );
    (err as { code?: string }).code =
      output.error === 'timeout' ? 'timeout' : 'agent_unavailable';
    logger.warn({
      event: 'voice_agent_invoker_turn_failed',
      call_id: input.call_id,
      turn_id: input.turn_id,
      latency_ms: latency,
      container_error: output.error,
    });
    throw err;
  }

  const resultText = streamedResult ?? output.result ?? '';
  const { instructions, placeholderLeak, fenced } =
    extractRenderedString(resultText);

  if (!fenced) {
    logger.warn({
      event: 'voice_agent_invoker_turn_no_fence',
      call_id: input.call_id,
      turn_id: input.turn_id,
      latency_ms: latency,
      result_len: resultText.length,
    });
  }

  // Decode null-sentinel.
  if (instructions === NULL_SENTINEL) {
    return { instructions_update: null };
  }

  if (placeholderLeak) {
    logger.warn({
      event: 'voice_agent_invoker_turn_placeholder_leak',
      call_id: input.call_id,
      turn_id: input.turn_id,
      latency_ms: latency,
    });
  }

  return { instructions_update: instructions };
}
