// voice-bridge/tests/webhook-accept-branch.test.ts
//
// Phase 05.5 Plan 04 Task 3 — Branch coverage for /accept REASONING_MODE flag.
//
// Two describe blocks (slow-brain default + container-agent), each driving
// the registered AcceptRoute through a mocked OpenAI client + injected
// router/outbound-router/nanoclawMcp. Asserts that:
//   - REASONING_MODE='slow-brain' (default) keeps the legacy baseline+overlay
//     composition path; nanoclawMcp.init is NEVER invoked.
//   - REASONING_MODE='container-agent' calls nanoclawMcp.init with the typed
//     args from D-8 (case_type + call_direction + counterpart_label) at both
//     splice points (outbound non-Case-2 + inbound Carsten).
//   - On nanoclawMcp.init() rejection, the Bridge falls back to FALLBACK_PERSONA
//     and emits a `container_agent_init_failed` warn-log (REQ-VOICE-13).
//   - When REASONING_MODE='container-agent' but the client is undefined
//     (config error), the Bridge falls back to FALLBACK_PERSONA and emits
//     a `container_agent_mode_but_client_missing` error-log.
//
// Pattern source: tests/accept.test.ts (Phase-2 full-wiring fixture) +
// tests/webhook-amd-handoff.test.ts (router-override + outbound-router stub).

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NanoclawMcpError,
  NanoclawMcpTimeoutError,
  type NanoclawMcpClient,
} from '../src/nanoclaw-mcp-client.js'
import { FALLBACK_PERSONA, CARSTEN_CLI_NUMBER } from '../src/config.js'

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

function makeRouter() {
  const sendSpy = vi.fn()
  const sidebandState: Record<string, unknown> = {
    callId: 'rtc_branch_test',
    ready: true,
    ws: { readyState: 1, send: sendSpy } as unknown as never,
    openedAt: 0,
    lastUpdateAt: 0,
    armedForFirstSpeech: false,
  }
  const ctx = {
    callId: 'rtc_branch_test',
    sideband: { state: sidebandState, close: vi.fn() },
  }
  const startCall = vi.fn().mockReturnValue(ctx)
  return {
    startCall,
    endCall: vi.fn(),
    getCall: vi.fn(),
    _size: vi.fn().mockReturnValue(0),
  }
}

function makeOpenAIInbound(callId: string, callerNumber: string) {
  const acceptSpy = vi.fn().mockResolvedValue({})
  const rejectSpy = vi.fn().mockResolvedValue({})
  const unwrapSpy = vi.fn().mockResolvedValue({
    type: 'realtime.call.incoming',
    data: {
      call_id: callId,
      sip_headers: [
        {
          name: 'From',
          value: `"Caller" <sip:${callerNumber}@sipgate.de>`,
        },
      ],
    },
  })
  return {
    openai: {
      webhooks: { unwrap: unwrapSpy },
      realtime: { calls: { accept: acceptSpy, reject: rejectSpy } },
    },
    acceptSpy,
    rejectSpy,
  }
}

function makeOpenAIOutbound(callId: string) {
  const acceptSpy = vi.fn().mockResolvedValue({})
  const rejectSpy = vi.fn().mockResolvedValue({})
  const unwrapSpy = vi.fn().mockResolvedValue({
    type: 'realtime.call.incoming',
    data: { call_id: callId },
  })
  return {
    openai: {
      webhooks: { unwrap: unwrapSpy },
      realtime: { calls: { accept: acceptSpy, reject: rejectSpy } },
    },
    acceptSpy,
    rejectSpy,
  }
}

/**
 * Outbound-router stub for non-Case-2 default-outbound flow. Returns an
 * active task (so isOutbound branch fires) with a non-Case-2 case_type.
 */
function makeNonCase2OutboundRouter(taskGoal: string) {
  return {
    getActiveTask: vi.fn().mockReturnValue({
      task_id: 'task-branch-test',
      target_phone: '+491709999999',
      goal: taskGoal,
      context: 'Test context',
      case_type: 'case_1_default',
      case_payload: { restaurant_name: 'Test Restaurant' },
      report_to_jid: 'dc:test',
      status: 'dialing',
      created_at: Date.now(),
      openai_call_id: undefined,
    }),
    bindOpenaiCallId: vi.fn(),
    enqueue: vi.fn(),
    onCallEnd: vi.fn(),
    taskIdForOpenaiCallId: vi.fn(),
    buildPersonaForTask: vi
      .fn()
      .mockReturnValue('OUTBOUND_BASELINE_OVERLAY_STUB'),
  }
}

function makeInboundOnlyRouter() {
  return {
    getActiveTask: vi.fn().mockReturnValue(null),
    bindOpenaiCallId: vi.fn(),
    enqueue: vi.fn(),
    onCallEnd: vi.fn(),
    taskIdForOpenaiCallId: vi.fn(),
    buildPersonaForTask: vi.fn(),
  }
}

/** Build a NanoclawMcpClient mock that satisfies the structural type. */
function makeMockNanoclawMcp(opts: {
  initImpl?: (args: unknown) => Promise<{ instructions: string }>
}): NanoclawMcpClient {
  const init = vi.fn(
    opts.initImpl ??
      (async () => ({ instructions: 'CONTAINER_BAKED_PERSONA' })),
  )
  const transcript = vi
    .fn()
    .mockResolvedValue({ instructions_update: null })
  const close = vi.fn().mockResolvedValue(undefined)
  return {
    init,
    transcript,
    close,
    // ensureConnected isn't called from /accept (init() handles it internally
    // in real client) but we provide a stub to satisfy the structural type.
    ensureConnected: vi.fn().mockResolvedValue(undefined),
  } as unknown as NanoclawMcpClient
}

async function injectAccept(app: import('fastify').FastifyInstance, callId: string) {
  return app.inject({
    method: 'POST',
    url: '/accept',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'branch-test',
      'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
      'webhook-signature': 'v1,xxx',
    },
    payload: JSON.stringify({
      type: 'realtime.call.incoming',
      data: { call_id: callId },
    }),
  })
}

// ---------------------------------------------------------------------------
// Test environment setup.
// ---------------------------------------------------------------------------

let logDir: string

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'bridge-branch-'))
  process.env.OPENAI_WEBHOOK_SECRET =
    'whsec_test_branch_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  process.env.BRIDGE_BIND = '127.0.0.1'
  process.env.BRIDGE_PORT = '0'
  process.env.BRIDGE_LOG_DIR = logDir
  vi.resetModules()
})

afterEach(() => {
  rmSync(logDir, { recursive: true, force: true })
  delete process.env.OPENAI_WEBHOOK_SECRET
  delete process.env.BRIDGE_BIND
  delete process.env.BRIDGE_PORT
  delete process.env.BRIDGE_LOG_DIR
  delete process.env.REASONING_MODE
})

// ---------------------------------------------------------------------------
// describe — REASONING_MODE='slow-brain' (default — Phase-5 byte-identical)
// ---------------------------------------------------------------------------

describe("REASONING_MODE='slow-brain'", () => {
  it('outbound /accept uses legacy baseline+overlay composition (NOT nanoclawMcp.init)', async () => {
    // Default: REASONING_MODE unset → 'slow-brain'.
    delete process.env.REASONING_MODE

    const callId = 'rtc_sb_outbound'
    const router = makeRouter()
    const outboundRouter = makeNonCase2OutboundRouter('Test outbound goal')
    const { openai, acceptSpy } = makeOpenAIOutbound(callId)
    const nanoclawMcp = makeMockNanoclawMcp({})

    const { buildApp } = await import('../src/index.js')
    const app = await buildApp({
      openaiOverride: openai as never,
      whitelistOverride: new Set([CARSTEN_CLI_NUMBER]),
      routerOverride: router as never,
      outboundRouterOverride: outboundRouter as never,
      nanoclawMcpOverride: nanoclawMcp,
    })
    try {
      const res = await injectAccept(app, callId)
      expect(res.statusCode).toBe(200)
      // CRITICAL: nanoclawMcp.init MUST NOT be called under slow-brain default.
      expect(nanoclawMcp.init).not.toHaveBeenCalled()
      // Legacy outbound path: buildPersonaForTask was called.
      expect(outboundRouter.buildPersonaForTask).toHaveBeenCalledWith(
        'task-branch-test',
      )
      // openai.realtime.calls.accept got the legacy stub-instruction.
      expect(acceptSpy).toHaveBeenCalledTimes(1)
      const session = acceptSpy.mock.calls[0][1] as {
        instructions: string
      }
      expect(session.instructions).toBe('OUTBOUND_BASELINE_OVERLAY_STUB')
    } finally {
      await app.close()
    }
  })

  it('inbound /accept Carsten path uses legacy persona (NOT nanoclawMcp.init)', async () => {
    delete process.env.REASONING_MODE

    const callId = 'rtc_sb_inbound'
    const router = makeRouter()
    const outboundRouter = makeInboundOnlyRouter()
    const { openai, acceptSpy } = makeOpenAIInbound(callId, CARSTEN_CLI_NUMBER)
    const nanoclawMcp = makeMockNanoclawMcp({})

    const { buildApp } = await import('../src/index.js')
    const app = await buildApp({
      openaiOverride: openai as never,
      whitelistOverride: new Set([CARSTEN_CLI_NUMBER]),
      routerOverride: router as never,
      outboundRouterOverride: outboundRouter as never,
      nanoclawMcpOverride: nanoclawMcp,
    })
    try {
      const res = await injectAccept(app, callId)
      expect(res.statusCode).toBe(200)
      // nanoclawMcp.init MUST NOT be called.
      expect(nanoclawMcp.init).not.toHaveBeenCalled()
      // accept() got the legacy carstenInstructions (case_6b baseline+overlay).
      expect(acceptSpy).toHaveBeenCalledTimes(1)
      const session = acceptSpy.mock.calls[0][1] as { instructions: string }
      // Carsten persona contains the case-6b overlay marker
      // (see persona/baseline.ts: 'Carsten' counterpart_label).
      expect(session.instructions).toContain('Carsten')
    } finally {
      await app.close()
    }
  })
})

// ---------------------------------------------------------------------------
// describe — REASONING_MODE='container-agent' (Phase 05.5 new path)
// ---------------------------------------------------------------------------

describe("REASONING_MODE='container-agent'", () => {
  beforeEach(() => {
    process.env.REASONING_MODE = 'container-agent'
  })

  it('outbound /accept (non-Case-2) calls nanoclawMcp.init with case_2 + outbound + restaurant_name', async () => {
    const callId = 'rtc_ca_outbound'
    const router = makeRouter()
    const outboundRouter = makeNonCase2OutboundRouter('Test outbound goal')
    const { openai, acceptSpy } = makeOpenAIOutbound(callId)
    const nanoclawMcp = makeMockNanoclawMcp({
      initImpl: async () => ({ instructions: 'CONTAINER_BAKED_OUTBOUND' }),
    })

    const { buildApp } = await import('../src/index.js')
    const app = await buildApp({
      openaiOverride: openai as never,
      whitelistOverride: new Set([CARSTEN_CLI_NUMBER]),
      routerOverride: router as never,
      outboundRouterOverride: outboundRouter as never,
      nanoclawMcpOverride: nanoclawMcp,
    })
    try {
      const res = await injectAccept(app, callId)
      expect(res.statusCode).toBe(200)
      // nanoclawMcp.init MUST be called with D-8 typed args.
      expect(nanoclawMcp.init).toHaveBeenCalledTimes(1)
      const initCall = (nanoclawMcp.init as ReturnType<typeof vi.fn>).mock
        .calls[0][0]
      expect(initCall).toMatchObject({
        call_id: callId,
        case_type: 'case_2',
        call_direction: 'outbound',
        counterpart_label: 'Test Restaurant',
      })
      // Returned instructions flow into accept() session.
      expect(acceptSpy).toHaveBeenCalledTimes(1)
      const session = acceptSpy.mock.calls[0][1] as { instructions: string }
      expect(session.instructions).toBe('CONTAINER_BAKED_OUTBOUND')
      // Legacy buildPersonaForTask MUST NOT be invoked under container-agent.
      expect(outboundRouter.buildPersonaForTask).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('outbound /accept on init() rejection falls back to FALLBACK_PERSONA + warn-log container_agent_init_failed', async () => {
    const callId = 'rtc_ca_outbound_fail'
    const router = makeRouter()
    const outboundRouter = makeNonCase2OutboundRouter('Test outbound goal')
    const { openai, acceptSpy } = makeOpenAIOutbound(callId)
    const nanoclawMcp = makeMockNanoclawMcp({
      initImpl: async () => {
        throw new NanoclawMcpTimeoutError('voice_triggers_init', 5000)
      },
    })

    const { buildApp } = await import('../src/index.js')
    const app = await buildApp({
      openaiOverride: openai as never,
      whitelistOverride: new Set([CARSTEN_CLI_NUMBER]),
      routerOverride: router as never,
      outboundRouterOverride: outboundRouter as never,
      nanoclawMcpOverride: nanoclawMcp,
    })
    try {
      const res = await injectAccept(app, callId)
      expect(res.statusCode).toBe(200)
      // nanoclawMcp.init was attempted.
      expect(nanoclawMcp.init).toHaveBeenCalledTimes(1)
      // accept() got FALLBACK_PERSONA — REQ-VOICE-13 fallback exception.
      expect(acceptSpy).toHaveBeenCalledTimes(1)
      const session = acceptSpy.mock.calls[0][1] as { instructions: string }
      expect(session.instructions).toBe(FALLBACK_PERSONA)
    } finally {
      await app.close()
    }
  })

  it('inbound /accept Carsten calls nanoclawMcp.init with case_6b + inbound + Carsten', async () => {
    const callId = 'rtc_ca_inbound'
    const router = makeRouter()
    const outboundRouter = makeInboundOnlyRouter()
    const { openai, acceptSpy } = makeOpenAIInbound(callId, CARSTEN_CLI_NUMBER)
    const nanoclawMcp = makeMockNanoclawMcp({
      initImpl: async () => ({ instructions: 'CONTAINER_INBOUND_CARSTEN' }),
    })

    const { buildApp } = await import('../src/index.js')
    const app = await buildApp({
      openaiOverride: openai as never,
      whitelistOverride: new Set([CARSTEN_CLI_NUMBER]),
      routerOverride: router as never,
      outboundRouterOverride: outboundRouter as never,
      nanoclawMcpOverride: nanoclawMcp,
    })
    try {
      const res = await injectAccept(app, callId)
      expect(res.statusCode).toBe(200)
      expect(nanoclawMcp.init).toHaveBeenCalledTimes(1)
      const initCall = (nanoclawMcp.init as ReturnType<typeof vi.fn>).mock
        .calls[0][0]
      expect(initCall).toMatchObject({
        call_id: callId,
        case_type: 'case_6b',
        call_direction: 'inbound',
        counterpart_label: 'Carsten',
      })
      expect(acceptSpy).toHaveBeenCalledTimes(1)
      const session = acceptSpy.mock.calls[0][1] as { instructions: string }
      expect(session.instructions).toBe('CONTAINER_INBOUND_CARSTEN')
    } finally {
      await app.close()
    }
  })

  it('inbound /accept config-error guard: REASONING_MODE=container-agent but nanoclawMcp undefined → FALLBACK_PERSONA + container_agent_mode_but_client_missing error log', async () => {
    const callId = 'rtc_ca_missing_client'
    const router = makeRouter()
    const outboundRouter = makeInboundOnlyRouter()
    const { openai, acceptSpy } = makeOpenAIInbound(callId, CARSTEN_CLI_NUMBER)

    const { buildApp } = await import('../src/index.js')
    const app = await buildApp({
      openaiOverride: openai as never,
      whitelistOverride: new Set([CARSTEN_CLI_NUMBER]),
      routerOverride: router as never,
      outboundRouterOverride: outboundRouter as never,
      // nanoclawMcpOverride NOT passed — buildApp's index.ts construction is
      // skipped in test (no NANOCLAW_VOICE_MCP_URL set), so the client is
      // undefined despite REASONING_MODE='container-agent'. This is the
      // misconfiguration the guard exists for.
    })
    try {
      const res = await injectAccept(app, callId)
      expect(res.statusCode).toBe(200)
      expect(acceptSpy).toHaveBeenCalledTimes(1)
      const session = acceptSpy.mock.calls[0][1] as { instructions: string }
      // Guard fires → FALLBACK_PERSONA, not legacy carstenInstructions.
      expect(session.instructions).toBe(FALLBACK_PERSONA)
    } finally {
      await app.close()
    }
  })

  it('outbound /accept on NanoclawMcpError (agent_unavailable) falls back to FALLBACK_PERSONA', async () => {
    const callId = 'rtc_ca_agent_unavail'
    const router = makeRouter()
    const outboundRouter = makeNonCase2OutboundRouter('Test outbound goal')
    const { openai, acceptSpy } = makeOpenAIOutbound(callId)
    const nanoclawMcp = makeMockNanoclawMcp({
      initImpl: async () => {
        throw new NanoclawMcpError(
          'agent_unavailable',
          'agent_unavailable',
          'voice_triggers_init',
        )
      },
    })

    const { buildApp } = await import('../src/index.js')
    const app = await buildApp({
      openaiOverride: openai as never,
      whitelistOverride: new Set([CARSTEN_CLI_NUMBER]),
      routerOverride: router as never,
      outboundRouterOverride: outboundRouter as never,
      nanoclawMcpOverride: nanoclawMcp,
    })
    try {
      const res = await injectAccept(app, callId)
      expect(res.statusCode).toBe(200)
      expect(nanoclawMcp.init).toHaveBeenCalledTimes(1)
      expect(acceptSpy).toHaveBeenCalledTimes(1)
      const session = acceptSpy.mock.calls[0][1] as { instructions: string }
      expect(session.instructions).toBe(FALLBACK_PERSONA)
    } finally {
      await app.close()
    }
  })
})
