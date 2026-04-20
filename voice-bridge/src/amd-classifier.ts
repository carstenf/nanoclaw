// voice-bridge/src/amd-classifier.ts
// Plan 05-03 Task 1: Case-2 AMD (Answering Machine Detection) classifier.
//
// Design: event-driven hybrid AMD per Spike-A + Spike-C carryforward.
// - Stage 1: regex match on cumulative ASR transcript (CASE2_MAILBOX_CUE_REGEX_V2)
// - Stage 2: VAD cadence gate (Timer A: 4000ms uninterrupted speech) + silence gate (Timer B: 6000ms no speech)
// - amd_result function_call from model: explicit verdict from OpenAI Realtime
//
// Critical: zero audio emitted before voicemail verdict (§201 StGB, T-05-03-01).
// If response.audio.delta arrives before verdict, log warn + set audioLeaked (Test 12).
//
// Spike-A verdict was 'partial': model can emit amd_result before real audio evidence.
// Mitigation: Bridge-side VAD gates + transcript-cue regex provide reliable secondary gates.
//
// Timer A (cadence gate): armed at construction. Fires at CASE2_VAD_CADENCE_MS after
//   speech_started if no speech_stopped yet and no verdict. → onVoicemail('cadence_cue').
// Timer B (silence gate): armed at construction. Fires at CASE2_VAD_SILENCE_MS if
//   no speech_started observed and no verdict. → onVoicemail('silence_mailbox').
// Both timers cleared on verdict.

import { CASE2_VAD_CADENCE_MS, CASE2_VAD_SILENCE_MS } from './config.js'
import type { Logger } from 'pino'

// ---- Prompt ----

/**
 * AMD classifier prompt — verbatim from Plan 05-03 interfaces section.
 * Instructs gpt-realtime-mini to emit amd_result WITHOUT speaking first.
 * Spike-A validated that function_call precedes response.audio.delta when prompt instructs it.
 */
export const CASE2_AMD_CLASSIFIER_PROMPT = `Du bist in einem Detektions-Modus. Der Anruf wurde GERADE angenommen.
Deine EINZIGE Aufgabe ist: bestimme, ob ein Mensch oder eine Mailbox/Anrufbeantworter angenommen hat.

KRITISCH: Du sprichst JETZT NICHT. Generiere KEIN Audio. Du hörst nur zu.

Höre die ersten 3 Sekunden:
- Wenn ein Mensch knapp grüßt (Guten Tag, Restaurant X / Hallo? / Ja?) — emit function_call amd_result with arg {verdict: human}
- Wenn eine Ansage läuft (Willkommen bei der Mailbox von ... / Der Teilnehmer ist derzeit nicht erreichbar / bitte hinterlassen Sie eine Nachricht / Musik / IVR-Menü) — emit function_call amd_result with arg {verdict: voicemail}
- Wenn 4 Sekunden lang NICHTS gesprochen wird — emit function_call amd_result with arg {verdict: silence}

Sprich NIEMALS bis die Bridge dir neue Anweisungen gibt.`

// ---- Regex ----

/**
 * CASE2_MAILBOX_CUE_REGEX_V2 — from Spike-C corpus, hardened against 12 German voicemail greetings.
 *
 * Coverage: 12/12 corpus greetings (Spike-C §2).
 * Extended vs. original to cover:
 *   - FritzBox/casual: "im moment nicht (erreichbar|da)" + "entgegengenommen/nehmen"
 *   - G12 edge (permanent-absence): "anschluss.*nicht bedient/belegt/existiert nicht"
 *   - Business after-hours: "büro geschlossen" + "außerhalb geschäftszeiten/sprechzeiten"
 *   - Whitespace tolerance: \s+ across tokens (ASR transcript collapse/expand)
 *   - mailbox\s+von (anchored with "von") to avoid matching "Restaurant Mailbox Kitchen" (false-positive guard)
 *
 * Positional gating: run ONLY on cumulative transcript of 0-6s post-accept (Wave 3 design).
 *
 * NOTE: regex has the 'i' flag for case-insensitive matching. NOT global (/g) to avoid lastIndex issues.
 */
export const CASE2_MAILBOX_CUE_REGEX_V2 =
  /nicht\s+(mehr\s+)?erreichbar|bitte\s+hinterlassen|anrufbeantworter|mailbox\s+von|sprachbox|nach\s+dem\s+(signal(ton)?|piep(ton)?|ton(signal)?)|sprach(nachricht|box)|ist\s+zur\s+zeit\s+nicht|zur\s+zeit\s+nicht\s+erreichbar|im\s+moment\s+nicht\s+(erreichbar|da)|entgegen(nehmen|genommen)|anschluss.*(nicht\s+bedient|nicht\s+belegt|existiert\s+nicht)|b(ü|ue)ro\s+(ist\s+)?geschlossen|au(ß|ss)erhalb\s+.*(gesch(ä|ae)ftszeiten|sprechzeiten)/i

// ---- Types ----

export type AmdVerdict = 'pending' | 'human' | 'voicemail' | 'silence'

export type AmdVoicemailReason = 'amd_result' | 'cadence_cue' | 'silence_mailbox' | 'transcript_cue'

export interface AmdEventSnapshot {
  eventLog: AmdSidebandEvent[]
}

export type AmdSidebandEvent =
  | { type: 'speech_started'; at: number }
  | { type: 'speech_stopped'; at: number }
  | { type: 'transcript'; text: string; at: number }
  | { type: 'audio_delta'; bytes: number; at: number }

export interface AmdClassifierOpts {
  callId: string
  log: Logger
  onHuman: (snapshot: AmdEventSnapshot) => void
  onVoicemail: (reason: AmdVoicemailReason) => void
  /** cadence gate ms (Timer A). Default CASE2_VAD_CADENCE_MS (4000ms). */
  cadenceMs?: number
  /** silence gate ms (Timer B). Default CASE2_VAD_SILENCE_MS (6000ms). */
  silenceMs?: number
  /** DI for timers (tests). */
  timers?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
    clearTimeout: (id: ReturnType<typeof setTimeout>) => void
  }
}

export interface AmdClassifier {
  /** Called when sideband emits input_audio_buffer.speech_started. */
  onSpeechStarted: () => void
  /** Called when sideband emits input_audio_buffer.speech_stopped. */
  onSpeechStopped: () => void
  /** Called when ASR transcript arrives (conversation.item.input_audio_transcription.completed). */
  onTranscript: (text: string) => void
  /** Called when model emits amd_result function_call. */
  onAmdResult: (verdict: string) => void
  /** Called when response.audio.delta arrives (T-05-03-01 tracking). */
  onAudioDelta: (bytes: number) => void
  /** Stop all timers; subsequent events become no-ops. */
  stop: () => void
  /** Current verdict (pending until resolved). */
  getVerdict: () => AmdVerdict
  /** True if response.audio.delta was observed before verdict. */
  isAudioLeaked: () => boolean
}

// ---- Implementation ----

export function createAmdClassifier(opts: AmdClassifierOpts): AmdClassifier {
  const cadenceMs = opts.cadenceMs ?? CASE2_VAD_CADENCE_MS
  const silenceMs = opts.silenceMs ?? CASE2_VAD_SILENCE_MS
  const timers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  }

  let verdict: AmdVerdict = 'pending'
  let stopped = false
  let audioLeaked = false
  let speechStartedObserved = false
  let speechStoppedObserved = false

  const eventLog: AmdSidebandEvent[] = []

  // Timer A: cadence gate — fires if speech_started but no speech_stopped within cadenceMs
  // Timer B: silence gate — fires if no speech_started within silenceMs
  let timerA: ReturnType<typeof setTimeout> | null = null
  let timerB: ReturnType<typeof setTimeout> | null = null

  // Arm Timer B immediately (silence = no speech_started at all)
  timerB = timers.setTimeout(() => {
    if (stopped || verdict !== 'pending') return
    settleVoicemail('silence_mailbox')
  }, silenceMs)

  function clearTimers(): void {
    if (timerA !== null) {
      timers.clearTimeout(timerA)
      timerA = null
    }
    if (timerB !== null) {
      timers.clearTimeout(timerB)
      timerB = null
    }
  }

  function settleHuman(): void {
    if (verdict !== 'pending' || stopped) return
    verdict = 'human'
    clearTimers()
    opts.log.info({
      event: 'case_2_amd_verdict_human',
      call_id: opts.callId,
      event_log_size: eventLog.length,
    })
    opts.onHuman({ eventLog: [...eventLog] })
  }

  function settleVoicemail(reason: AmdVoicemailReason): void {
    if (verdict !== 'pending' || stopped) return
    verdict = 'voicemail'
    clearTimers()
    opts.log.info({
      event: 'case_2_voicemail_hangup',
      call_id: opts.callId,
      reason,
    })
    opts.onVoicemail(reason)
  }

  return {
    onSpeechStarted(): void {
      if (stopped || verdict !== 'pending') return
      speechStartedObserved = true
      eventLog.push({ type: 'speech_started', at: Date.now() })

      // Cancel Timer B: speech has started, so it's not a silence-mailbox
      if (timerB !== null) {
        timers.clearTimeout(timerB)
        timerB = null
      }

      // Arm Timer A: if speech continues for cadenceMs without stopping → cadence cue
      if (timerA === null) {
        timerA = timers.setTimeout(() => {
          if (stopped || verdict !== 'pending') return
          if (speechStartedObserved && !speechStoppedObserved) {
            settleVoicemail('cadence_cue')
          }
        }, cadenceMs)
      }
    },

    onSpeechStopped(): void {
      if (stopped || verdict !== 'pending') return
      speechStoppedObserved = true
      eventLog.push({ type: 'speech_stopped', at: Date.now() })

      // Cancel Timer A: speech stopped naturally (not a long uninterrupted monologue)
      if (timerA !== null) {
        timers.clearTimeout(timerA)
        timerA = null
      }
    },

    onTranscript(text: string): void {
      if (stopped || verdict !== 'pending') return
      eventLog.push({ type: 'transcript', text, at: Date.now() })

      // Stage 1: regex match — immediate transcript cue
      CASE2_MAILBOX_CUE_REGEX_V2.lastIndex = 0
      if (CASE2_MAILBOX_CUE_REGEX_V2.test(text)) {
        settleVoicemail('transcript_cue')
      }
    },

    onAmdResult(rawVerdict: string): void {
      if (stopped || verdict !== 'pending') return
      eventLog.push({
        type: 'transcript',
        text: `amd_result:${rawVerdict}`,
        at: Date.now(),
      })

      if (rawVerdict === 'human') {
        settleHuman()
      } else if (rawVerdict === 'voicemail' || rawVerdict === 'silence') {
        settleVoicemail('amd_result')
      } else {
        opts.log.warn({
          event: 'case_2_amd_result_unknown_verdict',
          call_id: opts.callId,
          verdict: rawVerdict,
        })
        // Treat unknown verdict as voicemail (safe default per §201 StGB asymmetry)
        settleVoicemail('amd_result')
      }
    },

    onAudioDelta(bytes: number): void {
      eventLog.push({ type: 'audio_delta', bytes, at: Date.now() })

      if (verdict === 'pending' && !audioLeaked) {
        audioLeaked = true
        // T-05-03-01: log warning — Spike-A 'partial' tolerance, do not stop classifier
        opts.log.warn({
          event: 'case_2_audio_leaked_before_verdict',
          call_id: opts.callId,
          bytes,
          note: 'Spike-A partial: model emitted audio before amd_result — proceeding but flagged',
        })
      }
    },

    stop(): void {
      stopped = true
      clearTimers()
    },

    getVerdict(): AmdVerdict {
      return verdict
    },

    isAudioLeaked(): boolean {
      return audioLeaked
    },
  }
}
