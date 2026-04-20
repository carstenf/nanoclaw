// voice-bridge/tests/pre-greet.test.ts
// Plan 03-14 / REQ-VOICE-13: Slow-Brain pre-greet injection.
import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'

import { maybeInjectPreGreet } from '../src/pre-greet.js'
import type { SidebandHandle } from '../src/sideband.js'

function makeLog(): Logger {
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

interface FakeWS {
  send: ReturnType<typeof vi.fn>
}

function makeFakeSideband(ready: boolean): { handle: SidebandHandle; ws: FakeWS } {
  const ws: FakeWS = { send: vi.fn() }
  const handle: SidebandHandle = {
    state: {
      callId: 'rtc_test',
      ready,
      ws: ws as unknown as SidebandHandle['state']['ws'],
      openedAt: Date.now(),
      lastUpdateAt: 0,
    },
    close: vi.fn(),
  }
  return { handle, ws }
}

describe('maybeInjectPreGreet (03-14, REQ-VOICE-13)', () => {
  it('happy path: ready sideband + RPC returns instructions → session.update emitted', async () => {
    const { handle, ws } = makeFakeSideband(true)
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      instructions_update: 'TAILORED PERSONA: friendly Carsten greeting',
    })
    const log = makeLog()

    await maybeInjectPreGreet({
      callId: 'rtc_test',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 2000,
      readyWaitMs: 100,
      pollMs: 10,
    })

    expect(callTool).toHaveBeenCalledWith(
      'voice_on_transcript_turn',
      expect.objectContaining({
        call_id: 'rtc_test',
        turn_id: 'pre-greet',
        transcript: '',
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    )
    expect(ws.send).toHaveBeenCalledOnce()
    const sent = JSON.parse((ws.send.mock.calls[0]?.[0] as string) ?? '{}')
    expect(sent.type).toBe('session.update')
    expect(sent.session.instructions).toBe(
      'TAILORED PERSONA: friendly Carsten greeting',
    )
  })

  it('wrapped MCP shape (result.instructions_update) is unwrapped correctly', async () => {
    const { handle, ws } = makeFakeSideband(true)
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      result: { ok: true, instructions_update: 'WRAPPED PERSONA' },
    })
    const log = makeLog()

    await maybeInjectPreGreet({
      callId: 'rtc_w',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 2000,
      readyWaitMs: 100,
    })

    expect(ws.send).toHaveBeenCalledOnce()
    const sent = JSON.parse((ws.send.mock.calls[0]?.[0] as string) ?? '{}')
    expect(sent.session.instructions).toBe('WRAPPED PERSONA')
  })

  it('null instructions_update → skip, no session.update emitted', async () => {
    const { handle, ws } = makeFakeSideband(true)
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      instructions_update: null,
    })
    const log = makeLog()

    await maybeInjectPreGreet({
      callId: 'rtc_n',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 2000,
      readyWaitMs: 100,
    })

    expect(ws.send).not.toHaveBeenCalled()
  })

  it('empty string instructions_update → skip', async () => {
    const { handle, ws } = makeFakeSideband(true)
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      instructions_update: '',
    })
    const log = makeLog()

    await maybeInjectPreGreet({
      callId: 'rtc_e',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 2000,
      readyWaitMs: 100,
    })

    expect(ws.send).not.toHaveBeenCalled()
  })

  it('sideband never ready → skip, no RPC call', async () => {
    const { handle, ws } = makeFakeSideband(false)
    const callTool = vi.fn()
    const log = makeLog()

    await maybeInjectPreGreet({
      callId: 'rtc_nr',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 500,
      readyWaitMs: 100,
      pollMs: 10,
    })

    expect(callTool).not.toHaveBeenCalled()
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('RPC throws (timeout/network) → skip silently, no session.update', async () => {
    const { handle, ws } = makeFakeSideband(true)
    const callTool = vi.fn().mockRejectedValue(new Error('core_timeout'))
    const log = makeLog()

    await maybeInjectPreGreet({
      callId: 'rtc_t',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 500,
      readyWaitMs: 100,
    })

    expect(callTool).toHaveBeenCalled()
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('budget exhausted by ready-wait → skip RPC entirely', async () => {
    const { handle } = makeFakeSideband(false)
    const callTool = vi.fn()
    const log = makeLog()

    // budget=200, readyWait=200 → 200ms spent waiting, remaining ~0 → skip
    await maybeInjectPreGreet({
      callId: 'rtc_b',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 200,
      readyWaitMs: 200,
      pollMs: 20,
    })

    expect(callTool).not.toHaveBeenCalled()
  })

  it('respects budget: passes remaining budget as RPC timeout', async () => {
    const { handle } = makeFakeSideband(true)
    const captured: { timeoutMs?: number } = {}
    const callTool = vi.fn().mockImplementation((_name, _args, o) => {
      captured.timeoutMs = o?.timeoutMs
      return Promise.resolve({ ok: true, instructions_update: null })
    })
    const log = makeLog()

    await maybeInjectPreGreet({
      callId: 'rtc_bud',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 1500,
      readyWaitMs: 50,
    })

    // Should be close to 1500ms (minus a few ms wait time)
    expect(captured.timeoutMs).toBeGreaterThan(1000)
    expect(captured.timeoutMs).toBeLessThanOrEqual(1500)
  })

  it('non-string instructions_update (number/object) → skip', async () => {
    const { handle, ws } = makeFakeSideband(true)
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      instructions_update: 42,
    })
    const log = makeLog()

    await maybeInjectPreGreet({
      callId: 'rtc_x',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 2000,
      readyWaitMs: 100,
    })

    expect(ws.send).not.toHaveBeenCalled()
  })
})
