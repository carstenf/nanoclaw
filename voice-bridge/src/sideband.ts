// voice-bridge/src/sideband.ts
// D-26 / D-43 / DIR-01..DIR-05:
// Opens a per-call WebSocket to the OpenAI Realtime sideband, tracks the
// connect SLA, sends instructions-only session.update messages. Graceful
// degrade on error; hot-path never blocks on this module.
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

export interface SidebandState {
  callId: string
  ready: boolean
  ws: WSType | null
  openedAt: number
  lastUpdateAt: number
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
  /**
   * Invoked when the sideband WS closes. This is the authoritative call-end
   * signal: OpenAI's Realtime API does NOT emit a `realtime.call.completed`
   * webhook (only `realtime.call.incoming`), and there is no
   * `session.closed` server-event. Teardown is triggered by the WS close,
   * with 02-06 startTeardown's 5s timer as the belt-and-suspenders fallback.
   */
  onClose?: (callId: string) => void
  /**
   * Plan 02-10: Invoked per user-utterance-turn-end, i.e. when an OpenAI
   * Realtime `conversation.item.input_audio_transcription.completed` event
   * arrives on the sideband WS. Carries the stable item_id as turnId and the
   * final transcript text. Callers wire this to `slowBrain.push({...})`.
   */
  onTranscriptTurn?: (turnId: string, transcript: string) => void
  /**
   * Plan 02-11: DI hook for dispatchTool. If provided, used instead of the
   * real dispatchTool import. Allows tests to mock without side-effects.
   * Production callers (call-router) leave this unset — the sideband module
   * imports the real dispatchTool lazily via dynamic import to avoid circular
   * dependency at module load time.
   */
  dispatchTool?: DispatchToolFn
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
  }
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

  ws.on('message', (raw: unknown) => {
    // Plan 02-10 + 02-11: parse OpenAI Realtime events.
    // Any JSON-parse failure or unexpected shape is swallowed with a WARN —
    // message-loop must never crash the WS (REQ-DIR-02 hot-path-continuity).
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
      }

      // Plan 02-10: user-utterance transcript completed → slow-brain push
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

      // Plan 02-11: function_call_arguments.done → dispatch tool fire-and-forget
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

/**
 * Lazy loader for the real dispatchTool to avoid circular imports at
 * module load time. Cached after first call.
 */
let _cachedDispatch: DispatchToolFn | null = null
function _getDispatchTool(): DispatchToolFn {
  if (_cachedDispatch) return _cachedDispatch
  // Dynamic require at runtime — safe because this path is only hit in
  // production (tests inject via opts.dispatchTool DI).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./tools/dispatch.js') as {
    dispatchTool: DispatchToolFn
  }
  _cachedDispatch = mod.dispatchTool
  return _cachedDispatch
}

/**
 * D-26 / AC-05: instructions-only session.update. Any `tools` key in the
 * extra-session payload is stripped and logged BUG-level before send.
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
  const session: Record<string, unknown> = { ...extraSession, instructions }
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
