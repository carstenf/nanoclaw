// voice-bridge/tests/sipgate-rest-client.test.ts
// Plan 03-11 pivot 2026-04-19: Sipgate REST-API outbound client tests.
import { describe, it, expect, vi } from 'vitest'

import {
  sipgateRestOriginate,
  SipgateRestError,
} from '../src/sipgate-rest-client.js'

function mockFetch(
  response: { ok: boolean; status?: number; bodyText: string },
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    text: async () => response.bodyText,
  } as Response) as unknown as typeof globalThis.fetch
}

describe('sipgateRestOriginate (03-11 pivot)', () => {
  it('happy path: POST /v2/sessions/calls with basic-auth and body, returns sessionId', async () => {
    const fetchFn = mockFetch({
      ok: true,
      bodyText: JSON.stringify({ sessionId: 'sess-12345' }),
    })

    const result = await sipgateRestOriginate({
      callee: '+491708036426',
      taskId: 'task-1',
      tokenId: 'token-XYZ',
      token: 'secret-abc',
      deviceId: 'e0',
      caller: '+49308687022345',
      fetchFn,
    })

    expect(result.sessionId).toBe('sess-12345')

    const callArgs = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]
    expect(callArgs[0]).toBe('https://api.sipgate.com/v2/sessions/calls')
    const opts = callArgs[1] as RequestInit
    expect(opts.method).toBe('POST')
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      'Basic ' + Buffer.from('token-XYZ:secret-abc').toString('base64'),
    )
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    )
    const body = JSON.parse(opts.body as string)
    expect(body).toEqual({
      deviceId: 'e0',
      callee: '+491708036426',
      caller: '+49308687022345',
    })
  })

  it('omits caller when empty (Sipgate uses device default)', async () => {
    const fetchFn = mockFetch({
      ok: true,
      bodyText: JSON.stringify({ sessionId: 'sess-2' }),
    })
    await sipgateRestOriginate({
      callee: '+491708036426',
      taskId: 't',
      tokenId: 'a',
      token: 'b',
      deviceId: 'e0',
      caller: '',
      fetchFn,
    })
    const body = JSON.parse(
      ((fetchFn as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as RequestInit).body as string,
    )
    expect(body).toEqual({ deviceId: 'e0', callee: '+491708036426' })
    expect(body.caller).toBeUndefined()
  })

  it('throws auth_missing when SIPGATE_TOKEN_ID/TOKEN unset', async () => {
    await expect(
      sipgateRestOriginate({
        callee: '+49',
        taskId: 't',
        tokenId: '',
        token: 'b',
        deviceId: 'e0',
        fetchFn: vi.fn() as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/auth_missing/)
  })

  it('throws auth_missing when SIPGATE_DEVICE_ID unset', async () => {
    await expect(
      sipgateRestOriginate({
        callee: '+49',
        taskId: 't',
        tokenId: 'a',
        token: 'b',
        deviceId: '',
        fetchFn: vi.fn() as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/auth_missing/)
  })

  it('http_error: 401 unauthorized propagates as SipgateRestError', async () => {
    const fetchFn = mockFetch({
      ok: false,
      status: 401,
      bodyText: 'Unauthorized',
    })
    try {
      await sipgateRestOriginate({
        callee: '+49',
        taskId: 't',
        tokenId: 'a',
        token: 'b',
        deviceId: 'e0',
        fetchFn,
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SipgateRestError)
      expect((err as SipgateRestError).code).toBe('http_error')
      expect((err as SipgateRestError).httpStatus).toBe(401)
    }
  })

  it('http_error: 400 bad request includes response body in message', async () => {
    const fetchFn = mockFetch({
      ok: false,
      status: 400,
      bodyText: JSON.stringify({ message: 'invalid callee' }),
    })
    await expect(
      sipgateRestOriginate({
        callee: 'not-e164',
        taskId: 't',
        tokenId: 'a',
        token: 'b',
        deviceId: 'e0',
        fetchFn,
      }),
    ).rejects.toThrow(/invalid callee/)
  })

  it('network_error wraps fetch failure', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof globalThis.fetch
    await expect(
      sipgateRestOriginate({
        callee: '+49',
        taskId: 't',
        tokenId: 'a',
        token: 'b',
        deviceId: 'e0',
        fetchFn,
      }),
    ).rejects.toThrow(/network_error.*ECONNREFUSED/)
  })

  it('timeout: AbortError mapped to timeout code', async () => {
    const fetchFn = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        const sig = (opts as RequestInit).signal as AbortSignal
        sig.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    }) as unknown as typeof globalThis.fetch
    await expect(
      sipgateRestOriginate({
        callee: '+49',
        taskId: 't',
        tokenId: 'a',
        token: 'b',
        deviceId: 'e0',
        timeoutMs: 30,
        fetchFn,
      }),
    ).rejects.toThrow(/timeout/)
  })

  it('handles 204 No Content (sessionId empty string, not crash)', async () => {
    const fetchFn = mockFetch({ ok: true, status: 204, bodyText: '' })
    const r = await sipgateRestOriginate({
      callee: '+49',
      taskId: 't',
      tokenId: 'a',
      token: 'b',
      deviceId: 'e0',
      fetchFn,
    })
    expect(r.sessionId).toBe('')
  })
})
