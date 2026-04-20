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

/**
 * Structured details parsed from Sipgate error responses (Spike-B 2026-04-20).
 *
 * Spike-B verdict: Sipgate originate returns 200 OK for ALL async outcomes
 * (busy, no-answer, voicemail). Only pre-submission sync errors carry HTTP
 * error codes. See spike-results/SPIKE-B-sipgate-486.md.
 *
 * Research §4.4 fallback: treat all non-2xx originate responses as retryable
 * UNLESS the body matches a known non-retryable pattern (e.g. invalid_number).
 */
export interface SipgateRestErrorDetails {
  /** true when Sipgate returned a "could not validate phonenumber" 400 body. */
  invalidNumber?: boolean;
  /** true when this error is retryable (Research §4.4 fallback — all unknowns). */
  retryable?: boolean;
  /** true when Sipgate returned a known busy signal (RESERVED — Spike-B: not distinguishable). */
  lineBusy?: boolean;
}

export class SipgateRestError extends Error {
  constructor(
    public readonly code:
      | 'auth_missing'
      | 'http_error'
      | 'network_error'
      | 'timeout',
    message: string,
    public readonly httpStatus?: number,
    public readonly details?: SipgateRestErrorDetails,
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
 * Parse Sipgate error-body to determine retryability and error class.
 *
 * Spike-B 2026-04-20 findings:
 * - 400 + body.message contains "could not validate phonenumber" → invalidNumber=true, retryable=false
 * - All other non-2xx responses → retryable=true (Research §4.4 fallback)
 * - No 486 body exists — busy vs no-answer is indistinguishable from originate HTTP response
 */
function parseSipgateErrorDetails(
  status: number,
  body: unknown,
): SipgateRestErrorDetails {
  // Check for known invalid-number pattern (400 + "could not validate phonenumber")
  if (status === 400) {
    const msg =
      (body as { message?: string })?.message ??
      (typeof body === 'string' ? body : '')
    if (typeof msg === 'string' && msg.toLowerCase().includes('could not validate phonenumber')) {
      return { invalidNumber: true, retryable: false }
    }
  }
  // Research §4.4 fallback: all other non-2xx originate errors are retryable
  return { retryable: true }
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
      // Spike-B 2026-04-20: parse known Sipgate error-body shapes.
      // No 486 body exists — all async call outcomes (busy, no-answer) come
      // via History API, not from this endpoint. Only pre-submission sync errors
      // arrive here. Research §4.4 fallback: unknowns are retryable.
      const bodyStr = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
      const details = parseSipgateErrorDetails(res.status, parsed)
      throw new SipgateRestError(
        'http_error',
        `sipgate returned ${res.status}: ${bodyStr}`,
        res.status,
        details,
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
