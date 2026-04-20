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

// Plan 03-15 fix 22:18 PSTN: extra delay AFTER pre-greet completes before the
// initial response.create push. Default 1000ms — caller reported greet was
// audible too soon after pickup, leading to clipped first word. Tuneable via
// env without rebuild.
export const GREET_TRIGGER_DELAY_MS = Number(
  process.env.GREET_TRIGGER_DELAY_MS ?? 1000,
)

// Plan 03-11 fix 09:58 PSTN: outbound calls need a longer delay than inbound
// because Sipgate's two-leg bridge takes ~1.5-2s extra to settle the caller
// audio path after pickup. Carsten reported greet was 1-2s too early. Without
// this, the bot starts speaking before the callee can hear it.
export const GREET_TRIGGER_DELAY_OUTBOUND_MS = Number(
  process.env.GREET_TRIGGER_DELAY_OUTBOUND_MS ?? 2500,
)

// ----- Plan 03-11 pivot 2026-04-19: Sipgate REST-API outbound -----
// Sipgate Basic accounts do not support trunk-outbound (paid Trunking product
// only). REST-API is the officially-supported path for all account types.
// Decision-doc: ~/nanoclaw-state/decisions/2026-04-19-outbound-rest-api-pivot.md
export const SIPGATE_TOKEN_ID = process.env.SIPGATE_TOKEN_ID ?? ''
export const SIPGATE_TOKEN = process.env.SIPGATE_TOKEN ?? ''
/** Sipgate device id. Default 'e5' = "VoIP-Telefon NanoClaw" (the SIP device
 *  Hetzner-FS registers as). Verified live 2026-04-19 via /v2/w0/devices —
 *  device e0 from earlier code (commit 7ad0cce, April) no longer exists. */
export const SIPGATE_DEVICE_ID = process.env.SIPGATE_DEVICE_ID ?? 'e5'
/** Sipgate `caller` = phoneline-id (e.g. 'p2' = "Anschluss NanoClaw").
 *  Mandatory — without it Sipgate's API throws java.lang.NullPointerException
 *  (verified live 2026-04-19). NOT a phone number, NOT a SIP user-id. Find via
 *  GET /v2/<userId>/devices → device.activePhonelines[].id. */
export const SIPGATE_CALLER = process.env.SIPGATE_CALLER ?? 'p2'
export const SIPGATE_REST_TIMEOUT_MS = Number(
  process.env.SIPGATE_REST_TIMEOUT_MS ?? 5000,
)

// ----- Plan 03-11 rewrite ESL outbound (DEPRECATED 2026-04-19, kept as v2 fallback) -----
// FreeSWITCH event-socket connection — was the original 03-11 implementation
// path before pivoting to REST-API. Sipgate Basic does not support trunk
// outbound; if the account is upgraded to Trunking later, we can flip back.
// All ESL code is retained but inactive.
export const ESL_HOST = process.env.ESL_HOST ?? '10.0.0.1'
export const ESL_PORT = Number(process.env.ESL_PORT ?? 8021)
export const ESL_PASSWORD = process.env.ESL_PASSWORD ?? ''
export const ESL_TIMEOUT_MS = Number(process.env.ESL_TIMEOUT_MS ?? 5000)

// OpenAI Realtime SIP project ID (also referenced by inbound dialplan in
// voice-stack/conf/overlay/dialplan/public/01_sipgate_inbound.xml). Outbound
// uses the same project — bridge target is sip:<projectId>@sip.api.openai.com.
export const OPENAI_SIP_PROJECT_ID =
  process.env.OPENAI_SIP_PROJECT_ID ?? 'proj_4tEBz3XjO4gwM5hyrvsxLM8E'

// ----- Plan 02-09: NanoClaw-Core MCP endpoint (Slow-Brain Retrofit) -----
// Slow-Brain-Inference lebt in NanoClaw-Core (Plan 03-02). voice-bridge ruft
// per Turn voice_on_transcript_turn via HTTP-MCP ueber WireGuard. Unset =
// slow-brain no-op mode (wie alter getAnthropicKey-Fallback).
export const CORE_MCP_URL = process.env.CORE_MCP_URL

// D-27 retention: Slow-Brain via Core hat selben Timeout-Envelope wie direkt-
// Anthropic-Calls vor 02-09.
export const CORE_MCP_TIMEOUT_MS = Number(
  process.env.CORE_MCP_TIMEOUT_MS ?? 8000,
)

// Optional Bearer-Token fuer Core-MCP-Auth. Unset = WG-only auth (aktuell v0).
export const CORE_MCP_TOKEN = process.env.CORE_MCP_TOKEN

// ----- Plan 02-14: Case-6b persona + filler-phrase injection -----

// E.164 CLI number that maps to CASE6B_PERSONA (Carsten's personal number).
export const CARSTEN_CLI_NUMBER =
  process.env.CARSTEN_CLI_NUMBER ?? '+491708036426'

// Comma-separated list of tool names that trigger code-side filler-phrase injection.
// Default: ask_core (long container cold-start, ~90s).
export const FILLER_PHRASE_TOOLS: string[] = (
  process.env.FILLER_PHRASE_TOOLS ?? 'ask_core'
)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)

// ----- Plan 03-11: Outbound-Call Queue -----

// Maximum number of queued+active outbound tasks (prevents cost runaway).
export const OUTBOUND_QUEUE_MAX = Number(
  process.env.OUTBOUND_QUEUE_MAX ?? 10,
)

// Hard cap per outbound call (ms). Bridge fires calls.end() at this limit.
export const OUTBOUND_CALL_MAX_DURATION_MS = Number(
  process.env.OUTBOUND_CALL_MAX_DURATION_MS ?? 600000,
)

// Escalation timeout for queued tasks (ms). Task promoted to 'escalated' if
// not started within this window; Discord alert sent to report_to_jid.
export const OUTBOUND_ESCALATION_TIMEOUT_MS = Number(
  process.env.OUTBOUND_ESCALATION_TIMEOUT_MS ?? 600000,
)

// Optional Bearer token guarding POST /outbound. Empty = disabled (WG-only auth).
export const OUTBOUND_BRIDGE_AUTH_TOKEN =
  process.env.OUTBOUND_BRIDGE_AUTH_TOKEN ?? ''

// ----- Plan 02-11: Tool-Dispatch (Bridge → Core MCP forward) -----

// DIR-04 3s hot-path-budget for tool calls. Override via DISPATCH_TOOL_TIMEOUT_MS.
export const DISPATCH_TOOL_TIMEOUT_MS = Number(
  process.env.DISPATCH_TOOL_TIMEOUT_MS ?? 3000,
)

// Per-tool timeout overrides. Long-latency tools (container-spawn, Andy-Agent)
// need much more than the 3s hot-path budget. Filler-phrase bridges the UX gap.
// ask_core: 120s — Core-side ASK_CORE_ANDY_TIMEOUT_MS is 90s (container cold
// start), bridge needs ≥ that + round-trip margin. Live-verified 2026-04-18
// PSTN test 20:23: container_latency_ms ≈ 90004, 45s bridge-timeout dropped
// the voice_short output; 120s lets it through.
// Format env override: "ask_core=120000,other_tool=20000".
const TOOL_TIMEOUT_OVERRIDES_ENV =
  process.env.DISPATCH_TOOL_TIMEOUT_OVERRIDES ?? 'ask_core=120000'
export const DISPATCH_TOOL_TIMEOUT_OVERRIDES: Record<string, number> = (() => {
  const out: Record<string, number> = {}
  for (const pair of TOOL_TIMEOUT_OVERRIDES_ENV.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, ms] = pair.split('=')
    const n = Number(ms)
    if (name && Number.isFinite(n) && n > 0) out[name] = n
  }
  return out
})()

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

// ----- Plan 05-03 Wave 3: Case-2 AMD classifier timing -----

/** Overall timeout for AMD classification before silence fallback (ms). */
export const CASE2_AMD_TIMEOUT_MS = Number(
  process.env.CASE2_AMD_TIMEOUT_MS ?? 8000,
)

/** Timer A: uninterrupted speech after this long = cadence cue (mailbox). */
export const CASE2_VAD_CADENCE_MS = Number(
  process.env.CASE2_VAD_CADENCE_MS ?? 4000,
)

/** Timer B: no speech_started after this long = silence mailbox. */
export const CASE2_VAD_SILENCE_MS = Number(
  process.env.CASE2_VAD_SILENCE_MS ?? 6000,
)

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
