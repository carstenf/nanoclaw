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

// Sideband WS URL template — callers substitute {callId}.
export const SIDEBAND_WS_URL_TEMPLATE =
  process.env.SIDEBAND_WS_URL_TEMPLATE ??
  'wss://api.openai.com/v1/realtime?call_id={callId}'

// ----- Plan 02-09: NanoClaw-Core MCP endpoint (Slow-Brain Retrofit) -----
// Slow-Brain-Inference lebt in NanoClaw-Core (Plan 03-02). voice-bridge ruft
// per Turn voice.on_transcript_turn via HTTP-MCP ueber WireGuard. Unset =
// slow-brain no-op mode (wie alter getAnthropicKey-Fallback).
export const CORE_MCP_URL = process.env.CORE_MCP_URL

// D-27 retention: Slow-Brain via Core hat selben Timeout-Envelope wie direkt-
// Anthropic-Calls vor 02-09.
export const CORE_MCP_TIMEOUT_MS = Number(
  process.env.CORE_MCP_TIMEOUT_MS ?? 8000,
)

// Optional Bearer-Token fuer Core-MCP-Auth. Unset = WG-only auth (aktuell v0).
export const CORE_MCP_TOKEN = process.env.CORE_MCP_TOKEN

// ----- Plan 02-11: Tool-Dispatch (Bridge → Core MCP forward) -----

// DIR-04 3s hot-path-budget for tool calls. Override via DISPATCH_TOOL_TIMEOUT_MS.
export const DISPATCH_TOOL_TIMEOUT_MS = Number(
  process.env.DISPATCH_TOOL_TIMEOUT_MS ?? 3000,
)

// JSONL path for tool_dispatch_done entries (PII-free: tool_name + latency + status).
// Follows DATA_DIR convention: BRIDGE_LOG_DIR env or ~/nanoclaw/voice-container/runs.
import { join } from 'node:path'
import { homedir } from 'node:os'

function getDataDir(): string {
  return (
    process.env.BRIDGE_LOG_DIR ??
    join(homedir(), 'nanoclaw', 'voice-container', 'runs')
  )
}

export const TOOL_DISPATCH_JSONL_PATH = join(getDataDir(), 'tool-dispatch.jsonl')

// Phase-2 /accept session knobs. Single source of truth for turn-detection
// config — tests grep on SESSION_CONFIG for VOICE-04 / VOICE-05 assertions.
// REQ-VOICE-05 (barge-in cancellation within 200 ms of counterpart VAD) is an
// OpenAI Realtime platform guarantee delivered by server_vad + create_response.
// The Bridge does NOT implement cancellation logic; its obligation is to set
// this config at /accept. See PRD AC-04 and 01-05b-SUMMARY.md sideband-ws-spike
// evidence (PSTN bidi RTP, 2026-04-16).
//
// IMPORTANT: turn_detection lives under `audio.input.turn_detection` per the
// current openai@6 SDK shape (RealtimeAudioConfigInput, realtime.d.ts:1040).
// Passing it as a top-level session field yields a 400 "Unknown parameter:
// session.turn_detection" at realtime.calls.accept().
export const SESSION_CONFIG = {
  model: 'gpt-realtime-mini' as const,
  audio: {
    input: {
      turn_detection: {
        type: 'server_vad' as const,
        threshold: 0.55,
        silence_duration_ms: 700,
        create_response: true,
      },
      // Plan 02-10: enable user-transcription so OpenAI emits
      // `conversation.item.input_audio_transcription.completed` events on the
      // sideband WS — required for the Slow-Brain push path.
      transcription: { model: 'whisper-1' as const },
    },
    output: { voice: 'cedar' as const },
  },
}
