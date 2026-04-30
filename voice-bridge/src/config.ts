// voice-bridge/src/config.ts
// Phase 05.3 — Environment variable loading + SESSION_CONFIG (OpenAI Realtime
// /accept session body). PORT, HOST, WG_PEER_URL, DISCORD_ALERT_WEBHOOK_URL
// are safe to read at module load. Secrets (OPENAI_WEBHOOK_SECRET, API keys)
// are validated lazily via getSecret()/getApiKey() so vitest can import this
// module without triggering process.exit.
//
// Load-bearing invariants inside SESSION_CONFIG (canonical reference — do NOT
// edit without re-reading D-8 + idle-timeout-finding):
//   - turn_detection.create_response = true (REQ-VOICE-04 default as of Phase
//     05.4 Block-3). D-8 wait-for-speech narrowed to case_type='case_2' where
//     webhook.ts /accept overrides this to false so the bot stays silent
//     until AMD classifies voicemail vs human. Case-1 / Case-6b / inbound
//     use the true default + speak-first (native server_vad turn-taking).
//   - turn_detection.idle_timeout_ms = IDLE_TIMEOUT_MS (5000..30000 API bounds,
//     default 10000 per REQ-VOICE-08): native post-bot-turn silence trigger;
//     independent of create_response; chains off response.done so it's
//     dormant before the first bot turn — preserves §201 StGB AMD-gate
//     invariant (no audio leak pre-verdict).
// See .planning/phases/05.3-refactor-cleanup-timer-removal/idle-timeout-finding.md

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

// ----- Phase 2 additions -----

// D-43: Sideband WS connect-within-1500ms SLA (measured from /accept 200 to sideband_ready).
export const SIDEBAND_CONNECT_TIMEOUT_MS = Number(
  process.env.SIDEBAND_CONNECT_TIMEOUT_MS ?? 1500,
)

// Sideband WS URL template — callers substitute {callId}.
export const SIDEBAND_WS_URL_TEMPLATE =
  process.env.SIDEBAND_WS_URL_TEMPLATE ??
  'wss://api.openai.com/v1/realtime?call_id={callId}'

// Native OpenAI Realtime idle-timeout window (ms). Replaces legacy server-side
// UX setTimeouts (greet-trigger-delay constants retired). API bounds 5000..30000
// (server rejects out-of-range with 400); env override clamped here for safety.
// Phase 05.4 Block-4: default raised 8000 → 10000 for REQ-VOICE-08 compliance
// ("No-speech for 10s → 'Sind Sie noch da?'"). Paired with SILENCE_FALLBACK_MS
// = 10500 in sideband.ts (covers native 10s + 500ms race-jitter) so the Bridge
// backstop only fires when OpenAI's re-arm fails (Bug-4 evidence).
export const IDLE_TIMEOUT_MS = Math.max(
  5000,
  Math.min(30000, Number(process.env.IDLE_TIMEOUT_MS ?? 10000)),
)

// Phase 05.4 Block-5: per-call sideband-event trace directory. Replaces the
// interim `/tmp/spike-a-trace-*.jsonl` path (commit d6bf803) with the
// REQ-INFRA-05 / REQ-VOICE-10 location:
//   `~/nanoclaw/voice-container/runs/turns-{call_id}.jsonl`
// §201-redaction of `response.audio.delta` bytes is enforced in
// sideband.ts `maybeWriteTrace` (`delta_bytes` count only, no PCM payload).
// Retention: external trace-sweeper (see scripts/trace-sweep.sh + the
// voice-channel-spec/tracing-contract.md) rotates + gzips after 7 days and
// deletes after 90 days. Env override VOICE_TRACE_DIR for tests / local dev.
export const VOICE_TRACE_DIR =
  process.env.VOICE_TRACE_DIR ??
  (process.env.HOME
    ? `${process.env.HOME}/nanoclaw/voice-container/runs`
    : '/home/carsten_bot/nanoclaw/voice-container/runs')

/** Build the REQ-INFRA-05 trace path for a given callId (ASCII-safe). */
export function buildTracePath(callId: string): string {
  const safe = callId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${VOICE_TRACE_DIR}/turns-${safe}.jsonl`
}

// ----- Sipgate REST-API outbound (Basic accounts don't support trunk-outbound) -----
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

// ----- Nanoclaw-Voice MCP endpoint (Bridge → nanoclaw on Port 3201) -----
// Single MCP wire to NanoClaw for both persona render (voice_triggers_init /
// voice_triggers_transcript via NanoclawMcpClient) and tool dispatch (ask_core,
// voice_check_calendar, etc. via CoreMcpClient). Slow-brain endpoint retired
// in Phase 05.6.
export const NANOCLAW_VOICE_MCP_URL = process.env.NANOCLAW_VOICE_MCP_URL
export const NANOCLAW_VOICE_MCP_TOKEN = process.env.NANOCLAW_VOICE_MCP_TOKEN

// D-9: 5000 ms default per REQ-DIR-20.
export const NANOCLAW_VOICE_MCP_TIMEOUT_MS = Number(
  process.env.NANOCLAW_VOICE_MCP_TIMEOUT_MS ?? 5000,
)

// D-15 / REQ-DIR-18: minimal generic Sie-form persona used EXCLUSIVELY when
// the container-agent is unreachable at /accept (REQ-DIR-12 fallback). ~10
// lines, no case-specific content. This is the ONLY persona text the Bridge
// may contain post-Phase-05.5; all other personas live in the
// `container/skills/voice-personas/` skill (D-13).
export const FALLBACK_PERSONA =
  'Du bist NanoClaw, der Sprach-Assistent von Carsten Freek. Sprich Deutsch, kurze Saetze, Sie-Form. ' +
  'Du machst KEINE Annahme zum Zweck dieses Anrufs (kein "Reservierung", kein "Buchung", kein "Termin" voraussetzen) — frage hoeflich, womit du helfen kannst, und folge der Konversation. ' +
  'Bei Sprachwechsel des Gegenuebers: bleib bei Deutsch, sage hoeflich, dass du gerade nur Deutsch verstehst. ' +
  'Wenn du nicht weiter weisst oder ein technisches Problem auftritt: sage hoeflich Bescheid und beende den Anruf.'

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
// ask_core: 320s — Core-side ASK_CORE_ANDY_TIMEOUT_MS is 300s (5min, lifted
// from 90s 2026-04-25 so deeper Andy research has room before timeout). Bridge
// needs ≥ Core-timeout + round-trip margin (~20s).
// Format env override: "ask_core=320000,other_tool=20000".
const TOOL_TIMEOUT_OVERRIDES_ENV =
  process.env.DISPATCH_TOOL_TIMEOUT_OVERRIDES ?? 'ask_core=320000'
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

/**
 * Timer B: no speech_started after this long = silence mailbox.
 *
 * Default 30000 (30s) — accommodates the ringback window. /accept fires 2-3s
 * after SIP originate (OpenAI Realtime session ready, NOT SIP 200-OK pickup),
 * so the classifier must wait for the phone to ring AND the callee to speak.
 * Typical ringback is 10-20s before voicemail pickup; 30s covers both human
 * pickup and mailbox auto-answer comfortably. See Plan 05-03 Task 5 defect.
 */
export const CASE2_VAD_SILENCE_MS = Number(
  process.env.CASE2_VAD_SILENCE_MS ?? 30000,
)

/**
 * Voicemail-Capture-Window (ms): after AMD verdict='voicemail' the classifier
 * keeps the call open this long to collect the rest of the greeting transcript
 * before the bridge hangs up. Lets `voice_analyze_voicemail` extract opening
 * times ("ab 15 Uhr wieder erreichbar") for smart retry-scheduling instead of
 * the blind 5/15/45/120 ladder. 0 = immediate hangup (legacy behaviour).
 */
export const VOICEMAIL_CAPTURE_MS = Number(
  process.env.VOICEMAIL_CAPTURE_MS ?? 8000,
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
  // gpt-realtime (full, not mini) — holds persona role on longer turns; mini
  // exhibited role-hallucination in Case-1 outbound (Carsten 2026-04-21).
  model: 'gpt-realtime' as const,
  audio: {
    input: {
      turn_detection: {
        type: 'server_vad' as const,
        // Phase 05.4 Bug-5: lowered from 0.55 → 0.4 after live observation
        // 2026-04-24 (two-hello regression: first quiet/short "Hallo" fell
        // below threshold, callee had to repeat before VAD fired). Env
        // override `VAD_THRESHOLD` for runtime tuning (0.0..1.0). Lower =
        // more sensitive (catches quieter speech, risks false barge-in on
        // background noise); higher = stricter (rejects noise, may miss
        // quiet speech).
        threshold: Math.max(
          0.0,
          Math.min(1.0, Number(process.env.VAD_THRESHOLD ?? 0.4)),
        ),
        silence_duration_ms: 700,
        // Phase 05.4 Block-3: create_response DEFAULT is `true` per
        // REQ-VOICE-04 ("auto_create_response=true"). This is the correct
        // setting for Case-1 / Case-6b outbound (speak-first) and all
        // inbound paths. Case-2 AMD-gate overrides this to `false` at
        // /accept time in webhook.ts so the bot stays silent until the AMD
        // classifier produces a verdict — see D-8 invariant narrowed to
        // case_type='case_2' in phase 05.4 review (briefing 2026-04-24,
        // chat against voice-channel-spec/REQUIREMENTS.md). D-8 as
        // universal default contradicted REQ-VOICE-04 and produced the
        // Q2-outbound-silent-pickup hang; this narrowing resolves it.
        create_response: true,
        // idle_timeout_ms — native post-bot-turn silence trigger; independent
        // of create_response; chains off response.done so dormant before first
        // bot turn (§201 StGB AMD-gate invariant preserved for Case-2).
        idle_timeout_ms: IDLE_TIMEOUT_MS,
      },
      // User-transcription — emits conversation.item.input_audio_transcription
      // .completed events on the sideband WS (required for Slow-Brain push and
      // AMD VAD-fallback human verdict). language pinned per call (default 'de'
      // to prevent whisper auto-detect from misrouting German restaurant names).
      // Phase 06.x multilingual: per-call language picked via buildAudioConfig.
      // gpt-4o-mini-transcribe chosen over whisper-1 for FLEURS WER at 8kHz
      // telephony; we only consume `.completed` events (no `.delta` consumer).
      // Cost note: higher per-minute rate than whisper-1 — verify
      // CAP_PER_CALL_EUR still accommodates it during live verification.
      transcription: { model: 'gpt-4o-mini-transcribe' as const, language: 'de' as const },
    },
    output: { voice: 'cedar' as const },
  },
}

// ---------------------------------------------------------------------------
// Phase 06.x multilingual — per-language voice + transcription overrides.
// ---------------------------------------------------------------------------
//
// `cedar` is multilingual-trained and has been validated for DE; it is the
// safe default across all three v1 languages. To pick a different voice for
// EN / IT (e.g. a more native-sounding `marin` for EN), set
// `OPENAI_REALTIME_VOICE_{DE,EN,IT}` in voice-bridge .env — value is forwarded
// verbatim to the OpenAI Realtime session.
//
// `transcription.language` mirrors the persona language so whisper does not
// auto-detect (auto-detect occasionally misroutes proper nouns when there is
// only one short utterance).

export type CallLang = 'de' | 'en' | 'it'

const VOICE_BY_LANG: Record<CallLang, string> = {
  de: process.env.OPENAI_REALTIME_VOICE_DE ?? 'cedar',
  en: process.env.OPENAI_REALTIME_VOICE_EN ?? 'cedar',
  it: process.env.OPENAI_REALTIME_VOICE_IT ?? 'cedar',
}

/**
 * Build the per-call `audio` block for `openai.realtime.calls.accept`.
 * Picks `voice` + `transcription.language` from `lang` (default 'de').
 * Optional Case-2 AMD-gate forces `create_response:false` so the bot stays
 * silent until the classifier produces a verdict (§201 StGB invariant).
 */
export function buildAudioConfig(
  lang: CallLang = 'de',
  opts: { outboundAmdGate?: boolean } = {},
): typeof SESSION_CONFIG.audio {
  const baseInput = SESSION_CONFIG.audio.input
  const turnDetection = opts.outboundAmdGate
    ? { ...baseInput.turn_detection, create_response: false }
    : baseInput.turn_detection
  return {
    input: {
      ...baseInput,
      turn_detection: turnDetection,
      transcription: {
        ...baseInput.transcription,
        language: lang,
      },
    },
    output: { voice: VOICE_BY_LANG[lang] },
  } as typeof SESSION_CONFIG.audio
}
