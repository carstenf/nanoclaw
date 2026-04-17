import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'
import { startSlowBrain } from '../src/slow-brain.js'
import type { SidebandState } from '../src/sideband.js'

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

function fakeSideband(): SidebandState {
  const ws = { readyState: 1, send: vi.fn() } as unknown as WSType
  return {
    callId: 'c',
    ready: true,
    ws,
    openedAt: 0,
    lastUpdateAt: 0,
  }
}

const okResult = { ok: true, instructions_update: 'neue instr' as string | null }

describe('startSlowBrain — cadence cap (D-25)', () => {
  it('after cap=2, emits at most 2 Core-calls across 4 turns', async () => {
    const callTool = vi.fn().mockResolvedValue(okResult)
    const w = startSlowBrain(mockLog(), fakeSideband(), {
      coreClient: { callTool },
      cadenceCap: 2,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'a' })
    w.push({ turnId: 't2', transcript: 'b' })
    w.push({ turnId: 't3', transcript: 'c' })
    w.push({ turnId: 't4', transcript: 'd' })
    await new Promise((r) => setTimeout(r, 300))
    expect(callTool.mock.calls.length).toBeLessThanOrEqual(2)
    await w.stop()
  })

  it('with cadenceCap=0 (disabled), every push yields a Core-call', async () => {
    const callTool = vi.fn().mockResolvedValue(okResult)
    const w = startSlowBrain(mockLog(), fakeSideband(), {
      coreClient: { callTool },
      cadenceCap: 0,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'a' })
    w.push({ turnId: 't2', transcript: 'b' })
    await new Promise((r) => setTimeout(r, 200))
    expect(callTool.mock.calls.length).toBeGreaterThanOrEqual(2)
    // Verify the tool-name and arg-shape on the first call
    expect(callTool.mock.calls[0][0]).toBe('voice.on_transcript_turn')
    expect(callTool.mock.calls[0][1]).toMatchObject({
      call_id: 'c',
      turn_id: 't1',
      transcript: 'a',
    })
    await w.stop()
  })
})

describe('startSlowBrain — back-pressure (D-28)', () => {
  it('drops oldest when queue exceeds queueMax and logs backpressure', async () => {
    const callTool = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((r) => setTimeout(() => r(okResult), 1000)),
      )
    const log = mockLog()
    const w = startSlowBrain(log, fakeSideband(), {
      coreClient: { callTool },
      queueMax: 2,
      cadenceCap: 0,
      pollIntervalMs: 5,
    })
    for (let i = 0; i < 5; i++) {
      w.push({ turnId: `t${i}`, transcript: 'x' })
    }
    await new Promise((r) => setTimeout(r, 80))
    const warn = log.warn as ReturnType<typeof vi.fn>
    expect(
      warn.mock.calls.some((c) => c[0]?.event === 'slow_brain_backpressure'),
    ).toBe(true)
    await w.stop()
  })
})

describe('startSlowBrain — graceful degrade (REQ-DIR-12)', () => {
  it('logs slow_brain_degraded on Core timeout — no throw to hot-path', async () => {
    const callTool = vi.fn().mockImplementation(
      (_n, _a, opts: { signal?: AbortSignal } = {}) =>
        new Promise((_r, rej) => {
          if (opts.signal) {
            opts.signal.addEventListener('abort', () =>
              rej(new Error('aborted')),
            )
          }
        }),
    )
    const log = mockLog()
    const w = startSlowBrain(log, fakeSideband(), {
      coreClient: { callTool },
      timeoutMs: 30,
      cadenceCap: 0,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'x' })
    // Force abort via caller signal since callTool mock uses opts.signal directly
    await new Promise((r) => setTimeout(r, 50))
    // Abort any in-flight by stopping the worker (which aborts currentAbort)
    await w.stop()
    // Give the loop time to log degrade
    await new Promise((r) => setTimeout(r, 50))
    const warn = log.warn as ReturnType<typeof vi.fn>
    expect(
      warn.mock.calls.some((c) => c[0]?.event === 'slow_brain_degraded'),
    ).toBe(true)
  })

  it('continues processing after a failed turn', async () => {
    let calls = 0
    const callTool = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return okResult
    })
    const log = mockLog()
    const w = startSlowBrain(log, fakeSideband(), {
      coreClient: { callTool },
      cadenceCap: 0,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'a' })
    w.push({ turnId: 't2', transcript: 'b' })
    await new Promise((r) => setTimeout(r, 200))
    expect(calls).toBeGreaterThanOrEqual(2)
    await w.stop()
  })
})

describe('startSlowBrain — no-op mode (CORE_MCP_URL unset + no DI)', () => {
  it('logs slow_brain_disabled and silently discards pushes', async () => {
    // No coreClient + CORE_MCP_URL is unset in test env
    const log = mockLog()
    const w = startSlowBrain(log, fakeSideband(), {
      cadenceCap: 0,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'a' })
    await new Promise((r) => setTimeout(r, 50))
    await w.stop()
    const info = log.info as ReturnType<typeof vi.fn>
    expect(
      info.mock.calls.some((c) => c[0]?.event === 'slow_brain_disabled'),
    ).toBe(true)
  })
})

describe('startSlowBrain — bad-response handling', () => {
  it('logs slow_brain_bad_response when Core returns unknown shape', async () => {
    const callTool = vi.fn().mockResolvedValue({ weird: 'shape' })
    const log = mockLog()
    const w = startSlowBrain(log, fakeSideband(), {
      coreClient: { callTool },
      cadenceCap: 0,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'a' })
    await new Promise((r) => setTimeout(r, 100))
    const warn = log.warn as ReturnType<typeof vi.fn>
    expect(
      warn.mock.calls.some((c) => c[0]?.event === 'slow_brain_bad_response'),
    ).toBe(true)
    await w.stop()
  })

  it('accepts wrapped MCP-server response {ok, result:{ok, instructions_update}}', async () => {
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      result: { ok: true, instructions_update: 'mcp-style instr' },
    })
    const mockWs = { readyState: 1, send: vi.fn() } as unknown as WSType
    const sideband: SidebandState = {
      callId: 'c',
      ready: true,
      ws: mockWs,
      openedAt: 0,
      lastUpdateAt: 0,
    }
    const w = startSlowBrain(mockLog(), sideband, {
      coreClient: { callTool },
      cadenceCap: 0,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'a' })
    await new Promise((r) => setTimeout(r, 100))
    const send = mockWs.send as ReturnType<typeof vi.fn>
    const sent = send.mock.calls.map((c) => JSON.parse(c[0] as string))
    expect(
      sent.some((m: { session?: { instructions?: string } }) =>
        m.session?.instructions?.includes('mcp-style instr'),
      ),
    ).toBe(true)
    await w.stop()
  })
})
