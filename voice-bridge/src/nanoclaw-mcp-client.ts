// voice-bridge/src/nanoclaw-mcp-client.ts
//
// Phase 05.5 Plan 03 Task 1: Bridge-side MCP client wrapping the
// nanoclaw-voice MCP-server's `voice_triggers_init` + `voice_triggers_transcript`
// tools (REQ-DIR-20). Distinct from the legacy `core-mcp-client.ts` which
// targets the Phase-4 REST-shortcut: this client is the proper @modelcontextprotocol/sdk
// StreamableHTTP client per D-3 ("standard `@modelcontextprotocol/sdk`
// StreamableHTTP client, bearer auth, peer-allowlist, structurally identical
// to discord-mcp / tradeblocks-mcp").
//
// Design notes:
//   - 5000ms default timeout (D-9, REQ-DIR-20). NOT 8000ms like legacy
//     CORE_MCP_TIMEOUT_MS — slow-brain budget is irrelevant here.
//   - Two specific helper methods (`init`, `transcript`) per D-8 wire shape,
//     instead of a generic `callTool`. This keeps Bridge call sites typed.
//   - Error class hierarchy is deliberately distinct from CoreMcpError /
//     CoreMcpTimeoutError so `instanceof` checks during the Phase-05.5/05.6
//     rollout window cannot collide (PATTERNS.md line 93).
//   - No module-level singleton + no `__resetDefaultClientForTests` — D-3 says
//     per-call client (instantiated in webhook.ts /accept similarly to how
//     coreMcp is plumbed today). Plan 04 wires this through CallContext.
//
// Spec sources:
//   - .planning/phases/05.5-slow-brain-removal-container-agent/05.5-CONTEXT.md
//     (D-3, D-8, D-9, D-15, D-21)
//   - .planning/phases/05.5-slow-brain-removal-container-agent/05.5-PATTERNS.md
//     (`voice-bridge/src/nanoclaw-mcp-client.ts (NEW)` section)
//   - voice-bridge/src/core-mcp-client.ts (analog being replaced — structure)

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import {
  NANOCLAW_VOICE_MCP_URL,
  NANOCLAW_VOICE_MCP_TOKEN,
  NANOCLAW_VOICE_MCP_TIMEOUT_MS,
} from './config.js'

// ---------------------------------------------------------------------------
// Error classes.
//
// Distinct from CoreMcpError / CoreMcpTimeoutError so `instanceof` checks at
// call sites during the Phase-05.5/05.6 rollout window do not collide.
// Both expose `toolName` so logs/metrics can attribute failures.
// ---------------------------------------------------------------------------
export class NanoclawMcpError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly toolName?: string,
  ) {
    super(message)
    this.name = 'NanoclawMcpError'
  }
}

export class NanoclawMcpTimeoutError extends NanoclawMcpError {
  constructor(toolName: string, public readonly timeoutMs: number) {
    super(
      `nanoclaw-voice MCP call '${toolName}' timed out after ${timeoutMs}ms`,
      'TIMEOUT',
      toolName,
    )
    this.name = 'NanoclawMcpTimeoutError'
  }
}

// ---------------------------------------------------------------------------
// Wire-contract types — mirror the D-8 server-side schemas verbatim. Re-
// exported so Bridge consumers (webhook.ts /accept, sideband.ts callback)
// don't have to import from `src/mcp-tools/...` (cross-package boundary).
// ---------------------------------------------------------------------------
export interface VoiceTriggersInitInput {
  call_id: string
  case_type: 'case_2' | 'case_6a' | 'case_6b'
  call_direction: 'inbound' | 'outbound'
  counterpart_label: string
}

export interface VoiceTriggersTranscriptInput {
  call_id: string
  turn_id: number
  transcript: {
    turns: Array<{
      role: 'counterpart' | 'assistant'
      text: string
      started_at: string
    }>
  }
  fast_brain_state: {
    readback_pending?: string
    confirm_action_pending?: string
    silence_nudge_level?: 0 | 1 | 2 | 3
  }
}

// Server-side wire shape (same as the schemas in
// src/mcp-tools/voice-triggers-{init,transcript}.ts). Helpers below unwrap
// the discriminated union and surface errors as NanoclawMcpError.
type ServerInitResult =
  | { ok: true; result: { instructions: string } }
  | { ok: false; error: string }

type ServerTranscriptResult =
  | { ok: true; result: { instructions_update: string | null } }
  | { ok: false; error: string }

export interface NanoclawMcpClientOpts {
  url?: URL | string
  bearer?: string
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// NanoclawMcpClient — per-call session holder (D-3, D-6).
//
// Lazy-connect on first ensureConnected()/init()/transcript(). Bearer attached
// via transport requestInit headers. close() is idempotent. Same connect-once
// pattern as core-mcp-client.ts:96-117 (race-safe via this.connecting promise).
// ---------------------------------------------------------------------------
export class NanoclawMcpClient {
  private client: Client | null = null
  private readonly url: URL
  private readonly bearer: string | undefined
  private readonly timeoutMs: number
  // Serialize concurrent ensureConnected() calls so two trigger invocations
  // racing on first connect don't both open a transport.
  private connecting: Promise<void> | null = null

  constructor(opts: NanoclawMcpClientOpts = {}) {
    const rawUrl = opts.url ?? NANOCLAW_VOICE_MCP_URL
    if (!rawUrl) {
      throw new Error('nanoclaw-mcp: NANOCLAW_VOICE_MCP_URL not configured')
    }
    this.url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl)
    this.bearer = opts.bearer ?? NANOCLAW_VOICE_MCP_TOKEN
    this.timeoutMs = opts.timeoutMs ?? NANOCLAW_VOICE_MCP_TIMEOUT_MS
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

  /**
   * Generic tool-call helper. Mirrors core-mcp-client.ts:119-173 (timeout
   * detection, isError unwrap, JSON-parse of content[0].text).
   *
   * Surfaces:
   *   - NanoclawMcpTimeoutError on SDK timeout / abort.
   *   - NanoclawMcpError on isError tool result or transport failure.
   */
  private async callTool<T>(
    name: string,
    args: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    try {
      // ensureConnected() lives inside the try block so transport-level
      // failures (DNS, ECONNREFUSED, fetch TypeError) surface as
      // NanoclawMcpError — preserving the public error-class contract.
      // Differs from core-mcp-client.ts where the same line lives outside
      // the catch (legacy CoreMcpError mapping). See Plan 05.5-03 Task 1.
      await this.ensureConnected()
      const c = this.client!
      const result = (await c.callTool(
        {
          name,
          arguments: (args as Record<string, unknown>) ?? {},
        },
        undefined,
        { timeout: this.timeoutMs, signal: opts.signal },
      )) as {
        content?: Array<{ type: string; text?: string }>
        isError?: boolean
      }
      if (result?.isError) {
        const text = result.content?.[0]?.text ?? 'tool returned isError'
        throw new NanoclawMcpError(text, undefined, name)
      }
      const first = result?.content?.[0]
      if (first && first.type === 'text' && typeof first.text === 'string') {
        try {
          return JSON.parse(first.text) as T
        } catch {
          // Non-JSON text response — surface as opaque string under generic T.
          return first.text as unknown as T
        }
      }
      return result as unknown as T
    } catch (err) {
      if (err instanceof NanoclawMcpError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      const errCode = (err as { code?: unknown })?.code
      const isTimeoutCode = errCode === -32001
      if (isTimeoutCode || /timed?\s*out|timeout|abort/i.test(msg)) {
        throw new NanoclawMcpTimeoutError(name, this.timeoutMs)
      }
      throw new NanoclawMcpError(
        msg,
        typeof errCode === 'string'
          ? errCode
          : typeof errCode === 'number'
            ? String(errCode)
            : undefined,
        name,
      )
    }
  }

  /**
   * voice_triggers_init — sync at /accept.
   * D-8 / D-9: 5000 ms timeout, returns fully-rendered persona.
   * On `ok:false` envelope from the server, throws NanoclawMcpError with
   * `code` set to the server-emitted `error` string (e.g. 'agent_unavailable').
   * The Bridge catches and falls back to FALLBACK_PERSONA per REQ-DIR-12 / D-15.
   */
  async init(
    args: VoiceTriggersInitInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ instructions: string }> {
    const r = await this.callTool<ServerInitResult>(
      'voice_triggers_init',
      args,
      opts,
    )
    if (!r.ok) {
      throw new NanoclawMcpError(
        r.error ?? 'agent_unavailable',
        r.error ?? 'agent_unavailable',
        'voice_triggers_init',
      )
    }
    return r.result
  }

  /**
   * voice_triggers_transcript — per-turn FIFO at the server.
   * Returns `{ instructions_update: string | null }`. Bridge fires-and-forgets
   * via call-router.ts and pushes any non-null update through `session.update`.
   * On `ok:false` (e.g. 'mutation_blocked_mid_call' per REQ-DIR-17), throws
   * NanoclawMcpError; Bridge logs non-fatal and continues.
   */
  async transcript(
    args: VoiceTriggersTranscriptInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ instructions_update: string | null }> {
    const r = await this.callTool<ServerTranscriptResult>(
      'voice_triggers_transcript',
      args,
      opts,
    )
    if (!r.ok) {
      throw new NanoclawMcpError(
        r.error ?? 'agent_unavailable',
        r.error ?? 'agent_unavailable',
        'voice_triggers_transcript',
      )
    }
    return r.result
  }

  /**
   * voice_wake_up — open_points 2026-04-27 #1 pre-warm path.
   * Fired fire-and-forget at /accept time so the existing whatsapp_main
   * container is up + idle by the time the first ask_core arrives. Server
   * inserts a `<voice_wake_up />` sentinel in the main group's DB and
   * triggers the existing message-check pipeline; the host's runAgent
   * callback suppresses any output for wake-up turns. Returns the server
   * envelope as-is so callers can log; never throws on no_main_group, only
   * on transport / timeout errors.
   */
  /**
   * voice_send_discord_message — post-call transcript path (open_points
   * 2026-04-27 #2). Posts a single chunk to the configured channel via
   * Andy's Discord client. Caller chunks ≤ 2000 chars (Discord limit) and
   * iterates. Throws on transport/timeout/dedup/allowlist failure;
   * post-call-transcript caller catches and stops on first failure.
   */
  async sendDiscord(
    args: { channel: string; content: string; call_id?: string },
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ status: string }> {
    return await this.callTool<{ status: string }>(
      'voice_send_discord_message',
      args,
      opts,
    )
  }

  async wakeUp(
    args: { call_id: string; reason?: 'inbound' | 'outbound' },
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ status: string }> {
    return await this.callTool<{ status: string }>(
      'voice_wake_up',
      args,
      opts,
    )
  }

  /**
   * Idempotent close. Mirrors core-mcp-client.ts:175-184 — never throws.
   */
  async close(): Promise<void> {
    if (!this.client) return
    try {
      await this.client.close()
    } catch {
      // swallow — close must never throw out (Pitfall-4)
    }
    this.client = null
  }

  /**
   * Generic typed tool-call passthrough — exposes `callTool` for callers that
   * don't use the helper-method shortcuts (`init` / `transcript`). Matches
   * the v1 callCoreTool signature so the legacy callers (sideband.ts,
   * tools/dispatch.ts) can swap with zero churn after Phase 05.6 cleanup.
   */
  async callToolGeneric<T = unknown>(
    name: string,
    args: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    return (await this.callTool<T>(name, args, opts)) as T
  }
}

// ---------------------------------------------------------------------------
// Module-private singleton — Phase 05.6 D-22 cleanup migration.
//
// After the cleanup commit removes core-mcp-client.ts entirely, callers that
// used `callCoreTool` (sideband.ts, tools/dispatch.ts) swap to
// `callNanoclawTool` here. Same v1-style signature, same implicit
// (URL, token) keying via env vars. Per-call overrides spawn a short-lived
// client so the singleton never gets contaminated with per-call creds.
// ---------------------------------------------------------------------------
let defaultClient: NanoclawMcpClient | null = null

function getDefaultClient(): NanoclawMcpClient {
  if (!defaultClient) {
    if (!NANOCLAW_VOICE_MCP_URL) {
      throw new NanoclawMcpError(
        'nanoclaw-mcp: NANOCLAW_VOICE_MCP_URL not configured',
      )
    }
    defaultClient = new NanoclawMcpClient({
      url: NANOCLAW_VOICE_MCP_URL,
      bearer: NANOCLAW_VOICE_MCP_TOKEN,
    })
  }
  return defaultClient
}

export interface CallNanoclawToolOpts {
  url?: string
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * v1-compatible free-function. Drop-in replacement for the now-deleted
 * `callCoreTool` — same signature, same return-shape (parsed JSON from
 * content[0].text or raw string fallback). Routes via the nanoclaw-voice
 * MCP-stream server (port 3201) instead of the legacy Phase-4 REST shortcut.
 */
export async function callNanoclawTool<T = unknown>(
  name: string,
  args: unknown,
  opts: CallNanoclawToolOpts = {},
): Promise<T> {
  if (opts.url || opts.token) {
    const urlStr = opts.url ?? NANOCLAW_VOICE_MCP_URL
    if (!urlStr) {
      throw new NanoclawMcpError(
        'nanoclaw-mcp: NANOCLAW_VOICE_MCP_URL not configured',
      )
    }
    const client = new NanoclawMcpClient({
      url: urlStr,
      bearer: opts.token ?? NANOCLAW_VOICE_MCP_TOKEN,
      timeoutMs: opts.timeoutMs,
    })
    try {
      return await client.callToolGeneric<T>(name, args, {
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      })
    } finally {
      await client.close()
    }
  }
  return getDefaultClient().callToolGeneric<T>(name, args, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  })
}

/**
 * Test-only hook — resets the module singleton.
 */
export function __resetNanoclawDefaultClientForTests(): void {
  if (defaultClient) {
    void defaultClient.close().catch(() => undefined)
  }
  defaultClient = null
}
