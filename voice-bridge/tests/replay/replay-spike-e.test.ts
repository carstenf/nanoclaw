import { describe, it, expect } from 'vitest'
import { runReplayAgainstBridge, percentile } from './harness.js'
import {
  cosineOrDice,
  TEXT_SIMILARITY_MIN,
  getSimilarityChoice,
} from './text-similarity.js'

const FIXTURES = [
  'turns-1776242557.jsonl',
  'turns-1776242907.jsonl',
  'turns-1776243549.jsonl',
  'turns-1776243763.jsonl',
  'turns-1776243957.jsonl',
]

describe('Spike-E replay — SC-1 / SC-5 (D-31..D-34, REQ-VOICE-02, REQ-VOICE-03)', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture} — all turns in band (tool + non-tool use fixture-reported)`, async () => {
      const ms = await runReplayAgainstBridge(fixture)
      expect(ms.length).toBeGreaterThanOrEqual(1)
      for (const m of ms) {
        expect(m.in_band).toBe(true)
      }
    })
  }

  it('aggregate: p50 <= 900ms (VOICE-02), p95 <= 1500ms (VOICE-03) over TOOL-CALL turns only', async () => {
    const toolBucket: number[] = []
    let totalTurns = 0
    for (const fx of FIXTURES) {
      const ms = await runReplayAgainstBridge(fx)
      totalTurns += ms.length
      for (const m of ms) {
        if (m.counted_for_percentile) toolBucket.push(m.elapsed_ms)
      }
    }
    expect(totalTurns).toBeGreaterThanOrEqual(10)
    if (toolBucket.length < 10) {
      console.warn(
        `[replay] only ${toolBucket.length} tool-call turns across ${FIXTURES.length} fixtures — p50/p95 assertion skipped.`,
      )
      return
    }
    expect(percentile(toolBucket, 0.5)).toBeLessThanOrEqual(900)
    expect(percentile(toolBucket, 0.95)).toBeLessThanOrEqual(1500)
  })

  it('text-similarity helper returns >= 0.80 for identical strings and announces implementation', async () => {
    const s = await cosineOrDice('hallo carsten', 'hallo carsten')
    expect(s).toBeGreaterThanOrEqual(TEXT_SIMILARITY_MIN)
    expect(['sbert', 'dice']).toContain(getSimilarityChoice())
  })
})
