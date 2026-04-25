// src/voice-agent-invoker.ts
//
// Phase 05.6 Plan 02 architecture pivot — direct Anthropic API render path.
//
// Phase 05.6 Plan 01 wired voice_triggers_init/transcript to spawn a full
// NanoClaw container-agent (whatsapp_main / main group via runContainerAgent).
// Live PSTN test on 2026-04-25 surfaced a hard architectural mismatch: the
// container cold-start + Claude Agent SDK init + multi-turn reasoning loop
// takes >> the 5000ms /accept budget enforced by the Bridge, so every call
// silently fell back to FALLBACK_PERSONA (Sie-form) and the container-agent
// path was never actually exercised.
//
// This module replaces that path with a direct Anthropic Messages API call
// from the long-running NanoClaw process via the OneCLI proxy (same channel
// used by the legacy slow-brain). The voice-personas skill files
// (SKILL.md + baseline.md + overlay) are loaded as system prompt; the typed
// inputs become the user message; the LLM substitutes placeholders, picks
// the SCHWEIGEN ladder, derives Du/Sie, and returns a fenced persona body.
// One API roundtrip, ~1-2s, no container, no Agent SDK, no multi-turn loop.
//
// MOS-4 stays intact: the LLM that renders the persona is hosted upstream
// (Anthropic), called from the NanoClaw process — not from the Bridge. The
// Bridge still receives only the fully rendered string via session.update.
//
// Defense-in-depth for REQ-DIR-17 (read-only mid-call) is unchanged:
//   1. The render prompt forbids mutating tools (THIS file's prompt builders).
//   2. NanoClaw-side gateway rejects mutating tools at dispatch path
//      (`src/voice-mid-call-gateway.ts`).
//   3. `__MUTATION_ATTEMPT__` sentinel gate at handler boundary in
//      `src/mcp-tools/voice-triggers-transcript.ts`.
//
// REQ-DIR-20: Bridge MCP timeout is 5000ms; the render here defaults to
// 4500ms so the Bridge sees a well-formed `agent_unavailable` Error rather
// than a transport timeout.
//
// REQ-DIR-16: full turn-history (counterpart + assistant turns) is forwarded
// to the LLM on every transcript trigger via `buildPersonaTurnPrompt`.

import fs from 'fs';
import path from 'path';

import { callClaudeViaOneCli } from './mcp-tools/claude-client.js';
import { logger } from './logger.js';
import type { VoiceTriggersInitInput } from './mcp-tools/voice-triggers-init.js';
import type { VoiceTriggersTranscriptInput } from './mcp-tools/voice-triggers-transcript.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// 4500ms render timeout leaves 500ms headroom inside the Bridge's 5000ms MCP
// timeout (REQ-DIR-20). On timeout we throw `agent_unavailable` and the
// Bridge falls back to FALLBACK_PERSONA per REQ-DIR-12.
const VOICE_RENDER_TIMEOUT_MS_DEFAULT = 4500;

// Render-LLM model. Kept overridable via deps for tests + ENV (so we can
// dial up to Sonnet for higher fidelity if Haiku rendering isn't crisp
// enough). Default is the slow-brain model in config.ts.
const VOICE_RENDER_MAX_TOKENS_DEFAULT = 1500;

// Output fences — render-LLM is instructed to wrap the persona between
// these on lines of their own. Chosen to be unmistakable in free text and
// never appear in German persona content.
export const INSTRUCTIONS_FENCE_START = '---NANOCLAW_INSTRUCTIONS_START---';
export const INSTRUCTIONS_FENCE_END = '---NANOCLAW_INSTRUCTIONS_END---';
export const NULL_SENTINEL = 'NULL_NO_UPDATE';

// Skill location on the host filesystem. `container/skills/voice-personas/`
// is bind-mounted into containers but is also a regular directory the host
// NanoClaw process can read directly — which is exactly what Option A does.
const VOICE_PERSONAS_DIR = path.resolve(
  process.cwd(),
  'container',
  'skills',
  'voice-personas',
);

// Map case_type → overlay filename. Mirrors SKILL.md "case_type-to-overlay
// mapping" table.
const CASE_OVERLAY_MAP: Record<string, string | null> = {
  case_2: 'overlays/case-2-restaurant-outbound.md',
  case_6b: 'overlays/case-6b-inbound-carsten.md',
  // any other case → baseline only, log warning
};

// ---------------------------------------------------------------------------
// DI seam
// ---------------------------------------------------------------------------

/**
 * Render-API call signature — takes the assembled system prompt and a
 * single user message, returns the LLM response text. Defaults to
 * `callClaudeViaOneCli`; tests override with a stub.
 */
export type RenderApiCall = (
  systemPrompt: string,
  userMessage: string,
  opts?: { timeoutMs?: number; maxTokens?: number; model?: string },
) => Promise<string>;

export interface VoiceAgentInvokerDeps {
  /** Override the render API call. Default: callClaudeViaOneCli. */
  renderApi?: RenderApiCall;
  /** Override the skill-files reader. Default: fs.readFileSync from VOICE_PERSONAS_DIR. */
  loadSkillFiles?: (caseType: string) => VoicePersonaSkillFiles;
  /** Per-call render timeout in ms. Default: 4500. */
  timeoutMs?: number;
  /** max_tokens for the render API call. Default: 1500. */
  maxTokens?: number;
  /** Model id for the render API call. Default: SLOW_BRAIN_MODEL (env-overridable). */
  model?: string;
  /** Clock override for latency metrics in tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Skill loader
// ---------------------------------------------------------------------------

export interface VoicePersonaSkillFiles {
  /** SKILL.md body (rendering instructions for the LLM). */
  skill: string;
  /** baseline.md body (universal persona base). */
  baseline: string;
  /**
   * Overlay body for the requested case_type, or empty string if no overlay
   * is mapped (e.g. unknown case_type). Caller logs a warn in that case.
   */
  overlay: string;
  /** Resolved overlay path (or null if unmapped) — for logging. */
  overlayPath: string | null;
}

/**
 * Default skill-files reader. Reads from VOICE_PERSONAS_DIR on the host.
 * Throws if SKILL.md or baseline.md are missing — those are non-recoverable.
 */
export function loadVoicePersonaSkillDefault(
  caseType: string,
): VoicePersonaSkillFiles {
  const skillPath = path.join(VOICE_PERSONAS_DIR, 'SKILL.md');
  const baselinePath = path.join(VOICE_PERSONAS_DIR, 'baseline.md');
  const skill = fs.readFileSync(skillPath, 'utf8');
  const baseline = fs.readFileSync(baselinePath, 'utf8');

  const overlayRel = CASE_OVERLAY_MAP[caseType] ?? null;
  let overlay = '';
  let overlayPath: string | null = null;
  if (overlayRel) {
    overlayPath = path.join(VOICE_PERSONAS_DIR, overlayRel);
    try {
      overlay = fs.readFileSync(overlayPath, 'utf8');
    } catch {
      overlay = '';
      overlayPath = null;
    }
  }

  return { skill, baseline, overlay, overlayPath };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the render API call. Inlines the SKILL.md,
 * baseline.md, and overlay content so the render-LLM has everything it
 * needs to substitute placeholders and produce a coherent persona.
 *
 * Kept as a free function so tests can stub the skill-loader and feed
 * deterministic skill content into the assembly.
 */
export function buildSystemPrompt(skill: VoicePersonaSkillFiles): string {
  const overlayBlock = skill.overlay
    ? [
        '## OVERLAY (case-specific)',
        '',
        skill.overlay,
        '',
      ].join('\n')
    : [
        '## OVERLAY (none)',
        '',
        'No overlay mapped for this case_type. Render baseline only.',
        '',
      ].join('\n');

  return [
    'You are the NanoClaw voice-channel persona renderer.',
    '',
    'Your job is to assemble a single, fully-rendered persona text that the',
    'OpenAI Realtime model will use as session.update.instructions for a',
    'live phone call. You produce ONLY the rendered persona — no commentary,',
    'no explanation, no tool calls, no questions. One API roundtrip, one',
    'fenced output.',
    '',
    'Strict assembly rules — follow the SKILL.md verbatim:',
    '',
    '## SKILL.md',
    '',
    skill.skill,
    '',
    '## BASELINE.md',
    '',
    skill.baseline,
    '',
    overlayBlock,
    '## OUTPUT FORMAT (STRICT)',
    '',
    'Wrap the rendered persona between these fences, on lines of their own:',
    '',
    INSTRUCTIONS_FENCE_START,
    '<rendered persona text — multi-line OK, ASCII umlauts ae/oe/ue/ss>',
    INSTRUCTIONS_FENCE_END,
    '',
    'Do NOT add explanation outside the fences. The body between the',
    'fences MUST contain no `{{...}}` placeholder tokens (substitute every',
    'one). Pick exactly one SCHWEIGEN_LADDER block matching call_direction',
    'and drop the other block entirely.',
    '',
    '## HARD RULES',
    '',
    '- DO NOT call tools (the render is plain text-out, no tool use needed).',
    '- DO NOT include conversation context, just the rendered persona.',
    '- DO NOT echo the {{...}} tokens back. Substitute them all.',
    '- Du/Sie derivation: case_6b → Du/dich/du/Bist du; any other case → Sie/Sie/Sie/Sind Sie.',
  ].join('\n');
}

/**
 * Build the user message for `voice_triggers_init` rendering. Carries the
 * typed inputs the renderer needs to substitute placeholders.
 */
export function buildPersonaRenderPrompt(input: VoiceTriggersInitInput): string {
  return [
    'Render the voice-channel persona for this call.',
    '',
    '## Inputs',
    `- call_id: ${input.call_id}`,
    `- case_type: ${input.case_type}`,
    `- call_direction: ${input.call_direction}`,
    `- counterpart_label: ${input.counterpart_label}`,
    '',
    '## Derivation guidance',
    `- anrede_form: ${input.case_type === 'case_6b' ? 'Du' : 'Sie'}`,
    `- For {{goal}} and {{context}}: derive from case_type + call_direction.`,
    `  case_6b inbound → goal "Carsten ruft ueber CLI an — Kalender, Anfahrt,`,
    `  Recherche, Memory-Lookup. Hilf zuegig und konkret.", context "Inbound`,
    `  von Carstens CLI-Whitelist (case_6b)".`,
    `  case_2 outbound → goal/context come from the overlay; default goal`,
    `  "Tisch reservieren auf Carstens Wunsch.", context "Outbound an`,
    `  Restaurant ${input.counterpart_label} (case_2)".`,
    '',
    'Output the rendered persona between the fence markers as specified.',
  ].join('\n');
}

/**
 * Build the user message for `voice_triggers_transcript` mid-call decision.
 * Forwards the FULL turn-history (REQ-DIR-16) so the renderer has complete
 * context. The renderer either returns NULL_NO_UPDATE between fences (no
 * change) or a fully re-rendered persona between fences.
 */
export function buildPersonaTurnPrompt(
  input: VoiceTriggersTranscriptInput,
): string {
  const turnsBlock = input.transcript.turns
    .map((t, i) => `${i + 1}. [${t.role}, ${t.started_at}] ${t.text}`)
    .join('\n');

  return [
    'You are deciding whether to update the voice-channel persona mid-call',
    `for turn ${input.turn_id}. Review the full turn history and decide.`,
    '',
    '## Call context',
    `- call_id: ${input.call_id}`,
    `- turn_id: ${input.turn_id}`,
    '',
    '## Full turn history (REQ-DIR-16)',
    turnsBlock || '(no turns yet)',
    '',
    '## Fast-brain hints (optional)',
    JSON.stringify(input.fast_brain_state ?? {}),
    '',
    '## Decision rules',
    `- If no instruction change is warranted, output ONLY:`,
    `    ${INSTRUCTIONS_FENCE_START}`,
    `    ${NULL_SENTINEL}`,
    `    ${INSTRUCTIONS_FENCE_END}`,
    `- If an updated persona/instructions block is warranted, render the`,
    `  FULL new persona (NOT a diff) using the SKILL.md rules in the system`,
    `  prompt, with the same Du/Sie axis as the initial render. Wrap it in`,
    `  the fence markers.`,
    '',
    '## Hard rules (REQ-DIR-17 — read-only mid-call)',
    '- Read-only signals from the turn-history are allowed in your decision.',
    '- DO NOT propose any mutating action (calendar-create, message-send,',
    '  etc.) inside the rendered persona — those are deferred to the',
    '  post-end_call execution path.',
    '- If the counterpart asks for a verbindliche Aktion, the rendered',
    '  persona must direct the bot to obtain Readback confirmation first.',
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
 * Extract the rendered persona body from the render-LLM's response.
 *
 * Happy path: both fences present → body is the trimmed slice between them.
 * Fallback: no fences → body is the trimmed full text (caller logs a warn).
 * Always reports whether any unsubstituted `{{...}}` tokens leaked through.
 */
export function extractRenderedString(
  raw: string | null,
): ExtractedRender {
  const text = (raw ?? '').toString();
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
  const placeholderLeak = /\{\{[a-z_]+\}\}/i.test(body);
  return { instructions: body, placeholderLeak, fenced };
}

// ---------------------------------------------------------------------------
// Default render-API wrapper
// ---------------------------------------------------------------------------

/**
 * Default render-API implementation — calls Anthropic Messages API via
 * the OneCLI proxy used by the rest of NanoClaw. One stateless roundtrip.
 */
async function defaultRenderApi(
  systemPrompt: string,
  userMessage: string,
  opts: { timeoutMs?: number; maxTokens?: number; model?: string } = {},
): Promise<string> {
  return await callClaudeViaOneCli(
    systemPrompt,
    [{ role: 'user', content: userMessage }],
    {
      timeoutMs: opts.timeoutMs,
      maxTokens: opts.maxTokens,
      model: opts.model,
    },
  );
}

// ---------------------------------------------------------------------------
// defaultInvokeAgent — voice_triggers_init render path
// ---------------------------------------------------------------------------

/**
 * `defaultInvokeAgent` for the `voice_triggers_init` MCP-tool.
 *
 * Loads the voice-personas skill files, calls the render API with the
 * typed inputs, and returns the fenced persona string. Throws a typed
 * `agent_unavailable` Error on render failure or timeout; the MCP-tool
 * factory's catch maps that to `{ ok: false, error: 'agent_unavailable' }`
 * so the Bridge falls back to FALLBACK_PERSONA per REQ-DIR-12.
 */
export async function defaultInvokeAgent(
  input: VoiceTriggersInitInput,
  deps: VoiceAgentInvokerDeps = {},
): Promise<{ instructions: string }> {
  const _renderApi = deps.renderApi ?? defaultRenderApi;
  const _loadSkill = deps.loadSkillFiles ?? loadVoicePersonaSkillDefault;
  const timeoutMs = deps.timeoutMs ?? VOICE_RENDER_TIMEOUT_MS_DEFAULT;
  const maxTokens = deps.maxTokens ?? VOICE_RENDER_MAX_TOKENS_DEFAULT;
  const now = deps.now ?? (() => Date.now());

  const start = now();

  let skill: VoicePersonaSkillFiles;
  try {
    skill = _loadSkill(input.case_type);
  } catch (err) {
    logger.warn({
      event: 'voice_render_skill_load_failed',
      call_id: input.call_id,
      case_type: input.case_type,
      err: err instanceof Error ? err.message : String(err),
    });
    const e = new Error(`agent_unavailable: skill load failed`);
    (e as { code?: string }).code = 'agent_unavailable';
    throw e;
  }

  if (!skill.overlayPath) {
    logger.warn({
      event: 'voice_render_no_overlay_for_case',
      call_id: input.call_id,
      case_type: input.case_type,
    });
  }

  const systemPrompt = buildSystemPrompt(skill);
  const userMessage = buildPersonaRenderPrompt(input);

  let raw: string;
  try {
    raw = await _renderApi(systemPrompt, userMessage, {
      timeoutMs,
      maxTokens,
      model: deps.model,
    });
  } catch (err) {
    const latency = now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = /abort|timed?\s*out|timeout/i.test(msg);
    logger.warn({
      event: 'voice_render_init_failed',
      call_id: input.call_id,
      latency_ms: latency,
      err: msg,
    });
    const e = new Error(
      `agent_unavailable: ${isAbort ? 'timeout' : msg}`,
    );
    (e as { code?: string }).code = isAbort ? 'timeout' : 'agent_unavailable';
    throw e;
  }

  const latency = now() - start;
  const { instructions, placeholderLeak, fenced } = extractRenderedString(raw);

  if (!fenced) {
    logger.warn({
      event: 'voice_render_init_no_fence',
      call_id: input.call_id,
      latency_ms: latency,
      result_len: raw.length,
    });
  }
  if (placeholderLeak) {
    logger.warn({
      event: 'voice_render_init_placeholder_leak',
      call_id: input.call_id,
      latency_ms: latency,
    });
  }

  logger.info({
    event: 'voice_render_init_ok',
    call_id: input.call_id,
    latency_ms: latency,
    case_type: input.case_type,
    instructions_len: instructions.length,
  });

  return { instructions };
}

// ---------------------------------------------------------------------------
// defaultInvokeAgentTurn — voice_triggers_transcript render path
// ---------------------------------------------------------------------------

/**
 * `defaultInvokeAgentTurn` for the `voice_triggers_transcript` MCP-tool.
 *
 * Same render-API shape as `defaultInvokeAgent` but with the per-turn
 * prompt (full turn-history per REQ-DIR-16). Decodes the LLM's verdict:
 * a fenced `NULL_NO_UPDATE` body means "no update" → returns
 * `{ instructions_update: null }`; any other body becomes the update
 * string. Throws `agent_unavailable` on failure.
 *
 * NOTE: case_type isn't carried in the transcript schema — we re-load the
 * skill with empty case mapping (baseline only) since transcript-trigger
 * decisions are mostly about whether to nudge the persona based on the
 * conversation, not re-pick the overlay. If the renderer needs to issue a
 * full re-render with the same case_type, it has the case_type implicit in
 * the prior init call; the prompt instructs it to keep the same axis.
 */
export async function defaultInvokeAgentTurn(
  input: VoiceTriggersTranscriptInput,
  deps: VoiceAgentInvokerDeps = {},
): Promise<{ instructions_update: string | null }> {
  const _renderApi = deps.renderApi ?? defaultRenderApi;
  const _loadSkill = deps.loadSkillFiles ?? loadVoicePersonaSkillDefault;
  const timeoutMs = deps.timeoutMs ?? VOICE_RENDER_TIMEOUT_MS_DEFAULT;
  const maxTokens = deps.maxTokens ?? VOICE_RENDER_MAX_TOKENS_DEFAULT;
  const now = deps.now ?? (() => Date.now());

  const start = now();

  // Transcript schema has no case_type; load baseline-only skill files.
  let skill: VoicePersonaSkillFiles;
  try {
    skill = _loadSkill('__transcript__');
  } catch (err) {
    logger.warn({
      event: 'voice_render_skill_load_failed',
      call_id: input.call_id,
      turn_id: input.turn_id,
      err: err instanceof Error ? err.message : String(err),
    });
    const e = new Error(`agent_unavailable: skill load failed`);
    (e as { code?: string }).code = 'agent_unavailable';
    throw e;
  }

  const systemPrompt = buildSystemPrompt(skill);
  const userMessage = buildPersonaTurnPrompt(input);

  let raw: string;
  try {
    raw = await _renderApi(systemPrompt, userMessage, {
      timeoutMs,
      maxTokens,
      model: deps.model,
    });
  } catch (err) {
    const latency = now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = /abort|timed?\s*out|timeout/i.test(msg);
    logger.warn({
      event: 'voice_render_turn_failed',
      call_id: input.call_id,
      turn_id: input.turn_id,
      latency_ms: latency,
      err: msg,
    });
    const e = new Error(
      `agent_unavailable: ${isAbort ? 'timeout' : msg}`,
    );
    (e as { code?: string }).code = isAbort ? 'timeout' : 'agent_unavailable';
    throw e;
  }

  const latency = now() - start;
  const { instructions, placeholderLeak, fenced } = extractRenderedString(raw);

  if (!fenced) {
    logger.warn({
      event: 'voice_render_turn_no_fence',
      call_id: input.call_id,
      turn_id: input.turn_id,
      latency_ms: latency,
      result_len: raw.length,
    });
  }

  if (instructions === NULL_SENTINEL) {
    logger.info({
      event: 'voice_render_turn_no_update',
      call_id: input.call_id,
      turn_id: input.turn_id,
      latency_ms: latency,
    });
    return { instructions_update: null };
  }

  if (placeholderLeak) {
    logger.warn({
      event: 'voice_render_turn_placeholder_leak',
      call_id: input.call_id,
      turn_id: input.turn_id,
      latency_ms: latency,
    });
  }

  logger.info({
    event: 'voice_render_turn_update',
    call_id: input.call_id,
    turn_id: input.turn_id,
    latency_ms: latency,
    instructions_update_len: instructions.length,
  });

  return { instructions_update: instructions };
}
