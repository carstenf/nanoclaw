// voice-bridge/src/sideband.ts
// Phase 05.3 — Per-call OpenAI Realtime sideband WS client: connect, session.update
// (instructions-only), event dispatch (VAD, transcript, tool-call, cost, idle-timeout),
// and graceful teardown. Hot-path never blocks on this module.
//
// Owning plans: 04-02 (cost enforcement), 05-00 Spike-A (trace path, §201-redacted),
// 05.1-01 (session.type discriminator, WS-error observability), 05.2-02/03 (wait-for-
// speech D-8, bot-audio events), 05.3-05a/04 (native idle_timeout_ms handler).
//
// Load-bearing invariants:
//   - Plan 05.2-03 D-8 wait-for-speech gate (see armedForFirstSpeech handler below).
//   - Plan 05.3-05a D-3 idle_timeout_ms observability parity (see input_audio_buffer.
//     timeout_triggered handler).
//   - Plan 05.1-01 session.type='realtime' discriminator on every session.update
//     (GA 2026 requires it; missing → invalid_request_error silently drops persona swap).
//   - §201 StGB zero-audio-leak: response.audio.delta bytes redacted from trace path;
//     only delta_bytes length persisted.
//
// ASCII-umlaut convention enforced project-wide (see persona/baseline.ts header).
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from 'pino'
import WebSocketLib, { type WebSocket as WSType } from 'ws'
import {
  SESSION_CONFIG,
  SIDEBAND_CONNECT_TIMEOUT_MS,
  SIDEBAND_WS_URL_TEMPLATE,
  getApiKey,
} from './config.js'
import {
  emitFunctionCallOutput,
  emitResponseCreate,
} from './tools/tool-output-emitter.js'
import { dispatchTool as realDispatchTool } from './tools/dispatch.js'
import * as defaultAccumulator from './cost/accumulator.js'
import type { ResponseDoneEvent, ResponseDoneUsage } from './cost/accumulator.js'
import {
  CAP_PER_CALL_EUR as DEFAULT_CAP_PER_CALL_EUR,
  SOFT_WARN_FRACTION as DEFAULT_SOFT_WARN_FRACTION,
} from './cost/gate.js'
import {
  callNanoclawTool as defaultCallCoreTool,
  NanoclawMcpClient,
} from './nanoclaw-mcp-client.js'
import { sendDiscordAlert as defaultSendDiscordAlert } from './alerts.js'

/** Cost-hard-stop: farewell hold before ws.close. */
export const FAREWELL_TTS_HOLD_MS = 4000

/**
 * Phase 05.4 Bug-4 fix: Bridge-side silence fallback interval. Armed on
 * `output_audio_buffer.stopped`; fires `requestResponse()` if no
 * `speech_started`, `response.created`, or new bot turn arrives within the
 * window. Set slightly longer than SESSION_CONFIG.audio.input.turn_detection
 * .idle_timeout_ms so the native OpenAI trigger wins when it fires. The
 * fallback only kicks in when the server fails to re-arm its idle_timeout
 * after an auto-generated nudge (empirically confirmed live 2026-04-24).
 *
 * Phase 05.4 Block-4: default raised 9000 → 10500 to pair with
 * IDLE_TIMEOUT_MS=10000 (REQ-VOICE-08 "10s silence" compliance). 500ms jitter
 * covers the response.done → output_audio_buffer.stopped gap so native always
 * has first shot.
 */
export const SILENCE_FALLBACK_MS = Math.max(
  1000,
  Number(process.env.SILENCE_FALLBACK_MS ?? 10500),
)

/** Cost-hard-stop session.update instructions — instructions-only (D-26/AC-05). */
export const FAREWELL_INSTR =
  "Dein Zeitbudget für dieses Gespräch ist aufgebraucht. Verabschiede dich jetzt höflich mit einem einzigen Satz, z.B. 'Vielen Dank, ich melde mich später erneut. Auf Wiederhören.' und sage danach nichts mehr."

export interface SidebandState {
  callId: string
  ready: boolean
  ws: WSType | null
  openedAt: number
  lastUpdateAt: number
  /** Surfaced by router when a call opens — finalize_call_cost uses it. */
  caseType?: string
  /** ISO string of call start, for finalize_call_cost.started_at. */
  startedAtIso?: string
  /**
   * Plan 05.2-03 D-8: outbound wait-for-speech INVARIANT. Set to `true` by
   * webhook.ts at outbound /accept (Case-1) or post-AMD-verdict (Case-2). On
   * the FIRST `input_audio_buffer.speech_stopped` after arming, the sideband
   * onmessage handler fires a single `response.create` (bot's opening turn)
   * and clears the flag so subsequent speech_stopped events do not re-fire.
   * Inbound paths leave this `false` — inbound self-greet fires
   * requestResponse synchronously at the end of /accept's pre-greet finally
   * handler.
   */
  armedForFirstSpeech: boolean
  /**
   * Phase 05.4 Bug-1 fix: idempotency guard for `enableAutoResponseCreate`.
   * D-8 wait-for-speech protects the FIRST outbound turn only (pre-AMD-verdict
   * voicemail-gate). Once the first bot turn has been explicitly driven by the
   * Bridge (armedForFirstSpeech path in Case-1/generic outbound, or the
   * post-AMD-verdict synchronous requestResponse in Case-2), we flip
   * `turn_detection.create_response` to `true` via session.update so the
   * OpenAI server handles subsequent turns natively. This flag guards against
   * double-sending the session.update from parallel entry points or from
   * repeated speech_stopped events.
   */
  autoResponseEnabled: boolean
  /**
   * Phase 05.4 Bug-3 fix: `true` while the model is actively rendering audio
   * to the counterpart leg (between `output_audio_buffer.started` and
   * `output_audio_buffer.stopped`). Consumed by the `end_call` dispatch path
   * so the bridge waits for the farewell TTS to reach the caller before
   * hanging up (prevents silent-hangup observed live on 2026-04-24).
   */
  botSpeaking: boolean
  /**
   * Phase 05.4 Bug-3 fix: single-slot resolver armed by `waitForBotAudioDone`
   * when `end_call` is dispatched mid-utterance. Fired by the onmessage
   * handler on `output_audio_buffer.stopped`, cleared by a timeout fallback.
   * null when no wait is pending.
   */
  endCallAudioWaitResolve: (() => void) | null
  /**
   * function_call ids that belong to a response.done with status="cancelled".
   * Populated by the response.done handler when a cancelled response is seen.
   * The function_call_arguments.done handler defers its parse-failure error
   * emit by one event-loop tick — if its functionCallId is found here, the
   * emit is skipped (cancelled responses' truncated args are not real bot
   * errors). Entries are removed on consume.
   */
  cancelledFunctionCallIds: Set<string>
  /**
   * Phase 05.4 Bug-4 fix: Bridge-side silence fallback timer id. Armed on
   * `output_audio_buffer.stopped` (bot just finished) and cleared on
   * `input_audio_buffer.speech_started` (user speaking), `response.created`
   * (native idle_timeout or manual response winning), or
   * `output_audio_buffer.started` (new bot turn). Fires `requestResponse()`
   * if nothing else happened within SILENCE_FALLBACK_MS — backstops the
   * empirically observed gap where OpenAI's native `idle_timeout_ms` fails
   * to re-arm after an auto-generated nudge response (live trace
   * 2026-04-24, rtc_u7_DYCdePtOupEi3nW83gqrM: first timeout fires, second
   * never does on sustained silence). Content (Nudge-1/2/3 ladder + final
   * farewell + end_call) still comes from the persona — this timer only
   * provides the trigger.
   */
  silenceFallbackTimerId: ReturnType<typeof setTimeout> | null
}

/**
 * DI for the per-call cost accumulator. Production callers leave this unset —
 * the accumulator.ts module is used. Tests pass a mock that captures add() /
 * markWarned() / markEnforced() calls.
 */
export interface CostAccumulatorLike {
  add: (
    callId: string,
    turnId: string,
    usage: ResponseDoneUsage | undefined,
    costEur: number,
  ) => void
  totalEur: (callId: string) => number
  warned: (callId: string) => boolean
  enforced: (callId: string) => boolean
  markWarned: (callId: string) => void
  markEnforced: (callId: string) => void
  clearCall: (callId: string) => void
  costOfResponseDone?: (evt: ResponseDoneEvent) => number
}

export interface SidebandHandle {
  state: SidebandState
  close: () => void
}

/**
 * DI-injectable dispatchTool signature (matches tools/dispatch.ts export).
 * Kept as a loose function type so tests can pass a vi.fn() without importing
 * the real implementation (which would pull in fs/core-mcp-client).
 */
export type DispatchToolFn = (
  ws: WSType,
  callId: string,
  turnId: string,
  functionCallId: string,
  toolName: string,
  args: unknown,
  log: Logger,
  opts?: Record<string, unknown>,
) => Promise<void>

export interface SidebandOpenOpts {
  wsFactory?: (url: string, headers: Record<string, string>) => WSType
  urlTemplate?: string
  apiKey?: string
  /** Accumulator DI (production default → src/cost/accumulator.ts). */
  costAccumulator?: CostAccumulatorLike
  /** Core MCP client DI (production default → src/core-mcp-client.ts callNanoclawTool). */
  callNanoclawTool?: (
    name: string,
    args: unknown,
    opts: { timeoutMs: number },
  ) => Promise<unknown>
  /** Discord alert DI (production default → src/alerts.ts sendDiscordAlert). */
  sendDiscordAlert?: (message: string) => Promise<void>
  /** Per-call cap (€). Default CAP_PER_CALL_EUR from gate.ts. */
  capPerCallEur?: number
  /** Soft-warn fraction. Default SOFT_WARN_FRACTION from gate.ts. */
  softWarnFraction?: number
  /** Hold time (ms) between farewell response.create and ws.close. */
  farewellTtsHoldMs?: number
  /** case_type for finalize_call_cost. Default 'unknown'. */
  caseType?: string
  /** Test-only override for setTimeout (farewell hold timer). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  /**
   * Invoked when the sideband WS closes. This is the authoritative call-end
   * signal: OpenAI's Realtime API does NOT emit a `realtime.call.completed`
   * webhook (only `realtime.call.incoming`), and there is no
   * `session.closed` server-event. Teardown is triggered by the WS close,
   * with 02-06 startTeardown's 5s timer as the belt-and-suspenders fallback.
   */
  onClose?: (callId: string) => void
  /**
   * Invoked per user-utterance-turn-end, i.e. when an OpenAI Realtime
   * `conversation.item.input_audio_transcription.completed` event arrives on
   * the sideband WS. Carries the stable item_id as turnId and the final
   * transcript text. Callers wire this to nanoclawMcp.transcript fire-and-
   * forget (call-router.ts onTranscriptTurn).
   */
  onTranscriptTurn?: (turnId: string, transcript: string) => void
  /**
   * DI hook for dispatchTool. If provided, used instead of the real
   * dispatchTool import. Allows tests to mock without side-effects.
   * Production callers (call-router) leave this unset — the sideband module
   * imports the real dispatchTool lazily via dynamic import to avoid circular
   * dependency at module load time.
   */
  dispatchTool?: DispatchToolFn
  /**
   * VAD speech-segment events. Currently wired by call-router.ts solely into
   * the AMD-classifier (Case-2 VAD-fallback human path). Legacy silence-
   * monitor forwards retired in Plan 05.3-05b when the UX state machine was
   * replaced by native turn_detection.idle_timeout_ms + persona SCHWEIGEN ladder.
   */
  onSpeechStart?: () => void
  onSpeechStop?: () => void
  /**
   * Bot-audio events. Currently optional hooks with no production consumers
   * (silence-monitor retirement removed them). Kept as no-op fire points for
   * future wiring or buildApp variants. Events are OpenAI Realtime server-
   * events: `output_audio_buffer.started` and `output_audio_buffer.stopped`.
   */
  onBotStart?: () => void
  onBotStop?: () => void
  /**
   * Per-call MCP session handle. When provided, the sideband WS-close
   * finalizer will call `coreMcp.close()` inside a try/catch — prevents
   * server-side sessions Map leak. Null/undefined in tests and when
   * CORE_MCP_URL is unset.
   */
  coreMcp?: NanoclawMcpClient
  /**
   * Spike-A trace path — when set, every raw sideband message is appended
   * (one JSON object per line) to this file. The `response.audio.delta` event
   * has its `delta` base64 payload stripped and replaced with
   * `delta_bytes: <decoded-length>` — no audio is persisted (§201 StGB).
   * Every appended record carries `t_ms_since_open` (elapsed since ws open)
   * so downstream analysis can measure pickup→verdict latency. Production
   * callers leave this unset — only the spike throwaway script sets it via
   * the outbound override envelope in webhook.ts.
   */
  traceEventsPath?: string
}

export function openSidebandSession(
  callId: string,
  log: Logger,
  opts: SidebandOpenOpts = {},
): SidebandHandle {
  const t0 = Date.now()
  const url = (opts.urlTemplate ?? SIDEBAND_WS_URL_TEMPLATE).replace(
    '{callId}',
    callId,
  )
  const key = opts.apiKey ?? getApiKey()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'OpenAI-Beta': 'realtime=v1',
  }
  const ws = opts.wsFactory
    ? opts.wsFactory(url, headers)
    : (new WebSocketLib(url, { headers }) as unknown as WSType)

  const state: SidebandState = {
    callId,
    ready: false,
    ws,
    openedAt: t0,
    lastUpdateAt: 0,
    caseType: opts.caseType ?? 'unknown',
    startedAtIso: new Date(t0).toISOString(),
    // D-8 wait-for-speech: default false; webhook.ts flips to true for outbound /accept.
    armedForFirstSpeech: false,
    // Phase 05.4 Bug-1 fix: default false; flipped to true by
    // enableAutoResponseCreate() after the first Bridge-driven bot turn.
    autoResponseEnabled: false,
    // Phase 05.4 Bug-3 fix: tracked via output_audio_buffer.{started,stopped}.
    botSpeaking: false,
    endCallAudioWaitResolve: null,
    // Phase 05.4 Bug-4 fix: armed/cleared by onmessage silence-fallback helpers.
    silenceFallbackTimerId: null,
    cancelledFunctionCallIds: new Set<string>(),
  }

  // Cost-enforcement DI. Production defaults to the real accumulator/core-mcp/
  // alerts modules; tests inject mocks to assert calls.
  const accumulator: CostAccumulatorLike =
    opts.costAccumulator ?? (defaultAccumulator as unknown as CostAccumulatorLike)
  const costOfResponseDone =
    accumulator.costOfResponseDone ??
    ((defaultAccumulator.costOfResponseDone as unknown) as (
      evt: ResponseDoneEvent,
    ) => number)
  const callCoreToolFn = opts.callNanoclawTool ?? defaultCallCoreTool
  const sendDiscordAlertFn = opts.sendDiscordAlert ?? defaultSendDiscordAlert
  const capPerCallEur = opts.capPerCallEur ?? DEFAULT_CAP_PER_CALL_EUR
  const softWarnFraction = opts.softWarnFraction ?? DEFAULT_SOFT_WARN_FRACTION
  const farewellTtsHoldMs = opts.farewellTtsHoldMs ?? FAREWELL_TTS_HOLD_MS
  const setTimeoutFn =
    opts.setTimeoutFn ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms))

  let timedOut = false
  const timer = setTimeout(() => {
    if (!state.ready) {
      timedOut = true
      log.warn({
        event: 'sideband_timeout',
        call_id: callId,
        elapsed_ms: Date.now() - t0,
      })
    }
  }, SIDEBAND_CONNECT_TIMEOUT_MS)

  ws.on('open', () => {
    if (timedOut) return
    state.ready = true
    clearTimeout(timer)
    log.info({
      event: 'sideband_ready',
      call_id: callId,
      latency_ms: Date.now() - t0,
    })
  })

  ws.on('error', (err: Error) => {
    log.warn({
      event: 'sideband_error',
      call_id: callId,
      err: err.message,
    })
  })

  // Optional Spike-A trace-writer. Idempotent dir-mkdir on first message;
  // after that, just appendFileSync per event. All errors swallowed — trace is
  // spike-only and must never crash the hot path.
  const traceEventsPath = opts.traceEventsPath
  let traceDirEnsured = false
  function maybeWriteTrace(parsed: Record<string, unknown>): void {
    if (!traceEventsPath) return
    try {
      if (!traceDirEnsured) {
        mkdirSync(dirname(traceEventsPath), { recursive: true })
        traceDirEnsured = true
      }
      let redacted: Record<string, unknown> = parsed
      // §201 StGB: redact audio.delta bytes. Keep length so spike can count
      // frames before verdict without persisting any PCM/OGG payload.
      if (parsed.type === 'response.audio.delta') {
        const rawDelta = parsed.delta
        const deltaBytes =
          typeof rawDelta === 'string'
            ? Buffer.byteLength(rawDelta, 'base64')
            : typeof rawDelta === 'object' && rawDelta !== null
              ? JSON.stringify(rawDelta).length
              : 0
        const { delta: _delta, ...rest } = parsed
        redacted = { ...rest, delta_bytes: deltaBytes }
      }
      const record = {
        t_ms_since_open: Date.now() - t0,
        ...redacted,
      }
      appendFileSync(traceEventsPath, JSON.stringify(record) + '\n', 'utf-8')
    } catch {
      /* trace write failure is never fatal */
    }
  }

  ws.on('message', (raw: unknown) => {
    // Parse OpenAI Realtime server events. Any JSON-parse failure or unexpected
    // shape is swallowed with a WARN — message-loop must never crash the WS
    // (hot-path-continuity).
    try {
      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf-8')
            : String(raw)
      const parsed = JSON.parse(text) as {
        type?: unknown
        item_id?: unknown
        transcript?: unknown
        call_id?: unknown
        name?: unknown
        arguments?: unknown
        delta?: unknown
      }

      // Trace every event if the spike-path was enabled for this call.
      // No-op when traceEventsPath is undefined.
      maybeWriteTrace(parsed as Record<string, unknown>)

      // VAD speech-segment events — currently consumed by AMD-classifier only.
      if (parsed?.type === 'input_audio_buffer.speech_started') {
        // Phase 05.4 Bug-4: user is speaking → cancel silence fallback.
        clearSilenceFallback(state)
        opts.onSpeechStart?.()
        return
      }
      if (parsed?.type === 'input_audio_buffer.speech_stopped') {
        // Plan 05.2-03 D-8 invariant: outbound wait-for-speech. If this outbound
        // call was armed at /accept (or post-AMD verdict in Case-2), the FIRST
        // speech_stopped fires the bot's opening response.create exactly once.
        // Subsequent speech_stopped events are turn-taking signals only.
        if (state.armedForFirstSpeech) {
          state.armedForFirstSpeech = false
          log.info({
            event: 'first_caller_speech_response_create',
            call_id: state.callId,
          })
          requestResponse(state, log)
          // Phase 05.4 Bug-1 fix: after the first Bridge-driven bot turn, flip
          // turn_detection.create_response to true via session.update so that
          // subsequent counterpart speech_stopped events auto-generate
          // response.create server-side (native server_vad turn-taking).
          // D-8 first-turn invariant is preserved because SESSION_CONFIG still
          // ships false at /accept — the flip only happens post-first-speech.
          // Idempotency is guarded by state.autoResponseEnabled inside the
          // helper. See .planning/phases/05.3-refactor-cleanup-timer-removal/
          // idle-timeout-finding.md Q3 for the "mid-call turn_detection
          // session.update is ATOMIC" evidence.
          enableAutoResponseCreate(state, log)
        }
        opts.onSpeechStop?.()
        return
      }

      // Bot-audio events (output_audio_buffer.{started,stopped}). Phase 05.4
      // Bug-3 fix: also tracked on state.botSpeaking so the end_call dispatch
      // path can wait for the farewell TTS to reach the caller leg before
      // calling hangup. `output_audio_buffer.stopped` fires after full
      // response data is sent (response.done) — conservative "bot truly
      // finished speaking" signal.
      if (parsed?.type === 'output_audio_buffer.started') {
        state.botSpeaking = true
        // Phase 05.4 Bug-4: a new bot turn is rendering — cancel any
        // fallback that was armed after the previous stopped event.
        clearSilenceFallback(state)
        opts.onBotStart?.()
        return
      }
      if (parsed?.type === 'output_audio_buffer.stopped') {
        state.botSpeaking = false
        // Resolve any pending end_call wait so hangup can proceed now that the
        // farewell audio has been fully delivered to the counterpart.
        if (state.endCallAudioWaitResolve) {
          const resolve = state.endCallAudioWaitResolve
          state.endCallAudioWaitResolve = null
          resolve()
        }
        // Phase 05.4 Bug-4: arm the Bridge-side silence fallback. Native
        // OpenAI idle_timeout_ms still has first shot (it fires 8000 ms
        // after response.done + audio-playback); this fallback at
        // SILENCE_FALLBACK_MS (default 9000) only kicks in when the server
        // fails to re-arm its native timer after a prior auto-nudge.
        armSilenceFallback(state, log, SILENCE_FALLBACK_MS)
        opts.onBotStop?.()
        return
      }

      // Plan 05.3-05a D-3 event-driver invariant: native idle_timeout fired.
      // Server auto-commits empty audio via input_audio_buffer.committed AND
      // auto-generates a model response (persona OUTBOUND_SCHWEIGEN /
      // INBOUND_SCHWEIGEN ladder steers the nudge text from session
      // instructions). No bridge action required — this log is for metric
      // parity with legacy silence_round_* events. See idle-timeout-finding.md.
      if (parsed?.type === 'input_audio_buffer.timeout_triggered') {
        const p = parsed as {
          audio_start_ms?: unknown
          audio_end_ms?: unknown
          item_id?: unknown
        }
        log.info({
          event: 'idle_timeout_triggered',
          call_id: state.callId,
          audio_start_ms:
            typeof p.audio_start_ms === 'number' ? p.audio_start_ms : null,
          audio_end_ms:
            typeof p.audio_end_ms === 'number' ? p.audio_end_ms : null,
          item_id: typeof p.item_id === 'string' ? p.item_id : null,
        })
        return
      }

      // User-utterance transcript completed → nanoclawMcp.transcript fire-and-forget
      if (
        opts.onTranscriptTurn &&
        parsed?.type === 'conversation.item.input_audio_transcription.completed' &&
        typeof parsed.transcript === 'string'
      ) {
        const turnId =
          typeof parsed.item_id === 'string' && parsed.item_id.length > 0
            ? parsed.item_id
            : 'unknown'
        opts.onTranscriptTurn(turnId, parsed.transcript)
        return
      }

      // function_call_arguments.done → dispatch tool fire-and-forget
      if (parsed?.type === 'response.function_call_arguments.done') {
        const functionCallId =
          typeof parsed.call_id === 'string' ? parsed.call_id : ''
        const toolName =
          typeof parsed.name === 'string' ? parsed.name : ''

        // Parse arguments JSON string. On failure we MIGHT be looking at a
        // cancelled response (OpenAI Realtime can fire response.done with
        // status="cancelled" right after this args.done event when e.g.
        // filler-inject's response.create pre-empts an in-flight tool call;
        // the cancelled response still emits args.done with whatever was
        // streamed, e.g. `{  \n  "` — truncated). Emitting `invalid_arguments`
        // for a cancelled call confuses the bot into an "Andy nicht
        // erreichbar" turn even though the original (first) tool call is
        // still in flight and would answer fine.
        //
        // Strategy: defer the error emit by one event-loop tick. The
        // response.done handler below maintains state.cancelledFunctionCallIds
        // — if our function_call_id ends up in there before our deferred
        // closure runs, we silently skip emit; else we emit as before.
        let parsedArgs: unknown
        try {
          parsedArgs = JSON.parse(parsed.arguments as string)
        } catch {
          const argsStr =
            typeof parsed.arguments === 'string' ? parsed.arguments : ''
          const argsPreview = argsStr.trim().slice(0, 200)
          setImmediate(() => {
            if (state.cancelledFunctionCallIds.has(functionCallId)) {
              log.info({
                event: 'function_call_arguments_skipped_cancelled',
                call_id: callId,
                function_call_id: functionCallId,
                tool_name: toolName,
                args_preview: argsPreview,
              })
              state.cancelledFunctionCallIds.delete(functionCallId)
              return
            }
            log.warn({
              event: 'function_call_arguments_parse_failed',
              call_id: callId,
              function_call_id: functionCallId,
              tool_name: toolName,
              args_preview: argsPreview,
            })
            emitFunctionCallOutput(
              ws,
              functionCallId,
              { error: 'invalid_arguments' },
              log,
            )
            emitResponseCreate(ws, log)
          })
          return
        }

        // Fire-and-forget dispatch — handler must not block.
        //
        // Phase 05.4 Bug-3 fix: end_call dispatch is deferred until the
        // farewell TTS has reached the counterpart leg (or timeout cap). The
        // OpenAI Realtime model emits `response.function_call_arguments.done`
        // as soon as the tool_call is fully streamed, which can arrive
        // BEFORE the bot's text/audio response has finished rendering to the
        // SIP leg. Calling hangup immediately caused silent-hangup on
        // "Tschuess" (live 2026-04-24). Waiting on `output_audio_buffer
        // .stopped` (state.botSpeaking) preserves the farewell audio.
        const dispatch = opts.dispatchTool ?? _getDispatchTool()
        // Phase 06.x: post-dispatch hook for set_language. Bridge applies
        // the new persona via TWO-STEP session.update (audio first → 50ms
        // → instructions) per Q7 atomicity mitigation. Closure captures
        // the per-call sideband `state` so the helper has the right WS.
        const applyLanguageSwitch = async (
          _callId: string,
          instructions: string,
          lang: 'de' | 'en' | 'it',
        ): Promise<boolean> => {
          // Step 1: push voice + transcription.language. cedar default
          // multilingual; per-language env overrides honored via
          // OPENAI_REALTIME_VOICE_{DE,EN,IT}.
          const VOICE_BY_LANG: Record<'de' | 'en' | 'it', string> = {
            de: process.env.OPENAI_REALTIME_VOICE_DE ?? 'cedar',
            en: process.env.OPENAI_REALTIME_VOICE_EN ?? 'cedar',
            it: process.env.OPENAI_REALTIME_VOICE_IT ?? 'cedar',
          }
          const audioOk = updateAudioConfig(
            state,
            VOICE_BY_LANG[lang],
            lang,
            log,
          )
          // Step 2: 50ms gap so the audio update lands on the server before
          // the instructions update. Q7-finding documentation-lean ATOMIC,
          // but two-step is defensive against any future split-update edge.
          await new Promise((r) => setTimeout(r, 50))
          const instrOk = updateInstructions(state, instructions, log)
          log.info({
            event: 'set_language_applied',
            call_id: state.callId,
            lang,
            audio_ok: audioOk,
            instructions_ok: instrOk,
          })
          return audioOk && instrOk
        }
        const runDispatch = (): void => {
          dispatch(
            ws,
            callId,
            'fc-turn',
            functionCallId,
            toolName,
            parsedArgs,
            log,
            { applyLanguageSwitch },
          ).catch((e: unknown) => {
            const err = e as Error
            log.warn({
              event: 'dispatch_tool_unhandled_error',
              call_id: callId,
              function_call_id: functionCallId,
              err: err.message,
            })
          })
        }
        if (toolName === 'end_call') {
          void waitForBotAudioDone(state, log).then(runDispatch)
        } else {
          runDispatch()
        }
        return
      }

      // Phase 05.4 Bug-4: response.created → a response is now in flight
      // (either native idle_timeout won, user-speech triggered auto-create,
      // or our Bridge fallback fired requestResponse). Cancel the silence
      // fallback so we don't double-fire when the response completes.
      if (parsed?.type === 'response.created') {
        clearSilenceFallback(state)
        return
      }

      // response.done → accumulate + fire-and-forget voice_record_turn_cost
      // + soft-warn at 80% + hard-stop at 100% (instructions-only farewell).
      // Single-threaded event loop guarantees check-and-mark atomicity of the
      // `warned` / `enforced` flags below.
      if (parsed?.type === 'response.done') {
        // Track function_calls that belong to a CANCELLED response so the
        // function_call_arguments.done handler's deferred error emit can
        // recognise truncated args coming from cancellation rather than from
        // a genuine bot-emitted malformed JSON. Cancelled-response args.done
        // is observed live (e.g. when filler-inject's response.create
        // pre-empts an in-flight tool call) — without this guard the bot
        // sees `error: invalid_arguments` and synthesises an "Andy nicht
        // erreichbar" turn even though the original tool call is still
        // running and would answer fine.
        const evtRaw = parsed as {
          response?: { status?: unknown; output?: unknown }
        }
        if (evtRaw?.response?.status === 'cancelled') {
          const output = Array.isArray(evtRaw.response.output)
            ? evtRaw.response.output
            : []
          for (const item of output) {
            const it = item as { type?: unknown; call_id?: unknown }
            if (
              it?.type === 'function_call' &&
              typeof it.call_id === 'string' &&
              it.call_id.length > 0
            ) {
              state.cancelledFunctionCallIds.add(it.call_id)
            }
          }
        }
        try {
          const evt = parsed as ResponseDoneEvent
          const usage = evt?.response?.usage
          // No usage block = no billable tokens reported. Skip silently to
          // avoid (a) cluttering the ledger with 0-cost rows and (b) noisy
          // voice_record_turn_cost_fail logs when Core is unreachable in
          // test fixtures that emit a bare `{type: 'response.done'}`.
          if (!usage) {
            return
          }
          const turnId = String(evt?.response?.id ?? 'unknown')
          const costEur = costOfResponseDone(evt)
          accumulator.add(callId, turnId, usage, costEur)

          // Mirror to Core — fire-and-forget. Never throw from WS handler.
          const i = usage?.input_token_details ?? {}
          const o = usage?.output_token_details ?? {}
          void callCoreToolFn(
            'voice_record_turn_cost',
            {
              call_id: callId,
              turn_id: turnId,
              audio_in_tokens: i.audio_tokens ?? 0,
              audio_out_tokens: o.audio_tokens ?? 0,
              cached_in_tokens: i.cached_tokens ?? 0,
              text_in_tokens: i.text_tokens ?? 0,
              text_out_tokens: o.text_tokens ?? 0,
              cost_eur: costEur,
            },
            { timeoutMs: 3000 },
          ).catch((err: unknown) => {
            log.warn({
              event: 'voice_record_turn_cost_fail',
              call_id: callId,
              turn_id: turnId,
              err: (err as Error).message,
            })
          })

          // Check-and-mark is atomic within one tick (single-threaded event loop).
          const perCall = accumulator.totalEur(callId)
          if (perCall >= capPerCallEur && !accumulator.enforced(callId)) {
            accumulator.markEnforced(callId)
            log.warn({ event: 'cost_hard_stop', call_id: callId, eur: perCall })
            updateInstructions(state, FAREWELL_INSTR, log)
            try {
              state.ws?.send(JSON.stringify({ type: 'response.create' }))
            } catch {
              /* best-effort */
            }
            setTimeoutFn(() => {
              try {
                state.ws?.close(1000)
              } catch {
                /* already closed */
              }
            }, farewellTtsHoldMs)
            void sendDiscordAlertFn(
              `🛑 Call ${callId} hard-stopped at €${perCall.toFixed(2)}`,
            ).catch(() => {
              /* swallow */
            })
            void callCoreToolFn(
              'voice_finalize_call_cost',
              {
                call_id: callId,
                case_type: state.caseType ?? 'unknown',
                started_at: state.startedAtIso,
                ended_at: new Date().toISOString(),
                terminated_by: 'cost_cap_call',
                soft_warn_fired: accumulator.warned(callId) ? 1 : 0,
              },
              { timeoutMs: 5000 },
            ).catch((err: unknown) => {
              log.warn({
                event: 'voice_finalize_call_cost_fail',
                call_id: callId,
                err: (err as Error).message,
              })
            })
          } else if (
            perCall >= softWarnFraction * capPerCallEur &&
            !accumulator.warned(callId)
          ) {
            accumulator.markWarned(callId)
            log.info({ event: 'cost_soft_warn', call_id: callId, eur: perCall })
            void sendDiscordAlertFn(
              `⚠️ Call ${callId} at 80% (€${perCall.toFixed(2)})`,
            ).catch(() => {
              /* swallow */
            })
          }
        } catch (err: unknown) {
          log.warn({
            event: 'response_done_handler_fail',
            call_id: callId,
            err: (err as Error).message,
          })
        }
        return
      }

      // session.closed / session.terminated → finalize_call_cost (if not
      // already enforced) + clearCall.
      if (
        parsed?.type === 'session.closed' ||
        parsed?.type === 'session.terminated'
      ) {
        try {
          if (!accumulator.enforced(callId)) {
            void callCoreToolFn(
              'voice_finalize_call_cost',
              {
                call_id: callId,
                case_type: state.caseType ?? 'unknown',
                started_at: state.startedAtIso,
                ended_at: new Date().toISOString(),
                terminated_by: 'counterpart_bye',
                soft_warn_fired: accumulator.warned(callId) ? 1 : 0,
              },
              { timeoutMs: 5000 },
            ).catch((err: unknown) => {
              log.warn({
                event: 'voice_finalize_call_cost_fail',
                call_id: callId,
                err: (err as Error).message,
              })
            })
          }
          accumulator.clearCall(callId)
        } catch (err: unknown) {
          log.warn({
            event: 'session_closed_handler_fail',
            call_id: callId,
            err: (err as Error).message,
          })
        }
        return
      }

      // Explicit OpenAI WS error handler. Without this, invalid_request_error
      // (e.g. missing session.type) is swallowed silently and defects remain
      // invisible. Log at ERROR level with full error envelope so ops can grep
      // session_update_rejected.
      if (parsed?.type === 'error') {
        const err =
          (parsed as {
            error?: {
              code?: string
              message?: string
              param?: string
              type?: string
            }
          })?.error ?? {}
        log.error({
          event: 'session_update_rejected',
          call_id: callId,
          code: err.code,
          message: err.message,
          param: err.param,
          error_type: err.type,
          openai_event_id: (parsed as { event_id?: string })?.event_id,
        })
        return
      }

      // All other event types: silent ignore.
    } catch (e: unknown) {
      const err = e as Error
      log.warn({
        event: 'sideband_message_parse_failed',
        call_id: callId,
        err: err.message,
      })
    }
  })

  ws.on('close', () => {
    state.ready = false
    clearTimeout(timer)
    // Phase 05.4 Bug-4: ensure no dangling silence fallback after ws teardown.
    clearSilenceFallback(state)
    log.info({ event: 'sideband_closed', call_id: callId })
    // Close the per-call MCP session so the server-side sessions Map doesn't
    // leak one session per call. Fire-and-forget with try/catch so a close
    // failure logs but doesn't block other teardown steps. NanoclawMcpClient.close()
    // is idempotent — safe to call even if the session was never opened.
    const coreClient = opts.coreMcp
    if (coreClient) {
      void coreClient.close().then(
        () => {
          log.info({
            event: 'bridge_core_mcp_client_closed',
            call_id: callId,
          })
        },
        (err: unknown) => {
          log.warn({
            event: 'bridge_core_mcp_client_close_failed',
            call_id: callId,
            err: err instanceof Error ? err.message : String(err),
          })
        },
      )
    }
    if (opts.onClose) {
      try {
        opts.onClose(callId)
      } catch (e: unknown) {
        const err = e as Error
        log.warn({
          event: 'sideband_onclose_handler_failed',
          call_id: callId,
          err: err.message,
        })
      }
    }
  })

  return {
    state,
    close: () => {
      state.ready = false
      clearTimeout(timer)
      try {
        if (ws.readyState === 0 /* CONNECTING */ || ws.readyState === 1 /* OPEN */) {
          ws.close(1000)
        }
      } catch {
        /* swallow — close() on an already-dead WS is not fatal */
      }
    },
  }
}

function _getDispatchTool(): DispatchToolFn {
  return realDispatchTool as unknown as DispatchToolFn
}

/**
 * Instructions-only session.update (D-26/AC-05 invariant). Any `tools` key in
 * the extra-session payload is stripped and logged BUG-level before send.
 */
export function updateInstructions(
  state: SidebandState,
  instructions: string,
  log: Logger,
  extraSession: Record<string, unknown> = {},
): boolean {
  if (!state.ready || !state.ws) {
    log.warn({
      event: 'sideband_update_skipped',
      call_id: state.callId,
      reason: 'not_ready',
    })
    return false
  }
  // Plan 05.1-01 invariant: session.type='realtime' discriminator is MANDATORY
  // on every session.update (OpenAI Realtime GA 2026). Without it the server
  // rejects with invalid_request_error(param='session.type') and the persona
  // swap silently fails. `type` is placed FIRST so extraSession spread can
  // still override it for future 'transcription' callers.
  const session: Record<string, unknown> = { type: 'realtime', ...extraSession, instructions }
  if ('tools' in session) {
    log.error({
      event: 'slow_brain_tools_field_stripped_BUG',
      call_id: state.callId,
    })
    delete session.tools
  }
  try {
    state.ws.send(JSON.stringify({ type: 'session.update', session }))
    state.lastUpdateAt = Date.now()
    return true
  } catch (e: unknown) {
    const err = e as Error
    log.warn({
      event: 'sideband_send_failed',
      call_id: state.callId,
      err: err.message,
    })
    return false
  }
}

/**
 * Phase 06.x mid-call language switch — push voice + transcription.language
 * via session.update (audio-only, no instructions). Pair with a follow-up
 * updateInstructions() to two-step the persona swap per Q7 atomicity
 * mitigation.
 */
export function updateAudioConfig(
  state: SidebandState,
  voice: string,
  transcriptionLanguage: 'de' | 'en' | 'it',
  log: Logger,
): boolean {
  if (!state.ready || !state.ws) {
    log.warn({
      event: 'sideband_audio_update_skipped',
      call_id: state.callId,
      reason: 'not_ready',
    })
    return false
  }
  // session.type='realtime' discriminator preserved (same invariant as
  // updateInstructions). audio.input.transcription updates whisper's
  // expected language; audio.output.voice swaps the TTS voice.
  const session: Record<string, unknown> = {
    type: 'realtime',
    audio: {
      input: {
        transcription: {
          model: 'gpt-4o-mini-transcribe',
          language: transcriptionLanguage,
        },
      },
      output: { voice },
    },
  }
  try {
    state.ws.send(JSON.stringify({ type: 'session.update', session }))
    state.lastUpdateAt = Date.now()
    log.info({
      event: 'sideband_audio_updated',
      call_id: state.callId,
      voice,
      transcription_language: transcriptionLanguage,
    })
    return true
  } catch (e: unknown) {
    const err = e as Error
    log.warn({
      event: 'sideband_audio_update_send_failed',
      call_id: state.callId,
      err: err.message,
    })
    return false
  }
}

/**
 * Actively request a model response. OpenAI Realtime API only generates
 * assistant audio in reaction to events — without an explicit response.create
 * the model stays silent even after session.update. Used by:
 * - Greet-trigger (post-accept synchronous greeting, inbound + outbound)
 * - Case-2 post-AMD-handoff bot-opening turn
 *
 * `instructionsOverride` injects a one-shot instruction for THIS response only,
 * leaving the session-level instructions intact. Without it, the model uses
 * the current session instructions (the persona floor or last session.update).
 */
export function requestResponse(
  state: SidebandState,
  log: Logger,
  instructionsOverride?: string,
): boolean {
  if (!state.ready || !state.ws) {
    log.warn({
      event: 'sideband_response_create_skipped',
      call_id: state.callId,
      reason: 'not_ready',
    })
    return false
  }
  const payload: Record<string, unknown> = { type: 'response.create' }
  if (instructionsOverride) {
    payload.response = { instructions: instructionsOverride }
  }
  try {
    state.ws.send(JSON.stringify(payload))
    return true
  } catch (e: unknown) {
    const err = e as Error
    log.warn({
      event: 'sideband_response_create_failed',
      call_id: state.callId,
      err: err.message,
    })
    return false
  }
}

/**
 * Phase 05.4 Bug-1 fix: flip `audio.input.turn_detection.create_response` from
 * `false` (D-8 wait-for-speech, set at /accept) to `true` so the OpenAI
 * Realtime server auto-generates `response.create` on every subsequent
 * counterpart VAD-stop event. Callers invoke this AFTER the first
 * Bridge-driven bot turn has been dispatched via `requestResponse()`:
 *
 *  - Case-1 / generic outbound: sideband onmessage handler, armedForFirstSpeech
 *    branch (the first `input_audio_buffer.speech_stopped` after /accept).
 *  - Case-2: webhook.ts `onHuman` callback, immediately after the synchronous
 *    post-AMD-verdict requestResponse.
 *
 * D-8 invariant is preserved because `SESSION_CONFIG` still ships
 * `create_response: false` at /accept — the flip only happens after the first
 * verified-human bot turn, so no bot-audio leaks before AMD classification.
 *
 * Idempotency: `state.autoResponseEnabled` guards against redundant sends from
 * parallel entry points (e.g. a post-AMD-verdict call-path that also triggers
 * an armed speech_stopped). First invocation sends session.update + flips the
 * flag; subsequent invocations no-op.
 *
 * Payload shape: the full `turn_detection` object is resent (not just the
 * `create_response` field) to avoid any ambiguity about nested-object merge
 * semantics on the server side. All other fields (threshold,
 * silence_duration_ms, idle_timeout_ms, type) preserve their SESSION_CONFIG
 * values.
 *
 * Evidence for safety of mid-call turn_detection session.update:
 * `.planning/phases/05.3-refactor-cleanup-timer-removal/idle-timeout-finding.md`
 * Q3 — Plan 05.2-05 Q7 probe showed `session.update` is ATOMIC when not
 * co-sent with a `tools` field (AC-04/AC-05 are specifically about `tools`
 * mid-call, not `turn_detection`).
 */
export function enableAutoResponseCreate(
  state: SidebandState,
  log: Logger,
): boolean {
  if (state.autoResponseEnabled) {
    return false
  }
  if (!state.ready || !state.ws) {
    log.warn({
      event: 'sideband_auto_response_enable_skipped',
      call_id: state.callId,
      reason: 'not_ready',
    })
    return false
  }
  const turnDetection = {
    ...SESSION_CONFIG.audio.input.turn_detection,
    create_response: true,
  }
  const session = {
    type: 'realtime',
    audio: { input: { turn_detection: turnDetection } },
  }
  try {
    state.ws.send(JSON.stringify({ type: 'session.update', session }))
    state.autoResponseEnabled = true
    state.lastUpdateAt = Date.now()
    log.info({
      event: 'auto_response_create_enabled',
      call_id: state.callId,
    })
    return true
  } catch (e: unknown) {
    const err = e as Error
    log.warn({
      event: 'sideband_auto_response_enable_failed',
      call_id: state.callId,
      err: err.message,
    })
    return false
  }
}

/** Phase 05.4 Bug-3: max wait for farewell TTS before end_call hangup. */
export const END_CALL_AUDIO_WAIT_MS = 4000

/**
 * Phase 05.4 Bug-4 fix: clear any pending silence fallback timer. Idempotent
 * (safe to call when no timer is armed).
 */
function clearSilenceFallback(state: SidebandState): void {
  if (state.silenceFallbackTimerId !== null) {
    clearTimeout(state.silenceFallbackTimerId)
    state.silenceFallbackTimerId = null
  }
}

/**
 * Phase 05.4 Bug-4 fix: arm the Bridge-side silence fallback timer. Replaces
 * any pending timer (last-writer-wins — safe because the next event to fire
 * will either be a clear or a new arm). On expiry, logs
 * `silence_fallback_fired` and sends `response.create` so the model picks the
 * next SCHWEIGEN-ladder nudge from session instructions.
 *
 * Clear conditions (whichever fires first):
 *  - `input_audio_buffer.speech_started`: user started speaking (real turn)
 *  - `response.created`: a response is now in flight (native idle_timeout
 *    won, or the Bridge fallback itself fired)
 *  - `output_audio_buffer.started`: new bot turn has begun rendering
 *  - ws close / teardown
 */
function armSilenceFallback(
  state: SidebandState,
  log: Logger,
  timeoutMs: number,
): void {
  clearSilenceFallback(state)
  state.silenceFallbackTimerId = setTimeout(() => {
    state.silenceFallbackTimerId = null
    log.info({
      event: 'silence_fallback_fired',
      call_id: state.callId,
      fallback_ms: timeoutMs,
    })
    requestResponse(state, log)
  }, timeoutMs)
}

/**
 * Phase 05.4 Bug-3 fix: wait for the model's current TTS response to reach
 * the counterpart leg before proceeding with hangup. Called by sideband's
 * onmessage handler on the `end_call` dispatch path.
 *
 * Resolve conditions (whichever fires first):
 *  1. `output_audio_buffer.stopped` — bot audio fully delivered
 *     (onmessage handler flips `state.botSpeaking = false` and invokes the
 *     stored resolver).
 *  2. `timeoutMs` elapsed — defensive cap so a stuck stream never blocks
 *     hangup indefinitely (log event: `end_call_audio_wait_timeout`).
 *  3. Bot was NOT speaking when called — resolve immediately (no audio to
 *     wait for, e.g. model emitted end_call without a text/audio turn).
 *
 * Single-slot: only one wait can be armed per SidebandState. A second call
 * overwrites the resolver — safe because end_call is terminal (second
 * dispatch is a no-op at the hangup level).
 */
export function waitForBotAudioDone(
  state: SidebandState,
  log: Logger,
  timeoutMs: number = END_CALL_AUDIO_WAIT_MS,
): Promise<'already_stopped' | 'stopped' | 'timeout'> {
  if (!state.botSpeaking) {
    log.info({
      event: 'end_call_audio_wait_skip_not_speaking',
      call_id: state.callId,
    })
    return Promise.resolve('already_stopped')
  }
  return new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setTimeout(() => {
      if (state.endCallAudioWaitResolve) {
        state.endCallAudioWaitResolve = null
      }
      log.warn({
        event: 'end_call_audio_wait_timeout',
        call_id: state.callId,
        elapsed_ms: Date.now() - t0,
        timeout_ms: timeoutMs,
      })
      resolve('timeout')
    }, timeoutMs)
    state.endCallAudioWaitResolve = () => {
      clearTimeout(timer)
      log.info({
        event: 'end_call_audio_wait_resolved',
        call_id: state.callId,
        elapsed_ms: Date.now() - t0,
      })
      resolve('stopped')
    }
  })
}
