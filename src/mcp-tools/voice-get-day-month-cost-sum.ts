// src/mcp-tools/voice-get-day-month-cost-sum.ts
// Phase 4 Plan 04-02 (COST-02/03): Core MCP tool that the Bridge /accept gate
// queries to decide whether to open a new call. Returns {today_eur, month_eur,
// suspended} for the Bridge's cost/gate.ts to compare against CAP_DAILY_EUR /
// CAP_MONTHLY_EUR. Permissive zod schema — Bridge passes `{}`.
import { z } from 'zod';

import type { ToolHandler } from './index.js';

export const GetDayMonthCostSumSchema = z.object({}).passthrough();

export interface VoiceGetDayMonthCostSumDeps {
  sumCostCurrentDay: () => number;
  sumCostCurrentMonth: () => number;
  isSuspended: () => boolean;
}

export function makeVoiceGetDayMonthCostSum(
  deps: VoiceGetDayMonthCostSumDeps,
): ToolHandler {
  return async function voiceGetDayMonthCostSum(
    args: unknown,
  ): Promise<unknown> {
    GetDayMonthCostSumSchema.parse(args ?? {});
    const today_eur = deps.sumCostCurrentDay();
    const month_eur = deps.sumCostCurrentMonth();
    const suspended = deps.isSuspended();
    return {
      ok: true,
      result: { today_eur, month_eur, suspended },
    };
  };
}
