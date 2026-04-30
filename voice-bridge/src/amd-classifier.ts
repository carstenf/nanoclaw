// voice-bridge/src/amd-classifier.ts
// Phase 05.3 — Case-2 AMD (Answering Machine Detection) classifier.
//
// Event-driven hybrid AMD:
//   - Stage 1: regex match on cumulative ASR transcript (CASE2_MAILBOX_CUE_REGEX_V2)
//   - Stage 2: VAD-fallback human path (Plan 05.2-06 invariant — see onTranscript below)
//   - Stage 3 (fallback): amd_result function_call from model (unreliable for
//     human verdict with gpt-realtime; retained for voicemail)
//   - Timer A (cadence gate, CASE2_VAD_CADENCE_MS): uninterrupted speech →
//     onVoicemail('cadence_cue')
//   - Timer B (silence gate, CASE2_VAD_SILENCE_MS): no speech_started →
//     onVoicemail('silence_mailbox')
//   - All timers cleared on verdict.
//
// Load-bearing invariants:
//   - §201 StGB zero-audio-leak: no bot audio before voicemail verdict. If
//     response.audio.delta arrives before verdict, log warn + set audioLeaked.
//   - Plan 05.2-06 VAD-fallback human: speech_started + speech_stopped + ≥3
//     non-whitespace transcript chars → settleHuman() (bypasses unreliable
//     amd_result=human emit). §201 preserved because settleHuman fires ONLY
//     after the caller has clearly spoken.
//
// ASCII-umlaut convention enforced project-wide (see persona/baseline.ts header).

import {
  CASE2_VAD_CADENCE_MS,
  CASE2_VAD_SILENCE_MS,
  VOICEMAIL_CAPTURE_MS,
} from './config.js'
import type { Logger } from 'pino'

// ---- Prompt ----

// OUTBOUND_AMD_CLASSIFIER_PROMPT is a LISTEN-ONLY DETECTION prompt — the model
// is in a non-conversational mode whose only output is the amd_result
// function-call with verdict ∈ {human, voicemail, silent, noise}. It is
// structurally distinct from the baseline+overlay conversation-mode persona
// (persona/baseline.ts) used post-AMD-verdict.

/**
 * AMD classifier prompt — verbatim from Plan 05-03 interfaces section.
 * Instructs the Realtime model (gpt-realtime since Plan 05.1 upgrade 2026-04-21; previously mini) to emit amd_result WITHOUT speaking first.
 * Spike-A validated that function_call precedes response.audio.delta when prompt instructs it.
 */
export const OUTBOUND_AMD_CLASSIFIER_PROMPT = `Du bist in einem Detektions-Modus. Der Anruf wurde GERADE angenommen.
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
  /**
   * Fired once the verdict has settled to voicemail. The snapshot contains the
   * full eventLog accumulated up to (and during) the optional capture window,
   * so callers can re-extract the greeting transcript for analysis.
   */
  onVoicemail: (reason: AmdVoicemailReason, snapshot: AmdEventSnapshot) => void
  /** cadence gate ms (Timer A). Default CASE2_VAD_CADENCE_MS (4000ms). */
  cadenceMs?: number
  /** silence gate ms (Timer B). Default CASE2_VAD_SILENCE_MS (6000ms). */
  silenceMs?: number
  /**
   * Voicemail-capture window (ms): once the verdict settles to voicemail,
   * keep collecting transcript chunks for this long before firing onVoicemail.
   * 0 = fire immediately (legacy behaviour). Default VOICEMAIL_CAPTURE_MS.
   */
  voicemailCaptureMs?: number
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
  const voicemailCaptureMs = opts.voicemailCaptureMs ?? VOICEMAIL_CAPTURE_MS
  const timers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  }

  let verdict: AmdVerdict = 'pending'
  let stopped = false
  let audioLeaked = false
  let speechStartedObserved = false
  let speechStoppedObserved = false
  // Voicemail-capture-window: between settleVoicemail() and onVoicemail-fire,
  // continue appending transcript chunks to eventLog so the caller has the
  // full greeting (incl. opening times like "ab 15 Uhr") to analyze.
  let inCaptureWindow = false
  let captureTimer: ReturnType<typeof setTimeout> | null = null

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

  function fireVoicemail(reason: AmdVoicemailReason): void {
    inCaptureWindow = false
    captureTimer = null
    opts.log.info({
      event: 'case_2_voicemail_hangup',
      call_id: opts.callId,
      reason,
      event_log_size: eventLog.length,
    })
    opts.onVoicemail(reason, { eventLog: [...eventLog] })
  }

  function settleVoicemail(reason: AmdVoicemailReason): void {
    if (verdict !== 'pending' || stopped) return
    verdict = 'voicemail'
    clearTimers()

    if (voicemailCaptureMs > 0) {
      // Defer onVoicemail by the capture window — keep onTranscript active so
      // late chunks (opening times after the mailbox cue) land in eventLog.
      inCaptureWindow = true
      opts.log.info({
        event: 'voicemail_capture_window_armed',
        call_id: opts.callId,
        reason,
        capture_ms: voicemailCaptureMs,
      })
      captureTimer = timers.setTimeout(() => {
        if (stopped) return
        fireVoicemail(reason)
      }, voicemailCaptureMs)
      return
    }
    fireVoicemail(reason)
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
      if (stopped) return
      // Capture-window: verdict is already 'voicemail'; keep collecting
      // transcript chunks for the analyzer but skip the regex/VAD logic that
      // only matters pre-verdict.
      if (inCaptureWindow) {
        eventLog.push({ type: 'transcript', text, at: Date.now() })
        return
      }
      if (verdict !== 'pending') return
      eventLog.push({ type: 'transcript', text, at: Date.now() })

      // Stage 1: regex match — immediate transcript cue
      CASE2_MAILBOX_CUE_REGEX_V2.lastIndex = 0
      if (CASE2_MAILBOX_CUE_REGEX_V2.test(text)) {
        settleVoicemail('transcript_cue')
        return
      }

      // Plan 05.2-06 VAD-fallback human invariant: gpt-realtime does not reliably
      // emit amd_result=human even for clear human greetings. With BOTH
      // speech_started AND speech_stopped AND a non-trivial non-mailbox
      // transcript (>= 3 non-whitespace chars), default to human. §201 StGB
      // is preserved because settleHuman fires ONLY after the caller spoke.
      if (
        speechStartedObserved &&
        speechStoppedObserved &&
        text.replace(/\s/g, '').length >= 3
      ) {
        opts.log.info({
          event: 'case_2_amd_vad_fallback_human',
          call_id: opts.callId,
          transcript_preview: text.slice(0, 60),
        })
        settleHuman()
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
      if (captureTimer !== null) {
        timers.clearTimeout(captureTimer)
        captureTimer = null
      }
      inCaptureWindow = false
    },

    getVerdict(): AmdVerdict {
      return verdict
    },

    isAudioLeaked(): boolean {
      return audioLeaked
    },
  }
}
