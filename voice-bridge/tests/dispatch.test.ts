// voice-bridge/tests/dispatch.test.ts
// Plan 02-11: tests for async dispatchTool (MCP-forward + output-emit + error-handling).
// Old sync-stub tests replaced by async tests with DI mocks.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'
import { dispatchTool } from '../src/tools/dispatch.js'
import { CoreMcpTimeoutError, CoreMcpError } from '../src/core-mcp-client.js'

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

function makeMockWS() {
  return { send: vi.fn() } as unknown as WSType
}

function makeOpts(overrides: {
  callCoreTool?: ReturnType<typeof vi.fn>
  emitFunctionCallOutput?: ReturnType<typeof vi.fn>
  emitResponseCreate?: ReturnType<typeof vi.fn>
  dispatchTimeoutMs?: number
} = {}) {
  return {
    callCoreTool: overrides.callCoreTool ?? vi.fn().mockResolvedValue({ slots: [] }),
    emitFunctionCallOutput: overrides.emitFunctionCallOutput ?? vi.fn().mockReturnValue(true),
    emitResponseCreate: overrides.emitResponseCreate ?? vi.fn().mockReturnValue(true),
    dispatchTimeoutMs: overrides.dispatchTimeoutMs ?? 3000,
    jsonlPath: '/dev/null',
  }
}

describe('tools/dispatch — async MCP-forward (02-11)', () => {
  it('happy-path check_calendar: calls callCoreTool with voice. prefix and emits output + response.create', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const coreResult = { slots: [{ start: '09:00', end: '09:30' }] }
    const callCoreTool = vi.fn().mockResolvedValue(coreResult)
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    await dispatchTool(
      ws,
      'call_1',
      'turn_1',
      'fc_001',
      'check_calendar',
      { date: '2026-05-01', duration_minutes: 30 },
      log,
      opts,
    )

    // Must use voice. prefix
    expect(callCoreTool).toHaveBeenCalledWith(
      'voice.check_calendar',
      { date: '2026-05-01', duration_minutes: 30 },
      expect.objectContaining({ timeoutMs: 3000 }),
    )
    // Must emit function_call_output with correct call_id
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_001',
      coreResult,
      log,
    )
    // Must emit response.create after
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('rejects unknown tool name — emits invalid_tool_call, no callCoreTool', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn()
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    await dispatchTool(ws, 'c2', 't2', 'fc_002', 'unknown_tool_xyz', {}, log, opts)

    expect(callCoreTool).not.toHaveBeenCalled()
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_002',
      expect.objectContaining({ error: 'invalid_tool_call' }),
      log,
    )
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('rejects schema-fail args — emits invalid_tool_call, no callCoreTool', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn()
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    // create_calendar_entry requires title + start + end_time, omitting them
    await dispatchTool(ws, 'c3', 't3', 'fc_003', 'create_calendar_entry', { title: 'x' }, log, opts)

    expect(callCoreTool).not.toHaveBeenCalled()
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_003',
      expect.objectContaining({ error: 'invalid_tool_call' }),
      log,
    )
  })

  it('not_implemented (search_competitors) — emits not_implemented without callCoreTool', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn()
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    await dispatchTool(
      ws,
      'c4',
      't4',
      'fc_004',
      'search_competitors',
      { category: 'physiotherapy', criteria: {} },
      log,
      opts,
    )

    expect(callCoreTool).not.toHaveBeenCalled()
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_004',
      expect.objectContaining({ error: 'not_implemented' }),
      log,
    )
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('CoreMcpTimeoutError — emits tool_timeout', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn().mockRejectedValue(new CoreMcpTimeoutError())
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    await dispatchTool(
      ws,
      'c5',
      't5',
      'fc_005',
      'check_calendar',
      { date: '2026-05-01', duration_minutes: 30 },
      log,
      opts,
    )

    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_005',
      expect.objectContaining({ error: 'tool_timeout' }),
      log,
    )
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('CoreMcpError (HTTP 5xx) — emits tool_unavailable', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn().mockRejectedValue(new CoreMcpError(503, 'service unavailable'))
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    await dispatchTool(
      ws,
      'c6',
      't6',
      'fc_006',
      'get_practice_profile',
      { name: 'Musterpraxis' },
      log,
      opts,
    )

    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_006',
      expect.objectContaining({ error: 'tool_unavailable' }),
      log,
    )
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('generic network error — emits tool_unavailable', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    await dispatchTool(
      ws,
      'c7',
      't7',
      'fc_007',
      'schedule_retry',
      { case_type: 'busy', target_phone: '+491234567890', not_before_ts: '2026-05-01T10:00:00Z' },
      log,
      opts,
    )

    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_007',
      expect.objectContaining({ error: 'tool_unavailable' }),
      log,
    )
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('happy-path ask_core: calls callCoreTool with voice.ask_core prefix (02-12)', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const coreResult = { answer: 'Montag bis Freitag 9-18 Uhr' }
    const callCoreTool = vi.fn().mockResolvedValue(coreResult)
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    await dispatchTool(
      ws,
      'call_ask1',
      'turn_ask1',
      'fc_ask1',
      'ask_core',
      { topic: 'praxis-info', request: 'Was sind eure Oeffnungszeiten?' },
      log,
      opts,
    )

    expect(callCoreTool).toHaveBeenCalledWith(
      'voice.ask_core',
      { topic: 'praxis-info', request: 'Was sind eure Oeffnungszeiten?' },
      expect.objectContaining({ timeoutMs: 3000 }),
    )
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(ws, 'fc_ask1', coreResult, log)
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('happy-path get_travel_time: calls callCoreTool with voice.get_travel_time prefix (02-12)', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const coreResult = { duration_text: '12 Minuten', duration_seconds: 720 }
    const callCoreTool = vi.fn().mockResolvedValue(coreResult)
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    await dispatchTool(
      ws,
      'call_gtt1',
      'turn_gtt1',
      'fc_gtt1',
      'get_travel_time',
      { origin: 'Marienplatz, Munich', destination: 'Schwabing, Munich', mode: 'transit' },
      log,
      opts,
    )

    expect(callCoreTool).toHaveBeenCalledWith(
      'voice.get_travel_time',
      { origin: 'Marienplatz, Munich', destination: 'Schwabing, Munich', mode: 'transit' },
      expect.objectContaining({ timeoutMs: 3000 }),
    )
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(ws, 'fc_gtt1', coreResult, log)
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('JSONL file gets a tool_dispatch_done entry for successful dispatch', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn().mockResolvedValue({ ok: true })
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)

    // Use /tmp for JSONL output in test
    const fs = await import('node:fs/promises')
    const tmpPath = `/tmp/dispatch-test-${Date.now()}.jsonl`
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })
    opts.jsonlPath = tmpPath

    await dispatchTool(
      ws,
      'c8',
      't8',
      'fc_008',
      'get_contract',
      { provider_name: 'AOK' },
      log,
      opts,
    )

    const content = await fs.readFile(tmpPath, 'utf-8')
    const entry = JSON.parse(content.trim().split('\n')[0])
    expect(entry.event).toBe('tool_dispatch_done')
    expect(entry.call_id).toBe('c8')
    expect(entry.function_call_id).toBe('fc_008')
    expect(entry.tool_name).toBe('get_contract')
    expect(entry.mcp_status).toBe('ok')
    expect(typeof entry.latency_ms).toBe('number')
    // PII-safe: no args or result payload
    expect(entry.args).toBeUndefined()
    expect(entry.result).toBeUndefined()

    await fs.unlink(tmpPath)
  })
})
