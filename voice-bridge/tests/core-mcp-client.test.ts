import http from 'http'
import type { AddressInfo } from 'net'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  callCoreTool,
  CoreMcpError,
  CoreMcpTimeoutError,
} from '../src/core-mcp-client.js'

let server: http.Server
let baseUrl: string

function makeServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<void> {
  server = http.createServer(handler)
  return new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

beforeEach(() => {
  baseUrl = ''
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function url(): string {
  const addr = server.address() as AddressInfo
  return `http://127.0.0.1:${addr.port}/mcp`
}

describe('callCoreTool — happy path', () => {
  it('POST tool + body, parses JSON response', async () => {
    let seenBody: unknown
    let seenMethod = ''
    let seenUrl = ''
    await makeServer((req, res) => {
      seenMethod = req.method ?? ''
      seenUrl = req.url ?? ''
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        seenBody = JSON.parse(raw)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, instructions_update: 'neue instr' }))
      })
    })
    const result = await callCoreTool(
      'voice.on_transcript_turn',
      { call_id: 'c', turn_id: 't', transcript: 'hi' },
      { url: url(), timeoutMs: 1000 },
    )
    expect(seenMethod).toBe('POST')
    expect(seenUrl).toBe('/mcp/voice.on_transcript_turn')
    expect(seenBody).toEqual({
      arguments: { call_id: 'c', turn_id: 't', transcript: 'hi' },
    })
    expect(result).toEqual({ ok: true, instructions_update: 'neue instr' })
  })
})

describe('callCoreTool — timeout', () => {
  it('throws CoreMcpTimeoutError on AbortController fire', async () => {
    await makeServer((_req, res) => {
      // Never respond within the test's short timeout.
      void res
    })
    await expect(
      callCoreTool(
        'voice.on_transcript_turn',
        {},
        { url: url(), timeoutMs: 40 },
      ),
    ).rejects.toBeInstanceOf(CoreMcpTimeoutError)
  }, 2000)
})

describe('callCoreTool — 5xx', () => {
  it('throws CoreMcpError with status=500', async () => {
    await makeServer((_req, res) => {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'internal', ref_id: 'abc' }))
    })
    try {
      await callCoreTool('voice.on_transcript_turn', {}, { url: url() })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(CoreMcpError)
      expect((e as CoreMcpError).status).toBe(500)
      expect((e as CoreMcpError).body).toEqual({
        error: 'internal',
        ref_id: 'abc',
      })
    }
  })
})

describe('callCoreTool — 4xx', () => {
  it('throws CoreMcpError with status=400', async () => {
    await makeServer((_req, res) => {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'bad_request', field: 'call_id' }))
    })
    try {
      await callCoreTool('voice.on_transcript_turn', {}, { url: url() })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(CoreMcpError)
      expect((e as CoreMcpError).status).toBe(400)
    }
  })
})

describe('callCoreTool — config validation', () => {
  it('throws when no URL configured and none in opts', async () => {
    await expect(callCoreTool('voice.on_transcript_turn', {})).rejects.toThrow(
      /CORE_MCP_URL/,
    )
  })
})
