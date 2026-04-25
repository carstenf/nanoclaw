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

// Module-level active-call set. Process-local — sufficient for single-process
// NanoClaw deploy (REQ-INFRA-16: idle-timeout 30min, single container per
// group). If NanoClaw ever scales to multi-process voice handling, this
// becomes a shared store (Redis/SQLite); flagged as future-work.
const activeCalls = new Set<string>();

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
 * Register a call_id as active. Called from `voice_triggers_init` handler
 * entry — the call is considered active from /accept until
 * `voice_finalize_call_cost` deregisters it.
 */
export function registerActiveCall(call_id: string): void {
  activeCalls.add(call_id);
  logger.info({ event: 'mid_call_gateway_call_registered', call_id });
}

/**
 * Deregister a call_id from the active-call set. Called from
 * `voice_finalize_call_cost` (and any Phase-05.5 end_call hook). No-op when
 * the call_id was never registered (idempotent).
 */
export function deregisterActiveCall(call_id: string): void {
  if (activeCalls.delete(call_id)) {
    logger.info({ event: 'mid_call_gateway_call_deregistered', call_id });
  }
}

/** True if a call is in the active-call set. */
export function isCallActive(call_id: string): boolean {
  return activeCalls.has(call_id);
}

/** Test-only: clears the active-call set. */
export function _resetActiveSet(): void {
  activeCalls.clear();
}
