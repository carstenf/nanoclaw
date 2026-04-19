// voice-bridge/src/sipgate-rest-client.ts
// Plan 03-11 pivot 2026-04-19 (briefing 09:23): outbound via Sipgate REST-API
// instead of FreeSWITCH-Trunk-originate. Sipgate Basic accounts do NOT support
// trunk outbound — only the paid "sipgate trunking" product does. REST-API
// (`POST /v2/sessions/calls`) is the officially supported outbound path for
// all account types.
//
// Loopback model: Sipgate calls both legs (caller-side device + callee PSTN)
// and bridges server-side. Our FreeSWITCH receives an INBOUND INVITE for the
// caller-side leg, which then bridges to OpenAI as before. The outbound
// initiation is a single HTTPS POST — no SIP-side originate from our end.
//
// Decision-doc: ~/nanoclaw-state/decisions/2026-04-19-outbound-rest-api-pivot.md
import {
  SIPGATE_TOKEN_ID,
  SIPGATE_TOKEN,
  SIPGATE_DEVICE_ID,
  SIPGATE_CALLER,
  SIPGATE_REST_TIMEOUT_MS,
} from './config.js'

export class SipgateRestError extends Error {
  constructor(
    public readonly code:
      | 'auth_missing'
      | 'http_error'
      | 'network_error'
      | 'timeout',
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(`${code}: ${message}`)
    this.name = 'SipgateRestError'
  }
}

export interface SipgateOriginateOpts {
  /** E.164 destination — the PSTN number Sipgate will dial. */
  callee: string
  /** Outbound task ID — kept locally for log correlation, NOT sent to Sipgate. */
  taskId: string
  /** Override Sipgate device-id (default SIPGATE_DEVICE_ID env). */
  deviceId?: string
  /** Override caller-id presented to PSTN (default SIPGATE_CALLER env, may be empty for Sipgate-default). */
  caller?: string
  /** Override token-id (basic-auth user, default SIPGATE_TOKEN_ID env). */
  tokenId?: string
  /** Override token (basic-auth password, default SIPGATE_TOKEN env). */
  token?: string
  /** Override timeout in ms (default SIPGATE_REST_TIMEOUT_MS env). */
  timeoutMs?: number
  /** DI: fetch override for tests. */
  fetchFn?: typeof globalThis.fetch
}

export interface SipgateOriginateResult {
  /** Sipgate-side session id from the API response — opaque, for traceability. */
  sessionId: string
  /** Raw response body for logging. */
  raw: unknown
}

/**
 * Initiate an outbound call via Sipgate REST-API. Returns once Sipgate has
 * accepted the call request — actual ringing happens asynchronously.
 * Sipgate then sends an INBOUND SIP INVITE to FreeSWITCH for the caller-side
 * leg; that INVITE bridges to OpenAI per the existing inbound flow.
 */
export async function sipgateRestOriginate(
  opts: SipgateOriginateOpts,
): Promise<SipgateOriginateResult> {
  const tokenId = opts.tokenId ?? SIPGATE_TOKEN_ID
  const token = opts.token ?? SIPGATE_TOKEN
  const deviceId = opts.deviceId ?? SIPGATE_DEVICE_ID
  const caller = opts.caller ?? SIPGATE_CALLER
  const timeoutMs = opts.timeoutMs ?? SIPGATE_REST_TIMEOUT_MS
  const fetchFn = opts.fetchFn ?? globalThis.fetch

  if (!tokenId || !token) {
    throw new SipgateRestError(
      'auth_missing',
      'SIPGATE_TOKEN_ID or SIPGATE_TOKEN env not set',
    )
  }
  if (!deviceId) {
    throw new SipgateRestError('auth_missing', 'SIPGATE_DEVICE_ID env not set')
  }

  const auth = Buffer.from(`${tokenId}:${token}`).toString('base64')

  const body: Record<string, string> = {
    deviceId,
    callee: opts.callee,
  }
  if (caller && caller.length > 0) {
    body.caller = caller
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  try {
    const res = await fetchFn('https://api.sipgate.com/v2/sessions/calls', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    clearTimeout(timer)

    let parsed: unknown = null
    const text = await res.text()
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = text
      }
    }

    if (!res.ok) {
      throw new SipgateRestError(
        'http_error',
        `sipgate returned ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`,
        res.status,
      )
    }

    const sessionId =
      (parsed as { sessionId?: unknown })?.sessionId &&
      typeof (parsed as { sessionId?: unknown }).sessionId === 'string'
        ? ((parsed as { sessionId: string }).sessionId)
        : ''
    return { sessionId, raw: parsed }
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof SipgateRestError) throw err
    const msg = (err as Error).message ?? String(err)
    if (msg.includes('aborted') || (err as { name?: string }).name === 'AbortError') {
      throw new SipgateRestError(
        'timeout',
        `no response within ${timeoutMs}ms`,
      )
    }
    throw new SipgateRestError('network_error', msg)
  }
}
