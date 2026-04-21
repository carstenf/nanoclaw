// Phase 4 (INFRA-06): accumulator.ts — per-call cost math + RAM state unit tests.
// RED during Wave-0: accumulator.ts does not exist yet; Task 2 turns this GREEN.
// Pitfall 1 (RESEARCH.md): cached_tokens is a SUBSET of input audio_tokens, not a sibling.
import { describe, it, expect, beforeEach } from 'vitest'

import {
  costOfResponseDone,
  add,
  totalEur,
  warned,
  enforced,
  markWarned,
  markEnforced,
  clearCall,
  _stateSize,
  type ResponseDoneEvent,
} from './accumulator.js'

describe('accumulator — Pitfall 1: cached_tokens is subset of audio_tokens, not sibling', () => {
  it('bills (audio - cached) at audio rate + cached at cached rate', () => {
    const evt: ResponseDoneEvent = {
      type: 'response.done',
      response: {
        usage: {
          input_token_details: {
            audio_tokens: 1000,
            cached_tokens: 200,
            text_tokens: 0,
          },
          output_token_details: { audio_tokens: 0, text_tokens: 0 },
        },
      },
    }
    const eur = costOfResponseDone(evt)
    // Plan 05.1 upgrade 2026-04-21: gpt-realtime full-tier rates ($32 audio_in, $0.40 cached).
    // (800 * 32 + 200 * 0.40) / 1e6 USD * 0.93 EUR/USD
    const expected = ((800 * 32 + 200 * 0.4) / 1_000_000) * 0.93
    expect(eur).toBeCloseTo(expected, 7)
  })

  it('returns 0 when usage absent', () => {
    expect(costOfResponseDone({ type: 'response.done' } as ResponseDoneEvent)).toBe(0)
  })

  it('includes output audio + text at full rate', () => {
    const evt: ResponseDoneEvent = {
      type: 'response.done',
      response: {
        usage: {
          input_token_details: { audio_tokens: 0, cached_tokens: 0, text_tokens: 0 },
          output_token_details: { audio_tokens: 500, text_tokens: 100 },
        },
      },
    }
    const eur = costOfResponseDone(evt)
    // Plan 05.1 upgrade 2026-04-21: gpt-realtime full-tier rates ($64 audio_out, $16 text_out).
    // (500 * 64 + 100 * 16.0) / 1e6 USD * 0.93
    const expected = ((500 * 64 + 100 * 16.0) / 1_000_000) * 0.93
    expect(eur).toBeCloseTo(expected, 7)
  })
})

describe('accumulator — per-call state', () => {
  beforeEach(() => {
    clearCall('c1')
    clearCall('c2')
  })

  it('totalEur accumulates only for given callId', () => {
    add('c1', 't1', undefined, 0.1)
    add('c1', 't2', undefined, 0.05)
    add('c2', 't1', undefined, 0.99)
    expect(totalEur('c1')).toBeCloseTo(0.15, 5)
    expect(totalEur('c2')).toBeCloseTo(0.99, 5)
  })

  it('clearCall removes only target call state', () => {
    add('c1', 't1', undefined, 0.1)
    add('c2', 't1', undefined, 0.2)
    clearCall('c1')
    expect(totalEur('c1')).toBe(0)
    expect(totalEur('c2')).toBeCloseTo(0.2, 5)
  })

  it('warned/enforced start false, set via markWarned/markEnforced', () => {
    add('c1', 't1', undefined, 0.1)
    expect(warned('c1')).toBe(false)
    expect(enforced('c1')).toBe(false)
    markWarned('c1')
    expect(warned('c1')).toBe(true)
    expect(enforced('c1')).toBe(false)
    markEnforced('c1')
    expect(enforced('c1')).toBe(true)
  })

  it('_stateSize reflects number of active calls', () => {
    expect(_stateSize()).toBe(0)
    add('c1', 't1', undefined, 0.1)
    add('c2', 't1', undefined, 0.1)
    expect(_stateSize()).toBe(2)
    clearCall('c1')
    expect(_stateSize()).toBe(1)
  })
})
