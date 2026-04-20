// voice-bridge/src/core-mcp-client.test.ts
//
// Phase 4.5 Plan 04.5-02 Task 2: SDK client unit tests.
//
// Scenario titles are the contract — Wave-3 callers `-t`-filter on them,
// and VALIDATION.md rows 4.5-02-01/02/03 reference these exact strings.
// Source of truth: 04.5-VALIDATION.md §"Per-Task Verification Map" +
// 04.5-PATTERNS.md §"voice-bridge/src/core-mcp-client.test.ts (NEW)".
//
// Fixture pattern mirrors `src/mcp-stream-server.regression.test.ts`:
// ephemeral-port HTTP server hosting the real session-based
// `buildMcpStreamApp` from Wave 1. Tests drive the SUT (CoreMcpClient)
// against it over the real MCP protocol — no HTTP mocking, fidelity over
// speed (< 15s total budget per D-15).
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest'
import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { buildMcpStreamApp } from '../../src/mcp-stream-server.js'
import { ToolRegistry } from '../../src/mcp-tools/index.js'
import type { logger as RootLogger } from '../../src/logger.js'

import {
  CoreMcpClient,
  CoreMcpError,
  CoreMcpTimeoutError,
  __resetDefaultClientForTests,
} from './core-mcp-client.js'

const BEARER = 'test-v2-token'

let server: Server | null = null
let baseUrl = ''

function makeLog() {
  const noop = () => undefined
  return {
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  } as unknown as typeof RootLogger
}

/**
 * Build a fresh ToolRegistry with test-override handlers for three
 * TOOL_META-registered tool names. We reuse real voice.* names so the
 * server's createSession() takes the schema-aware path
 * (`mcp.tool(name, description, meta.shape, handler)`), which means the SDK
 * validates args via zod AND the server's wrapping handler passes them
 * through to our registry. Schemaless fallback would receive SDK extras as
 * the first handler arg instead of caller args — not what these tests need.
 *
 *  - voice_check_calendar  — "echo" behavior (round-trips validated args)
 *  - voice_ask_core        — slow path (awaits `slowToolMs` then resolves)
 *  - voice_get_contract    — throws so the server emits an MCP isError
 *                            payload (for server_error assertion)
 */
function makeRegistry(opts: { slowToolMs?: number } = {}): ToolRegistry {
  const r = new ToolRegistry()
  // Echo-style handler — returns the synthetic args the server hands us
  // (our caller args + Pitfall-8 call_id/turn_id injection).
  r.register('voice_check_calendar', async (args: unknown) => ({
    ok: true,
    echo: args,
  }))
  // Slow handler — used for the timeout scenario.
  r.register('voice_ask_core', async () => {
    await new Promise((res) => setTimeout(res, opts.slowToolMs ?? 500))
    return { ok: true, slow: true }
  })
  // Throwing handler — server catches, wraps as MCP isError payload.
  r.register('voice_get_contract', async () => {
    throw new Error('intentional_handler_error')
  })
  return r
}

async function startServer(opts: { slowToolMs?: number } = {}): Promise<void> {
  const app = buildMcpStreamApp({
    registry: makeRegistry(opts),
    bearerToken: BEARER,
    allowlist: ['127.0.0.1', '::ffff:127.0.0.1', '::1'],
    log: makeLog(),
  })
  server = http.createServer(app)
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server!.address() as AddressInfo
  // URL must be the root path (not `/mcp/stream`) — buildMcpStreamApp mounts
  // the handler at app.all('/').
  baseUrl = `http://127.0.0.1:${addr.port}/`
}

async function stopServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
}

beforeEach(async () => {
  __resetDefaultClientForTests()
  await startServer()
})

afterEach(async () => {
  __resetDefaultClientForTests()
  await stopServer()
})

// Helper — build a fresh set of schema-valid args for the "echo" tool,
// optionally marked with a per-test discriminator so response round-trips
// can be asserted. voice_check_calendar requires:
//   - date: YYYY-MM-DD string
//   - duration_minutes: integer in [1, 1440]
// We use duration_minutes as the discriminator (1..1440) so the echoed
// value in the response proves this call's args were the ones handled.
function echoArgs(discriminatorMinutes: number): {
  date: string
  duration_minutes: number
} {
  return {
    date: '2026-05-01',
    duration_minutes: discriminatorMinutes,
  }
}

describe('CoreMcpClient v2 (MCP StreamableHTTP via SDK)', () => {
  it('connect: lazy-opens MCP session on first ensureConnected()', async () => {
    const client = new CoreMcpClient(new URL(baseUrl), BEARER)
    // First call opens the session.
    await client.ensureConnected()
    // Second call is a no-op (must not throw, must not double-connect).
    await client.ensureConnected()
    // Indirect validation: a tool call succeeds, proving the session is live.
    const r = (await client.callTool(
      'voice_check_calendar',
      echoArgs(11),
    )) as {
      ok: boolean
      echo: Record<string, unknown>
    }
    expect(r.ok).toBe(true)
    expect(r.echo.duration_minutes).toBe(11)
    await client.close()
  })

  it('callTool: returns server result, preserves args shape', async () => {
    const client = new CoreMcpClient(new URL(baseUrl), BEARER)
    const r = (await client.callTool(
      'voice_check_calendar',
      echoArgs(42),
    )) as {
      ok: boolean
      echo: Record<string, unknown>
    }
    // Server injects synthetic call_id/turn_id (Pitfall 8) so echo is a
    // superset of our args — use toMatchObject to assert our keys survive
    // without demanding exact equality.
    expect(r.ok).toBe(true)
    expect(r.echo).toMatchObject({
      date: '2026-05-01',
      duration_minutes: 42,
    })
    // Sanity: the server-side synthetic ids are there and carry the
    // 'chat-' prefix (Pitfall 8 / D-11).
    expect(typeof r.echo.call_id).toBe('string')
    expect(String(r.echo.call_id)).toMatch(/^chat-/)
    await client.close()
  })

  it('close: idempotent, second close() is no-op', async () => {
    const client = new CoreMcpClient(new URL(baseUrl), BEARER)
    await client.ensureConnected()
    await client.close()
    // Second close() must not throw — Pitfall-4 idempotency guard.
    await expect(client.close()).resolves.toBeUndefined()
    // Third close() on a never-connected client must also be safe.
    const fresh = new CoreMcpClient(new URL(baseUrl), BEARER)
    await expect(fresh.close()).resolves.toBeUndefined()
  })

  it('timeout: callTool rejects with CoreMcpTimeoutError when opts.timeoutMs elapses', async () => {
    // Restart server with a slower handler so we can exercise a real
    // wall-clock timeout without flakiness. voice_ask_core requires
    // {topic: slug, request: non-empty} — schema-valid args let the call
    // reach our sleeping handler.
    await stopServer()
    await startServer({ slowToolMs: 400 })
    const client = new CoreMcpClient(new URL(baseUrl), BEARER)
    await expect(
      client.callTool(
        'voice_ask_core',
        { topic: 'calendar', request: 'probe' },
        { timeoutMs: 50 },
      ),
    ).rejects.toBeInstanceOf(CoreMcpTimeoutError)
    await client.close()
  })

  it('server_error: callTool rejects with CoreMcpError when tool handler throws', async () => {
    const client = new CoreMcpClient(new URL(baseUrl), BEARER)
    // voice_get_contract handler throws → server wraps as isError MCP
    // payload → v2 client unwraps to CoreMcpError with the error text as
    // message. Args must satisfy GetContractSchema (provider_name non-empty).
    const p = client.callTool('voice_get_contract', {
      provider_name: 'test-provider',
    })
    await expect(p).rejects.toBeInstanceOf(CoreMcpError)
    await expect(p).rejects.not.toBeInstanceOf(CoreMcpTimeoutError)
    await client.close()
  })

  it('reconnect_after_close: ensureConnected() after close() opens a fresh session', async () => {
    const client = new CoreMcpClient(new URL(baseUrl), BEARER)
    const r1 = (await client.callTool(
      'voice_check_calendar',
      echoArgs(1),
    )) as {
      ok: boolean
      echo: Record<string, unknown>
    }
    expect(r1.echo.duration_minutes).toBe(1)
    await client.close()
    // After close(), callTool() must transparently re-ensureConnected().
    const r2 = (await client.callTool(
      'voice_check_calendar',
      echoArgs(2),
    )) as {
      ok: boolean
      echo: Record<string, unknown>
    }
    expect(r2.echo.duration_minutes).toBe(2)
    await client.close()
  })
})
