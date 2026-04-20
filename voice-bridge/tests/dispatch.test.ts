// voice-bridge/tests/dispatch.test.ts
// Plan 02-11: tests for async dispatchTool (MCP-forward + output-emit + error-handling).
// Old sync-stub tests replaced by async tests with DI mocks.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'
import { dispatchTool } from '../src/tools/dispatch.js'
import { CoreMcpTimeoutError, CoreMcpError } from '../src/core-mcp-client.js'
import { clearCall as clearIdempotencyCache } from '../src/idempotency.js'

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
      'voice_check_calendar',
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

  it('not_implemented (search_hotels) — emits not_implemented without callCoreTool (Phase 6 scope)', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn()
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    // Bridge allowlist does not include search_hotels yet — this is an
    // invalid_tool_call at allowlist level, emitting invalid_tool_call not
    // not_implemented. search_hotels is Phase 6 scope; the TOOL_TO_CORE_MCP
    // mapping stays null for it as a sanity-check that other null-mapped
    // tools still short-circuit correctly.
    await dispatchTool(
      ws,
      'c4',
      't4',
      'fc_004',
      'search_hotels',
      { city: 'Munich' },
      log,
      opts,
    )

    expect(callCoreTool).not.toHaveBeenCalled()
    // invalid_tool_call emitted because search_hotels is not in the Bridge
    // allowlist (even though it's in TOOL_TO_CORE_MCP map as null).
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_004',
      expect.objectContaining({ error: 'invalid_tool_call' }),
      log,
    )
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('search_competitors routes to voice_search_competitors (Plan 04-03)', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const coreResult = { ok: false, error: 'not_configured' }
    const callCoreTool = vi.fn().mockResolvedValue(coreResult)
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate })

    await dispatchTool(
      ws,
      'c4sc',
      't4sc',
      'fc_sc',
      'search_competitors',
      { category: 'physiotherapy', criteria: { zip: '80339' } },
      log,
      opts,
    )

    // Core MCP invoked with voice_search_competitors prefix — no longer
    // short-circuited with not_implemented.
    expect(callCoreTool).toHaveBeenCalledWith(
      'voice_search_competitors',
      { category: 'physiotherapy', criteria: { zip: '80339' } },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    )
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_sc',
      coreResult,
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

  it('happy-path ask_core: calls callCoreTool with voice_ask_core prefix (02-12)', async () => {
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
      { topic: 'andy', request: 'Was sind eure Oeffnungszeiten?' },
      log,
      opts,
    )

    expect(callCoreTool).toHaveBeenCalledWith(
      'voice_ask_core',
      { topic: 'andy', request: 'Was sind eure Oeffnungszeiten?' },
      expect.objectContaining({ timeoutMs: 3000 }),
    )
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(ws, 'fc_ask1', coreResult, log)
    expect(emitResponseCreate).toHaveBeenCalledWith(ws, log)
  })

  it('happy-path get_travel_time: calls callCoreTool with voice_get_travel_time prefix (02-12)', async () => {
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
      'voice_get_travel_time',
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

  // --- Plan 02-14: filler-inject DI tests ---

  it('ask_core dispatch: emitFiller called BEFORE callCoreTool (fire-and-forget)', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callOrder: string[] = []
    const callCoreTool = vi.fn().mockImplementation(async () => {
      callOrder.push('callCoreTool')
      return { answer: 'test' }
    })
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const emitFiller = vi.fn().mockImplementation(async () => {
      callOrder.push('emitFiller')
      return true
    })
    const opts = {
      ...makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate }),
      emitFiller,
    }

    await dispatchTool(
      ws,
      'call_f1',
      'turn_f1',
      'fc_f1',
      'ask_core',
      { topic: 'andy', request: 'Was ist 2+2?' },
      log,
      opts,
    )

    expect(emitFiller).toHaveBeenCalledTimes(1)
    expect(emitFiller).toHaveBeenCalledWith(ws, 'ask_core', 'call_f1', log)
    expect(callCoreTool).toHaveBeenCalled()
    // emitFiller was awaited before callCoreTool
    expect(callOrder[0]).toBe('emitFiller')
    expect(callOrder[1]).toBe('callCoreTool')
  })

  it('check_calendar dispatch: emitFiller NOT called for non-filler tool', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn().mockResolvedValue({ slots: [] })
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const emitFiller = vi.fn().mockResolvedValue(true)
    const opts = {
      ...makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate }),
      emitFiller,
    }

    await dispatchTool(
      ws,
      'call_f2',
      'turn_f2',
      'fc_f2',
      'check_calendar',
      { date: '2026-05-01', duration_minutes: 30 },
      log,
      opts,
    )

    expect(emitFiller).not.toHaveBeenCalled()
    expect(callCoreTool).toHaveBeenCalled()
  })

  // -------- Plan 03-13: end_call (bridge-internal hangup) --------

  it('end_call farewell: invokes hangupCall(callId), emits ok output, no MCP, no response.create', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = {
      ...makeOpts({ callCoreTool, emitFunctionCallOutput, emitResponseCreate }),
      hangupCall,
    }

    await dispatchTool(
      ws,
      'rtc_farewell_1',
      'turn_e1',
      'fc_e1',
      'end_call',
      { reason: 'farewell' },
      log,
      opts,
    )

    expect(hangupCall).toHaveBeenCalledWith('rtc_farewell_1')
    expect(callCoreTool).not.toHaveBeenCalled()
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc_e1',
      expect.objectContaining({ ok: true, ended: true, reason: 'farewell' }),
      log,
    )
    // No follow-up response.create — bot must not speak after hangup
    expect(emitResponseCreate).not.toHaveBeenCalled()
  })

  it('end_call silence: invokes hangup with reason=silence', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const opts = { ...makeOpts(), hangupCall }

    await dispatchTool(
      ws,
      'rtc_sil',
      'turn',
      'fc',
      'end_call',
      { reason: 'silence' },
      log,
      opts,
    )

    expect(hangupCall).toHaveBeenCalledOnce()
  })

  it('end_call: rejects unknown reason via schema validation, no hangup', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const hangupCall = vi.fn()
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const opts = {
      ...makeOpts({ emitFunctionCallOutput }),
      hangupCall,
    }

    await dispatchTool(
      ws,
      'rtc',
      'turn',
      'fc',
      'end_call',
      { reason: 'bored' },
      log,
      opts,
    )

    expect(hangupCall).not.toHaveBeenCalled()
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc',
      { error: 'invalid_tool_call' },
      log,
    )
  })

  it('end_call: missing reason rejected', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const hangupCall = vi.fn()
    const opts = { ...makeOpts(), hangupCall }

    await dispatchTool(ws, 'rtc', 'turn', 'fc', 'end_call', {}, log, opts)

    expect(hangupCall).not.toHaveBeenCalled()
  })

  it('end_call: hangup error returns ok:false but does not throw', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const hangupCall = vi.fn().mockRejectedValue(new Error('openai down'))
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const opts = {
      ...makeOpts({ emitFunctionCallOutput }),
      hangupCall,
    }

    await dispatchTool(
      ws,
      'rtc',
      'turn',
      'fc',
      'end_call',
      { reason: 'error' },
      log,
      opts,
    )

    expect(hangupCall).toHaveBeenCalled()
    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc',
      expect.objectContaining({ ok: false, error: 'openai down' }),
      log,
    )
  })

  it('end_call: no hangupCall wired returns ok:false hangup_not_wired', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    // Do NOT pass hangupCall — and clear any module-level callback
    const { setHangupCallback } = await import('../src/tools/dispatch.js')
    setHangupCallback(null)
    const opts = makeOpts({ emitFunctionCallOutput })

    await dispatchTool(
      ws,
      'rtc',
      'turn',
      'fc',
      'end_call',
      { reason: 'farewell' },
      log,
      opts,
    )

    expect(emitFunctionCallOutput).toHaveBeenCalledWith(
      ws,
      'fc',
      expect.objectContaining({ ok: false, error: 'hangup_not_wired' }),
      log,
    )
  })
})

// Plan 04-03 Task 4: smoke tests for Phase-4 TOOLS-01/02/04/05/06/07
// end-to-end dispatch-path — verifies TOOL_TO_CORE_MCP mapping is intact
// through the allowlist + A12-idempotency + dispatch changes.
// The underlying Core handlers are Phase-3 shipped (and TOOLS-05 Plan 04-03
// shipped) — here we only prove the Bridge routes each toolName to the
// correct `voice.<name>` Core target.
describe('tools/dispatch — Phase-4 TOOLS smoke (04-03)', () => {
  beforeEach(() => {
    clearIdempotencyCache('*')
  })

  const cases: Array<{
    toolName: string
    coreName: string
    args: Record<string, unknown>
  }> = [
    {
      toolName: 'check_calendar',
      coreName: 'voice_check_calendar',
      args: { date: '2026-05-01', duration_minutes: 30 },
    },
    {
      toolName: 'create_calendar_entry',
      coreName: 'voice_create_calendar_entry',
      args: {
        title: 'Termin',
        date: '2026-05-01',
        time: '09:00',
        duration: 30,
      },
    },
    {
      toolName: 'get_contract',
      coreName: 'voice_get_contract',
      args: { provider_name: 'Telekom' },
    },
    {
      toolName: 'search_competitors',
      coreName: 'voice_search_competitors',
      args: { category: 'insurance', criteria: { max: 50 } },
    },
    {
      toolName: 'get_practice_profile',
      coreName: 'voice_get_practice_profile',
      args: { name: 'Dr. Schmidt' },
    },
    {
      toolName: 'schedule_retry',
      coreName: 'voice_schedule_retry',
      args: {
        case_type: 'case_2',
        target_phone: '+4915112345678',
        not_before_ts: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  ]

  for (const c of cases) {
    it(`${c.toolName} routes to callCoreTool('${c.coreName}')`, async () => {
      const ws = makeMockWS()
      const log = makeLog()
      const callCoreTool = vi.fn().mockResolvedValue({ ok: true })
      const opts = makeOpts({ callCoreTool })

      await dispatchTool(
        ws,
        `smoke-${c.toolName}`,
        `turn-${c.toolName}`,
        `fc-${c.toolName}`,
        c.toolName,
        c.args,
        log,
        opts,
      )

      expect(callCoreTool).toHaveBeenCalledTimes(1)
      expect(callCoreTool).toHaveBeenCalledWith(
        c.coreName,
        expect.objectContaining(c.args),
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      )
    })
  }
})

// Plan 04-02 Task 1: A12 closure — idempotency for mutating tools in dispatch.
describe('tools/dispatch — A12 idempotency gate (04-02)', () => {
  beforeEach(() => {
    clearIdempotencyCache('*')
  })

  it('A12: wraps mutating tool (create_calendar_entry) via invokeIdempotent — second identical (call,turn,tool,args) hits cache', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi
      .fn()
      .mockResolvedValue({ ok: true, id: 'evt_1' })
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({
      callCoreTool,
      emitFunctionCallOutput,
      emitResponseCreate,
    })

    const args = {
      title: 'Termin',
      date: '2026-05-01',
      time: '09:00',
      duration: 30,
    }

    await dispatchTool(ws, 'c1', 't1', 'fc1', 'create_calendar_entry', args, log, opts)
    await dispatchTool(ws, 'c1', 't1', 'fc2', 'create_calendar_entry', args, log, opts)

    // Core MCP invoked exactly once for identical (call,turn,tool,args)
    expect(callCoreTool).toHaveBeenCalledTimes(1)
    // Both dispatches still emit a function_call_output (second from cached result)
    expect(emitFunctionCallOutput).toHaveBeenCalledTimes(2)
    expect(emitResponseCreate).toHaveBeenCalledTimes(2)
    // idempotency_hit logged on second call
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    const hit = infoCalls.find((c) => c[0]?.event === 'idempotency_hit')
    expect(hit).toBeDefined()
  })

  it('A12: does NOT wrap read-only tool (check_calendar) — two identical calls hit core twice', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi.fn().mockResolvedValue({ ok: true, slots: [] })
    const emitFunctionCallOutput = vi.fn().mockReturnValue(true)
    const emitResponseCreate = vi.fn().mockReturnValue(true)
    const opts = makeOpts({
      callCoreTool,
      emitFunctionCallOutput,
      emitResponseCreate,
    })

    const args = { date: '2026-05-01', duration_minutes: 30 }

    await dispatchTool(ws, 'c2', 't1', 'fc1', 'check_calendar', args, log, opts)
    await dispatchTool(ws, 'c2', 't1', 'fc2', 'check_calendar', args, log, opts)

    // Read-only tools bypass idempotency cache — each call hits Core
    expect(callCoreTool).toHaveBeenCalledTimes(2)
  })

  it('A12: different args for same mutating tool = separate Core invocations (no collision)', async () => {
    const ws = makeMockWS()
    const log = makeLog()
    const callCoreTool = vi
      .fn()
      .mockResolvedValue({ ok: true, id: 'evt_x' })
    const opts = makeOpts({ callCoreTool })

    await dispatchTool(
      ws,
      'c3',
      't1',
      'fc1',
      'create_calendar_entry',
      {
        title: 'Termin A',
        date: '2026-05-01',
        time: '09:00',
        duration: 30,
      },
      log,
      opts,
    )
    await dispatchTool(
      ws,
      'c3',
      't1',
      'fc2',
      'create_calendar_entry',
      {
        title: 'Termin B',
        date: '2026-05-02',
        time: '09:00',
        duration: 30,
      },
      log,
      opts,
    )

    expect(callCoreTool).toHaveBeenCalledTimes(2)
  })
})
