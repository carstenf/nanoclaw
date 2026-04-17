import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'
import { createCallRouter } from '../src/call-router.js'

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

function fakeFactories() {
  const turnAppend = vi.fn()
  const turnClose = vi.fn().mockResolvedValue(undefined)
  const sidebandClose = vi.fn()
  const slowBrainStop = vi.fn().mockResolvedValue(undefined)
  const slowBrainPush = vi.fn()
  const scan = vi.fn().mockResolvedValue([])
  const clear = vi.fn()
  const sidebandFactory = vi.fn().mockImplementation((callId: string) => ({
    state: {
      callId,
      ready: false,
      ws: null,
      openedAt: 0,
      lastUpdateAt: 0,
    },
    close: sidebandClose,
  }))
  const turnFactory = vi.fn().mockImplementation((callId: string) => ({
    append: turnAppend,
    close: turnClose,
    path: `/tmp/turns-${callId}.jsonl`,
  }))
  const slowFactory = vi.fn().mockReturnValue({
    push: slowBrainPush,
    stop: slowBrainStop,
  })
  return {
    factories: {
      openTurnLog: turnFactory,
      openSidebandSession: sidebandFactory,
      startSlowBrain: slowFactory,
      runGhostScan: scan,
      clearIdempotencyCache: clear,
    },
    spies: {
      turnClose,
      sidebandClose,
      slowBrainStop,
      scan,
      clear,
      sidebandFactory,
      turnFactory,
      slowFactory,
    },
  }
}

describe('createCallRouter — lifecycle', () => {
  it('startCall registers a context and calls every factory once', () => {
    const { factories, spies } = fakeFactories()
    const r = createCallRouter(factories as never)
    const log = mockLog()
    r.startCall('rtc-1', log)
    expect(r._size()).toBe(1)
    expect(r.getCall('rtc-1')?.callId).toBe('rtc-1')
    expect(spies.turnFactory).toHaveBeenCalledWith('rtc-1')
    expect(spies.sidebandFactory).toHaveBeenCalledWith('rtc-1', log)
    expect(spies.slowFactory).toHaveBeenCalledTimes(1)
  })

  it('duplicate startCall warns and returns existing context', () => {
    const { factories } = fakeFactories()
    const log = mockLog()
    const r = createCallRouter(factories as never)
    const a = r.startCall('rtc-1', log)
    const b = r.startCall('rtc-1', log)
    expect(a).toBe(b)
    expect(r._size()).toBe(1)
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(warnCalls.some((c) => c[0]?.event === 'call_start_duplicate')).toBe(
      true,
    )
  })

  it('endCall closes sideband, turn log, slow-brain, clears idempotency', async () => {
    const { factories, spies } = fakeFactories()
    const log = mockLog()
    const r = createCallRouter(factories as never)
    r.startCall('rtc-2', log)
    r.endCall('rtc-2', log)
    await new Promise((r) => setTimeout(r, 20))
    expect(spies.sidebandClose).toHaveBeenCalled()
    expect(spies.turnClose).toHaveBeenCalled()
    expect(spies.slowBrainStop).toHaveBeenCalled()
    expect(spies.clear).toHaveBeenCalledWith('rtc-2')
    expect(r._size()).toBe(0)
  })

  it('endCall on unknown call is a no-op with info log', () => {
    const { factories } = fakeFactories()
    const log = mockLog()
    const r = createCallRouter(factories as never)
    r.endCall('never-started', log)
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(infoCalls.some((c) => c[0]?.event === 'call_end_unknown')).toBe(true)
  })

  it('captures memBaselineMB at start', () => {
    const { factories } = fakeFactories()
    const r = createCallRouter(factories as never)
    const ctx = r.startCall('rtc-mb', mockLog())
    expect(typeof ctx.memBaselineMB).toBe('number')
    expect(ctx.memBaselineMB).toBeGreaterThan(0)
  })
})
