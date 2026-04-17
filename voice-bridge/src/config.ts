// src/config.ts — environment variable loading for voice-bridge
// PORT, HOST, WG_PEER_URL, DISCORD_ALERT_WEBHOOK_URL are safe to read at module load.
// SECRET is validated lazily via getSecret() so vitest can import heartbeat/alerts
// modules without triggering process.exit when the env var is set per-test beforeEach.

// Port 4402 — 4401 is reserved by NanoClaw Core's Twilio voice-server (src/voice-server.ts)
export const PORT = Number(process.env.BRIDGE_PORT ?? 4402)
export const HOST = process.env.BRIDGE_BIND ?? '10.0.0.2'

// Default WG_PEER_URL is the D-16 canonical canary endpoint:
// HTTP canary on forwarder port 9876 (NOT ICMP — see heartbeat.ts header for rationale).
export const WG_PEER_URL =
  process.env.WG_PEER_URL ?? 'http://10.0.0.1:9876/__wg_canary'

// Discord ALERT URL is optional; if empty, alerts degrade to JSONL-only
// per RESEARCH §Environment Availability fallback.
export const DISCORD_ALERT_WEBHOOK_URL = process.env.DISCORD_ALERT_WEBHOOK_URL ?? ''

/**
 * Returns the webhook secret from env. Calls process.exit(1) if missing.
 * Called lazily inside buildApp/main — never at module import time.
 */
export function getSecret(): string {
  const s = process.env.OPENAI_WEBHOOK_SECRET
  if (!s) {
    console.error('OPENAI_WEBHOOK_SECRET not set; refusing to start')
    process.exit(1)
  }
  return s
}

/**
 * OpenAI API key for realtime.calls.accept()/reject() from webhook handler.
 * Lazy-loaded (tests can build app without setting it).
 */
export function getApiKey(): string {
  // Prefer OPENAI_SIP_API_KEY (project-scoped key for proj_4tEBz3XjO4gwM5hyrvsxLM8E),
  // fall back to OPENAI_API_KEY for generic setups.
  const k = process.env.OPENAI_SIP_API_KEY || process.env.OPENAI_API_KEY
  if (!k) {
    console.error(
      'Neither OPENAI_SIP_API_KEY nor OPENAI_API_KEY set; refusing to start',
    )
    process.exit(1)
  }
  return k
}

/**
 * Inbound caller whitelist (E.164, comma-separated). Empty set = reject all.
 */
export function getWhitelist(): Set<string> {
  const raw = process.env.INBOUND_CALLER_WHITELIST ?? ''
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
}

export const PHASE1_PERSONA =
  'Du bist NanoClaw, ein freundlicher deutscher Sprach-Assistent. Antworte kurz und auf Deutsch.'

// ----- Phase 2 additions -----

// D-43: Sideband WS connect-within-1500ms SLA (measured from /accept 200 to sideband_ready).
export const SIDEBAND_CONNECT_TIMEOUT_MS = Number(
  process.env.SIDEBAND_CONNECT_TIMEOUT_MS ?? 1500,
)

// D-25: max 1 session.update per N turns (default 2). 0 disables cap.
export const SLOW_BRAIN_CADENCE_CAP = Number(
  process.env.SLOW_BRAIN_CADENCE_CAP ?? 2,
)

// D-27: Claude Sonnet async worker HTTP timeout (ms). Exceeding = graceful degrade.
export const SLOW_BRAIN_TIMEOUT_MS = Number(
  process.env.SLOW_BRAIN_TIMEOUT_MS ?? 8000,
)

// D-28: max transcript queue depth before oldest-shift back-pressure kicks in.
export const SLOW_BRAIN_QUEUE_MAX = Number(
  process.env.SLOW_BRAIN_QUEUE_MAX ?? 5,
)

// Claude model used by Slow-Brain (overridable for tests).
export const SLOW_BRAIN_MODEL =
  process.env.SLOW_BRAIN_MODEL ?? 'claude-sonnet-4-5-20241022'

// Sideband WS URL template — callers substitute {callId}.
export const SIDEBAND_WS_URL_TEMPLATE =
  process.env.SIDEBAND_WS_URL_TEMPLATE ??
  'wss://api.openai.com/v1/realtime?call_id={callId}'

/**
 * Anthropic API key for the Slow-Brain worker. Lazy getter — tests can
 * override via env in beforeEach without tripping exit at module load.
 */
export function getAnthropicKey(): string {
  const k = process.env.ANTHROPIC_API_KEY
  if (!k) {
    console.error('ANTHROPIC_API_KEY not set; refusing to start Slow-Brain')
    process.exit(1)
  }
  return k
}
