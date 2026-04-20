// tests/outbound-webhook.test.ts — RED tests for POST /outbound route
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const VALID_BODY = {
  target_phone: '+491234567890',
  goal: 'Termin bei Zahnarzt vereinbaren',
  context: 'Carsten braucht einen Termin',
  report_to_jid: 'dc:1490365616518070407',
}

async function buildTestApp(overrides: {
  peerIp?: string
  authToken?: string
  routerOverride?: Record<string, unknown>
} = {}) {
  process.env.OPENAI_WEBHOOK_SECRET = 'whsec_test_phase1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  process.env.OPENAI_API_KEY = 'sk-test-dummy'
  process.env.BRIDGE_BIND = '127.0.0.1'
  process.env.BRIDGE_PORT = '0'

  const { buildApp } = await import('../src/index.js')

  const mockRouter = overrides.routerOverride ?? {
    enqueue: vi.fn().mockReturnValue({
      task_id: 'uuid-test-1234',
      status: 'queued',
      created_at: Date.now(),
      target_phone: VALID_BODY.target_phone,
      goal: VALID_BODY.goal,
      context: VALID_BODY.context,
      report_to_jid: VALID_BODY.report_to_jid,
    }),
    onCallEnd: vi.fn(),
    getState: vi.fn().mockReturnValue([]),
  }

  const app = await buildApp({
    skipApiKey: false,
    outboundRouterOverride: mockRouter as never,
    outboundAuthToken: overrides.authToken,
    peerIpOverride: overrides.peerIp ?? '10.0.0.1',
  })
  return { app, mockRouter }
}

describe('POST /outbound — Bridge outbound HTTP route', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.OPENAI_WEBHOOK_SECRET
    delete process.env.OPENAI_API_KEY
    delete process.env.BRIDGE_BIND
    delete process.env.BRIDGE_PORT
  })

  it('happy path: valid body from allowed peer returns 200 with task_id', async () => {
    const { app, mockRouter } = await buildTestApp({ peerIp: '10.0.0.1' })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify(VALID_BODY),
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.outbound_task_id).toBeDefined()
      expect(body.estimated_start_ts).toBeDefined()
      expect(typeof body.queue_position).toBe('number')
      expect(mockRouter.enqueue).toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('peer-not-allowed: request from non-allowlisted IP returns 403', async () => {
    const { app } = await buildTestApp({ peerIp: '8.8.8.8' })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '8.8.8.8' },
        payload: JSON.stringify(VALID_BODY),
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('missing-auth: returns 401 when authToken configured but missing in request', async () => {
    const { app } = await buildTestApp({ peerIp: '10.0.0.1', authToken: 'secret-token' })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify(VALID_BODY),
      })
      expect(res.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })

  it('bad-body: returns 400 for invalid body (missing goal)', async () => {
    const { app } = await buildTestApp({ peerIp: '10.0.0.1' })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify({ target_phone: '+491234567890' }), // missing goal, report_to_jid
      })
      expect(res.statusCode).toBe(400)
      const body = JSON.parse(res.payload)
      expect(body.error).toBe('bad_request')
    } finally {
      await app.close()
    }
  })

  it('bad-body: returns 400 for invalid E164 phone number', async () => {
    const { app } = await buildTestApp({ peerIp: '10.0.0.1' })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify({ ...VALID_BODY, target_phone: '0891234567' }), // not E.164
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('queue-full: returns 429 when router.enqueue throws QueueFullError', async () => {
    const { QueueFullError } = await import('../src/outbound-router.js')
    const fullRouter = {
      enqueue: vi.fn().mockImplementation(() => { throw new QueueFullError() }),
      onCallEnd: vi.fn(),
      getState: vi.fn().mockReturnValue([]),
    }
    const { app } = await buildTestApp({ peerIp: '10.0.0.1', routerOverride: fullRouter })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify(VALID_BODY),
      })
      expect(res.statusCode).toBe(429)
      const body = JSON.parse(res.payload)
      expect(body.error).toBe('queue_full')
    } finally {
      await app.close()
    }
  })

  // ---- Plan 05-00 Task 1 (Spike-A) / Wave 3 prep: override envelope ----

  it('persona_override is forwarded through router.enqueue', async () => {
    const { app, mockRouter } = await buildTestApp({ peerIp: '10.0.0.1' })
    try {
      const overrideText = 'SPIKE-A CLASSIFIER PROMPT verbatim text'
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify({ ...VALID_BODY, persona_override: overrideText }),
      })
      expect(res.statusCode).toBe(200)
      expect(mockRouter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ persona_override: overrideText }),
      )
    } finally {
      await app.close()
    }
  })

  it('tools_override with valid tool name is forwarded through router.enqueue', async () => {
    const { app, mockRouter } = await buildTestApp({ peerIp: '10.0.0.1' })
    try {
      const toolsOverride = [
        {
          name: 'amd_result',
          description: 'Spike-A AMD verdict',
          parameters: {
            type: 'object',
            properties: { verdict: { type: 'string', enum: ['human', 'voicemail', 'silence'] } },
            required: ['verdict'],
          },
        },
      ]
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify({ ...VALID_BODY, tools_override: toolsOverride }),
      })
      expect(res.statusCode).toBe(200)
      expect(mockRouter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ tools_override: toolsOverride }),
      )
    } finally {
      await app.close()
    }
  })

  it('tools_override with illegal tool name ("foo.bar") is rejected at zod boundary (400)', async () => {
    const { app, mockRouter } = await buildTestApp({ peerIp: '10.0.0.1' })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify({
          ...VALID_BODY,
          tools_override: [
            { name: 'foo.bar', parameters: { type: 'object' } },
          ],
        }),
      })
      expect(res.statusCode).toBe(400)
      expect(mockRouter.enqueue).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('estimated-start-ts in future when active call present', async () => {
    const now = Date.now()
    const activeRouter = {
      enqueue: vi.fn().mockReturnValue({
        task_id: 'uuid-future',
        status: 'queued',
        created_at: now,
        target_phone: VALID_BODY.target_phone,
        goal: VALID_BODY.goal,
        context: VALID_BODY.context,
        report_to_jid: VALID_BODY.report_to_jid,
      }),
      onCallEnd: vi.fn(),
      getState: vi.fn().mockReturnValue([
        { status: 'active', task_id: 'existing-call', target_phone: '+490000000000', goal: 'ongoing', context: '', report_to_jid: 'dc:0', created_at: now - 60000 }
      ]),
    }
    const { app } = await buildTestApp({ peerIp: '10.0.0.1', routerOverride: activeRouter })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify(VALID_BODY),
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      // estimated_start_ts should be a valid ISO timestamp
      expect(new Date(body.estimated_start_ts).getTime()).toBeGreaterThan(0)
      expect(body.queue_position).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  // ---- Plan 05-02 Wave 2: case_type + case_payload forwarding ----

  it('case_type and case_payload are forwarded to router.enqueue', async () => {
    const { app, mockRouter } = await buildTestApp({ peerIp: '10.0.0.1' })
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/outbound',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
        payload: JSON.stringify({
          ...VALID_BODY,
          case_type: 'case_2',
          case_payload: { bar: 2, restaurant_name: 'La Piazza' },
        }),
      })
      expect(res.statusCode).toBe(200)
      expect(mockRouter.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          case_type: 'case_2',
          case_payload: { bar: 2, restaurant_name: 'La Piazza' },
        }),
      )
    } finally {
      await app.close()
    }
  })
})
