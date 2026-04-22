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
import { openSidebandSession } from '../src/sideband.js'
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
