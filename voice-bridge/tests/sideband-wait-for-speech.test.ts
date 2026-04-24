// voice-bridge/tests/sideband-wait-for-speech.test.ts
// Phase 05.2 Plan 03 — RED phase: outbound wait-for-speech tests.
// D-8 (create_response:false flip) + first_caller_speech_response_create
// one-shot trigger in sideband.ts WS onmessage handler.
//
// These tests FAIL until Task 2 (GREEN) lands:
//  - SidebandState.armedForFirstSpeech field
//  - sideband.ts onmessage input_audio_buffer.speech_stopped → requestResponse
//  - config.ts SESSION_CONFIG.audio.input.turn_detection.create_response:false

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'
import {
  END_CALL_AUDIO_WAIT_MS,
  enableAutoResponseCreate,
  openSidebandSession,
  waitForBotAudioDone,
} from '../src/sideband.js'
import { SESSION_CONFIG } from '../src/config.js'

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
  simulateMessage(payload: unknown): void {
    const raw =
      typeof payload === 'string' ? payload : JSON.stringify(payload)
    this.emit('message', raw)
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

describe('Plan 05.2-03 — sideband wait-for-speech (D-8)', () => {
  beforeEach(() => {
    process.env.OPENAI_SIP_API_KEY = 'sk-test-wait-for-speech'
  })
  afterEach(() => {
    delete process.env.OPENAI_SIP_API_KEY
  })

  it('Test A (armed + first speech_stopped → response.create + log)', () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-armed-A', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()
    // Arm — outbound /accept will set this (Task 3). For Task 2 RED, set manually.
    handle.state.armedForFirstSpeech = true

    ws.simulateMessage({ type: 'input_audio_buffer.speech_stopped' })

    // (1) flag cleared after first fire
    expect(handle.state.armedForFirstSpeech).toBe(false)
    // (2) response.create sent on WS
    const createCalls = ws.sent
      .map((s) => {
        try {
          return JSON.parse(s)
        } catch {
          return null
        }
      })
      .filter((m) => m && (m as { type?: string }).type === 'response.create')
    expect(createCalls).toHaveLength(1)
    // (3) log event recorded
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(
      infoCalls.some(
        (c) => c[0]?.event === 'first_caller_speech_response_create',
      ),
    ).toBe(true)
    handle.close()
  })

  it('Test B (armed → ONE response.create; second speech_stopped does NOT re-fire)', () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-armed-B', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()
    handle.state.armedForFirstSpeech = true

    ws.simulateMessage({ type: 'input_audio_buffer.speech_stopped' })
    // Second speech_stopped — must NOT re-fire
    ws.simulateMessage({ type: 'input_audio_buffer.speech_stopped' })

    const createCalls = ws.sent
      .map((s) => {
        try {
          return JSON.parse(s)
        } catch {
          return null
        }
      })
      .filter((m) => m && (m as { type?: string }).type === 'response.create')
    expect(createCalls).toHaveLength(1)

    // Log fires exactly once
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    const fires = infoCalls.filter(
      (c) => c[0]?.event === 'first_caller_speech_response_create',
    )
    expect(fires).toHaveLength(1)
    handle.close()
  })

  it('Test C (NOT armed → speech_stopped does NOT fire first-speech response.create; onSpeechStop still invoked)', () => {
    const ws = new MockWS()
    const log = mockLog()
    const onSpeechStop = vi.fn()
    const handle = openSidebandSession('rtc-unarmed-C', log, {
      wsFactory: () => ws as unknown as WSType,
      onSpeechStop,
    })
    ws.simulateOpen()
    // Default = false (inbound path)
    expect(handle.state.armedForFirstSpeech).toBe(false)

    ws.simulateMessage({ type: 'input_audio_buffer.speech_stopped' })

    // No response.create sent from this path
    const createCalls = ws.sent
      .map((s) => {
        try {
          return JSON.parse(s)
        } catch {
          return null
        }
      })
      .filter((m) => m && (m as { type?: string }).type === 'response.create')
    expect(createCalls).toHaveLength(0)

    // No first-speech log
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(
      infoCalls.some(
        (c) => c[0]?.event === 'first_caller_speech_response_create',
      ),
    ).toBe(false)

    // Existing silence-monitor callback still invoked (behavior preserved)
    expect(onSpeechStop).toHaveBeenCalledTimes(1)
    handle.close()
  })

  it('Test D (config D-8): SESSION_CONFIG.audio.input.turn_detection.create_response === false', () => {
    expect(SESSION_CONFIG.audio.input.turn_detection.create_response).toBe(
      false,
    )
  })
})

// ---------------------------------------------------------------------------
// Phase 05.4 Bug-1 fix: post-first-turn create_response flip via session.update
// ---------------------------------------------------------------------------

function parseSent(ws: MockWS): Array<Record<string, unknown>> {
  return ws.sent
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((m): m is Record<string, unknown> => m !== null)
}

describe('Phase 05.4 Bug-1 — enableAutoResponseCreate flip after first turn', () => {
  beforeEach(() => {
    process.env.OPENAI_SIP_API_KEY = 'sk-test-auto-response-flip'
  })
  afterEach(() => {
    delete process.env.OPENAI_SIP_API_KEY
  })

  it('armed + first speech_stopped → response.create AND session.update with create_response:true', () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-auto-flip-A', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()
    handle.state.armedForFirstSpeech = true

    ws.simulateMessage({ type: 'input_audio_buffer.speech_stopped' })

    const sent = parseSent(ws)
    const createCalls = sent.filter((m) => m.type === 'response.create')
    const sessionUpdates = sent.filter((m) => m.type === 'session.update')

    expect(createCalls).toHaveLength(1)
    expect(sessionUpdates).toHaveLength(1)

    // Full turn_detection resent; create_response flipped to true, other
    // SESSION_CONFIG fields preserved.
    const session = sessionUpdates[0].session as Record<string, unknown>
    expect(session.type).toBe('realtime')
    const audio = session.audio as { input: { turn_detection: Record<string, unknown> } }
    const td = audio.input.turn_detection
    expect(td.create_response).toBe(true)
    expect(td.type).toBe(SESSION_CONFIG.audio.input.turn_detection.type)
    expect(td.threshold).toBe(SESSION_CONFIG.audio.input.turn_detection.threshold)
    expect(td.silence_duration_ms).toBe(
      SESSION_CONFIG.audio.input.turn_detection.silence_duration_ms,
    )
    expect(td.idle_timeout_ms).toBe(
      SESSION_CONFIG.audio.input.turn_detection.idle_timeout_ms,
    )

    // No `tools` in payload — AC-04/AC-05 invariant.
    expect('tools' in session).toBe(false)

    // State flag set so subsequent calls no-op.
    expect(handle.state.autoResponseEnabled).toBe(true)

    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(
      infoCalls.some((c) => c[0]?.event === 'auto_response_create_enabled'),
    ).toBe(true)

    handle.close()
  })

  it('idempotent: second invocation does NOT re-send session.update', () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-auto-flip-idem', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()

    expect(enableAutoResponseCreate(handle.state, log)).toBe(true)
    expect(enableAutoResponseCreate(handle.state, log)).toBe(false)
    expect(enableAutoResponseCreate(handle.state, log)).toBe(false)

    const sessionUpdates = parseSent(ws).filter(
      (m) => m.type === 'session.update',
    )
    expect(sessionUpdates).toHaveLength(1)
    handle.close()
  })

  it('WS not ready → skip with warn; flag stays false', () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-auto-flip-notready', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    // Do NOT simulateOpen — state.ready stays false.

    expect(enableAutoResponseCreate(handle.state, log)).toBe(false)
    expect(handle.state.autoResponseEnabled).toBe(false)

    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(
      warnCalls.some(
        (c) =>
          c[0]?.event === 'sideband_auto_response_enable_skipped' &&
          c[0]?.reason === 'not_ready',
      ),
    ).toBe(true)

    handle.close()
  })

  it('NOT armed (inbound) → no flip on speech_stopped (D-8 inbound-separation preserved)', () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-auto-flip-inbound', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()
    // armedForFirstSpeech stays false — inbound path.

    ws.simulateMessage({ type: 'input_audio_buffer.speech_stopped' })

    const sessionUpdates = parseSent(ws).filter(
      (m) => m.type === 'session.update',
    )
    expect(sessionUpdates).toHaveLength(0)
    expect(handle.state.autoResponseEnabled).toBe(false)

    handle.close()
  })
})

// ---------------------------------------------------------------------------
// Phase 05.4 Bug-3 — end_call hangup deferred until farewell TTS delivered
// ---------------------------------------------------------------------------

describe('Phase 05.4 Bug-3 — waitForBotAudioDone + end_call dispatch deferral', () => {
  beforeEach(() => {
    process.env.OPENAI_SIP_API_KEY = 'sk-test-end-call-audio-wait'
  })
  afterEach(() => {
    delete process.env.OPENAI_SIP_API_KEY
    vi.useRealTimers()
  })

  it('output_audio_buffer.{started,stopped} toggles state.botSpeaking', () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-bug3-botspeaking', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()

    expect(handle.state.botSpeaking).toBe(false)

    ws.simulateMessage({ type: 'output_audio_buffer.started' })
    expect(handle.state.botSpeaking).toBe(true)

    ws.simulateMessage({ type: 'output_audio_buffer.stopped' })
    expect(handle.state.botSpeaking).toBe(false)

    handle.close()
  })

  it('waitForBotAudioDone resolves "already_stopped" when bot is not speaking', async () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-bug3-notspeaking', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()

    expect(handle.state.botSpeaking).toBe(false)
    const result = await waitForBotAudioDone(handle.state, log)
    expect(result).toBe('already_stopped')
    handle.close()
  })

  it('waitForBotAudioDone resolves "stopped" when output_audio_buffer.stopped fires mid-wait', async () => {
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-bug3-stopped', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()
    ws.simulateMessage({ type: 'output_audio_buffer.started' })
    expect(handle.state.botSpeaking).toBe(true)

    const pending = waitForBotAudioDone(handle.state, log, 5000)
    // Simulate TTS completion a moment later.
    setTimeout(() => {
      ws.simulateMessage({ type: 'output_audio_buffer.stopped' })
    }, 10)
    const result = await pending
    expect(result).toBe('stopped')
    expect(handle.state.botSpeaking).toBe(false)
    expect(handle.state.endCallAudioWaitResolve).toBe(null)

    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(
      infoCalls.some((c) => c[0]?.event === 'end_call_audio_wait_resolved'),
    ).toBe(true)
    handle.close()
  })

  it('waitForBotAudioDone resolves "timeout" when stopped never arrives', async () => {
    vi.useFakeTimers()
    const ws = new MockWS()
    const log = mockLog()
    const handle = openSidebandSession('rtc-bug3-timeout', log, {
      wsFactory: () => ws as unknown as WSType,
    })
    ws.simulateOpen()
    ws.simulateMessage({ type: 'output_audio_buffer.started' })

    const pending = waitForBotAudioDone(handle.state, log, 4000)
    await vi.advanceTimersByTimeAsync(4000)
    const result = await pending
    expect(result).toBe('timeout')
    expect(handle.state.endCallAudioWaitResolve).toBe(null)

    const warnCalls = (log.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(
      warnCalls.some((c) => c[0]?.event === 'end_call_audio_wait_timeout'),
    ).toBe(true)
    handle.close()
  })

  it('end_call dispatch is deferred until bot audio stopped (vs. non-end_call fires immediately)', async () => {
    const ws = new MockWS()
    const log = mockLog()
    const dispatchCalls: Array<{ tool: string; at: number }> = []
    const mockDispatch = vi.fn(async (_ws, _cid, _tid, _fcid, toolName) => {
      dispatchCalls.push({ tool: toolName, at: Date.now() })
    })
    const handle = openSidebandSession('rtc-bug3-dispatch-gate', log, {
      wsFactory: () => ws as unknown as WSType,
      dispatchTool: mockDispatch,
    })
    ws.simulateOpen()
    // Bot is currently speaking the farewell.
    ws.simulateMessage({ type: 'output_audio_buffer.started' })
    expect(handle.state.botSpeaking).toBe(true)

    // Model emits end_call BEFORE TTS completes.
    ws.simulateMessage({
      type: 'response.function_call_arguments.done',
      call_id: 'fc_end_call_1',
      name: 'end_call',
      arguments: JSON.stringify({ reason: 'farewell' }),
    })

    // Dispatch MUST NOT have fired yet — waiting for audio done.
    await new Promise((r) => setTimeout(r, 5))
    expect(mockDispatch).not.toHaveBeenCalled()

    // Simulate audio completion.
    ws.simulateMessage({ type: 'output_audio_buffer.stopped' })
    await new Promise((r) => setTimeout(r, 5))

    // Now dispatch should have fired exactly once for end_call.
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(dispatchCalls[0].tool).toBe('end_call')

    // Non-end_call dispatch fires immediately (no gate).
    mockDispatch.mockClear()
    ws.simulateMessage({ type: 'output_audio_buffer.started' })
    ws.simulateMessage({
      type: 'response.function_call_arguments.done',
      call_id: 'fc_check_cal',
      name: 'check_calendar',
      arguments: JSON.stringify({ date: '2026-04-25' }),
    })
    // Give the fire-and-forget a microtask to schedule.
    await new Promise((r) => setTimeout(r, 5))
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(mockDispatch.mock.calls[0][4]).toBe('check_calendar')
    handle.close()
  })

  it('end_call dispatch fires immediately when bot is NOT speaking (short-circuit)', async () => {
    const ws = new MockWS()
    const log = mockLog()
    const mockDispatch = vi.fn(async () => undefined)
    const handle = openSidebandSession('rtc-bug3-short-circuit', log, {
      wsFactory: () => ws as unknown as WSType,
      dispatchTool: mockDispatch,
    })
    ws.simulateOpen()
    expect(handle.state.botSpeaking).toBe(false)

    ws.simulateMessage({
      type: 'response.function_call_arguments.done',
      call_id: 'fc_end_silent',
      name: 'end_call',
      arguments: JSON.stringify({ reason: 'silence' }),
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(mockDispatch.mock.calls[0][4]).toBe('end_call')

    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    expect(
      infoCalls.some(
        (c) => c[0]?.event === 'end_call_audio_wait_skip_not_speaking',
      ),
    ).toBe(true)
    handle.close()
  })

  it('END_CALL_AUDIO_WAIT_MS default sane (1–10 s)', () => {
    expect(END_CALL_AUDIO_WAIT_MS).toBeGreaterThanOrEqual(1000)
    expect(END_CALL_AUDIO_WAIT_MS).toBeLessThanOrEqual(10000)
  })
})
