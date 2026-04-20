// voice-bridge/tests/amd-classifier.test.ts
// Plan 05-03 Task 1 (RED): AMD classifier module tests
// 12 tests covering verdict routing, VAD cadence gate, transcript-cue, idempotency
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CASE2_AMD_CLASSIFIER_PROMPT,
  CASE2_MAILBOX_CUE_REGEX_V2,
  createAmdClassifier,
  type AmdVerdict,
} from '../src/amd-classifier.js'
import type { Logger } from 'pino'

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

// Fake timer helpers
type FakeTimer = { fn: () => void; ms: number; cleared: boolean; id: number }
let timerList: FakeTimer[]
let nextTimerId: number

function makeFakeTimers() {
  timerList = []
  nextTimerId = 0
  return {
    setTimeout: (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const id = nextTimerId++
      timerList.push({ fn, ms, cleared: false, id })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>): void => {
      const t = timerList.find((x) => x.id === (id as unknown as number))
      if (t) t.cleared = true
    },
  }
}

function fireTimer(ms: number): void {
  const t = timerList.find((x) => x.ms === ms && !x.cleared)
  if (t) {
    t.cleared = true // prevent double-fire
    t.fn()
  }
}

// Spike-C corpus greetings (12 entries) for regex test
const MAILBOX_CORPUS = [
  'Guten Tag, Sie sind verbunden mit der Vodafone Mailbox von plus vier neun eins sieben null acht. Bitte sprechen Sie Ihre Nachricht nach dem Tonsignal.',
  'Die gewählte Rufnummer ist zur Zeit nicht erreichbar. Auf Wiederhören.',
  'Der von Ihnen gewünschte Teilnehmer ist zur Zeit nicht erreichbar. Sie können jetzt eine Nachricht hinterlassen.',
  'Der gewünschte Gesprächspartner ist zur Zeit nicht erreichbar. Bitte hinterlassen Sie uns eine Nachricht nach dem Signalton.',
  'Der gewünschte Gesprächspartner ist derzeit nicht erreichbar. Bitte hinterlassen Sie uns eine Nachricht nach dem Signalton.',
  'Der Anruf kann im Moment nicht entgegengenommen werden. Bitte hinterlassen Sie eine Nachricht.',
  'Guten Tag, Sie sind mit Max Muster verbunden. Leider bin ich gerade nicht erreichbar. Hinterlassen Sie mir bitte eine Nachricht nach dem Signalton.',
  'Hallo, hier ist die Mailbox von Anna. Ich bin grad nicht da sprich mir nach dem Piep drauf ich ruf zurück.',
  'Willkommen bei der Max Mustermann GmbH. Wir bedauern, dass wir im Moment nicht für Sie erreichbar sind. Bitte hinterlassen Sie Ihren Namen, Ihre Rufnummer und eine kurze Nachricht nach dem Piepton.',
  'Sie haben die Fantasie GmbH erreicht. Zurzeit ist unser Büro geschlossen. Bitte hinterlassen Sie eine Nachricht oder rufen Sie zu unseren Geschäftszeiten zurück.',
  'Guten Tag, hier ist die Praxis Dr. Schmidt. Wir sind gerade nicht in der Praxis. Bitte sprechen Sie nach dem Ton.',
  'Dieser Anschluss wird zurzeit nicht bedient. Auf Wiederhören.',
]

describe('CASE2_MAILBOX_CUE_REGEX_V2', () => {
  it('test 10: matches ≥9 of 10 Spike-C corpus greetings', () => {
    // Take first 10 corpus entries (G01..G10 from Spike-C)
    const first10 = MAILBOX_CORPUS.slice(0, 10)
    const matched = first10.filter((g) => CASE2_MAILBOX_CUE_REGEX_V2.test(g))
    expect(matched.length).toBeGreaterThanOrEqual(9)
  })

  it('test 11: does NOT match "Guten Tag, Restaurant Mailbox Kitchen" (false-positive guard)', () => {
    // Restaurant name containing "Mailbox" as a marketing name — should not trigger
    const restaurantGreeting = 'Guten Tag, Restaurant Mailbox Kitchen. Wie kann ich Ihnen helfen?'
    // Reset regex lastIndex in case of global flag
    CASE2_MAILBOX_CUE_REGEX_V2.lastIndex = 0
    // This is a human greeting — should NOT match the voicemail regex
    // The regex should only match canonical voicemail tokens, not "Mailbox" as a restaurant name
    // NOTE: if regex matches on 'Mailbox' alone, this is a false positive
    // The V2 regex uses 'mailbox\s+von' (with the 'von' anchor) to avoid this
    const result = CASE2_MAILBOX_CUE_REGEX_V2.test(restaurantGreeting)
    // Expect no match: "Mailbox Kitchen" does not contain voicemail-specific tokens
    expect(result).toBe(false)
  })
})

describe('CASE2_AMD_CLASSIFIER_PROMPT', () => {
  it('is a non-empty string containing AMD instruction keywords', () => {
    expect(typeof CASE2_AMD_CLASSIFIER_PROMPT).toBe('string')
    expect(CASE2_AMD_CLASSIFIER_PROMPT.length).toBeGreaterThan(50)
    expect(CASE2_AMD_CLASSIFIER_PROMPT).toContain('amd_result')
    expect(CASE2_AMD_CLASSIFIER_PROMPT).toContain('human')
    expect(CASE2_AMD_CLASSIFIER_PROMPT).toContain('voicemail')
  })
})

describe('createAmdClassifier', () => {
  let log: Logger
  let timers: ReturnType<typeof makeFakeTimers>
  let onHuman: ReturnType<typeof vi.fn>
  let onVoicemail: ReturnType<typeof vi.fn>

  beforeEach(() => {
    log = makeLog()
    timers = makeFakeTimers()
    onHuman = vi.fn()
    onVoicemail = vi.fn()
    // reset regex state
    CASE2_MAILBOX_CUE_REGEX_V2.lastIndex = 0
  })

  function makeClassifier(overrides: { cadenceMs?: number; silenceMs?: number } = {}) {
    return createAmdClassifier({
      callId: 'test-call-1',
      log,
      onHuman,
      onVoicemail,
      cadenceMs: overrides.cadenceMs ?? 4000,
      silenceMs: overrides.silenceMs ?? 6000,
      timers,
    })
  }

  it('test 1: human greeting does NOT trigger voicemail; classifier waits for amd_result', () => {
    const c = makeClassifier()
    // Simulate transcript event with a human greeting
    c.onTranscript('Guten Tag, Restaurant Adria')
    expect(onVoicemail).not.toHaveBeenCalled()
    expect(onHuman).not.toHaveBeenCalled()
    // Classifier should still be in pending state
    expect(c.getVerdict()).toBe('pending')
  })

  it('test 2: amd_result verdict=human → onHuman called once; both timers cleared', () => {
    const c = makeClassifier()
    c.onAmdResult('human')
    expect(onHuman).toHaveBeenCalledTimes(1)
    expect(onVoicemail).not.toHaveBeenCalled()
    // Both timers should be cleared (cadence + silence)
    const clearedCount = timerList.filter((t) => t.cleared).length
    expect(clearedCount).toBe(2) // Timer A + Timer B cleared
    expect(c.getVerdict()).toBe('human')
  })

  it('test 3: amd_result verdict=voicemail → onVoicemail called; no onHuman', () => {
    const c = makeClassifier()
    c.onAmdResult('voicemail')
    expect(onVoicemail).toHaveBeenCalledWith('amd_result')
    expect(onHuman).not.toHaveBeenCalled()
    expect(c.getVerdict()).toBe('voicemail')
  })

  it('test 4: speech_started at 100ms + no speech_stopped by 4100ms → Timer A fires → onVoicemail("cadence_cue")', () => {
    const c = makeClassifier()
    // Simulate speech_started event
    c.onSpeechStarted()
    // Timer A should fire at 4000ms (cadence gate)
    fireTimer(4000)
    expect(onVoicemail).toHaveBeenCalledWith('cadence_cue')
    expect(onHuman).not.toHaveBeenCalled()
    expect(c.getVerdict()).toBe('voicemail')
  })

  it('test 5: no speech_started by 6001ms → Timer B fires → onVoicemail("silence_mailbox")', () => {
    const c = makeClassifier()
    // No speech events — Timer B fires at 6000ms
    fireTimer(6000)
    expect(onVoicemail).toHaveBeenCalledWith('silence_mailbox')
    expect(onHuman).not.toHaveBeenCalled()
    expect(c.getVerdict()).toBe('voicemail')
  })

  it('test 6: transcript matching mailbox regex → onVoicemail("transcript_cue")', () => {
    const c = makeClassifier()
    c.onTranscript('Der Teilnehmer ist zur Zeit nicht erreichbar. Bitte hinterlassen Sie eine Nachricht.')
    expect(onVoicemail).toHaveBeenCalledWith('transcript_cue')
    expect(onHuman).not.toHaveBeenCalled()
    expect(c.getVerdict()).toBe('voicemail')
  })

  it('test 7: late amd_result at 7500ms after Timer A fired at 4000ms → ignored (idempotent)', () => {
    const c = makeClassifier()
    c.onSpeechStarted()
    // Timer A fires first
    fireTimer(4000)
    expect(onVoicemail).toHaveBeenCalledTimes(1)
    // Late amd_result should be a no-op (verdict already settled)
    c.onAmdResult('human')
    expect(onHuman).not.toHaveBeenCalled()
    expect(onVoicemail).toHaveBeenCalledTimes(1)
    expect(c.getVerdict()).toBe('voicemail')
  })

  it('test 8: onHuman handler receives snapshot of sideband events up to verdict', () => {
    const c = makeClassifier()
    // Feed some events before verdict
    c.onSpeechStarted()
    c.onSpeechStopped()
    c.onTranscript('Guten Tag')
    // Now human verdict
    c.onAmdResult('human')
    expect(onHuman).toHaveBeenCalledTimes(1)
    const arg = onHuman.mock.calls[0]?.[0] as { eventLog: unknown[] } | undefined
    expect(arg).toBeDefined()
    expect(arg?.eventLog).toBeInstanceOf(Array)
    expect(arg?.eventLog.length).toBeGreaterThanOrEqual(3)
  })

  it('test 9: classifier.stop() → no more timers fire, no more handlers', () => {
    const c = makeClassifier()
    c.stop()
    // After stop, timers that fire should do nothing
    fireTimer(4000)
    fireTimer(6000)
    expect(onVoicemail).not.toHaveBeenCalled()
    expect(onHuman).not.toHaveBeenCalled()
  })

  it('test 12: audio_delta before amd_result → audioLeaked=true + log warn, classifier proceeds', () => {
    const c = makeClassifier()
    // Simulate audio delta arriving BEFORE amd_result
    c.onAudioDelta(100)
    // Should log a warning
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'case_2_audio_leaked_before_verdict' }),
    )
    // audioLeaked flag set
    expect(c.isAudioLeaked()).toBe(true)
    // Classifier still works — can receive amd_result
    c.onAmdResult('human')
    expect(onHuman).toHaveBeenCalledTimes(1)
  })
})
