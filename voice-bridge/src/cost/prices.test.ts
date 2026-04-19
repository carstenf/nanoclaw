// Phase 4 (INFRA-06): prices.ts — static pricing table unit tests.
// RED during Wave-0: prices.ts does not exist yet; Task 2 turns this GREEN.
import { describe, it, expect } from 'vitest'

import { PRICES_USD_PER_MTOK, USD_TO_EUR } from './prices.js'

describe('prices.ts — static pricing table (gpt-realtime-mini, Nov-2025)', () => {
  it('exposes audio_in=10.00 USD/Mtok', () => {
    expect(PRICES_USD_PER_MTOK.audio_in).toBe(10.0)
  })
  it('exposes audio_out=20.00 USD/Mtok', () => {
    expect(PRICES_USD_PER_MTOK.audio_out).toBe(20.0)
  })
  it('exposes audio_cached_in=0.30 USD/Mtok', () => {
    expect(PRICES_USD_PER_MTOK.audio_cached_in).toBe(0.3)
  })
  it('exposes text_in=0.60 USD/Mtok', () => {
    expect(PRICES_USD_PER_MTOK.text_in).toBe(0.6)
  })
  it('exposes text_out=2.40 USD/Mtok', () => {
    expect(PRICES_USD_PER_MTOK.text_out).toBe(2.4)
  })
  it('USD_TO_EUR defaults to 0.93 when env unset', () => {
    expect(USD_TO_EUR).toBeCloseTo(0.93, 2)
  })
})
