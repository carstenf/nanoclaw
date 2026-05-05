/**
 * MCP tool: voice_finalize_call_cost
 *
 * Stub implementation. Cost-tracking was deprecated (operator decision
 * 2026-05-05); this handler exists ONLY so the bridge's per-call
 * deregister hook does not log MCP "tool not found" and — crucially —
 * so the active-call state in voice-mid-call-gateway clears at session
 * end. Without this, calls stay registered indefinitely and the
 * post-call `voice_send_discord_message` (transcript chunk) is rejected
 * by the REQ-DIR-17 mid-call mutation gateway, killing transcript
 * delivery.
 *
 * The bridge calls this from sideband.ts on `session.closed` /
 * `session.terminated` and on cost-cap hard-stops. Args carry call_id
 * + bookkeeping fields (case_type, started_at, ended_at, terminated_by,
 * soft_warn_fired); we accept them with permissive types and ignore the
 * cost columns. Only call_id is load-bearing for the deregister.
 */
import { z } from 'zod';

import { deregisterActiveCall } from '../voice-mid-call-gateway.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const VoiceFinalizeCallCostSchema = z.object({
  call_id: z.string().min(1).max(128),
  // Bridge ships these; we ignore them but accept the shape so a typo on
  // the bridge side doesn't slip past validation.
  case_type: z.string().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  terminated_by: z.string().optional(),
  soft_warn_fired: z.number().optional(),
});

export type VoiceFinalizeCallCostInput = z.infer<
  typeof VoiceFinalizeCallCostSchema
>;

export function makeVoiceFinalizeCallCost(): ToolHandler {
  return async function voiceFinalizeCallCost(
    args: unknown,
  ): Promise<unknown> {
    const parsed = VoiceFinalizeCallCostSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }
    const { call_id, terminated_by } = parsed.data;
    deregisterActiveCall(call_id);
    logger.info({
      event: 'voice_finalize_call_cost_handled',
      call_id,
      terminated_by: terminated_by ?? null,
    });
    return { ok: true, result: { call_id, deregistered: true } };
  };
}
