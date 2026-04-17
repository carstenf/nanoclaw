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

describe('startSlowBrain — cadence cap (D-25)', () => {
  it('after cap=2, emits at most 2 Claude calls across 4 turns', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: 'new instr' }] })
    const w = startSlowBrain(mockLog(), fakeSideband(), {
      anthropicClient: { messages: { create } },
      cadenceCap: 2,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'a' })
    w.push({ turnId: 't2', transcript: 'b' })
    w.push({ turnId: 't3', transcript: 'c' })
    w.push({ turnId: 't4', transcript: 'd' })
    await new Promise((r) => setTimeout(r, 300))
    expect(create.mock.calls.length).toBeLessThanOrEqual(2)
    await w.stop()
  })

  it('with cadenceCap=0 (disabled), every push yields a Claude call', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: 'new instr' }] })
    const w = startSlowBrain(mockLog(), fakeSideband(), {
      anthropicClient: { messages: { create } },
      cadenceCap: 0,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'a' })
    w.push({ turnId: 't2', transcript: 'b' })
    await new Promise((r) => setTimeout(r, 200))
    expect(create.mock.calls.length).toBeGreaterThanOrEqual(2)
    await w.stop()
  })
})

describe('startSlowBrain — back-pressure (D-28)', () => {
  it('drops oldest when queue exceeds queueMax and logs backpressure', async () => {
    const create = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((r) =>
            setTimeout(
              () => r({ content: [{ type: 'text', text: 'ok' }] }),
              1000,
            ),
          ),
      )
    const log = mockLog()
    const w = startSlowBrain(log, fakeSideband(), {
      anthropicClient: { messages: { create } },
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

describe('startSlowBrain — graceful degrade (D-27)', () => {
  it('logs slow_brain_degraded on Claude timeout — no throw to hot-path', async () => {
    const create = vi.fn().mockImplementation(
      (_p, opts: { signal?: AbortSignal } = {}) =>
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
      anthropicClient: { messages: { create } },
      timeoutMs: 30,
      cadenceCap: 0,
      pollIntervalMs: 5,
    })
    w.push({ turnId: 't1', transcript: 'x' })
    await new Promise((r) => setTimeout(r, 200))
    const warn = log.warn as ReturnType<typeof vi.fn>
    expect(
      warn.mock.calls.some((c) => c[0]?.event === 'slow_brain_degraded'),
    ).toBe(true)
    await w.stop()
  })

  it('continues processing after a failed turn', async () => {
    let calls = 0
    const create = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return { content: [{ type: 'text', text: 'ok' }] }
    })
    const log = mockLog()
    const w = startSlowBrain(log, fakeSideband(), {
      anthropicClient: { messages: { create } },
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
