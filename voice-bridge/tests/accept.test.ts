import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Tests for POST /accept — the Phase 1 call-accept handler that replaces
 * the legacy Core sidecar. Uses OpenAI client injection (buildApp
 * openaiOverride) so we can assert calls.accept/reject are invoked with
 * the expected payload without touching the real API.
 */
describe('POST /accept — Phase 1 inbound call handler', () => {
  let logDir: string

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'bridge-accept-test-'))
    process.env.OPENAI_WEBHOOK_SECRET =
      'whsec_test_phase1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    process.env.BRIDGE_BIND = '127.0.0.1'
    process.env.BRIDGE_PORT = '0'
    process.env.BRIDGE_LOG_DIR = logDir
  })

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true })
    delete process.env.OPENAI_WEBHOOK_SECRET
    delete process.env.BRIDGE_BIND
    delete process.env.BRIDGE_PORT
    delete process.env.BRIDGE_LOG_DIR
  })

  function makeMockOpenAI(overrides?: {
    unwrap?: ReturnType<typeof vi.fn>
    accept?: ReturnType<typeof vi.fn>
    reject?: ReturnType<typeof vi.fn>
  }): {
    openai: any
    acceptSpy: ReturnType<typeof vi.fn>
    rejectSpy: ReturnType<typeof vi.fn>
  } {
    const acceptSpy = overrides?.accept ?? vi.fn().mockResolvedValue({})
    const rejectSpy = overrides?.reject ?? vi.fn().mockResolvedValue({})
    const unwrapSpy =
      overrides?.unwrap ??
      vi.fn().mockResolvedValue({
        type: 'realtime.call.incoming',
        data: {
          call_id: 'rtc_test_123',
          sip_headers: [
            {
              name: 'From',
              value: '"Caller" <sip:+491708036426@sipgate.de>',
            },
          ],
        },
      })
    const openai = {
      webhooks: { unwrap: unwrapSpy },
      realtime: { calls: { accept: acceptSpy, reject: rejectSpy } },
    }
    return { openai, acceptSpy, rejectSpy }
  }

  it('whitelisted caller → calls accept() with call_id and persona', async () => {
    const { buildApp } = await import('../src/index.js')
    const { openai, acceptSpy, rejectSpy } = makeMockOpenAI()
    const app = await buildApp({
      openaiOverride: openai,
      whitelistOverride: new Set(['+491708036426']),
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/accept',
        headers: {
          'content-type': 'application/json',
          'webhook-id': 'test-id-1',
          'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'webhook-signature': 'v1,xxx',
        },
        payload: JSON.stringify({
          type: 'realtime.call.incoming',
          data: { call_id: 'rtc_test_123' },
        }),
      })
      expect(res.statusCode).toBe(200)
      expect(acceptSpy).toHaveBeenCalledTimes(1)
      expect(acceptSpy).toHaveBeenCalledWith(
        'rtc_test_123',
        expect.objectContaining({
          model: 'gpt-realtime-mini',
          instructions: expect.stringContaining('NanoClaw'),
        }),
      )
      expect(rejectSpy).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('non-whitelisted caller → calls reject(486), never accept()', async () => {
    const { buildApp } = await import('../src/index.js')
    const { openai, acceptSpy, rejectSpy } = makeMockOpenAI()
    const app = await buildApp({
      openaiOverride: openai,
      whitelistOverride: new Set(['+499999999999']),
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/accept',
        headers: {
          'content-type': 'application/json',
          'webhook-id': 'test-id-2',
          'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'webhook-signature': 'v1,xxx',
        },
        payload: JSON.stringify({
          type: 'realtime.call.incoming',
          data: { call_id: 'rtc_test_123' },
        }),
      })
      expect(res.statusCode).toBe(200)
      expect(rejectSpy).toHaveBeenCalledWith('rtc_test_123', {
        status_code: 486,
      })
      expect(acceptSpy).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('invalid signature → 401, neither accept nor reject called', async () => {
    const { buildApp } = await import('../src/index.js')
    const unwrap = vi.fn().mockRejectedValue(new Error('bad signature'))
    const { openai, acceptSpy, rejectSpy } = makeMockOpenAI({ unwrap })
    const app = await buildApp({
      openaiOverride: openai,
      whitelistOverride: new Set(['+491708036426']),
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/accept',
        headers: {
          'content-type': 'application/json',
          'webhook-id': 'test-id-3',
          'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'webhook-signature': 'v1,invalid',
        },
        payload: JSON.stringify({
          type: 'realtime.call.incoming',
          data: {},
        }),
      })
      expect(res.statusCode).toBe(401)
      expect(acceptSpy).not.toHaveBeenCalled()
      expect(rejectSpy).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('non-incoming event type → 200, accept not called', async () => {
    const { buildApp } = await import('../src/index.js')
    const unwrap = vi.fn().mockResolvedValue({
      type: 'realtime.call.completed',
      data: { call_id: 'rtc_done' },
    })
    const { openai, acceptSpy, rejectSpy } = makeMockOpenAI({ unwrap })
    const app = await buildApp({
      openaiOverride: openai,
      whitelistOverride: new Set(['+491708036426']),
    })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/accept',
        headers: {
          'content-type': 'application/json',
          'webhook-id': 'test-id-4',
          'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'webhook-signature': 'v1,xxx',
        },
        payload: JSON.stringify({
          type: 'realtime.call.completed',
          data: { call_id: 'rtc_done' },
        }),
      })
      expect(res.statusCode).toBe(200)
      expect(acceptSpy).not.toHaveBeenCalled()
      expect(rejectSpy).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})

describe('POST /accept — Phase 2 full-wiring', () => {
  let logDir: string

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'bridge-accept-p2-'))
    process.env.OPENAI_WEBHOOK_SECRET =
      'whsec_test_phase2_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    process.env.BRIDGE_BIND = '127.0.0.1'
    process.env.BRIDGE_PORT = '0'
    process.env.BRIDGE_LOG_DIR = logDir
  })

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true })
    delete process.env.OPENAI_WEBHOOK_SECRET
    delete process.env.BRIDGE_BIND
    delete process.env.BRIDGE_PORT
    delete process.env.BRIDGE_LOG_DIR
  })

  function makeRouter() {
    const startCall = vi.fn()
    const endCall = vi.fn()
    const getCall = vi.fn()
    const _size = vi.fn().mockReturnValue(0)
    return { startCall, endCall, getCall, _size }
  }

  function makeMockOpenAIv2(overrides?: {
    unwrap?: ReturnType<typeof vi.fn>
    accept?: ReturnType<typeof vi.fn>
    reject?: ReturnType<typeof vi.fn>
  }) {
    const acceptSpy = overrides?.accept ?? vi.fn().mockResolvedValue({})
    const rejectSpy = overrides?.reject ?? vi.fn().mockResolvedValue({})
    const unwrapSpy =
      overrides?.unwrap ??
      vi.fn().mockResolvedValue({
        type: 'realtime.call.incoming',
        data: {
          call_id: 'rtc_p2',
          sip_headers: [
            {
              name: 'From',
              value: '"Caller" <sip:+491708036426@sipgate.de>',
            },
          ],
        },
      })
    const openai = {
      webhooks: { unwrap: unwrapSpy },
      realtime: { calls: { accept: acceptSpy, reject: rejectSpy } },
    }
    return { openai, acceptSpy, rejectSpy }
  }

  async function acceptIncoming(
    whitelist: Set<string>,
    router: ReturnType<typeof makeRouter>,
    overrides?: Parameters<typeof makeMockOpenAIv2>[0],
  ) {
    const { buildApp } = await import('../src/index.js')
    const { openai, acceptSpy, rejectSpy } = makeMockOpenAIv2(overrides)
    const app = await buildApp({
      openaiOverride: openai,
      whitelistOverride: whitelist,
      routerOverride: router as never,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/accept',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'p2-id-1',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,xxx',
      },
      payload: JSON.stringify({
        type: 'realtime.call.incoming',
        data: { call_id: 'rtc_p2' },
      }),
    })
    await app.close()
    return { res, acceptSpy, rejectSpy }
  }

  it('passes full SESSION_CONFIG + persona + tools list to accept() — case6b for Carsten CLI', async () => {
    const router = makeRouter()
    const { res, acceptSpy } = await acceptIncoming(
      new Set(['+491708036426']),
      router,
    )
    expect(res.statusCode).toBe(200)
    expect(acceptSpy).toHaveBeenCalledTimes(1)
    const [calledCallId, session] = acceptSpy.mock.calls[0]
    expect(calledCallId).toBe('rtc_p2')
    expect(session.model).toBe('gpt-realtime-mini')
    // Caller is Carsten CLI (+491708036426) → CASE6B_PERSONA (02-14)
    expect(session.instructions).toContain('Carsten')
    expect(session.instructions).toContain('ask_core')
    expect(session.audio.input.turn_detection.type).toBe('server_vad')
    expect(session.audio.input.turn_detection.create_response).toBe(true)
    expect(Array.isArray(session.tools)).toBe(true)
    expect(session.tools.length).toBe(11)
    expect(session.tools[0]).toHaveProperty('type', 'function')
    expect(session.tools[0]).toHaveProperty('name')
    expect(session.tools[0]).toHaveProperty('parameters')
  })

  it('every allowlist tool appears in the accept() tools list', async () => {
    const router = makeRouter()
    const { acceptSpy } = await acceptIncoming(
      new Set(['+491708036426']),
      router,
    )
    const session = acceptSpy.mock.calls[0][1]
    const names = session.tools.map((t: { name: string }) => t.name).sort()
    expect(names).toEqual([
      'ask_core',
      'check_calendar',
      'confirm_action',
      'create_calendar_entry',
      'get_contract',
      'get_practice_profile',
      'get_travel_time',
      'schedule_retry',
      'search_competitors',
      'send_discord_message',
      'transfer_call',
    ])
  })

  it('calls router.startCall exactly once with the callId after accept()', async () => {
    const router = makeRouter()
    await acceptIncoming(new Set(['+491708036426']), router)
    expect(router.startCall).toHaveBeenCalledTimes(1)
    expect(router.startCall.mock.calls[0][0]).toBe('rtc_p2')
  })

  it('does NOT call router.startCall if accept() rejects', async () => {
    const router = makeRouter()
    const acceptRejecting = vi.fn().mockRejectedValue(new Error('openai 500'))
    await acceptIncoming(new Set(['+491708036426']), router, {
      accept: acceptRejecting,
    })
    expect(router.startCall).not.toHaveBeenCalled()
  })

  it('non-incoming event → accept_skipped, router not called (OpenAI only emits realtime.call.incoming)', async () => {
    const { buildApp } = await import('../src/index.js')
    const router = makeRouter()
    const unwrap = vi.fn().mockResolvedValue({
      type: 'realtime.call.testing',
      data: { call_id: 'rtc_probe' },
    })
    const { openai, acceptSpy } = makeMockOpenAIv2({ unwrap })
    const app = await buildApp({
      openaiOverride: openai,
      whitelistOverride: new Set(['+491708036426']),
      routerOverride: router as never,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/accept',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'p2-probe',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,xxx',
      },
      payload: JSON.stringify({
        type: 'realtime.call.testing',
        data: { call_id: 'rtc_probe' },
      }),
    })
    await app.close()
    expect(res.statusCode).toBe(200)
    expect(acceptSpy).not.toHaveBeenCalled()
    expect(router.startCall).not.toHaveBeenCalled()
    expect(router.endCall).not.toHaveBeenCalled()
  })
})
