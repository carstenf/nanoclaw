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
          sip_headers: { From: '"Caller" <sip:+491708036426@sipgate.de>' },
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
          model: 'gpt-realtime',
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
