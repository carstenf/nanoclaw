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

// --- Plan 05-03 Task 3: Case-2 pre-greet bypass ---
import type { OutboundTask } from '../src/outbound-router.js'

function makeFakeOutboundRouter(task: OutboundTask | null) {
  return {
    getActiveTask: vi.fn().mockReturnValue(task),
    bindOpenaiCallId: vi.fn(),
    onCallEnd: vi.fn(),
    getState: vi.fn().mockReturnValue([]),
    taskIdForOpenaiCallId: vi.fn().mockReturnValue(null),
    buildPersonaForTask: vi.fn().mockReturnValue(null),
    enqueue: vi.fn(),
  }
}

describe('maybeInjectPreGreet — Case-2 bypass (Plan 05-03 Task 3)', () => {
  it('pre-greet-test 1: case_type=case_2 → returns immediately with pre_greet_skipped log', async () => {
    const { handle, ws } = makeFakeSideband(true)
    const callTool = vi.fn()
    const log = makeLog()
    const task: OutboundTask = {
      task_id: 'task-c2',
      target_phone: '+49123456',
      goal: 'test',
      context: 'test',
      report_to_jid: 'jid@test',
      created_at: Date.now(),
      status: 'active',
      case_type: 'case_2',
    }
    const outboundRouter = makeFakeOutboundRouter(task)

    await maybeInjectPreGreet({
      callId: 'rtc_c2',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 2000,
      readyWaitMs: 100,
      outboundRouter: outboundRouter as never,
    })

    // Should NOT call Core MCP (early return)
    expect(callTool).not.toHaveBeenCalled()
    expect(ws.send).not.toHaveBeenCalled()
    // Should log pre_greet_skipped with reason case_2_amd_branch
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'pre_greet_skipped',
        reason: 'case_2_amd_branch',
      }),
    )
  })

  it('pre-greet-test 2: case_type undefined (Case-6b) → existing Slow-Brain path runs', async () => {
    const { handle, ws } = makeFakeSideband(true)
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      instructions_update: 'CASE6B TAILORED',
    })
    const log = makeLog()
    // No outboundRouter — simulates legacy path
    await maybeInjectPreGreet({
      callId: 'rtc_6b',
      sideband: handle,
      coreClient: { callTool },
      log,
      budgetMs: 2000,
      readyWaitMs: 100,
      outboundRouter: undefined,
    })

    // Core MCP SHOULD be called (normal pre-greet path)
    expect(callTool).toHaveBeenCalled()
    // session.update SHOULD be sent
    expect(ws.send).toHaveBeenCalledOnce()
  })
})
