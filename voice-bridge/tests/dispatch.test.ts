import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'
import { dispatchTool } from '../src/tools/dispatch.js'

function makeLog() {
  const warn = vi.fn()
  const log = {
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: 'info',
  } as unknown as Logger
  return { log, warn }
}

describe('tools/dispatch — MCP-proxy gate (D-09, D-36)', () => {
  it('rejects fabricated tool name with synthetic tool_error + JSONL log (T-02-01-01)', () => {
    const { log, warn } = makeLog()
    const result = dispatchTool('call_1', 'turn_1', 'foo_bar_drop_db', {}, log)
    expect(result).toEqual({
      type: 'tool_error',
      message: 'Das kann ich gerade leider nicht nachsehen.',
      code: 'invalid_tool_call',
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'invalid_tool_call',
        call_id: 'call_1',
        turn_id: 'turn_1',
        tool_name: 'foo_bar_drop_db',
        reason: 'unknown_name',
      }),
    )
  })

  it('rejects schema-fail args with synthetic tool_error (T-02-01-02)', () => {
    const { log, warn } = makeLog()
    const result = dispatchTool(
      'call_2',
      'turn_3',
      'create_calendar_entry',
      { title: 'x' },
      log,
    )
    expect(result.type).toBe('tool_error')
    if (result.type === 'tool_error') {
      expect(result.code).toBe('invalid_tool_call')
    }
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'invalid_tool_call',
        call_id: 'call_2',
        turn_id: 'turn_3',
        tool_name: 'create_calendar_entry',
        reason: 'schema_fail',
      }),
    )
  })

  it('accepts valid args and returns accepted-stub (D-36 forward placeholder)', () => {
    const { log, warn } = makeLog()
    const result = dispatchTool(
      'call_3',
      'turn_7',
      'check_calendar',
      { date: '2026-05-01', duration_minutes: 30 },
      log,
    )
    expect(result).toEqual({
      type: 'tool_call_accepted',
      tool_name: 'check_calendar',
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('accepts valid confirm_action args (C6-03 readback anchor)', () => {
    const { log } = makeLog()
    const result = dispatchTool(
      'call_4',
      'turn_1',
      'confirm_action',
      { action_id: 'evt-123', confirmed: true },
      log,
    )
    expect(result.type).toBe('tool_call_accepted')
  })

  it('rejects additionalProperties injection on otherwise-valid args', () => {
    const { log } = makeLog()
    const result = dispatchTool(
      'call_5',
      'turn_1',
      'send_discord_message',
      { channel: 'alerts', content: 'hi', stealth: 'payload' },
      log,
    )
    expect(result.type).toBe('tool_error')
  })
})
