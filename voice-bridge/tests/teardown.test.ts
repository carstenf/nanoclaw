import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'
import { startTeardown } from '../src/teardown.js'
import type { SidebandHandle } from '../src/sideband.js'

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

function fakeSideband(): { handle: SidebandHandle; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn()
  return {
    handle: {
      state: {
        callId: 'c',
        ready: true,
        ws: null,
        openedAt: 0,
        lastUpdateAt: 0,
      },
      close,
    },
    close,
  }
}

describe('startTeardown — D-16 / D-17 / D-19 (REQ-VOICE-11 assertion)', () => {
  it('markClosed() cancels force-close and runs normal close sequence', async () => {
    vi.useFakeTimers()
    const sb = fakeSideband()
    const clear = vi.fn()
    const scan = vi.fn().mockResolvedValue([])
    const log = mockLog()
    const h = startTeardown({
      callId: 'c1',
      sideband: sb.handle,
      clearCall: clear,
      ghostScan: scan,
      log,
      memBaselineMB: 100,
      killMs: 50,
      forceMs: 100,
      heapDelayMs: 200,
    })
    h.markClosed()
    await vi.advanceTimersByTimeAsync(500)
    expect(sb.close).toHaveBeenCalled()
    expect(clear).toHaveBeenCalledWith('c1')
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(warnCalls.some((c) => c[0]?.event === 'teardown_force_closed')).toBe(
      false,
    )
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(
      infoCalls.some((c) => c[0]?.event === 'teardown_closed_normally'),
    ).toBe(true)
    vi.useRealTimers()
  })

  it('force-close fires after forceMs when markClosed never called (5s force-close)', async () => {
    vi.useFakeTimers()
    const sb = fakeSideband()
    const clear = vi.fn()
    const scan = vi.fn().mockResolvedValue([])
    const log = mockLog()
    startTeardown({
      callId: 'c2',
      sideband: sb.handle,
      clearCall: clear,
      ghostScan: scan,
      log,
      memBaselineMB: 100,
      killMs: 50,
      forceMs: 100,
      heapDelayMs: 200,
    })
    await vi.advanceTimersByTimeAsync(150)
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(warnCalls.some((c) => c[0]?.event === 'teardown_force_closed')).toBe(
      true,
    )
    expect(sb.close).toHaveBeenCalled()
    expect(clear).toHaveBeenCalledWith('c2')
    expect(scan).toHaveBeenCalledWith('c2', expect.anything())
    vi.useRealTimers()
  })

  it('schedules mem_delta_mb heapDelayMs after close', async () => {
    vi.useFakeTimers()
    const sb = fakeSideband()
    const log = mockLog()
    const h = startTeardown({
      callId: 'c3',
      sideband: sb.handle,
      clearCall: vi.fn(),
      ghostScan: vi.fn().mockResolvedValue([]),
      log,
      memBaselineMB: 100,
      killMs: 50,
      forceMs: 100,
      heapDelayMs: 200,
    })
    h.markClosed()
    await vi.advanceTimersByTimeAsync(300)
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(infoCalls.some((c) => c[0]?.event === 'mem_delta_mb')).toBe(true)
    vi.useRealTimers()
  })

  it('emits teardown_kill_pending warning at kill timer when not yet closed', async () => {
    vi.useFakeTimers()
    const sb = fakeSideband()
    const log = mockLog()
    startTeardown({
      callId: 'c4',
      sideband: sb.handle,
      clearCall: vi.fn(),
      ghostScan: vi.fn().mockResolvedValue([]),
      log,
      memBaselineMB: 100,
      killMs: 50,
      forceMs: 10000,
      heapDelayMs: 200,
    })
    await vi.advanceTimersByTimeAsync(60)
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(warnCalls.some((c) => c[0]?.event === 'teardown_kill_pending')).toBe(
      true,
    )
    vi.useRealTimers()
  })

  it('abort() cancels both timers without close sequence', async () => {
    vi.useFakeTimers()
    const sb = fakeSideband()
    const clear = vi.fn()
    const scan = vi.fn().mockResolvedValue([])
    const log = mockLog()
    const h = startTeardown({
      callId: 'c5',
      sideband: sb.handle,
      clearCall: clear,
      ghostScan: scan,
      log,
      memBaselineMB: 100,
      killMs: 50,
      forceMs: 100,
      heapDelayMs: 200,
    })
    h.abort()
    await vi.advanceTimersByTimeAsync(500)
    expect(sb.close).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(scan).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
