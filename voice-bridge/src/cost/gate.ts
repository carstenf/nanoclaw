// voice-bridge/src/cost/gate.ts
// Phase 4 Plan 04-02 (COST-02, COST-03): /accept-time cost gate.
// Queries Core via voice_get_day_month_cost_sum and returns a decision
// {allow|reject_daily|reject_monthly|reject_suspended} + current totals.
// webhook.ts is the sole caller; it maps non-'allow' decisions to SIP 503.
//
// Pitfall 10: daily cap is enforced ONLY at /accept (call open), never
// mid-call. A mid-call re-evaluation would need concurrent-call design
// (A11 — single caller assumption). Per-call cap (€1.00) is the only
// in-call enforcement; it fires from sideband.ts response.done path.
//
// Fail-open policy: if Core is unreachable at gate-time we log
// `cost_gate_core_unreachable` and return decision='allow'. Blocking every
// call during a Core outage would be a worse failure mode than temporarily
// bypassing the daily/monthly cap (single-user system, JSONL is the audit
// trail of last resort).
import type { Logger } from 'pino'
import { callCoreTool as _callCoreTool } from '../core-mcp-client.js'

export const CAP_PER_CALL_EUR = 1.0
export const CAP_DAILY_EUR = 3.0
export const CAP_MONTHLY_EUR = 25.0
export const SOFT_WARN_FRACTION = 0.8

export type GateDecision =
  | 'allow'
  | 'reject_daily'
  | 'reject_monthly'
  | 'reject_suspended'

export interface GateResult {
  decision: GateDecision
  today_eur: number
  month_eur: number
  suspended: boolean
}

export class CostCapExceededError extends Error {
  constructor(
    public readonly decision: GateDecision,
    public readonly detail: GateResult,
  ) {
    super(`cost-cap-exceeded: ${decision}`)
    this.name = 'CostCapExceededError'
  }
}

export interface CheckCostCapsOpts {
  /** Gate timeout (ms). Default 2000 — must finish before the /accept SLA. */
  gateTimeoutMs?: number
  /** DI: override callCoreTool for tests. */
  callCoreTool?: (
    name: string,
    args: unknown,
    opts: { timeoutMs: number },
  ) => Promise<unknown>
}

export async function checkCostCaps(
  log: Logger,
  opts: CheckCostCapsOpts = {},
): Promise<GateResult> {
  const timeoutMs = opts.gateTimeoutMs ?? 2000
  const callCore = opts.callCoreTool ?? _callCoreTool

  let res: unknown
  try {
    res = await callCore('voice_get_day_month_cost_sum', {}, { timeoutMs })
  } catch (err: unknown) {
    log.warn({
      event: 'cost_gate_core_unreachable',
      err: (err as Error).message,
    })
    return { decision: 'allow', today_eur: 0, month_eur: 0, suspended: false }
  }

  const shaped = res as {
    ok?: boolean
    result?: { today_eur?: number; month_eur?: number; suspended?: boolean }
  }
  if (!shaped?.ok || !shaped.result) {
    log.warn({ event: 'cost_gate_core_unreachable', reason: 'bad_payload' })
    return { decision: 'allow', today_eur: 0, month_eur: 0, suspended: false }
  }

  const today_eur = shaped.result.today_eur ?? 0
  const month_eur = shaped.result.month_eur ?? 0
  const suspended = shaped.result.suspended ?? false

  if (suspended) {
    return { decision: 'reject_suspended', today_eur, month_eur, suspended }
  }
  if (month_eur >= CAP_MONTHLY_EUR) {
    return { decision: 'reject_monthly', today_eur, month_eur, suspended }
  }
  if (today_eur >= CAP_DAILY_EUR) {
    return { decision: 'reject_daily', today_eur, month_eur, suspended }
  }
  return { decision: 'allow', today_eur, month_eur, suspended }
}
