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

export const FinalizeCallCostSchema = z.object({
  call_id: z.string().min(1),
  case_type: z.string().min(1).max(32),
  started_at: z.string().min(1),
  ended_at: z.string().min(1),
  terminated_by: z.enum(TERMINATED_BY),
  soft_warn_fired: z.union([z.literal(0), z.literal(1)]).default(0),
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
  /**
   * Phase 4 Plan 04-02 Task 3 (COST-03 variant b, locked per WARNING-2):
   * after upsert, query SUM(voice_call_costs.cost_eur) for current month.
   * If result >= CAP_MONTHLY_EUR (€25), auto-suspend via setRouterState
   * ('voice_channel_suspended','1'). Injected so in-memory tests can omit
   * and production wiring in mcp-tools/index.ts supplies real accessors.
   */
  sumCostCurrentMonth?: () => number;
  setRouterState?: (key: string, value: string) => void;
  /**
   * Monthly cap constant (€25). Default matches voice-bridge/src/cost/gate.ts
   * CAP_MONTHLY_EUR. Injectable only for test override.
   */
  capMonthlyEur?: number;
  jsonlPath?: string;
  now?: () => number;
}

export function makeVoiceFinalizeCallCost(
  deps: VoiceFinalizeCallCostDeps,
): ToolHandler {
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-cost.jsonl');
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

    // Phase 4 Plan 04-02 (COST-03 variant b, locked): Core-side auto-suspend.
    // After upsert, re-query the monthly SUM. If >= CAP_MONTHLY_EUR (default
    // €25), atomically set router_state.voice_channel_suspended='1'. The
    // Bridge /accept-gate then reads this flag via voice_get_day_month_cost_sum
    // and returns SIP 503 for any further calls until voice_reset_monthly_cap
    // is invoked. Keeping the suspension-write on the same Core handler
    // avoids adding a voice.set_suspend MCP tool (A12 surface minimization).
    const capMonthlyEur = deps.capMonthlyEur ?? 25.0;
    let auto_suspended = false;
    let monthSumAfter: number | null = null;
    if (deps.sumCostCurrentMonth && deps.setRouterState) {
      try {
        monthSumAfter = deps.sumCostCurrentMonth();
        if (monthSumAfter >= capMonthlyEur) {
          deps.setRouterState('voice_channel_suspended', '1');
          auto_suspended = true;
          logger.warn({
            event: 'monthly_cap_auto_suspend',
            call_id: d.call_id,
            month_eur: monthSumAfter,
            cap_eur: capMonthlyEur,
          });
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'monthly_cap_auto_suspend',
            tool: 'voice_finalize_call_cost',
            call_id: d.call_id,
            month_eur: monthSumAfter,
            cap_eur: capMonthlyEur,
          });
        }
      } catch (err: unknown) {
        logger.warn({
          event: 'monthly_cap_auto_suspend_fail',
          err: (err as Error).message,
        });
      }
    }

    appendJsonl(jsonlPath, {
      ts: d.ended_at,
      event: 'call_cost_finalized',
      tool: 'voice_finalize_call_cost',
      call_id: d.call_id,
      cost_eur: sum_eur,
      turn_count: count,
      terminated_by: d.terminated_by,
      soft_warn_fired: d.soft_warn_fired,
      auto_suspended,
      month_eur_after: monthSumAfter,
      latency_ms: now() - start,
    });

    // Phase 05.5 Plan 01 Task 4 (REQ-INFRA-16, D-11): garbage-collect the
    // per-call_id voice-trigger queue chain on end-of-call. Dynamic import
    // avoids a circular dependency: `mcp-tools/index.ts` already imports
    // this file statically, so importing the singleton from there in a
    // top-level static import would loop. Failures are non-fatal — the
    // queue's own `gc()` is idempotent and the next end_call would retry.
    try {
      const indexMod = (await import('./index.js')) as {
        voiceTriggerQueue: { gc: (callId: string) => void };
      };
      indexMod.voiceTriggerQueue.gc(d.call_id);
    } catch (e: unknown) {
      logger.warn({
        event: 'voice_trigger_queue_gc_failed',
        call_id: d.call_id,
        err: (e as Error)?.message ?? String(e),
      });
    }

    return {
      ok: true,
      result: {
        finalized: true,
        cost_eur: sum_eur,
        turn_count: count,
        auto_suspended,
      },
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
