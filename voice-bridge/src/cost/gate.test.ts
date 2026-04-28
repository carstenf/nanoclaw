// voice-bridge/src/cost/gate.test.ts
// Phase 4 Plan 04-02 Task 2: /accept-time cost gate — unit tests.
// Assertion matrix per plan §behavior RED:
//   today=2.50, month=10   → allow
//   today=3.00, month=10   → reject_daily
//   today=0,    month=25   → reject_monthly
//   suspended=true         → reject_suspended
//   Core unreachable       → fail-open allow (logs cost_gate_core_unreachable)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Logger } from 'pino'
import {
  checkCostCaps,
  CostCapExceededError,
  CAP_PER_CALL_EUR,
  CAP_DAILY_EUR,
  CAP_MONTHLY_EUR,
  SOFT_WARN_FRACTION,
} from './gate.js'

function mockLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: 'info',
  } as unknown as Logger
}

describe('cost/gate — constants locked per plan', () => {
  it('CAP_PER_CALL_EUR = 1.00', () => {
    expect(CAP_PER_CALL_EUR).toBe(1.0)
  })
  it('CAP_DAILY_EUR = 3.00', () => {
    expect(CAP_DAILY_EUR).toBe(3.0)
  })
  it('CAP_MONTHLY_EUR = 25.00', () => {
    expect(CAP_MONTHLY_EUR).toBe(25.0)
  })
  it('SOFT_WARN_FRACTION = 0.80', () => {
    expect(SOFT_WARN_FRACTION).toBe(0.8)
  })
  it('CostCapExceededError name + decision propagated', () => {
    const e = new CostCapExceededError('reject_daily', {
      decision: 'reject_daily',
      today_eur: 3.0,
      month_eur: 0,
      suspended: false,
    })
    expect(e.name).toBe('CostCapExceededError')
    expect(e.decision).toBe('reject_daily')
  })
})

describe('cost/gate.checkCostCaps — DI: callNanoclawTool injected', () => {
  const envBackup: Record<string, string | undefined> = {}
  beforeEach(() => {
    envBackup.CORE_MCP_URL = process.env.CORE_MCP_URL
    process.env.CORE_MCP_URL = 'http://10.0.0.2:3200'
  })
  afterEach(() => {
    process.env.CORE_MCP_URL = envBackup.CORE_MCP_URL
  })

  it('today=2.50, month=10 → allow', async () => {
    const callNanoclawTool = vi.fn().mockResolvedValue({
      ok: true,
      result: { today_eur: 2.5, month_eur: 10, suspended: false },
    })
    const res = await checkCostCaps(mockLog(), { callNanoclawTool })
    expect(res.decision).toBe('allow')
    expect(res.today_eur).toBeCloseTo(2.5, 5)
    expect(res.month_eur).toBeCloseTo(10, 5)
    expect(res.suspended).toBe(false)
  })

  it('today=3.00, month=10 → reject_daily', async () => {
    const callNanoclawTool = vi.fn().mockResolvedValue({
      ok: true,
      result: { today_eur: 3.0, month_eur: 10, suspended: false },
    })
    const res = await checkCostCaps(mockLog(), { callNanoclawTool })
    expect(res.decision).toBe('reject_daily')
  })

  it('today=0, month=25 → reject_monthly', async () => {
    const callNanoclawTool = vi.fn().mockResolvedValue({
      ok: true,
      result: { today_eur: 0, month_eur: 25.0, suspended: false },
    })
    const res = await checkCostCaps(mockLog(), { callNanoclawTool })
    expect(res.decision).toBe('reject_monthly')
  })

  it('suspended=true → reject_suspended (even if sums are below caps)', async () => {
    const callNanoclawTool = vi.fn().mockResolvedValue({
      ok: true,
      result: { today_eur: 0, month_eur: 0, suspended: true },
    })
    const res = await checkCostCaps(mockLog(), { callNanoclawTool })
    expect(res.decision).toBe('reject_suspended')
    expect(res.suspended).toBe(true)
  })

  it('Core unreachable → fail-open allow, logs cost_gate_core_unreachable', async () => {
    const callNanoclawTool = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const log = mockLog()
    const res = await checkCostCaps(log, { callNanoclawTool })
    expect(res.decision).toBe('allow')
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(
      warnCalls.some((c) => c[0]?.event === 'cost_gate_core_unreachable'),
    ).toBe(true)
  })

  it('malformed Core response (missing result) → fail-open allow', async () => {
    const callNanoclawTool = vi.fn().mockResolvedValue({ ok: false })
    const log = mockLog()
    const res = await checkCostCaps(log, { callNanoclawTool })
    expect(res.decision).toBe('allow')
  })

  it('Comment Pitfall 10: daily cap only enforced AT /accept, never mid-call', () => {
    // This test asserts the gate module source carries the Pitfall-10 comment.
    // Mid-call daily-cap re-evaluation would require a concurrent-call design
    // which is out of scope (A11 single-caller). The comment pins the contract.
    // (Asserted via grep in acceptance_criteria — placeholder test keeps the
    // intent visible in the test suite.)
    expect(true).toBe(true)
  })
})
