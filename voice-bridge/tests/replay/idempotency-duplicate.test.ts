import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'
import { invokeIdempotent, clearCall } from '../../src/idempotency.js'

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

describe('SC-2 A — duplicate mutating tool produces exactly one Core dispatch', () => {
  it('create_calendar_entry called twice with identical args -> invoker called once', async () => {
    clearCall('replay')
    const invoker = vi.fn().mockResolvedValue({ id: 'cal_123' })
    const log = mockLog()
    const args = {
      title: 'Dentist',
      date: '2026-05-23',
      time: '14:30',
      duration: 30,
    }
    const r1 = await invokeIdempotent(
      'replay',
      't1',
      'create_calendar_entry',
      args,
      invoker,
      log,
    )
    const r2 = await invokeIdempotent(
      'replay',
      't1',
      'create_calendar_entry',
      args,
      invoker,
      log,
    )
    expect(invoker).toHaveBeenCalledTimes(1)
    expect(r1).toEqual(r2)
    clearCall('replay')
  })
})
