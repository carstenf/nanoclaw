import { describe, it, expect } from 'vitest'
import { SESSION_CONFIG } from '../src/config.js'

/**
 * Regression guard for Plan 05.1-02 defect #3 — Realtime ASR upgrade.
 *
 * Historical context:
 *   - whisper-1 (legacy) produced garbled German transcripts on 8kHz
 *     telephony audio ("Hallo, hier Restaurant Bellavista" → "Jan-Uwe
 *     das war es von Bellevista", DEFECTS §3).
 *   - gpt-4o-mini-transcribe is the 2026 OpenAI Realtime best-practice
 *     for German telephony; documented FLEURS WER improvement; drop-in
 *     swap because voice-bridge consumes only `.completed` transcript
 *     events (RESEARCH §3.5).
 *
 * This test pins both model and language so an accidental revert to
 * whisper-1 (or to `undefined`/auto language) fails CI.
 */
describe('SESSION_CONFIG transcription (defect #3 — Plan 05.1)', () => {
  it('uses gpt-4o-mini-transcribe model (not whisper-1)', () => {
    expect(SESSION_CONFIG.audio.input.transcription.model).toBe(
      'gpt-4o-mini-transcribe',
    )
  })

  it('pins language to de', () => {
    expect(SESSION_CONFIG.audio.input.transcription.language).toBe('de')
  })
})
