// voice-bridge/src/cost/prices.ts
// Phase 4 (INFRA-06, COST-01..05): static pricing table.
// Phase 05.1 live-verification (2026-04-21): upgraded from gpt-realtime-mini
// to gpt-realtime (full tier) after Operator observed persona-discipline
// failure on mini. Rates sourced via WebSearch 2026-04-21: gpt-realtime full
// tier — text $4/$16 per Mtok (6.67x mini), audio $32/$64 per Mtok (3.2x mini),
// cached audio input $0.40/Mtok (1.33x mini).
// DO NOT auto-update — pricing-refresh cron alerts on >5% drift, Operator bumps manually.
// Units: USD per 1_000_000 tokens (Mtok).
export const PRICES_USD_PER_MTOK = {
  text_in: 4.0,
  text_out: 16.0,
  audio_in: 32.0,
  audio_out: 64.0,
  audio_cached_in: 0.4,
} as const

// USD → EUR fixed rate (env-override for tests / periodic refresh).
// Default 0.93 per .planning/research/STACK.md historical.
export const USD_TO_EUR = Number(process.env.USD_TO_EUR ?? 0.93)
