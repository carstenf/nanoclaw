// src/mcp-tools/voice-record-turn-cost.ts
//
// Bridge fires this per response.done with the OpenAI Realtime usage
// breakdown (sideband.ts:748). Persists one row per turn into
// voice_turn_costs via insertTurnCost(). The schema has lived in
// cost-ledger.ts since Phase 4 (INFRA-06); this handler just provides the
// MCP tool that landed on NanoClaw side after the 2026-05-05 deprecation.
//
// Idempotency: insertTurnCost uses INSERT OR IGNORE on (call_id, turn_id),
// so duplicate fires (bridge retries, replay) drop silently.
//
// Mutating=false: this is bookkeeping; not a mid-call user-visible mutation.
// Marking it mutating would block it via the REQ-DIR-17 gateway during the
// active call, exactly when we need it most. The mid-call gateway is for
// state changes the bot triggers (calendar writes, messages); cost ledger
// rows are an internal observability concern.

import { z } from 'zod';

import { insertTurnCost } from '../cost-ledger.js';
import { getDatabase } from '../db.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_record_turn_cost' as const;

export const VoiceRecordTurnCostSchema = z.object({
  call_id: z.string().min(1).max(128),
  turn_id: z.string().min(1).max(128),
  audio_in_tokens: z.number().int().nonnegative().default(0),
  audio_out_tokens: z.number().int().nonnegative().default(0),
  cached_in_tokens: z.number().int().nonnegative().default(0),
  text_in_tokens: z.number().int().nonnegative().default(0),
  text_out_tokens: z.number().int().nonnegative().default(0),
  cost_eur: z.number().nonnegative(),
});

export type VoiceRecordTurnCostInput = z.infer<typeof VoiceRecordTurnCostSchema>;

export type VoiceRecordTurnCostResult = {
  ok: true;
  result: { call_id: string; turn_id: string; cost_eur: number };
};

export interface VoiceRecordTurnCostDeps {
  /** DI for tests; defaults to getDatabase(). */
  db?: import('better-sqlite3').Database;
  /** DI for tests; defaults to () => new Date().toISOString(). */
  now?: () => string;
}

export function makeVoiceRecordTurnCost(
  deps: VoiceRecordTurnCostDeps = {},
): ToolHandler {
  const nowFn = deps.now ?? (() => new Date().toISOString());

  return async function voiceRecordTurnCost(
    args: unknown,
  ): Promise<VoiceRecordTurnCostResult> {
    const parsed = VoiceRecordTurnCostSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }

    const db = deps.db ?? getDatabase();
    const row = {
      call_id: parsed.data.call_id,
      turn_id: parsed.data.turn_id,
      ts: nowFn(),
      audio_in_tokens: parsed.data.audio_in_tokens,
      audio_out_tokens: parsed.data.audio_out_tokens,
      cached_in_tokens: parsed.data.cached_in_tokens,
      text_in_tokens: parsed.data.text_in_tokens,
      text_out_tokens: parsed.data.text_out_tokens,
      cost_eur: parsed.data.cost_eur,
      trigger_type: 'turn' as const,
    };
    insertTurnCost(db, row);

    logger.info({
      event: 'voice_record_turn_cost_ok',
      call_id: row.call_id,
      turn_id: row.turn_id,
      cost_eur: row.cost_eur,
    });

    return {
      ok: true,
      result: {
        call_id: row.call_id,
        turn_id: row.turn_id,
        cost_eur: row.cost_eur,
      },
    };
  };
}
