// voice-bridge/tests/nanoclaw-mcp-client.test.ts
//
// Phase 05.5 Plan 03 Task 1: NanoclawMcpClient unit tests.
//
// Fixture pattern mirrors voice-bridge/src/core-mcp-client.test.ts
// verbatim — ephemeral-port HTTP server hosting the real
// `buildMcpStreamApp` from src/mcp-stream-server.ts. Tests drive
// NanoclawMcpClient against it over the real MCP protocol — no HTTP
// mocking, fidelity over speed.
//
// Tool names registered in the test ToolRegistry MUST match the
// TOOL_META entries (voice_triggers_init, voice_triggers_transcript)
// because the server's createSession() takes the schema-aware path
// (`mcp.tool(name, description, meta.shape, handler)`); using
// arbitrary names would fall through to the schemaless path and the
// SDK would reshape the args.

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
  NanoclawMcpClient,
  NanoclawMcpError,
  NanoclawMcpTimeoutError,
} from '../src/nanoclaw-mcp-client.js'

const BEARER = 'test-nanoclaw-mcp-token'

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
 * Per-test handler hooks. The fixture builds a fresh ToolRegistry that
 * delegates to whatever the current test installed. This avoids
 * top-of-file mutable state and makes each test's expectations clear.
 */
type InitHandler = (args: unknown) => Promise<unknown>
type TranscriptHandler = (args: unknown) => Promise<unknown>

let initHandler: InitHandler = async () => ({
  ok: true,
  result: { instructions: 'BAKED_PERSONA' },
})
let transcriptHandler: TranscriptHandler = async () => ({
  ok: true,
  result: { instructions_update: null },
})

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register('voice_triggers_init', async (args: unknown) =>
    initHandler(args),
  )
  r.register('voice_triggers_transcript', async (args: unknown) =>
    transcriptHandler(args),
  )
  return r
}

async function startServer(): Promise<void> {
  const app = buildMcpStreamApp({
    registry: makeRegistry(),
    bearerToken: BEARER,
    allowlist: ['127.0.0.1', '::ffff:127.0.0.1', '::1'],
    log: makeLog(),
  })
  server = http.createServer(app)
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server!.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}/`
}

async function stopServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
}

beforeEach(async () => {
  // Reset to default happy-path handlers between tests.
  initHandler = async () => ({
    ok: true,
    result: { instructions: 'BAKED_PERSONA' },
  })
  transcriptHandler = async () => ({
    ok: true,
    result: { instructions_update: null },
  })
  await startServer()
})

afterEach(async () => {
  await stopServer()
})

// Schema-valid args for the two tools (D-8 wire shapes).
function validInitArgs() {
  return {
    call_id: 'test-call-1',
    case_type: 'case_2' as const,
    call_direction: 'outbound' as const,
    counterpart_label: 'Bella Vista',
  }
}
function validTranscriptArgs() {
  return {
    call_id: 'test-call-1',
    turn_id: 1,
    transcript: {
      turns: [
        {
          role: 'counterpart' as const,
          text: 'Hallo Bella Vista',
          started_at: new Date().toISOString(),
        },
      ],
    },
    fast_brain_state: {},
  }
}

describe('NanoclawMcpClient (MCP StreamableHTTP via SDK)', () => {
  it('init returns rendered instructions string (BAKED_PERSONA happy-path)', async () => {
    initHandler = async () => ({
      ok: true,
      result: { instructions: 'BAKED_PERSONA' },
    })
    const client = new NanoclawMcpClient({ url: baseUrl, bearer: BEARER })
    const r = await client.init(validInitArgs())
    expect(r).toEqual({ instructions: 'BAKED_PERSONA' })
    await client.close()
  })

  it('transcript returns instructions_update string', async () => {
    transcriptHandler = async () => ({
      ok: true,
      result: { instructions_update: 'NEW' },
    })
    const client = new NanoclawMcpClient({ url: baseUrl, bearer: BEARER })
    const r = await client.transcript(validTranscriptArgs())
    expect(r).toEqual({ instructions_update: 'NEW' })
    await client.close()
  })

  it('transcript returns instructions_update null', async () => {
    transcriptHandler = async () => ({
      ok: true,
      result: { instructions_update: null },
    })
    const client = new NanoclawMcpClient({ url: baseUrl, bearer: BEARER })
    const r = await client.transcript(validTranscriptArgs())
    expect(r).toEqual({ instructions_update: null })
    await client.close()
  })

  it('transcript times out → throws NanoclawMcpTimeoutError', async () => {
    // Slow handler — 200ms — combined with a 100ms client timeout fires the
    // SDK timeout deterministically (D-9 default is 5000ms; we shorten it
    // here to keep the suite fast).
    transcriptHandler = async () => {
      await new Promise((res) => setTimeout(res, 200))
      return { ok: true, result: { instructions_update: 'TOO_LATE' } }
    }
    const client = new NanoclawMcpClient({
      url: baseUrl,
      bearer: BEARER,
      timeoutMs: 100,
    })
    await expect(client.transcript(validTranscriptArgs())).rejects.toBeInstanceOf(
      NanoclawMcpTimeoutError,
    )
    await client.close()
  })

  it('connection error → throws NanoclawMcpError (unbound port)', async () => {
    // Point the client at a port that is almost certainly unbound. We use
    // 1 (privileged port, won't accept on localhost without root) — any
    // failure to open the MCP transport surfaces as NanoclawMcpError.
    const client = new NanoclawMcpClient({
      url: 'http://127.0.0.1:1/',
      bearer: BEARER,
      timeoutMs: 1000,
    })
    await expect(client.init(validInitArgs())).rejects.toBeInstanceOf(
      NanoclawMcpError,
    )
    await client.close()
  })

  it('init with ok:false handler → throws NanoclawMcpError (code agent_unavailable)', async () => {
    initHandler = async () => ({ ok: false, error: 'agent_unavailable' })
    const client = new NanoclawMcpClient({ url: baseUrl, bearer: BEARER })
    let caught: unknown
    try {
      await client.init(validInitArgs())
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(NanoclawMcpError)
    expect((caught as NanoclawMcpError).code).toBe('agent_unavailable')
    expect((caught as NanoclawMcpError).toolName).toBe('voice_triggers_init')
    await client.close()
  })
})
