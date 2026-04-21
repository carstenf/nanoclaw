// voice-bridge/src/silence-monitor.ts
// Plan 03-15 / REQ-VOICE-08/09: active silence detection. Persona-side prompts
// alone do not work in OpenAI Realtime — the model only generates a response
// when an event arrives. This module listens to VAD speech_started/stopped
// events and fires forced response.create prompts after configurable silence
// rounds, then triggers a hard hangup at round 3.
//
// Lifecycle:
// - construct after sideband ready
// - call onSpeechStart() when caller starts speaking → cancel current timer,
//   reset round counter
// - call onSpeechStop() when caller pauses → start countdown
// - on countdown elapse:
//   round 1 → push response.create with "Bist du noch da?" prompt
//   round 2 → push with second variant
//   round 3 → push with "Ich lege jetzt auf, es ist niemand mehr da" prompt
//             AND schedule hangup ~3500ms later for bot to finish speaking
// - call stop() when call ends to clean up timers
import type { Logger } from 'pino'

import type { SidebandHandle } from './sideband.js'
import { requestResponse } from './sideband.js'

export interface SilenceMonitorOpts {
  callId: string
  sideband: SidebandHandle
  log: Logger
  /** Hangup callback — same callback wired in dispatch.ts setHangupCallback. */
  hangupCall: (callId: string) => Promise<void>
  /** Silence threshold per round in ms. Default 10000. */
  silenceMs?: number
  /** Delay between final prompt and hangup so bot can finish speaking. Default 3500ms. */
  hangupDelayMs?: number
  /** Custom prompts per round. Override only for tests. */
  prompts?: {
    round1?: string
    round2?: string
    round3?: string
  }
  /** DI for setTimeout/clearTimeout (tests). */
  timers?: {
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
  }
}

export interface SilenceMonitor {
  onSpeechStart: () => void
  onSpeechStop: () => void
  /**
   * Plan 05.2-02 D-7 / research §4.3: bot starts emitting audio
   * (OpenAI Realtime `output_audio_buffer.started`). Cancels any armed
   * silence timer — silence during a bot turn is semantically meaningless.
   */
  onBotStart: () => void
  /**
   * Plan 05.2-02 D-7 / research §4.3: bot audio buffer drained
   * (OpenAI Realtime `output_audio_buffer.stopped`). Arms the silence timer
   * iff the caller is not currently speaking.
   */
  onBotStop: () => void
  stop: () => void
  /** For tests: current round (0..3). */
  _round: () => number
}

const DEFAULT_PROMPTS = {
  round1:
    "Sage jetzt EXAKT diesen Satz und sonst nichts: 'Bist du noch da, Carsten?'",
  round2:
    "Sage jetzt EXAKT diesen Satz und sonst nichts: 'Hallo? Carsten? Hoerst du mich noch?'",
  round3:
    "Sage jetzt EXAKT diesen Satz und sonst nichts: 'Ich lege jetzt auf, es ist niemand mehr da.'",
} as const

export function createSilenceMonitor(opts: SilenceMonitorOpts): SilenceMonitor {
  const silenceMs = opts.silenceMs ?? 10000
  const hangupDelayMs = opts.hangupDelayMs ?? 3500
  const prompts = { ...DEFAULT_PROMPTS, ...(opts.prompts ?? {}) }
  const timers = opts.timers ?? { setTimeout, clearTimeout }
  let round = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let hangupTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  // State-machine rewire (05.2-02 D-7 / research §4.3): track botSpeaking AND
  // callerSpeaking; timer ONLY armed when BOTH are false. Prior bug: timer
  // armed purely on caller speech_stopped, ignoring bot-speaking state,
  // causing "Bist du noch da" to fire mid-bot-turn (live defect 2026-04-21,
  // research §1.3 item 2 / §4.1).
  let botSpeaking = false
  let callerSpeaking = false

  function clear(): void {
    if (timer) {
      timers.clearTimeout(timer)
      timer = null
    }
  }

  function fireRound(): void {
    if (stopped) return
    round += 1
    if (round === 1) {
      opts.log.info({
        event: 'silence_round_1',
        call_id: opts.callId,
      })
      requestResponse(opts.sideband.state, opts.log, prompts.round1)
      schedule()
      return
    }
    if (round === 2) {
      opts.log.info({
        event: 'silence_round_2',
        call_id: opts.callId,
      })
      requestResponse(opts.sideband.state, opts.log, prompts.round2)
      schedule()
      return
    }
    // round 3 — final farewell + hangup
    opts.log.info({
      event: 'silence_round_3_hangup_pending',
      call_id: opts.callId,
      hangup_delay_ms: hangupDelayMs,
    })
    requestResponse(opts.sideband.state, opts.log, prompts.round3)
    hangupTimer = timers.setTimeout(() => {
      if (stopped) return
      opts.log.info({
        event: 'silence_hangup_fired',
        call_id: opts.callId,
      })
      opts.hangupCall(opts.callId).catch((e: Error) =>
        opts.log.warn({
          event: 'silence_hangup_failed',
          call_id: opts.callId,
          err: e?.message,
        }),
      )
    }, hangupDelayMs)
  }

  function schedule(): void {
    clear()
    if (stopped) return
    timer = timers.setTimeout(fireRound, silenceMs)
  }

  return {
    onSpeechStart(): void {
      if (stopped) return
      callerSpeaking = true
      // Caller is speaking again — reset the silence ladder entirely.
      clear()
      if (round !== 0) {
        opts.log.info({
          event: 'silence_reset_on_speech',
          call_id: opts.callId,
          prev_round: round,
        })
      }
      round = 0
      // Cancel pending hangup if caller wakes up between round-3 prompt and
      // the hangup fire — e.g. they realize and say something.
      if (hangupTimer) {
        timers.clearTimeout(hangupTimer)
        hangupTimer = null
        opts.log.info({
          event: 'silence_hangup_cancelled_on_speech',
          call_id: opts.callId,
        })
      }
    },
    onSpeechStop(): void {
      if (stopped) return
      callerSpeaking = false
      // Plan 05.2-02 D-7: only arm timer if bot is not currently speaking.
      // If botSpeaking=true, the eventual onBotStop() will arm the timer.
      if (!botSpeaking) schedule()
    },
    // Event names per OpenAI Realtime Server Events reference:
    // https://developers.openai.com/api/reference/resources/realtime/server-events
    // — output_audio_buffer.stopped fires AFTER full response data sent
    // (response.done), so it is the conservative "bot definitely finished
    // speaking" signal. Research §4.2.
    onBotStart(): void {
      if (stopped) return
      botSpeaking = true
      // Bot is speaking — silence is semantically meaningless. Cancel any
      // armed timer (may have been armed from a prior caller speech_stopped
      // that fired DURING the bot's own TTS window — this is the core
      // live-defect 2026-04-21 root cause, research §4.1).
      // NOTE: do NOT reset round counter here — the counter tracks how many
      // forced-prompt attempts we've made in the current silence ladder;
      // only genuine caller activity (onSpeechStart) resets it.
      clear()
      opts.log.info({
        event: 'silence_bot_start',
        call_id: opts.callId,
      })
    },
    onBotStop(): void {
      if (stopped) return
      botSpeaking = false
      opts.log.info({
        event: 'silence_bot_stop',
        call_id: opts.callId,
      })
      // Plan 05.2-02 D-7 / research §4.3: arm timer iff caller is also silent.
      // Invariant: timer is NEVER armed while either botSpeaking or
      // callerSpeaking is true — only at the moment BOTH become false.
      if (!callerSpeaking) schedule()
    },
    stop(): void {
      stopped = true
      clear()
      if (hangupTimer) {
        timers.clearTimeout(hangupTimer)
        hangupTimer = null
      }
    },
    _round(): number {
      return round
    },
  }
}
