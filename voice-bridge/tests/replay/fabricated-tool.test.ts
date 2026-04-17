import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'
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

describe('SC-2 B — fabricated / invalid tool rejected gracefully', () => {
  it('unknown tool name returns synthetic tool_error + logs unknown_name', () => {
    const log = mockLog()
    const r = dispatchTool('replay', 't1', 'foo_bar_not_real', {}, log)
    expect(r).toMatchObject({ type: 'tool_error', code: 'invalid_tool_call' })
    const warn = log.warn as ReturnType<typeof vi.fn>
    expect(
      warn.mock.calls.some(
        (c) =>
          c[0]?.event === 'invalid_tool_call' &&
          c[0]?.reason === 'unknown_name',
      ),
    ).toBe(true)
  })

  it('known tool with schema-invalid args returns synthetic tool_error + logs schema_fail', () => {
    const log = mockLog()
    // create_calendar_entry missing required "title"
    const r = dispatchTool(
      'replay',
      't2',
      'create_calendar_entry',
      { date: '2026-05-23', time: '14:30', duration: 30 },
      log,
    )
    expect(r).toMatchObject({ type: 'tool_error', code: 'invalid_tool_call' })
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
