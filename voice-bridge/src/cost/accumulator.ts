// voice-bridge/src/cost/accumulator.ts
// Phase 4 (INFRA-06): per-call RAM cost accumulator fed by response.done.usage.
// Guard flags `warned` and `enforced` are locked per call (single-threaded event loop
// makes the check/mark sequence atomic within one tick — Pitfall 2).
// clearCall() called from sideband.ts on session.closed (Plan 04-02 wires this).
//
// Pitfall 1 (RESEARCH §Pattern 2):
//   cached_tokens is a SUBSET of input audio_tokens, NOT a sibling field.
//   Billing formula: audio_billed = max(0, audio_tokens - cached_tokens).
//   Cached tokens are billed separately at audio_cached_in rate.
import { PRICES_USD_PER_MTOK, USD_TO_EUR } from './prices.js'

export interface ResponseDoneUsage {
  input_token_details?: {
    audio_tokens?: number
    cached_tokens?: number
    text_tokens?: number
  }
  output_token_details?: {
    audio_tokens?: number
    text_tokens?: number
  }
}

export interface ResponseDoneEvent {
  type?: string
  response?: { id?: string; usage?: ResponseDoneUsage }
}

interface CallState {
  totalEur: number
  warned: boolean
  enforced: boolean
}

const state = new Map<string, CallState>()

function getOrInit(callId: string): CallState {
  let s = state.get(callId)
  if (!s) {
    s = { totalEur: 0, warned: false, enforced: false }
    state.set(callId, s)
  }
  return s
}

/**
 * Convert OpenAI Realtime `response.done.usage` block to EUR cost.
 *
 * Pitfall 1: cached_tokens is a SUBSET of input audio_tokens, not a sibling.
 * Compute: audio_billed = max(0, audio_tokens - cached_tokens)
 */
export function costOfResponseDone(evt: ResponseDoneEvent): number {
  const u = evt?.response?.usage
  if (!u) return 0
  const i = u.input_token_details ?? {}
  const o = u.output_token_details ?? {}
  const audioIn = i.audio_tokens ?? 0
  const cachedIn = i.cached_tokens ?? 0
  // Pitfall 1: max(0, audio_tokens - cached_tokens)
  const audioInBilled = Math.max(0, audioIn - cachedIn)
  const textIn = i.text_tokens ?? 0
  const audioOut = o.audio_tokens ?? 0
  const textOut = o.text_tokens ?? 0
  const usd =
    (audioInBilled * PRICES_USD_PER_MTOK.audio_in) / 1_000_000 +
    (cachedIn * PRICES_USD_PER_MTOK.audio_cached_in) / 1_000_000 +
    (textIn * PRICES_USD_PER_MTOK.text_in) / 1_000_000 +
    (audioOut * PRICES_USD_PER_MTOK.audio_out) / 1_000_000 +
    (textOut * PRICES_USD_PER_MTOK.text_out) / 1_000_000
  return usd * USD_TO_EUR
}

export function add(
  callId: string,
  _turnId: string,
  _usage: ResponseDoneUsage | undefined,
  costEur: number,
): void {
  const s = getOrInit(callId)
  s.totalEur += costEur
}

export function totalEur(callId: string): number {
  return state.get(callId)?.totalEur ?? 0
}

export function warned(callId: string): boolean {
  return state.get(callId)?.warned ?? false
}

export function enforced(callId: string): boolean {
  return state.get(callId)?.enforced ?? false
}

export function markWarned(callId: string): void {
  getOrInit(callId).warned = true
}

export function markEnforced(callId: string): void {
  getOrInit(callId).enforced = true
}

export function clearCall(callId: string): void {
  state.delete(callId)
}

// Observability/test-only accessor — never consumed in production code paths.
export function _stateSize(): number {
  return state.size
}
