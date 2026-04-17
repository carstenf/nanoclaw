// voice-bridge/src/core-mcp-client.ts
// Plan 02-09: HTTP-MCP-Client that replaces the in-bridge Anthropic call.
// Emits AbortController-timeout wrapped POST to CORE_MCP_URL with
// {arguments: ...}. Slow-brain upstream is responsible for graceful-degrade
// on thrown errors (REQ-DIR-12).
import { CORE_MCP_URL, CORE_MCP_TIMEOUT_MS, CORE_MCP_TOKEN } from './config.js'

export class CoreMcpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`core-mcp: HTTP ${status}`)
    this.name = 'CoreMcpError'
  }
}

export class CoreMcpTimeoutError extends Error {
  constructor() {
    super('core-mcp: timeout')
    this.name = 'CoreMcpTimeoutError'
  }
}

export interface CallCoreToolOpts {
  timeoutMs?: number
  url?: string
  token?: string
  signal?: AbortSignal
}

export async function callCoreTool(
  name: string,
  args: unknown,
  opts: CallCoreToolOpts = {},
): Promise<unknown> {
  const baseUrl = opts.url ?? CORE_MCP_URL
  if (!baseUrl) {
    throw new Error('core-mcp: CORE_MCP_URL not configured')
  }
  const timeoutMs = opts.timeoutMs ?? CORE_MCP_TIMEOUT_MS
  const token = opts.token ?? CORE_MCP_TOKEN

  const ctrl = new AbortController()
  const onCallerAbort = (): void => ctrl.abort()
  if (opts.signal) opts.signal.addEventListener('abort', onCallerAbort)
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const startedAt = Date.now()
  let timedOut = false
  const toTimer = setTimeout(() => {
    timedOut = true
  }, timeoutMs)

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const res = await fetch(`${baseUrl}/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ arguments: args }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    clearTimeout(toTimer)
    if (!res.ok) {
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        /* ignore parse error */
      }
      throw new CoreMcpError(res.status, body)
    }
    return await res.json()
  } catch (err) {
    clearTimeout(timer)
    clearTimeout(toTimer)
    if (err instanceof CoreMcpError) throw err
    if (
      timedOut ||
      (err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('aborted')))
    ) {
      throw new CoreMcpTimeoutError()
    }
    throw err
  } finally {
    if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort)
    void startedAt // may be used by caller-side metrics later
  }
}
