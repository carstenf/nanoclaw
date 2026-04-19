// src/mcp-tools/voice-finalize-call-cost.ts
// Phase 4 (INFRA-06): Bridge-internal housekeeping MCP-tool.
// Bridge posts one record at session.closed; Core upserts the per-call row
// with cost_eur recomputed from SUM(voice_turn_costs) via sumTurnCosts() DI.
// Not exposed to OpenAI Realtime — no schema in voice-bridge allowlist.
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { VoiceCallCostRow } from '../cost-ledger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

const TERMINATED_BY = [
  'counterpart_bye',
  'cost_cap_call',
  'cost_cap_daily',
  'cost_cap_monthly',
  'timeout',
] as const;

const FinalizeCallCostSchema = z.object({
  call_id: z.string().min(1),
  case_type: z.string().min(1).max(32),
  started_at: z.string().min(1),
  ended_at: z.string().min(1),
  terminated_by: z.enum(TERMINATED_BY),
  soft_warn_fired: z
    .union([z.literal(0), z.literal(1)])
    .default(0),
  model: z.string().default('gpt-realtime-mini'),
});

export interface VoiceFinalizeCallCostDeps {
  upsertCallCost: (row: VoiceCallCostRow) => void;
  /**
   * Recompute SUM(cost_eur), COUNT(*) from voice_turn_costs for this call.
   * Pitfall 3: persistence is per-turn, so we always recompute at finalize
   * time — do NOT trust Bridge in-RAM totals which may be lost on restart.
   */
  sumTurnCosts: (call_id: string) => { sum_eur: number; count: number };
  jsonlPath?: string;
  now?: () => number;
}

export function makeVoiceFinalizeCallCost(
  deps: VoiceFinalizeCallCostDeps,
): ToolHandler {
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-cost.jsonl');
  const now = deps.now ?? (() => Date.now());

  return async function voiceFinalizeCallCost(args: unknown): Promise<unknown> {
    const start = now();

    const parseResult = FinalizeCallCostSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      const field = String(firstError?.path?.[0] ?? 'input');
      const message = firstError?.message ?? 'invalid';
      throw new BadRequestError(field, message);
    }

    const d = parseResult.data;
    const { sum_eur, count } = deps.sumTurnCosts(d.call_id);

    const row: VoiceCallCostRow = {
      call_id: d.call_id,
      case_type: d.case_type,
      started_at: d.started_at,
      ended_at: d.ended_at,
      cost_eur: sum_eur,
      turn_count: count,
      terminated_by: d.terminated_by,
      soft_warn_fired: d.soft_warn_fired as 0 | 1,
      model: d.model,
    };

    try {
      deps.upsertCallCost(row);
    } catch (err: unknown) {
      // Graceful degrade — JSONL audit trail remains.
      logger.warn({
        event: 'voice_finalize_call_cost_db_fail',
        err: (err as Error).message,
      });
    }

    appendJsonl(jsonlPath, {
      ts: d.ended_at,
      event: 'call_cost_finalized',
      tool: 'voice.finalize_call_cost',
      call_id: d.call_id,
      cost_eur: sum_eur,
      turn_count: count,
      terminated_by: d.terminated_by,
      soft_warn_fired: d.soft_warn_fired,
      latency_ms: now() - start,
    });

    return {
      ok: true,
      result: { finalized: true, cost_eur: sum_eur, turn_count: count },
    };
  };
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}
