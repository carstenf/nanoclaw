// voice-bridge/tests/replay/fabricated-tool.test.ts
// SC-2B: fabricated/invalid tool rejected gracefully.
// Updated for 02-11 async dispatchTool API — verifies invalid_tool_call is
// emitted as function_call_output payload via mocked WS, not returned sync.
import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'
import { dispatchTool } from '../../src/tools/dispatch.js'

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

function makeMockWS() {
  return { send: vi.fn() } as unknown as WSType
}

function makeOpts(overrides: {
  callCoreTool?: ReturnType<typeof vi.fn>
} = {}) {
  return {
    callCoreTool: overrides.callCoreTool ?? vi.fn(),
    emitFunctionCallOutput: vi.fn().mockReturnValue(true),
    emitResponseCreate: vi.fn().mockReturnValue(true),
    jsonlPath: '/dev/null',
  }
}

describe('SC-2 B — fabricated / invalid tool rejected gracefully', () => {
  it('unknown tool name returns synthetic tool_error + logs unknown_name', async () => {
    const log = mockLog()
    const ws = makeMockWS()
    const callCoreTool = vi.fn()
    const opts = makeOpts({ callCoreTool })

    await dispatchTool(ws, 'replay', 't1', 'fc_bad_1', 'foo_bar_not_real', {}, log, opts)

    // callCoreTool must NOT be called
    expect(callCoreTool).not.toHaveBeenCalled()
    // invalid_tool_call must be emitted
    expect(opts.emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_bad_1',
      expect.objectContaining({ error: 'invalid_tool_call' }),
      log,
    )
    const warn = log.warn as ReturnType<typeof vi.fn>
    expect(
      warn.mock.calls.some(
        (c) =>
          c[0]?.event === 'invalid_tool_call' &&
          c[0]?.reason === 'unknown_name',
      ),
    ).toBe(true)
  })

  it('known tool with schema-invalid args returns synthetic tool_error + logs schema_fail', async () => {
    const log = mockLog()
    const ws = makeMockWS()
    const callCoreTool = vi.fn()
    const opts = makeOpts({ callCoreTool })

    // create_calendar_entry missing required fields
    await dispatchTool(
      ws,
      'replay',
      't2',
      'fc_bad_2',
      'create_calendar_entry',
      { date: '2026-05-23', time: '14:30', duration: 30 },
      log,
      opts,
    )

    expect(callCoreTool).not.toHaveBeenCalled()
    expect(opts.emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_bad_2',
      expect.objectContaining({ error: 'invalid_tool_call' }),
      log,
    )
    const warn = log.warn as ReturnType<typeof vi.fn>
    expect(
      warn.mock.calls.some(
        (c) =>
          c[0]?.event === 'invalid_tool_call' &&
          c[0]?.reason === 'schema_fail',
      ),
    ).toBe(true)
  })
})
