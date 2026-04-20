// Phase 4 Plan 04-02 Task 2: voice_get_day_month_cost_sum MCP handler — unit tests.
// RED during this plan's task 2a; GREEN after the handler is landed.
import { describe, it, expect } from 'vitest';

import {
  makeVoiceGetDayMonthCostSum,
  VoiceGetDayMonthCostSumDeps,
} from './voice-get-day-month-cost-sum.js';

function makeDeps(
  overrides: Partial<VoiceGetDayMonthCostSumDeps> = {},
): VoiceGetDayMonthCostSumDeps {
  return {
    sumCostCurrentDay: () => 0,
    sumCostCurrentMonth: () => 0,
    isSuspended: () => false,
    ...overrides,
  };
}

describe('makeVoiceGetDayMonthCostSum (04-02 COST-02/03)', () => {
  it('happy path: returns {today_eur, month_eur, suspended} from deps', async () => {
    const deps = makeDeps({
      sumCostCurrentDay: () => 1.25,
      sumCostCurrentMonth: () => 7.5,
      isSuspended: () => false,
    });
    const handler = makeVoiceGetDayMonthCostSum(deps);

    const result = (await handler({})) as {
      ok: true;
      result: { today_eur: number; month_eur: number; suspended: boolean };
    };

    expect(result.ok).toBe(true);
    expect(result.result.today_eur).toBeCloseTo(1.25, 5);
    expect(result.result.month_eur).toBeCloseTo(7.5, 5);
    expect(result.result.suspended).toBe(false);
  });

  it('suspended=true is reflected in result', async () => {
    const deps = makeDeps({
      sumCostCurrentDay: () => 0,
      sumCostCurrentMonth: () => 25.0,
      isSuspended: () => true,
    });
    const handler = makeVoiceGetDayMonthCostSum(deps);

    const result = (await handler({})) as {
      ok: true;
      result: { today_eur: number; month_eur: number; suspended: boolean };
    };

    expect(result.result.month_eur).toBeCloseTo(25.0, 5);
    expect(result.result.suspended).toBe(true);
  });

  it('accepts no-args or empty-object input (schema is permissive)', async () => {
    const handler = makeVoiceGetDayMonthCostSum(makeDeps());
    const r1 = (await handler({})) as { ok: true };
    const r2 = (await handler(undefined)) as { ok: true };
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});
