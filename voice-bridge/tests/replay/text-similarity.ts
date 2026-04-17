// voice-bridge/tests/replay/text-similarity.ts
// D-31: text-similarity helper. Prefers SBERT cosine via @xenova/transformers;
// falls back to dice-coefficient (from Plan 02-04) when @xenova/transformers
// is unavailable or slow-to-load. Caches the model instance across calls.
//
// Emits a single init log `similarity=sbert` or `similarity=dice` on the
// first cosineOrDice() invocation so CI output makes the implementation
// choice observable (Warning 3 fix from planner review).
import { diceCoefficient } from '../../src/readback/validator.js'

let choice: 'sbert' | 'dice' | null = null
let sbertReady: Promise<((s: string) => Promise<Float32Array>) | null> | null =
  null

async function loadSbert(): Promise<
  ((s: string) => Promise<Float32Array>) | null
> {
  try {
    // Optional dep — ignore missing-module error under NodeNext.
    // @ts-expect-error optional dep
    const mod = await import('@xenova/transformers')
    const pipeline = (mod as { pipeline: unknown }).pipeline as (
      task: string,
      model: string,
      opts?: Record<string, unknown>,
    ) => Promise<
      (
        s: string,
        opts?: Record<string, unknown>,
      ) => Promise<{ data: Float32Array }>
    >
    const embed = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      { quantized: true },
    )
    return async (s: string) => {
      const out = await embed(s, { pooling: 'mean', normalize: true })
      return out.data
    }
  } catch {
    return null
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] ** 2
    nb += b[i] ** 2
  }
  return dot / Math.max(Math.sqrt(na) * Math.sqrt(nb), 1e-9)
}

async function announce(): Promise<void> {
  if (choice !== null) return
  if (!sbertReady) sbertReady = loadSbert()
  const embed = await sbertReady
  choice = embed ? 'sbert' : 'dice'
  // Single CI-visible init line (Warning 3 fix) — console.log, NOT the pino
  // bridge logger. This is test-infra output bound for CI stdout, not a
  // structured JSONL event on the bridge log.
  console.log(`similarity=${choice}`)
}

export async function cosineOrDice(a: string, b: string): Promise<number> {
  await announce()
  if (choice === 'sbert') {
    const embed = await sbertReady
    if (embed) {
      const [ea, eb] = await Promise.all([embed(a), embed(b)])
      return cosine(ea, eb)
    }
  }
  return diceCoefficient(a, b)
}

export function getSimilarityChoice(): 'sbert' | 'dice' | null {
  return choice
}

export const TEXT_SIMILARITY_MIN = 0.8
