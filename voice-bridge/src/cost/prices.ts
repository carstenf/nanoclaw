// voice-bridge/src/cost/prices.ts
// Phase 4 (INFRA-06, COST-01..05): static pricing table for gpt-realtime-mini.
// Source: https://www.eesel.ai/blog/gpt-realtime-mini-pricing (Nov 2025).
// DO NOT auto-update — pricing-refresh cron alerts on >5% drift, Carsten bumps manually.
// Units: USD per 1_000_000 tokens (Mtok).
export const PRICES_USD_PER_MTOK = {
  text_in: 0.6,
  text_out: 2.4,
  audio_in: 10.0,
  audio_out: 20.0,
  audio_cached_in: 0.3,
} as const

// USD → EUR fixed rate (env-override for tests / periodic refresh).
// Default 0.93 per .planning/research/STACK.md historical.
export const USD_TO_EUR = Number(process.env.USD_TO_EUR ?? 0.93)
