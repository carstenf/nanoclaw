import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The builder must be exported from src/index.ts to allow test injection
// without binding to 10.0.0.2.
// Lazy import so tests fail with meaningful errors during RED phase.

describe('webhook signature verification', () => {
  let logDir: string

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'bridge-test-'))
    process.env.OPENAI_WEBHOOK_SECRET = 'whsec_test_phase1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    process.env.BRIDGE_BIND = '127.0.0.1'
    process.env.BRIDGE_PORT = '0' // ephemeral
    process.env.BRIDGE_LOG_DIR = logDir
  })

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true })
    delete process.env.OPENAI_WEBHOOK_SECRET
    delete process.env.BRIDGE_BIND
    delete process.env.BRIDGE_PORT
    delete process.env.BRIDGE_LOG_DIR
  })

  it('GET /health returns 200 with required fields', async () => {
    const { buildApp } = await import('../src/index.js')
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.payload)
      expect(body.ok).toBe(true)
      expect(body.secret_loaded).toBe(true)
      expect(typeof body.uptime_s).toBe('number')
      expect(body.uptime_s).toBeGreaterThanOrEqual(0)
      expect(body.bind).toBe('127.0.0.1')
      expect(body.port).toBe(0)
    } finally {
      await app.close()
    }
  })

  it('POST /webhook with invalid signature returns 401', async () => {
    const { buildApp } = await import('../src/index.js')
    const app = await buildApp()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'webhook-id': 'test-id-123',
          'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
          'webhook-signature': 'v1,invalidsignature',
        },
        payload: JSON.stringify({ type: 'realtime.call.incoming', data: {} }),
      })
      expect(res.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })

  it.skip(
    'POST /webhook with valid signature returns 200 + JSONL entry',
    async () => {
      // Skipped per RESEARCH Assumption A2 — exact HMAC scheme verification
      // requires SDK round-trip with a real secret; covered by Plan 06 integration test.
    },
  )
})
