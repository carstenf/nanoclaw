import { describe, it, expect } from 'vitest'
import { SESSION_CONFIG, IDLE_TIMEOUT_MS } from '../src/config.js'

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

/**
 * Regression guard for Plan 05.3-05a D-3 — native idle_timeout_ms replaces
 * server-side UX setTimeouts (GREET_TRIGGER_DELAY_* deleted; silence-monitor
 * UX timer retirement scoped to Plan 05.3-05b).
 *
 * Source of truth: idle-timeout-finding.md (Plan 05.3-04 D-4 deliverable).
 * Recommended value: 8000ms (clamped to API bounds 5000..30000).
 *
 * These tests pin:
 *   - idle_timeout_ms is present in turn_detection block
 *   - matches the finding-recommended default (8000)
 *   - create_response:false invariant preserved (Plan 05.2-03 D-8)
 *   - type='server_vad' invariant preserved
 */
describe('SESSION_CONFIG idle_timeout (Plan 05.3-05a D-3)', () => {
  it('IDLE_TIMEOUT_MS defaults to 8000ms (from idle-timeout-finding.md)', () => {
    expect(IDLE_TIMEOUT_MS).toBe(8000)
  })

  it('SESSION_CONFIG turn_detection.idle_timeout_ms matches finding value', () => {
    expect(
      (
        SESSION_CONFIG.audio.input.turn_detection as {
          idle_timeout_ms: number
        }
      ).idle_timeout_ms,
    ).toBe(8000)
  })

  it('Phase 05.4 Block-3: create_response=true default (REQ-VOICE-04; D-8 narrowed to case-2 only, override at webhook /accept)', () => {
    expect(SESSION_CONFIG.audio.input.turn_detection.create_response).toBe(
      true,
    )
  })

  it('invariant preserved: type=server_vad', () => {
    expect(SESSION_CONFIG.audio.input.turn_detection.type).toBe('server_vad')
  })
})
