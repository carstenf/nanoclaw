// voice-bridge/src/core-mcp-client-v2.ts
//
// Phase 4.5 Plan 04.5-02 (AC-09): v2 MCP client using the
// @modelcontextprotocol/sdk StreamableHTTPClientTransport. Ships alongside
// v1 (voice-bridge/src/core-mcp-client.ts) per D-9 step 3 — a safe,
// reversible migration. Wave 3 (04.5-03) swaps callers to v2 and then
// deletes v1; until then, both modules coexist.
//
// Spec sources:
//   - 04.5-RESEARCH.md §"Pattern 2: Bridge MCP client — long-lived per-call session" (lines 292-336)
//   - 04.5-CONTEXT.md D-6 (one session per live call, lazy init)
//   - 04.5-CONTEXT.md D-12 (bearer auth unchanged)
//   - 04.5-PATTERNS.md §"voice-bridge/src/core-mcp-client-v2.ts (NEW)"
//
// Design notes:
//   - SDK handles the MCP protocol envelope, handshake, session lifecycle,
//     and reconnect-on-close. We do NOT hand-roll JSON-RPC ids or
//     Mcp-Session-Id plumbing — the transport does it.
//   - Error mapping preserves class names (CoreMcpError / CoreMcpTimeoutError)
//     so downstream `instanceof` checks in tools/dispatch.ts keep working.
//   - Module-level `callCoreTool` free-function maintains a lazily-
//     initialized singleton CoreMcpClient for callers that don't hold their
//     own instance — mirrors v1's stateless call model.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import {
  CORE_MCP_URL,
  CORE_MCP_TIMEOUT_MS,
  CORE_MCP_TOKEN,
} from './config.js'

// ---------------------------------------------------------------------------
// Error classes.
//
// NOTE — v2 signatures differ from v1 on purpose (carry toolName + human
// message so callers get context-rich errors). The CLASS NAMES are preserved
// so tools/dispatch.ts `instanceof CoreMcpError` / `instanceof CoreMcpTimeoutError`
// branches continue to match after the Wave-3 import swap.
// ---------------------------------------------------------------------------
export class CoreMcpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly toolName?: string,
  ) {
    super(message)
    this.name = 'CoreMcpError'
  }
}

export class CoreMcpTimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number,
    public readonly toolName?: string,
  ) {
    super(message)
    this.name = 'CoreMcpTimeoutError'
  }
}

export interface CallCoreToolOpts {
  timeoutMs?: number
  url?: string
  token?: string
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// CoreMcpClient — long-lived per-call session holder (D-6).
//
// One CoreMcpClient instance per live voice call. Lazy-connects on first
// ensureConnected()/callTool(); bearer is attached via transport requestInit
// headers. close() is idempotent and may be called multiple times safely
// (see scenario `reconnect_after_close`).
//
// Satisfies the CoreClientLike interface from voice-bridge/src/slow-brain.ts
// so the class can be passed directly wherever callers expect a DI-injected
// tool dispatcher.
// ---------------------------------------------------------------------------
export class CoreMcpClient {
  private client: Client | null = null
  private readonly url: URL
  private readonly bearer: string | undefined
  // Serialize concurrent ensureConnected() calls so two tool invocations
  // racing on first connect don't both open a transport.
  private connecting: Promise<void> | null = null

  constructor(url: URL | string, bearer?: string) {
    this.url = url instanceof URL ? url : new URL(url)
    this.bearer = bearer
  }

  async ensureConnected(): Promise<void> {
    if (this.client) return
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const transport = new StreamableHTTPClientTransport(this.url, {
        requestInit: this.bearer
          ? { headers: { Authorization: `Bearer ${this.bearer}` } }
          : undefined,
      })
      const c = new Client(
        { name: 'voice-bridge', version: '1.0.0' },
        { capabilities: {} },
      )
      await c.connect(transport)
      this.client = c
    })()
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  async callTool(
    name: string,
    args: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    await this.ensureConnected()
    const c = this.client!
    const timeoutMs = opts.timeoutMs ?? CORE_MCP_TIMEOUT_MS
    try {
      const result = (await c.callTool(
        {
          name,
          arguments: (args as Record<string, unknown>) ?? {},
        },
        undefined,
        { timeout: timeoutMs, signal: opts.signal },
      )) as {
        content?: Array<{ type: string; text?: string }>
        isError?: boolean
      }
      if (result?.isError) {
        const text = result.content?.[0]?.text ?? 'tool returned isError'
        throw new CoreMcpError(text, undefined, name)
      }
      // Mirror v1 return shape: callers receive the parsed JSON from the
      // first text content block. Falls back to raw string on parse error,
      // and to the full result object if no text block is present.
      const first = result?.content?.[0]
      if (first && first.type === 'text' && typeof first.text === 'string') {
        try {
          return JSON.parse(first.text)
        } catch {
          return first.text
        }
      }
      return result
    } catch (err) {
      if (err instanceof CoreMcpError) throw err
      if (err instanceof CoreMcpTimeoutError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      // SDK timeout / abort surface: McpError with code -32001, or an
      // AbortError/ECONNRESET whose message contains "timeout"/"aborted".
      const errCode = (err as { code?: unknown })?.code
      const isTimeoutCode = errCode === -32001
      if (isTimeoutCode || /timed?\s*out|timeout|abort/i.test(msg)) {
        throw new CoreMcpTimeoutError(msg, timeoutMs, name)
      }
      // SDK McpError carries a numeric JSON-RPC code on .code — surface it.
      throw new CoreMcpError(
        msg,
        typeof errCode === 'number' ? errCode : undefined,
        name,
      )
    }
  }

  async close(): Promise<void> {
    if (!this.client) return // idempotent: no-op on second call
    try {
      await this.client.close()
    } catch {
      /* swallow — close must never throw out (Pitfall 4 idempotency) */
    }
    this.client = null
  }
}

// ---------------------------------------------------------------------------
// Module-private singleton for callers that don't hold their own
// CoreMcpClient. Keyed implicitly by (CORE_MCP_URL, CORE_MCP_TOKEN) — the
// opts.url / opts.token overrides create a short-lived client so the
// singleton never gets contaminated with per-call credentials.
// ---------------------------------------------------------------------------
let defaultClient: CoreMcpClient | null = null

function getDefaultClient(): CoreMcpClient {
  if (!defaultClient) {
    if (!CORE_MCP_URL) {
      throw new Error('core-mcp: CORE_MCP_URL not configured')
    }
    defaultClient = new CoreMcpClient(new URL(CORE_MCP_URL), CORE_MCP_TOKEN)
  }
  return defaultClient
}

/**
 * v1-compatible free-function. Exists so Wave-3 callers (cost/gate.ts,
 * sideband.ts, tools/dispatch.ts) can swap the import path with zero
 * signature churn.
 *
 * For per-call session holding (D-6), instantiate `CoreMcpClient` directly
 * in webhook.ts and pass it through to slow-brain.ts / pre-greet.ts via
 * CoreClientLike.
 */
export async function callCoreTool(
  name: string,
  args: unknown,
  opts: CallCoreToolOpts = {},
): Promise<unknown> {
  if (opts.url || opts.token) {
    // Per-call override: use a short-lived client so overrides don't leak
    // into the default singleton.
    const urlStr = opts.url ?? CORE_MCP_URL
    if (!urlStr) {
      throw new Error('core-mcp: CORE_MCP_URL not configured')
    }
    const client = new CoreMcpClient(
      new URL(urlStr),
      opts.token ?? CORE_MCP_TOKEN,
    )
    try {
      return await client.callTool(name, args, {
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      })
    } finally {
      await client.close()
    }
  }
  return getDefaultClient().callTool(name, args, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  })
}

/**
 * Test-only hook — resets the module singleton so tests can re-point
 * CORE_MCP_URL between cases without leaking a stale client. Not part of
 * the public API surface; production code must not call this.
 */
export function __resetDefaultClientForTests(): void {
  if (defaultClient) {
    void defaultClient.close().catch(() => undefined)
  }
  defaultClient = null
}
