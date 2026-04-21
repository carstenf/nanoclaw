// Phase 4 (INFRA-06): prices.ts — static pricing table unit tests.
// RED during Wave-0: prices.ts does not exist yet; Task 2 turns this GREEN.
import { describe, it, expect } from 'vitest'

import { PRICES_USD_PER_MTOK, USD_TO_EUR } from './prices.js'

describe('prices.ts — static pricing table (gpt-realtime full tier, Phase 05.1 upgrade 2026-04-21)', () => {
  it('exposes audio_in=32.00 USD/Mtok (full tier; 3.2x mini)', () => {
    expect(PRICES_USD_PER_MTOK.audio_in).toBe(32.0)
  })
  it('exposes audio_out=64.00 USD/Mtok (full tier; 3.2x mini)', () => {
    expect(PRICES_USD_PER_MTOK.audio_out).toBe(64.0)
  })
  it('exposes audio_cached_in=0.40 USD/Mtok (full tier; 1.33x mini)', () => {
    expect(PRICES_USD_PER_MTOK.audio_cached_in).toBe(0.4)
  })
  it('exposes text_in=4.00 USD/Mtok (full tier; 6.67x mini)', () => {
    expect(PRICES_USD_PER_MTOK.text_in).toBe(4.0)
  })
  it('exposes text_out=16.00 USD/Mtok (full tier; 6.67x mini)', () => {
    expect(PRICES_USD_PER_MTOK.text_out).toBe(16.0)
  })
  it('USD_TO_EUR defaults to 0.93 when env unset', () => {
    expect(USD_TO_EUR).toBeCloseTo(0.93, 2)
  })
})
