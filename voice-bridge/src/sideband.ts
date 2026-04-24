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
  callCoreTool as defaultCallCoreTool,
  CoreMcpClient,
} from './core-mcp-client.js'
import { sendDiscordAlert as defaultSendDiscordAlert } from './alerts.js'

/** Cost-hard-stop: farewell hold before ws.close. */
export const FAREWELL_TTS_HOLD_MS = 4000

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
  /** Core MCP client DI (production default → src/core-mcp-client.ts callCoreTool). */
  callCoreTool?: (
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
   * transcript text. Callers wire this to `slowBrain.push({...})`.
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
  coreMcp?: CoreMcpClient
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
  const callCoreToolFn = opts.callCoreTool ?? defaultCallCoreTool
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
        }
        opts.onSpeechStop?.()
        return
      }

      // Bot-audio events (output_audio_buffer.{started,stopped}). No production
      // consumers after silence-monitor retirement; fire optional hooks only.
      // `output_audio_buffer.stopped` fires after full response data is sent
      // (response.done) — conservative "bot truly finished speaking" signal.
      if (parsed?.type === 'output_audio_buffer.started') {
        opts.onBotStart?.()
        return
      }
      if (parsed?.type === 'output_audio_buffer.stopped') {
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

      // User-utterance transcript completed → slow-brain push
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

        // Parse arguments JSON string — on failure emit invalid_arguments directly
        let parsedArgs: unknown
        try {
          parsedArgs = JSON.parse(parsed.arguments as string)
        } catch {
          log.warn({
            event: 'function_call_arguments_parse_failed',
            call_id: callId,
            function_call_id: functionCallId,
            tool_name: toolName,
          })
          // Emit error directly without dispatching
          emitFunctionCallOutput(ws, functionCallId, { error: 'invalid_arguments' }, log)
          emitResponseCreate(ws, log)
          return
        }

        // Fire-and-forget dispatch — handler must not block
        const dispatch = opts.dispatchTool ?? _getDispatchTool()
        dispatch(ws, callId, 'fc-turn', functionCallId, toolName, parsedArgs, log).catch(
          (e: unknown) => {
            const err = e as Error
            log.warn({
              event: 'dispatch_tool_unhandled_error',
              call_id: callId,
              function_call_id: functionCallId,
              err: err.message,
            })
          },
        )
        return
      }

      // response.done → accumulate + fire-and-forget voice_record_turn_cost
      // + soft-warn at 80% + hard-stop at 100% (instructions-only farewell).
      // Single-threaded event loop guarantees check-and-mark atomicity of the
      // `warned` / `enforced` flags below.
      if (parsed?.type === 'response.done') {
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
    log.info({ event: 'sideband_closed', call_id: callId })
    // Close the per-call MCP session so the server-side sessions Map doesn't
    // leak one session per call. Fire-and-forget with try/catch so a close
    // failure logs but doesn't block other teardown steps. CoreMcpClient.close()
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
