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
