// voice-bridge/src/freeswitch-esl-client.ts
// Plan 03-11 rewrite: thin FreeSWITCH event-socket client. Single-shot
// originate command per outbound call — no event subscription, no inbound
// event stream. Connect → auth → api originate → parse +OK/-ERR → close.
//
// FreeSWITCH ESL framing: text protocol over TCP. Messages end with \n\n.
// Auth flow:
//   FS sends:  "Content-Type: auth/request\n\n"
//   We send:   "auth <password>\n\n"
//   FS sends:  "Content-Type: command/reply\nReply-Text: +OK accepted\n\n"
//
// API command flow (api = blocking):
//   We send:   "api originate ...\n\n"
//   FS sends:  "Content-Type: api/response\nContent-Length: N\n\n<body>"
//   <body> is "+OK <uuid>\n" on success or "-ERR <reason>\n" on failure.
//
// Reference: https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_event_socket_1048924/
import net from 'node:net'

import {
  ESL_HOST,
  ESL_PORT,
  ESL_PASSWORD,
  ESL_TIMEOUT_MS,
  OPENAI_SIP_PROJECT_ID,
} from './config.js'

export class EslError extends Error {
  constructor(
    public readonly code:
      | 'connect_failed'
      | 'auth_failed'
      | 'api_failed'
      | 'timeout'
      | 'protocol_error',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'EslError'
  }
}

export interface EslOriginateOpts {
  /** E.164 destination (sipgate gateway will dial this PSTN number) */
  targetPhone: string
  /** Outbound task ID — passed as channel variable for correlation */
  taskId: string
  /** Override OpenAI project ID (default OPENAI_SIP_PROJECT_ID from config) */
  projectId?: string
  /** Sipgate gateway name in FreeSWITCH (default 'sipgate') */
  gatewayName?: string
  /** OpenAI sip profile name in FreeSWITCH (default 'openai') */
  openaiProfile?: string
  /** Override host/port/password/timeout (tests). */
  host?: string
  port?: number
  password?: string
  timeoutMs?: number
  /** DI: socket factory for tests (returns a net.Socket-shaped object). */
  socketFactory?: (host: string, port: number) => net.Socket
}

export interface EslOriginateResult {
  /** FreeSWITCH-side channel UUID (the originate response payload). */
  fsUuid: string
  /** Raw +OK line for diagnostics. */
  raw: string
}

/**
 * Build the originate command body. Exposed for tests.
 *
 * Format:
 *   originate {var=val,var=val}sofia/gateway/<gw>/<E.164> &bridge(<bleg-uri>)
 *
 * - PCMA codec on both legs: required by REQ-SIP-04 refined (sipgate=PCMU on
 *   inbound, but for outbound we set PCMA on the openai leg via bridge-prefix
 *   and let sipgate negotiate down).
 * - call_uuid set to taskId so the originated leg has a deterministic UUID
 *   for cross-referencing with the OpenAI webhook flow (correlated via the
 *   active outbound-router slot).
 * - origination_caller_id_number presents Carsten's CLI on the outbound leg.
 */
export function buildOriginateCommand(opts: {
  targetPhone: string
  taskId: string
  projectId: string
  gatewayName: string
  openaiProfile: string
}): string {
  // No origination_caller_id_number override: sipgate's gateway-status check
  // showed CallsOUT=4/FailedCallsOUT=4 when we presented +49308687022345 as
  // CLI. Sipgate auths the FROM header against the registered SIP user-id
  // (8702234e5) and rejects mismatched CLIs. Letting FS use the gateway's
  // default From (sip:8702234e5@sipgate.de) is what sipgate accepts.
  const aLegVars = [
    `call_uuid=${opts.taskId}`,
    'absolute_codec_string=PCMA',
    'codec_string=PCMA',
    'hangup_after_bridge=true',
    'continue_on_fail=NORMAL_TEMPORARY_FAILURE,USER_BUSY,NO_ANSWER,ALLOTTED_TIMEOUT,NO_USER_RESPONSE',
  ].join(',')
  const aLeg = `{${aLegVars}}sofia/gateway/${opts.gatewayName}/${opts.targetPhone}`
  const bLegPrefix = '[absolute_codec_string=PCMA,codec_string=PCMA]'
  const bLegUri = `sofia/${opts.openaiProfile}/sip:${opts.projectId}@sip.api.openai.com;transport=tls`
  // bgapi (NOT api): returns Job-UUID immediately, real call setup runs in
  // background. `api originate` would block until ANSWER (up to 60s default
  // originate_timeout) which exceeds our ESL_TIMEOUT_MS — caused first PSTN
  // attempt to silently timeout at the bridge before the call ever reached
  // sipgate.
  return `bgapi originate ${aLeg} &bridge(${bLegPrefix}${bLegUri})`
}

/**
 * Connect to ESL, authenticate, send originate, return parsed result.
 * Closes the socket on every exit path.
 */
export async function eslOriginate(
  opts: EslOriginateOpts,
): Promise<EslOriginateResult> {
  const host = opts.host ?? ESL_HOST
  const port = opts.port ?? ESL_PORT
  const password = opts.password ?? ESL_PASSWORD
  const timeoutMs = opts.timeoutMs ?? ESL_TIMEOUT_MS
  const projectId = opts.projectId ?? OPENAI_SIP_PROJECT_ID
  const gatewayName = opts.gatewayName ?? 'sipgate'
  const openaiProfile = opts.openaiProfile ?? 'openai'

  if (!password) {
    throw new EslError('auth_failed', 'ESL_PASSWORD env not set')
  }

  const command = buildOriginateCommand({
    targetPhone: opts.targetPhone,
    taskId: opts.taskId,
    projectId,
    gatewayName,
    openaiProfile,
  })

  const sock: net.Socket = opts.socketFactory
    ? opts.socketFactory(host, port)
    : net.createConnection({ host, port })

  return new Promise<EslOriginateResult>((resolve, reject) => {
    let buf = ''
    let phase: 'await_auth_request' | 'await_auth_reply' | 'await_api_response' =
      'await_auth_request'
    let apiBodyExpected = -1
    let apiBody = ''
    let settled = false

    const finish = (
      err: EslError | null,
      result: EslOriginateResult | null,
    ): void => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* swallow */
      }
      if (err) reject(err)
      else if (result) resolve(result)
    }

    const timer = setTimeout(() => {
      finish(new EslError('timeout', `no response within ${timeoutMs}ms`), null)
    }, timeoutMs)

    sock.setEncoding('utf8')

    sock.on('error', (err: Error) => {
      clearTimeout(timer)
      finish(new EslError('connect_failed', err.message), null)
    })

    sock.on('close', () => {
      clearTimeout(timer)
      if (!settled) {
        finish(
          new EslError('protocol_error', 'socket closed before response'),
          null,
        )
      }
    })

    sock.on('data', (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')

      // Drain framed messages: header block ends with \n\n.
      // For api/response, body length is in Content-Length and follows
      // immediately after the empty line.
      while (true) {
        if (phase === 'await_api_response' && apiBodyExpected > 0) {
          // Reading body
          if (buf.length >= apiBodyExpected) {
            apiBody = buf.slice(0, apiBodyExpected)
            buf = buf.slice(apiBodyExpected)
            const trimmed = apiBody.trim()
            if (trimmed.startsWith('+OK')) {
              const fsUuid = trimmed.slice(3).trim()
              clearTimeout(timer)
              finish(null, { fsUuid, raw: trimmed })
              return
            }
            // -ERR or anything else
            clearTimeout(timer)
            finish(new EslError('api_failed', trimmed), null)
            return
          }
          return // wait for more data
        }

        const sep = buf.indexOf('\n\n')
        if (sep < 0) return // need more data
        const headerBlock = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const headers = parseHeaders(headerBlock)

        if (phase === 'await_auth_request') {
          if (headers['Content-Type'] === 'auth/request') {
            phase = 'await_auth_reply'
            sock.write(`auth ${password}\n\n`)
          }
          // else: ignore unsolicited frames before auth
          continue
        }

        if (phase === 'await_auth_reply') {
          if (
            headers['Content-Type'] === 'command/reply' &&
            (headers['Reply-Text'] ?? '').startsWith('+OK')
          ) {
            phase = 'await_api_response'
            sock.write(`${command}\n\n`)
            continue
          }
          if (headers['Content-Type'] === 'command/reply') {
            const why = headers['Reply-Text'] ?? 'unknown'
            clearTimeout(timer)
            finish(new EslError('auth_failed', why), null)
            return
          }
          // unexpected — keep draining
          continue
        }

        if (phase === 'await_api_response') {
          // bgapi originate returns command/reply with "+OK Job-UUID: <uuid>"
          // immediately. The actual call setup runs in background — we don't
          // wait for it here. Job-UUID is logged for traceability but the
          // task's openai_call_id is bound later via webhook /accept.
          if (headers['Content-Type'] === 'command/reply') {
            const reply = headers['Reply-Text'] ?? ''
            if (reply.startsWith('+OK')) {
              // Reply-Text format: "+OK Job-UUID: <uuid>"
              const jobUuid = headers['Job-UUID'] ?? reply.replace(/^\+OK\s*Job-UUID:\s*/, '').trim()
              clearTimeout(timer)
              finish(null, { fsUuid: jobUuid, raw: reply }, )
              return
            }
            clearTimeout(timer)
            finish(new EslError('api_failed', reply), null)
            return
          }
          if (headers['Content-Type'] === 'api/response') {
            const len = parseInt(headers['Content-Length'] ?? '0', 10)
            apiBodyExpected = isNaN(len) ? 0 : len
            if (apiBodyExpected === 0) {
              clearTimeout(timer)
              finish(new EslError('api_failed', 'empty body'), null)
              return
            }
            // loop will pick up the body branch
            continue
          }
          // ignore other frame types (e.g. log/data for unrelated events)
          continue
        }
      }
    })
  })
}

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key.length > 0) out[key] = val
  }
  return out
}
