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

export interface SidebandOpenOpts {
  wsFactory?: (url: string, headers: Record<string, string>) => WSType
  urlTemplate?: string
  apiKey?: string
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

  ws.on('close', () => {
    state.ready = false
    clearTimeout(timer)
    log.info({ event: 'sideband_closed', call_id: callId })
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
