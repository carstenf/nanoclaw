// src/voice-mid-call-gateway.ts
//
// Phase 05.6 Plan 01 Task 4 — NanoClaw-side mid-call mutation gateway.
//
// REQ-DIR-17 (verbatim, from
//   ~/nanoclaw-state/voice-channel-spec/decisions/2026-04-24-slow-brain-removal-phase-6.md
//   Q4 resolution):
//
//   "Mid-call tool access shall be restricted to read-only operations.
//    Mutating tool invocations shall be queued by the container-agent for
//    execution after `end_call` via the existing session-summary pipeline.
//    Mid-call mutation attempts shall be rejected by the NanoClaw-side
//    gateway."
//
// This file owns the third defense layer (the second logical layer — see
// below). REQ-DIR-17 is enforced via a 3-tier defense-in-depth:
//
//   Layer 1 — Agent prompt forbids mutating tool calls mid-call
//             (`src/voice-agent-invoker.ts` buildPersonaTurnPrompt).
//   Layer 2 — THIS gateway rejects at the dispatch path
//             (`src/mcp-tools/index.ts ToolRegistry.invoke` calls
//             `checkMidCallMutation` before invoking any handler whose
//             metadata flag `mutating=true`).
//   Layer 3 — `__MUTATION_ATTEMPT__` sentinel gate at handler boundary in
//             `src/mcp-tools/voice-triggers-transcript.ts` (Phase 05.5-01).
//
// All three layers are independent — the goal is that no single point of
// failure (a misbehaving agent, a forgotten metadata flag, a broken sentinel)
// can let a mutating tool execute mid-call.

import { logger } from './logger.js';

// Module-level active-call state. Process-local — sufficient for single-
// process NanoClaw deploy (REQ-INFRA-16: idle-timeout 30min, single
// container per group). If NanoClaw ever scales to multi-process voice
// handling, this becomes a shared store (Redis/SQLite); flagged as
// future-work.
//
// Phase 06.x mid-call language switch: state is now a Map<callId, ActiveCallState>
// so voice_set_language can look up the per-call lang + whitelist by call_id
// and reject switches that exceed Andy's variable whitelist.
export type CallLang = 'de' | 'en' | 'it';

export interface ActiveCallState {
  /** Currently-active persona language for this call. */
  lang: CallLang;
  /**
   * Allowed langs the bot may switch to mid-call via voice_set_language.
   * Empty array = no mid-call switching (legacy single-lang call).
   */
  lang_whitelist: CallLang[];
  /**
   * Render context captured at /accept time so voice_set_language can
   * re-render the persona with a new lang while keeping case_type,
   * counterpart_label, call_direction and goal constant. Without this the
   * mid-call language switch would lose the call brief.
   */
  render_ctx: {
    case_type: 'case_2' | 'case_6a' | 'case_6b';
    call_direction: 'inbound' | 'outbound';
    counterpart_label: string;
    goal?: string;
  };
}

const activeCalls = new Map<string, ActiveCallState>();

export interface ToolMeta {
  /**
   * True if the tool mutates external state (calendar, message, payment, etc.).
   * Read-only tools (RAG, lookups, status reads) leave this false/undefined.
   * Implicit default = false (non-mutating) — explicit opt-in semantic.
   */
  mutating?: boolean;
}

export interface MutationCheckResult {
  allowed: boolean;
  reason?: 'mid_call_mutation_forbidden';
}

/**
 * REQ-DIR-17 NanoClaw-side gateway.
 *
 * Called from the MCP-tool dispatch path BEFORE invoking any mutating tool
 * handler. If the call_id is in the active-call set (a voice call is currently
 * in progress for this call_id) AND the tool is marked mutating, the call is
 * rejected. The container-agent must instead defer the mutation to the
 * post-end_call execution path (session-summary pipeline).
 */
export function checkMidCallMutation(
  call_id: string | null,
  tool_name: string,
  tool_meta: ToolMeta,
): MutationCheckResult {
  if (call_id === null || call_id === undefined) {
    // No call correlation → background task / Andy invocation / scheduled
    // retry → ALLOWED.
    return { allowed: true };
  }
  if (!tool_meta.mutating) {
    // Read-only → ALLOWED.
    return { allowed: true };
  }
  if (!activeCalls.has(call_id)) {
    // Post-call execution path → ALLOWED.
    return { allowed: true };
  }
  logger.warn({
    event: 'mid_call_mutation_blocked',
    call_id,
    tool_name,
  });
  return { allowed: false, reason: 'mid_call_mutation_forbidden' };
}

/**
 * Register a call_id as active with its starting lang + whitelist. Called
 * from `voice_triggers_init` handler entry — the call is considered active
 * from /accept until `voice_finalize_call_cost` deregisters it.
 *
 * Defaults: lang='de', lang_whitelist=[] (no mid-call switching). When the
 * caller supplies neither, behaviour matches pre-Phase-06.x (single-lang
 * call locked to DE).
 */
export function registerActiveCall(
  call_id: string,
  opts: {
    lang?: CallLang;
    lang_whitelist?: CallLang[];
    render_ctx?: ActiveCallState['render_ctx'];
  } = {},
): void {
  activeCalls.set(call_id, {
    lang: opts.lang ?? 'de',
    lang_whitelist: opts.lang_whitelist ?? [],
    // Default render_ctx is a generic outbound case_2 — sufficient for the
    // legacy mid-call-mutation gateway use case where render_ctx isn't read.
    // Phase 06.x mid-call language switch always supplies a real ctx.
    render_ctx: opts.render_ctx ?? {
      case_type: 'case_2',
      call_direction: 'outbound',
      counterpart_label: 'Counterpart',
    },
  });
  logger.info({
    event: 'mid_call_gateway_call_registered',
    call_id,
    lang: opts.lang ?? 'de',
    lang_whitelist: opts.lang_whitelist ?? [],
  });
}

/**
 * Deregister a call_id from the active-call map. Called from
 * `voice_finalize_call_cost` (and any Phase-05.5 end_call hook). No-op when
 * the call_id was never registered (idempotent).
 */
export function deregisterActiveCall(call_id: string): void {
  if (activeCalls.delete(call_id)) {
    logger.info({ event: 'mid_call_gateway_call_deregistered', call_id });
  }
}

/** True if a call is currently active (registered + not yet deregistered). */
export function isCallActive(call_id: string): boolean {
  return activeCalls.has(call_id);
}

/** Look up the currently-active lang for a call, or null if call is unknown. */
export function getActiveLang(call_id: string): CallLang | null {
  return activeCalls.get(call_id)?.lang ?? null;
}

/** Look up the lang whitelist for a call, or null if call is unknown. */
export function getActiveWhitelist(call_id: string): CallLang[] | null {
  const state = activeCalls.get(call_id);
  return state ? state.lang_whitelist : null;
}

/** Render context captured at /accept time, or null if call is unknown. */
export function getActiveRenderCtx(
  call_id: string,
): ActiveCallState['render_ctx'] | null {
  return activeCalls.get(call_id)?.render_ctx ?? null;
}

/**
 * Set the active lang for a call. Called from voice_set_language AFTER it
 * has validated lang ∈ whitelist. No-op when call_id is unknown (the gate
 * is the validation step, not this state-setter).
 */
export function setActiveLang(call_id: string, lang: CallLang): boolean {
  const state = activeCalls.get(call_id);
  if (!state) return false;
  state.lang = lang;
  logger.info({ event: 'mid_call_gateway_lang_set', call_id, lang });
  return true;
}

/** Test-only: clears the active-call map. */
export function _resetActiveSet(): void {
  activeCalls.clear();
}
