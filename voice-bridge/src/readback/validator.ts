// voice-bridge/src/readback/validator.ts
// D-11..D-15: Two-form readback validator. Mutating-tool dispatch gate.
// Scope: mutating tools ONLY — callers (Plan 02-07) check toolEntry.mutating
// before invoking validateReadback.
import type { Logger } from 'pino'
import { distance } from 'fastest-levenshtein'
import {
  foldDiacritics,
  normalizeGermanTime,
  normalizeGermanDate,
} from './normalize.js'

export type ReadbackDimension = 'time' | 'date' | 'name' | 'freetext'

export type ReadbackResult =
  | { ok: true }
  | {
      ok: false
      dimension: ReadbackDimension
      expected: string
      observed: string
    }

export const NAME_LEVENSHTEIN_MAX = 2 // D-13
export const FREETEXT_DICE_MIN = 0.85 // D-13

function tokens(s: string): string[] {
  return foldDiacritics(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

function diceCoefficient(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (ta.size === 0 && tb.size === 0) return 1
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return (2 * inter) / (ta.size + tb.size)
}

/**
 * Pick the dimension + (expected) pair from tool args.
 * Priority: time > date > name > freetext.
 */
function detect(
  toolArgs: Record<string, unknown>,
): { dimension: ReadbackDimension; expected: string } | null {
  if (typeof toolArgs?.time === 'string') {
    return { dimension: 'time', expected: toolArgs.time }
  }
  if (typeof toolArgs?.date === 'string') {
    // Prefer the DD component when tool arg is ISO YYYY-MM-DD.
    const m = toolArgs.date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    return { dimension: 'date', expected: m ? m[3] : toolArgs.date }
  }
  for (const key of ['title', 'provider_name', 'name', 'counterpart_name']) {
    const v = toolArgs?.[key]
    if (typeof v === 'string' && v.length > 0) {
      return { dimension: 'name', expected: v }
    }
  }
  for (const key of ['content', 'message', 'body']) {
    const v = toolArgs?.[key]
    if (typeof v === 'string') return { dimension: 'freetext', expected: v }
  }
  return null
}

export function validateReadback(
  toolArgs: Record<string, unknown> | null | undefined,
  lastUtterance: string,
  log: Logger,
  callId: string,
  turnId: string,
  toolName: string,
): ReadbackResult {
  const probe = detect(toolArgs ?? {})
  if (!probe) {
    // No readback-relevant field — schema validation already vetted shape; don't
    // double-gate. (D-15: scope is mutating tools with known fields.)
    return { ok: true }
  }
  const observed = lastUtterance ?? ''
  let ok = false

  if (probe.dimension === 'time') {
    const norm = normalizeGermanTime(observed)
    if (norm) {
      const candidates = norm.split('|')
      ok = candidates.some((c) => c === probe.expected)
    }
  } else if (probe.dimension === 'date') {
    const norm = normalizeGermanDate(observed)
    if (norm) ok = norm === probe.expected
  } else if (probe.dimension === 'name') {
    const a = foldDiacritics(observed)
    const b = foldDiacritics(probe.expected)
    ok = distance(a, b) <= NAME_LEVENSHTEIN_MAX
  } else {
    ok = diceCoefficient(observed, probe.expected) >= FREETEXT_DICE_MIN
  }

  if (ok) return { ok: true }

  log.warn({
    event: 'readback_mismatch',
    tool_name: toolName,
    call_id: callId,
    turn_id: turnId,
    expected: probe.expected,
    observed,
    tolerance_dim: probe.dimension,
  })
  return {
    ok: false,
    dimension: probe.dimension,
    expected: probe.expected,
    observed,
  }
}
