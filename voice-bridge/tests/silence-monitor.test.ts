// voice-bridge/tests/silence-monitor.test.ts
// Plan 03-15 / REQ-VOICE-08/09: silence-monitor unit tests with fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Logger } from 'pino'

import { createSilenceMonitor } from '../src/silence-monitor.js'
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

function makeFakeSideband(): { handle: SidebandHandle; ws: FakeWS } {
  const ws: FakeWS = { send: vi.fn() }
  const handle: SidebandHandle = {
    state: {
      callId: 'rtc_test',
      ready: true,
      ws: ws as unknown as SidebandHandle['state']['ws'],
      openedAt: Date.now(),
      lastUpdateAt: 0,
    },
    close: vi.fn(),
  }
  return { handle, ws }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSilenceMonitor (03-15, REQ-VOICE-08/09)', () => {
  it('does nothing until first onSpeechStop', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const log = makeLog()
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log,
      hangupCall,
      silenceMs: 10000,
    })

    vi.advanceTimersByTime(60000)
    expect(ws.send).not.toHaveBeenCalled()
    expect(hangupCall).not.toHaveBeenCalled()
    expect(m._round()).toBe(0)
  })

  it('round 1: silence 10s after speech_stop → first prompt sent', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const log = makeLog()
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log,
      hangupCall,
      silenceMs: 10000,
    })

    m.onSpeechStop()
    vi.advanceTimersByTime(9999)
    expect(ws.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(ws.send).toHaveBeenCalledOnce()
    const sent = JSON.parse((ws.send.mock.calls[0]?.[0] as string) ?? '{}')
    expect(sent.type).toBe('response.create')
    expect(sent.response.instructions).toContain('Bist du noch da')
    expect(m._round()).toBe(1)
  })

  it('round 2: another 10s without speech → second prompt sent', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
    })

    m.onSpeechStop()
    vi.advanceTimersByTime(10000) // round 1 fires
    vi.advanceTimersByTime(10000) // round 2 fires
    expect(ws.send).toHaveBeenCalledTimes(2)
    const sent2 = JSON.parse((ws.send.mock.calls[1]?.[0] as string) ?? '{}')
    expect(sent2.response.instructions).toContain('Hallo')
    expect(m._round()).toBe(2)
  })

  it('round 3: third silence → final prompt + hangup after delay', async () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
      hangupDelayMs: 3500,
    })

    m.onSpeechStop()
    vi.advanceTimersByTime(10000) // r1
    vi.advanceTimersByTime(10000) // r2
    vi.advanceTimersByTime(10000) // r3 prompt fires
    expect(ws.send).toHaveBeenCalledTimes(3)
    const sent3 = JSON.parse((ws.send.mock.calls[2]?.[0] as string) ?? '{}')
    expect(sent3.response.instructions).toContain('Ich lege jetzt auf')
    expect(hangupCall).not.toHaveBeenCalled()

    // hangup delay
    vi.advanceTimersByTime(3499)
    expect(hangupCall).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hangupCall).toHaveBeenCalledWith('rtc')
  })

  it('onSpeechStart resets round and cancels pending timer', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
    })

    m.onSpeechStop()
    vi.advanceTimersByTime(5000)
    m.onSpeechStart() // caller speaks
    vi.advanceTimersByTime(60000) // long time
    expect(ws.send).not.toHaveBeenCalled()
    expect(m._round()).toBe(0)
  })

  it('round-1 fired then speech resets back to round 0', () => {
    const { handle, ws } = makeFakeSideband()
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall: vi.fn().mockResolvedValue(undefined),
      silenceMs: 10000,
    })

    m.onSpeechStop()
    vi.advanceTimersByTime(10000) // r1 fires
    expect(m._round()).toBe(1)
    m.onSpeechStart()
    expect(m._round()).toBe(0)
    m.onSpeechStop()
    vi.advanceTimersByTime(10000)
    // Should be round 1 again (new ladder), not round 2
    expect(m._round()).toBe(1)
    expect(ws.send).toHaveBeenCalledTimes(2)
  })

  it('speech AFTER round-3 prompt but BEFORE hangup → cancels hangup', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
      hangupDelayMs: 3500,
    })

    m.onSpeechStop()
    vi.advanceTimersByTime(30000) // r1 + r2 + r3 prompts fire
    expect(hangupCall).not.toHaveBeenCalled()
    m.onSpeechStart() // caller wakes up just in time
    vi.advanceTimersByTime(10000)
    expect(hangupCall).not.toHaveBeenCalled()
  })

  it('stop() cancels pending timer, no further prompts or hangup', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn()
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
    })

    m.onSpeechStop()
    vi.advanceTimersByTime(5000)
    m.stop()
    vi.advanceTimersByTime(60000)
    expect(ws.send).not.toHaveBeenCalled()
    expect(hangupCall).not.toHaveBeenCalled()
  })

  it('stop() after round-3 prompt cancels pending hangup', () => {
    const { handle } = makeFakeSideband()
    const hangupCall = vi.fn()
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
      hangupDelayMs: 3500,
    })

    m.onSpeechStop()
    vi.advanceTimersByTime(30000) // through round 3 prompt
    m.stop()
    vi.advanceTimersByTime(10000)
    expect(hangupCall).not.toHaveBeenCalled()
  })

  it('multiple speech_stop calls without speech_start re-arm timer', () => {
    const { handle, ws } = makeFakeSideband()
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall: vi.fn(),
      silenceMs: 10000,
    })

    m.onSpeechStop()
    vi.advanceTimersByTime(5000)
    m.onSpeechStop() // re-arm — restart 10s
    vi.advanceTimersByTime(5000) // total 10s but only 5s on current armed timer
    expect(ws.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000) // now 10s on the armed timer
    expect(ws.send).toHaveBeenCalledOnce()
  })

  it('respects custom prompts override', () => {
    const { handle, ws } = makeFakeSideband()
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall: vi.fn(),
      silenceMs: 10000,
      prompts: { round1: 'CUSTOM PROMPT 1' },
    })
    m.onSpeechStop()
    vi.advanceTimersByTime(10000)
    const sent = JSON.parse((ws.send.mock.calls[0]?.[0] as string) ?? '{}')
    expect(sent.response.instructions).toBe('CUSTOM PROMPT 1')
  })
})

// Plan 05.2-02 D-7 / research §4.3: bot-audio-aware silence-monitor state
// machine. Prior bug (live-defect 2026-04-21): monitor was armed purely on
// caller `speech_stopped`, ignoring bot-speaking state — "Bist du noch da,
// Carsten?" could fire mid-bot-turn because a caller `speech_stopped` event
// arrived BEFORE the bot's own TTS finished. Fix: arm only when BOTH
// botSpeaking AND callerSpeaking are false; cancel whenever either becomes
// true. Events are OpenAI Realtime server-events: `output_audio_buffer.started`
// (bot speaks), `output_audio_buffer.stopped` (bot done — conservative
// "truly finished" signal, fires after response.done, see research §4.2).
describe('bot-audio-aware state machine (05.2-02 D-7)', () => {
  it('Test A (bug repro): onBotStart alone (no onBotStop) must NOT arm the timer — no response fires during bot speech', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
    })

    // Bot starts speaking. While bot is speaking, silence-monitor MUST stay
    // dormant — no timer armed, no prompt fired even after silenceMs+buffer.
    m.onBotStart()
    vi.advanceTimersByTime(20000)

    expect(ws.send).not.toHaveBeenCalled()
    expect(hangupCall).not.toHaveBeenCalled()
    expect(m._round()).toBe(0)
  })

  it('Test B (arm-on-bot-stop): onBotStart → onBotStop arms the timer; round1 fires after silenceMs', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
    })

    // Bot says its greeting, then finishes (output_audio_buffer.stopped).
    m.onBotStart()
    m.onBotStop()

    vi.advanceTimersByTime(9999)
    expect(ws.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(ws.send).toHaveBeenCalledOnce()
    const sent = JSON.parse((ws.send.mock.calls[0]?.[0] as string) ?? '{}')
    expect(sent.type).toBe('response.create')
    expect(sent.response.instructions).toContain('Bist du noch da')
    expect(m._round()).toBe(1)
  })

  it('Test C (bot-interrupts-arm — core bug fix): caller-armed timer is cancelled when bot starts speaking', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
    })

    // Caller just finished a turn — this would arm the timer under old code.
    m.onSpeechStop()
    vi.advanceTimersByTime(5000)

    // Bot starts its own turn BEFORE silenceMs elapsed. The timer must be
    // cancelled — bot speaking makes "silence" meaningless.
    m.onBotStart()

    // Even if we wait silenceMs*2, round must stay 0 — no ghost prompt.
    vi.advanceTimersByTime(20000)
    expect(ws.send).not.toHaveBeenCalled()
    expect(hangupCall).not.toHaveBeenCalled()
    expect(m._round()).toBe(0)
  })

  it('Test D (both-flags-true-no-arm): onBotStop while caller still speaking → timer NOT armed until onSpeechStop', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
    })

    // Barge-in: bot talking, caller starts talking (both flags true), then
    // bot stops. Caller is STILL talking — timer must stay disarmed.
    m.onBotStart()
    m.onSpeechStart()
    m.onBotStop()

    vi.advanceTimersByTime(silenceMsPlusBuffer())
    expect(ws.send).not.toHaveBeenCalled()
    expect(m._round()).toBe(0)

    // Only after caller finishes does the timer arm.
    m.onSpeechStop()
    vi.advanceTimersByTime(10000)
    expect(ws.send).toHaveBeenCalledOnce()
    expect(m._round()).toBe(1)
  })

  it('Test E (regression — full 3-round ladder fires on post-greeting silence armed from onBotStop)', async () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
      hangupDelayMs: 3500,
    })

    // Post-greeting: bot finished its self-greet, counterpart totally silent.
    m.onBotStart()
    m.onBotStop()

    vi.advanceTimersByTime(10000) // round 1 fires
    vi.advanceTimersByTime(10000) // round 2 fires
    vi.advanceTimersByTime(10000) // round 3 prompt fires
    expect(ws.send).toHaveBeenCalledTimes(3)
    const sent3 = JSON.parse((ws.send.mock.calls[2]?.[0] as string) ?? '{}')
    expect(sent3.response.instructions).toContain('Ich lege jetzt auf')
    expect(hangupCall).not.toHaveBeenCalled()

    vi.advanceTimersByTime(3500) // hangup delay elapsed
    expect(hangupCall).toHaveBeenCalledWith('rtc')
  })

  it('Test F (regression — caller-armed path: onSpeechStop alone still arms timer as before)', () => {
    const { handle, ws } = makeFakeSideband()
    const hangupCall = vi.fn().mockResolvedValue(undefined)
    const m = createSilenceMonitor({
      callId: 'rtc',
      sideband: handle,
      log: makeLog(),
      hangupCall,
      silenceMs: 10000,
    })

    // Standard turn-end: caller finished speaking. Bot is not speaking
    // (botSpeaking=false by default). Timer must arm as before.
    m.onSpeechStop()
    vi.advanceTimersByTime(10000)
    expect(ws.send).toHaveBeenCalledOnce()
    expect(m._round()).toBe(1)
  })
})

function silenceMsPlusBuffer(): number {
  return 10000 + 100
}
