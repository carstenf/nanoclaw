import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'
import { openSidebandSession, updateInstructions } from '../src/sideband.js'
import type { SidebandState } from '../src/sideband.js'

class MockWS extends EventEmitter {
  readyState = 0
  sent: string[] = []
  send(s: string): void {
    this.sent.push(s)
  }
  close(_code?: number): void {
    this.readyState = 3
    this.emit('close')
  }
  simulateOpen(): void {
    this.readyState = 1
    this.emit('open')
  }
}

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

describe('openSidebandSession — connect SLA + degrade', () => {
  beforeEach(() => {
    process.env.OPENAI_SIP_API_KEY = 'sk-test-sideband'
  })
  afterEach(() => {
    delete process.env.OPENAI_SIP_API_KEY
  })

  it('logs sideband_ready when WS opens before SLA', () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-1', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()
    expect(handle.state.ready).toBe(true)
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(infoCalls.some((c) => c[0]?.event === 'sideband_ready')).toBe(true)
    handle.close()
  })

  it('logs sideband_timeout when WS stays silent past SLA', async () => {
    vi.useFakeTimers()
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-1', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    await vi.advanceTimersByTimeAsync(1600)
    expect(handle.state.ready).toBe(false)
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(warnCalls.some((c) => c[0]?.event === 'sideband_timeout')).toBe(true)
    handle.close()
    vi.useRealTimers()
  })

  it('passes Authorization + OpenAI-Beta headers to wsFactory', () => {
    const ws = new MockWS()
    const log = mockLog()
    const seen: Record<string, string> = {}
    openSidebandSession('rtc-1', log, {
      wsFactory: (_url, headers) => {
        Object.assign(seen, headers)
        return ws as unknown as WSType
      },
    })
    expect(seen.Authorization).toBe('Bearer sk-test-sideband')
    expect(seen['OpenAI-Beta']).toBe('realtime=v1')
  })

  it('invokes onClose with callId when the WS closes (authoritative call-end)', () => {
    const ws = new MockWS()
    const log = mockLog()
    const onClose = vi.fn()
    const handle = openSidebandSession('rtc-close', log, {
      wsFactory: () => ws as unknown as WSType,
      onClose,
    })
    ws.simulateOpen()
    ws.close() // triggers 'close' event
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith('rtc-close')
    expect(handle.state.ready).toBe(false)
  })

  it('swallows onClose handler errors (hot-path continuity)', () => {
    const ws = new MockWS()
    const log = mockLog()
    const onClose = vi.fn().mockImplementation(() => {
      throw new Error('handler boom')
    })
    openSidebandSession('rtc-x', log, {
      wsFactory: () => ws as unknown as WSType,
      onClose,
    })
    ws.close()
    expect(onClose).toHaveBeenCalled()
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(
      warnCalls.some(
        (c) => c[0]?.event === 'sideband_onclose_handler_failed',
      ),
    ).toBe(true)
  })
})

describe('updateInstructions — D-26 tools-strip guard', () => {
  function openState(): SidebandState {
    const ws = new MockWS()
    ws.readyState = 1
    return {
      callId: 'c',
      ready: true,
      ws: ws as unknown as WSType,
      openedAt: 0,
      lastUpdateAt: 0,
    }
  }

  it('sends instructions-only session.update after ready', () => {
    const state = openState()
    const mock = state.ws as unknown as MockWS
    const log = mockLog()
    updateInstructions(state, 'neue instruction', log)
    expect(mock.sent).toHaveLength(1)
    const msg = JSON.parse(mock.sent[0])
    expect(msg.type).toBe('session.update')
    expect(msg.session.instructions).toBe('neue instruction')
    expect(msg.session.tools).toBeUndefined()
  })

  it('strips tools field and logs BUG-level', () => {
    const state = openState()
    const mock = state.ws as unknown as MockWS
    const log = mockLog()
    updateInstructions(state, 'foo', log, { tools: [{ name: 'leak' }] })
    expect(mock.sent).toHaveLength(1)
    const msg = JSON.parse(mock.sent[0])
    expect(msg.session.tools).toBeUndefined()
    const errCalls = (log.error as ReturnType<typeof vi.fn>).mock.calls
    expect(
      errCalls.some(
        (c) => c[0]?.event === 'slow_brain_tools_field_stripped_BUG',
      ),
    ).toBe(true)
  })

  it('skips send when state.ready is false', () => {
    const state = openState()
    state.ready = false
    const mock = state.ws as unknown as MockWS
    const log = mockLog()
    const sent = updateInstructions(state, 'x', log)
    expect(sent).toBe(false)
    expect(mock.sent).toHaveLength(0)
  })
})

// Plan 05.1-01 Task 1: session.type='realtime' discriminator (defect #6 L1)
// + error-event handler (Pitfall 2 observability).
// Without session.type, OpenAI Realtime GA 2026 rejects session.update with
// invalid_request_error and the persona swap never lands (defect #6 root cause).
// See .planning/phases/05.1-amd-persona-handoff-redesign-and-asr-upgrade/05.1-RESEARCH.md §2.4 §2.6 §8.
describe('updateInstructions session.type discriminator (defect #6 L1)', () => {
  function openState(): SidebandState {
    const ws = new MockWS()
    ws.readyState = 1
    return {
      callId: 'c-type',
      ready: true,
      ws: ws as unknown as WSType,
      openedAt: 0,
      lastUpdateAt: 0,
    }
  }

  it('Test A: session.update payload includes session.type="realtime"', () => {
    const state = openState()
    const mock = state.ws as unknown as MockWS
    const log = mockLog()
    updateInstructions(state, 'new persona', log)
    expect(mock.sent).toHaveLength(1)
    const msg = JSON.parse(mock.sent[0])
    expect(msg).toEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: 'new persona',
      },
    })
  })

  it('Test B: extraSession merges with type:"realtime" without losing either field', () => {
    const state = openState()
    const mock = state.ws as unknown as MockWS
    const log = mockLog()
    updateInstructions(state, 'persona+voice', log, { voice: 'cedar' })
    expect(mock.sent).toHaveLength(1)
    const msg = JSON.parse(mock.sent[0])
    expect(msg.type).toBe('session.update')
    expect(msg.session.type).toBe('realtime')
    expect(msg.session.voice).toBe('cedar')
    expect(msg.session.instructions).toBe('persona+voice')
  })

  it('Test C (regression guard): no session.update is ever sent without session.type', () => {
    // Simulate multiple updateInstructions calls across a call lifecycle
    const state = openState()
    const mock = state.ws as unknown as MockWS
    const log = mockLog()
    updateInstructions(state, 'persona 1', log)
    updateInstructions(state, 'persona 2', log, { voice: 'cedar' })
    updateInstructions(state, 'persona 3 — farewell', log)
    expect(mock.sent.length).toBeGreaterThan(0)
    mock.sent.forEach((raw) => {
      const parsed = JSON.parse(raw)
      if (parsed.type === 'session.update') {
        expect(parsed.session?.type).toBe('realtime')
      }
    })
  })
})

describe('openSidebandSession — error-event handler (Pitfall 2 observability)', () => {
  beforeEach(() => {
    process.env.OPENAI_SIP_API_KEY = 'sk-test-sideband'
  })
  afterEach(() => {
    delete process.env.OPENAI_SIP_API_KEY
  })

  it('Test D: WS error event logs session_update_rejected with code, message, param, openai_event_id', () => {
    const ws = new MockWS()
    const log = mockLog()
    openSidebandSession('rtc-err-1', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()
    ws.emit(
      'message',
      JSON.stringify({
        type: 'error',
        event_id: 'evt_x',
        error: {
          type: 'invalid_request_error',
          code: 'missing_required_parameter',
          message: "Missing required parameter: 'session.type'.",
          param: 'session.type',
        },
      }),
    )
    const errorCalls = (log.error as ReturnType<typeof vi.fn>).mock.calls
    const match = errorCalls.find(
      (c) => c[0]?.event === 'session_update_rejected',
    )
    expect(match).toBeDefined()
    expect(match?.[0]?.code).toBe('missing_required_parameter')
    expect(match?.[0]?.message).toContain('session.type')
    expect(match?.[0]?.param).toBe('session.type')
    expect(match?.[0]?.openai_event_id).toBe('evt_x')
    expect(match?.[0]?.call_id).toBe('rtc-err-1')
  })

  it('Test E: non-error WS messages (response.done) do NOT trigger session_update_rejected', () => {
    const ws = new MockWS()
    const log = mockLog()
    openSidebandSession('rtc-err-2', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()
    ws.emit('message', JSON.stringify({ type: 'response.done', response: {} }))
    ws.emit('message', JSON.stringify({ type: 'session.created' }))
    const errorCalls = (log.error as ReturnType<typeof vi.fn>).mock.calls
    expect(
      errorCalls.some((c) => c[0]?.event === 'session_update_rejected'),
    ).toBe(false)
  })
})

describe('openSidebandSession — onTranscriptTurn (02-10)', () => {
  beforeEach(() => {
    process.env.OPENAI_SIP_API_KEY = 'sk-test-sideband'
  })
  afterEach(() => {
    delete process.env.OPENAI_SIP_API_KEY
  })

  it('user-transcription-completed event triggers onTranscriptTurn with item_id + transcript', () => {
    const ws = new MockWS()
    const log = mockLog()
    const onTranscriptTurn = vi.fn()
    openSidebandSession('rtc-10', log, {
      wsFactory: () => ws as unknown as WSType,
      onTranscriptTurn,
    })
    ws.simulateOpen()
    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_abc',
        content_index: 0,
        transcript: 'hallo ich moechte einen termin',
      }),
    )
    expect(onTranscriptTurn).toHaveBeenCalledTimes(1)
    expect(onTranscriptTurn).toHaveBeenCalledWith(
      'item_abc',
      'hallo ich moechte einen termin',
    )
  })

  it('transcription.delta event does NOT trigger onTranscriptTurn', () => {
    const ws = new MockWS()
    const log = mockLog()
    const onTranscriptTurn = vi.fn()
    openSidebandSession('rtc-11', log, {
      wsFactory: () => ws as unknown as WSType,
      onTranscriptTurn,
    })
    ws.simulateOpen()
    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_abc',
        delta: 'hal',
      }),
    )
    expect(onTranscriptTurn).not.toHaveBeenCalled()
  })

  it('other event types (response.done, session.created, ...) are silently ignored', () => {
    const ws = new MockWS()
    const log = mockLog()
    const onTranscriptTurn = vi.fn()
    openSidebandSession('rtc-12', log, {
      wsFactory: () => ws as unknown as WSType,
      onTranscriptTurn,
    })
    ws.simulateOpen()
    ws.emit('message', JSON.stringify({ type: 'response.done' }))
    ws.emit('message', JSON.stringify({ type: 'session.created' }))
    ws.emit('message', JSON.stringify({ type: 'error', error: { code: 'x' } }))
    expect(onTranscriptTurn).not.toHaveBeenCalled()
    // No parse-warn either — those are valid JSON and known non-triggers.
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('broken JSON message logs sideband_message_parse_failed and does not throw', () => {
    const ws = new MockWS()
    const log = mockLog()
    const onTranscriptTurn = vi.fn()
    openSidebandSession('rtc-13', log, {
      wsFactory: () => ws as unknown as WSType,
      onTranscriptTurn,
    })
    ws.simulateOpen()
    // Should NOT throw — the test framework would catch an unhandled throw
    ws.emit('message', '{not valid json')
    expect(onTranscriptTurn).not.toHaveBeenCalled()
    const warn = log.warn as ReturnType<typeof vi.fn>
    expect(
      warn.mock.calls.some(
        (c) => c[0]?.event === 'sideband_message_parse_failed',
      ),
    ).toBe(true)
  })

  it('Buffer-typed message is decoded to utf-8 before parsing', () => {
    const ws = new MockWS()
    const log = mockLog()
    const onTranscriptTurn = vi.fn()
    openSidebandSession('rtc-14', log, {
      wsFactory: () => ws as unknown as WSType,
      onTranscriptTurn,
    })
    ws.simulateOpen()
    const buf = Buffer.from(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_utf8',
        transcript: 'gruess gott',
      }),
      'utf-8',
    )
    ws.emit('message', buf)
    expect(onTranscriptTurn).toHaveBeenCalledWith('item_utf8', 'gruess gott')
  })

  it('missing onTranscriptTurn opt is a clean no-op (no throw)', () => {
    const ws = new MockWS()
    const log = mockLog()
    openSidebandSession('rtc-15', log, {
      wsFactory: () => ws as unknown as WSType,
      // No onTranscriptTurn
    })
    ws.simulateOpen()
    ws.emit(
      'message',
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_none',
        transcript: 'hi',
      }),
    )
    // Just verify no throw — covered by test not failing.
    expect(true).toBe(true)
  })
})

describe('openSidebandSession — function_call_arguments.done handler (02-11)', () => {
  beforeEach(() => {
    process.env.OPENAI_SIP_API_KEY = 'sk-test-sideband'
  })
  afterEach(() => {
    delete process.env.OPENAI_SIP_API_KEY
  })

  it('function_call_arguments.done fires dispatchTool fire-and-forget with parsed args', async () => {
    const ws = new MockWS()
    const log = mockLog()
    const dispatchTool = vi.fn().mockResolvedValue(undefined)

    openSidebandSession('rtc-fc-1', log, {
      wsFactory: () => ws as unknown as WSType,
      dispatchTool,
    })
    ws.simulateOpen()
    ws.emit(
      'message',
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        response_id: 'resp_abc',
        item_id: 'fc_xyz',
        call_id: 'call_abc',
        name: 'check_calendar',
        arguments: JSON.stringify({ date: '2026-05-01', duration_minutes: 30 }),
      }),
    )

    // Fire-and-forget: handler returns immediately, dispatch runs async.
    // Yield the microtask queue so the promise resolves.
    await new Promise((r) => setImmediate(r))

    expect(dispatchTool).toHaveBeenCalledTimes(1)
    const [_ws, _callId, _turnId, functionCallId, toolName, parsedArgs] =
      dispatchTool.mock.calls[0]
    expect(functionCallId).toBe('call_abc')
    expect(toolName).toBe('check_calendar')
    expect(parsedArgs).toEqual({ date: '2026-05-01', duration_minutes: 30 })
  })

  it('malformed arguments JSON emits invalid_arguments error directly without dispatching', async () => {
    const ws = new MockWS()
    ws.readyState = 1
    const log = mockLog()
    const dispatchTool = vi.fn()

    openSidebandSession('rtc-fc-2', log, {
      wsFactory: () => ws as unknown as WSType,
      dispatchTool,
    })
    ws.simulateOpen()
    ws.emit(
      'message',
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call_bad',
        name: 'check_calendar',
        arguments: '{not valid json',
      }),
    )

    await new Promise((r) => setImmediate(r))

    // dispatchTool must NOT be called
    expect(dispatchTool).not.toHaveBeenCalled()
    // A send with invalid_arguments error must have been emitted
    const sent = ws.sent
    expect(sent.length).toBeGreaterThanOrEqual(1)
    const outputMsg = sent.find((s) => {
      try {
        const p = JSON.parse(s)
        return p.item?.type === 'function_call_output'
      } catch {
        return false
      }
    })
    expect(outputMsg).toBeDefined()
    if (outputMsg) {
      const parsed = JSON.parse(outputMsg)
      const output = JSON.parse(parsed.item.output as string)
      expect(output.error).toBe('invalid_arguments')
    }
  })

  it('truncated args.done from a CANCELLED response is silently skipped (no invalid_arguments emitted)', async () => {
    // Live-observed scenario (2026-04-27 rtc_u1_DZLyfuu6...): OpenAI Realtime
    // emits args.done with whatever was streamed before a response was
    // cancelled (truncated JSON like `{  \n  "`), then sends response.done
    // with status="cancelled" ~4 ms later. Without cancellation tracking
    // the bridge interprets the truncated args as a malformed function_call
    // and emits `error: invalid_arguments`, which the bot synthesises into
    // an "Andy nicht erreichbar" turn even though the original (in-flight)
    // tool call would have answered fine.
    const ws = new MockWS()
    ws.readyState = 1
    const log = mockLog()
    const dispatchTool = vi.fn()

    openSidebandSession('rtc-fc-cancel', log, {
      wsFactory: () => ws as unknown as WSType,
      dispatchTool,
    })
    ws.simulateOpen()
    // 1. args.done arrives with truncated JSON (same shape as live-observed)
    ws.emit(
      'message',
      JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call_cancelled_xyz',
        name: 'ask_core',
        arguments: '{  \n  "',
      }),
    )
    // 2. response.done with status="cancelled" arrives shortly after,
    //    listing the function_call in its output so the bridge can map
    //    the call_id to the cancellation. Our handler defers the parse
    //    error emit by setImmediate so this event lands first.
    ws.emit(
      'message',
      JSON.stringify({
        type: 'response.done',
        response: {
          status: 'cancelled',
          output: [
            {
              type: 'function_call',
              call_id: 'call_cancelled_xyz',
              name: 'ask_core',
            },
          ],
        },
      }),
    )

    // Flush both microtasks and the setImmediate queue.
    await new Promise((r) => setImmediate(r))

    // dispatchTool must NOT be called for the truncated/cancelled call.
    expect(dispatchTool).not.toHaveBeenCalled()
    // No function_call_output with `invalid_arguments` must have been
    // emitted — that's the whole point of the cancellation skip.
    const sent = ws.sent
    const errorOutput = sent.find((s) => {
      try {
        const p = JSON.parse(s)
        if (p.item?.type !== 'function_call_output') return false
        const out =
          typeof p.item.output === 'string' ? JSON.parse(p.item.output) : null
        return out?.error === 'invalid_arguments'
      } catch {
        return false
      }
    })
    expect(errorOutput).toBeUndefined()
  })

  it('unknown event types (e.g. response.done) are still silently ignored when dispatchTool is set', () => {
    const ws = new MockWS()
    const log = mockLog()
    const dispatchTool = vi.fn()
    const onTranscriptTurn = vi.fn()

    openSidebandSession('rtc-fc-3', log, {
      wsFactory: () => ws as unknown as WSType,
      dispatchTool,
      onTranscriptTurn,
    })
    ws.simulateOpen()
    ws.emit('message', JSON.stringify({ type: 'response.done', response: {} }))
    ws.emit('message', JSON.stringify({ type: 'session.created' }))

    expect(dispatchTool).not.toHaveBeenCalled()
    expect(onTranscriptTurn).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })
})

// Plan 04-02 Task 3: response.done → cost accumulator + voice_record_turn_cost
// + 80% soft-warn + 100% hard-stop (instructions-only farewell + ws.close).
describe('openSidebandSession — response.done cost hook (04-02 Task 3)', () => {
  beforeEach(() => {
    process.env.OPENAI_SIP_API_KEY = 'sk-test-sideband'
  })
  afterEach(() => {
    delete process.env.OPENAI_SIP_API_KEY
  })

  function makeMockAccumulator(initTotal = 0) {
    const s = { total: initTotal, warned: false, enforced: false }
    return {
      add: vi.fn((_callId: string, _turnId: string, _u: unknown, cost: number) => {
        s.total += cost
      }),
      totalEur: vi.fn(() => s.total),
      warned: vi.fn(() => s.warned),
      enforced: vi.fn(() => s.enforced),
      markWarned: vi.fn(() => {
        s.warned = true
      }),
      markEnforced: vi.fn(() => {
        s.enforced = true
      }),
      clearCall: vi.fn(),
      costOfResponseDone: vi.fn((evt: { _cost_eur?: number }) => evt._cost_eur ?? 0),
      _state: s,
    }
  }

  function mkResponseDone(costEur: number, responseId = 'resp_1') {
    return JSON.stringify({
      type: 'response.done',
      // test hook: our mock costOfResponseDone reads this directly
      _cost_eur: costEur,
      response: {
        id: responseId,
        usage: {
          input_token_details: { audio_tokens: 100, cached_tokens: 0, text_tokens: 0 },
          output_token_details: { audio_tokens: 50, text_tokens: 0 },
        },
      },
    })
  }

  it('accumulates cost on response.done and fires voice_record_turn_cost (INFRA-06 live)', async () => {
    const ws = new MockWS()
    const log = mockLog()
    const acc = makeMockAccumulator()
    const callNanoclawTool = vi.fn().mockResolvedValue({ ok: true })
    const sendDiscordAlert = vi.fn().mockResolvedValue(undefined)
    openSidebandSession('rtc-cost-1', log, {
      wsFactory: () => ws as unknown as WSType,
      costAccumulator: acc,
      callNanoclawTool,
      sendDiscordAlert,
      capPerCallEur: 1.0,
      softWarnFraction: 0.8,
    })
    ws.simulateOpen()
    ws.emit('message', mkResponseDone(0.1, 'resp_a'))

    // accumulator.add invoked once with cost=0.1
    expect(acc.add).toHaveBeenCalledTimes(1)
    const addCall = acc.add.mock.calls[0]
    expect(addCall[0]).toBe('rtc-cost-1')
    expect(addCall[1]).toBe('resp_a')
    expect(addCall[3]).toBeCloseTo(0.1, 5)

    await new Promise((r) => setImmediate(r))
    // Core record_turn_cost fire-and-forget
    expect(callNanoclawTool).toHaveBeenCalledWith(
      'voice_record_turn_cost',
      expect.objectContaining({
        call_id: 'rtc-cost-1',
        turn_id: 'resp_a',
        cost_eur: expect.any(Number),
      }),
      expect.objectContaining({ timeoutMs: 3000 }),
    )
    // Below soft-warn: no Discord alert
    expect(sendDiscordAlert).not.toHaveBeenCalled()
    // No hard-stop log
    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(warnCalls.some((c) => c[0]?.event === 'cost_hard_stop')).toBe(false)
  })

  it('fires soft-warn Discord alert ONCE at 80% (Pitfall 2 — guard flag)', async () => {
    const ws = new MockWS()
    const log = mockLog()
    const acc = makeMockAccumulator()
    const callNanoclawTool = vi.fn().mockResolvedValue({ ok: true })
    const sendDiscordAlert = vi.fn().mockResolvedValue(undefined)
    openSidebandSession('rtc-warn', log, {
      wsFactory: () => ws as unknown as WSType,
      costAccumulator: acc,
      callNanoclawTool,
      sendDiscordAlert,
      capPerCallEur: 1.0,
      softWarnFraction: 0.8,
    })
    ws.simulateOpen()

    // Three response.done events at 0.3 each → cumulative 0.3, 0.6, 0.9
    // Crossing 0.8 threshold on the 3rd event (totalEur just reads s.total)
    ws.emit('message', mkResponseDone(0.3))
    ws.emit('message', mkResponseDone(0.3))
    ws.emit('message', mkResponseDone(0.3))
    // 4th event still above threshold but markWarned was set → no double-fire
    ws.emit('message', mkResponseDone(0.01))

    await new Promise((r) => setImmediate(r))

    // Discord soft-warn fired exactly once
    const warnMessages = sendDiscordAlert.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('80%'))
    expect(warnMessages.length).toBe(1)
    expect(warnMessages[0]).toContain('⚠')
    expect(acc.markWarned).toHaveBeenCalledTimes(1)
  })

  it('fires hard-stop at 100% — instructions-only session.update + response.create + ws.close after hold', async () => {
    const ws = new MockWS()
    ws.readyState = 1
    const log = mockLog()
    const acc = makeMockAccumulator()
    const callNanoclawTool = vi.fn().mockResolvedValue({ ok: true })
    const sendDiscordAlert = vi.fn().mockResolvedValue(undefined)
    const setTimeoutFn = vi.fn((fn: () => void, _ms: number) => {
      fn()
      return 0
    })
    openSidebandSession('rtc-stop', log, {
      wsFactory: () => ws as unknown as WSType,
      costAccumulator: acc,
      callNanoclawTool,
      sendDiscordAlert,
      capPerCallEur: 1.0,
      softWarnFraction: 0.8,
      farewellTtsHoldMs: 4000,
      setTimeoutFn,
      caseType: 'case_6a',
    })
    ws.simulateOpen()

    // Cross 100% with a single 1.0 event
    ws.emit('message', mkResponseDone(1.0))
    // Follow-up events MUST NOT re-fire (enforced guard)
    ws.emit('message', mkResponseDone(0.5))

    await new Promise((r) => setImmediate(r))

    // session.update instructions-only (NO tools field)
    const sessionUpdates = ws.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === 'session.update')
    expect(sessionUpdates.length).toBe(1)
    expect(sessionUpdates[0].session.instructions).toContain('Zeitbudget')
    expect(sessionUpdates[0].session.tools).toBeUndefined()

    // response.create fired
    const createMsgs = ws.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === 'response.create')
    expect(createMsgs.length).toBe(1)

    // setTimeoutFn invoked with 4000ms, triggering ws.close(1000)
    expect(setTimeoutFn).toHaveBeenCalledTimes(1)
    expect(setTimeoutFn.mock.calls[0][1]).toBe(4000)
    expect(ws.readyState).toBe(3) // closed

    // Discord hard-stop alert once
    const hardStopMsgs = sendDiscordAlert.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('hard-stopped'))
    expect(hardStopMsgs.length).toBe(1)

    // Core finalize_call_cost with terminated_by=cost_cap_call
    const finalizeCalls = callNanoclawTool.mock.calls.filter(
      (c) => c[0] === 'voice_finalize_call_cost',
    )
    expect(finalizeCalls.length).toBe(1)
    expect(finalizeCalls[0][1]).toMatchObject({
      call_id: 'rtc-stop',
      case_type: 'case_6a',
      terminated_by: 'cost_cap_call',
    })

    // Guard: markEnforced invoked once; second response.done does not re-fire
    expect(acc.markEnforced).toHaveBeenCalledTimes(1)
    expect(hardStopMsgs.length).toBe(1)
  })

  it('session.closed calls voice_finalize_call_cost (counterpart_bye) + clearCall when not enforced', async () => {
    const ws = new MockWS()
    const log = mockLog()
    const acc = makeMockAccumulator()
    const callNanoclawTool = vi.fn().mockResolvedValue({ ok: true })
    openSidebandSession('rtc-close', log, {
      wsFactory: () => ws as unknown as WSType,
      costAccumulator: acc,
      callNanoclawTool,
      caseType: 'case_6b',
    })
    ws.simulateOpen()
    ws.emit('message', JSON.stringify({ type: 'session.closed' }))

    await new Promise((r) => setImmediate(r))

    const finalizeCalls = callNanoclawTool.mock.calls.filter(
      (c) => c[0] === 'voice_finalize_call_cost',
    )
    expect(finalizeCalls.length).toBe(1)
    expect(finalizeCalls[0][1]).toMatchObject({
      call_id: 'rtc-close',
      case_type: 'case_6b',
      terminated_by: 'counterpart_bye',
    })
    expect(acc.clearCall).toHaveBeenCalledWith('rtc-close')
  })

  it('session.closed after hard-stop does NOT re-call finalize (enforced guard)', async () => {
    const ws = new MockWS()
    ws.readyState = 1
    const log = mockLog()
    const acc = makeMockAccumulator()
    const callNanoclawTool = vi.fn().mockResolvedValue({ ok: true })
    openSidebandSession('rtc-dup', log, {
      wsFactory: () => ws as unknown as WSType,
      costAccumulator: acc,
      callNanoclawTool,
      capPerCallEur: 1.0,
      softWarnFraction: 0.8,
      farewellTtsHoldMs: 4000,
      setTimeoutFn: () => 0,
    })
    ws.simulateOpen()
    ws.emit('message', mkResponseDone(1.0))
    ws.emit('message', JSON.stringify({ type: 'session.closed' }))

    await new Promise((r) => setImmediate(r))

    // Only one finalize — from the hard-stop path, not from session.closed
    const finalizeCalls = callNanoclawTool.mock.calls.filter(
      (c) => c[0] === 'voice_finalize_call_cost',
    )
    expect(finalizeCalls.length).toBe(1)
    expect(finalizeCalls[0][1]).toMatchObject({ terminated_by: 'cost_cap_call' })
    // clearCall still fires
    expect(acc.clearCall).toHaveBeenCalledWith('rtc-dup')
  })

  it('response.done with no usage block is silently ignored (0-cost skip)', async () => {
    const ws = new MockWS()
    const log = mockLog()
    const acc = makeMockAccumulator()
    const callNanoclawTool = vi.fn().mockResolvedValue({ ok: true })
    openSidebandSession('rtc-empty', log, {
      wsFactory: () => ws as unknown as WSType,
      costAccumulator: acc,
      callNanoclawTool,
    })
    ws.simulateOpen()
    ws.emit('message', JSON.stringify({ type: 'response.done', response: {} }))

    await new Promise((r) => setImmediate(r))

    expect(acc.add).not.toHaveBeenCalled()
    expect(callNanoclawTool).not.toHaveBeenCalled()
  })
})
