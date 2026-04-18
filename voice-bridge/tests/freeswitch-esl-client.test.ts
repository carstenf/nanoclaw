// voice-bridge/tests/freeswitch-esl-client.test.ts
// Plan 03-11 rewrite: ESL client unit tests with a fake socket.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'

import {
  buildOriginateCommand,
  eslOriginate,
  EslError,
} from '../src/freeswitch-esl-client.js'

interface FakeSocket extends EventEmitter {
  write: ReturnType<typeof vi.fn>
  setEncoding: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  // Helper to push a string from "FreeSWITCH" to our client.
  __recv: (s: string) => void
}

function makeFakeSocket(): FakeSocket {
  const ee = new EventEmitter() as FakeSocket
  ee.write = vi.fn()
  ee.setEncoding = vi.fn()
  ee.destroy = vi.fn()
  ee.__recv = (s: string) => ee.emit('data', s)
  return ee
}

describe('buildOriginateCommand', () => {
  it('produces api originate with PCMA + bridge to OpenAI proj', () => {
    const cmd = buildOriginateCommand({
      targetPhone: '+491708036426',
      taskId: 'task-uuid-1',
      projectId: 'proj_test_xyz',
      gatewayName: 'sipgate',
      openaiProfile: 'openai',
    })
    expect(cmd).toContain('api originate')
    expect(cmd).toContain('call_uuid=task-uuid-1')
    expect(cmd).toContain('absolute_codec_string=PCMA')
    expect(cmd).toContain('sofia/gateway/sipgate/+491708036426')
    expect(cmd).toContain('&bridge(')
    expect(cmd).toContain(
      'sofia/openai/sip:proj_test_xyz@sip.api.openai.com;transport=tls',
    )
  })
})

describe('eslOriginate', () => {
  it('happy path: auth → originate → +OK <uuid>', async () => {
    const sock = makeFakeSocket()
    const promise = eslOriginate({
      targetPhone: '+491708036426',
      taskId: 'task-1',
      password: 'Adagio11ESL',
      socketFactory: () => sock as unknown as never,
    })

    // Drain async setup
    await new Promise((r) => setImmediate(r))

    // FS sends auth/request
    sock.__recv('Content-Type: auth/request\n\n')
    await new Promise((r) => setImmediate(r))

    // Verify we sent auth command
    expect(sock.write).toHaveBeenCalledWith('auth Adagio11ESL\n\n')

    // FS sends auth OK
    sock.__recv(
      'Content-Type: command/reply\nReply-Text: +OK accepted\n\n',
    )
    await new Promise((r) => setImmediate(r))

    // Verify we sent originate
    expect(sock.write).toHaveBeenCalledWith(
      expect.stringContaining('api originate'),
    )

    // FS sends api/response with body "+OK <uuid>\n"
    const body = '+OK fs-uuid-12345\n'
    sock.__recv(
      `Content-Type: api/response\nContent-Length: ${body.length}\n\n${body}`,
    )

    const result = await promise
    expect(result.fsUuid).toBe('fs-uuid-12345')
    expect(sock.destroy).toHaveBeenCalled()
  })

  it('auth failure: -ERR reply rejects with auth_failed', async () => {
    const sock = makeFakeSocket()
    const promise = eslOriginate({
      targetPhone: '+491708036426',
      taskId: 'task-2',
      password: 'wrong-password',
      socketFactory: () => sock as unknown as never,
    })

    await new Promise((r) => setImmediate(r))
    sock.__recv('Content-Type: auth/request\n\n')
    await new Promise((r) => setImmediate(r))
    sock.__recv(
      'Content-Type: command/reply\nReply-Text: -ERR invalid\n\n',
    )

    await expect(promise).rejects.toThrow(EslError)
    await expect(promise).rejects.toThrow(/auth_failed/)
  })

  it('originate -ERR: api_failed with reason', async () => {
    const sock = makeFakeSocket()
    const promise = eslOriginate({
      targetPhone: '+491708036426',
      taskId: 'task-3',
      password: 'pw',
      socketFactory: () => sock as unknown as never,
    })

    await new Promise((r) => setImmediate(r))
    sock.__recv('Content-Type: auth/request\n\n')
    await new Promise((r) => setImmediate(r))
    sock.__recv(
      'Content-Type: command/reply\nReply-Text: +OK accepted\n\n',
    )
    await new Promise((r) => setImmediate(r))

    const body = '-ERR GATEWAY_DOWN\n'
    sock.__recv(
      `Content-Type: api/response\nContent-Length: ${body.length}\n\n${body}`,
    )

    await expect(promise).rejects.toThrow(/api_failed/)
    await expect(promise).rejects.toThrow(/GATEWAY_DOWN/)
  })

  it('socket error before auth → connect_failed', async () => {
    const sock = makeFakeSocket()
    const promise = eslOriginate({
      targetPhone: '+49170',
      taskId: 't',
      password: 'pw',
      socketFactory: () => sock as unknown as never,
    })

    await new Promise((r) => setImmediate(r))
    sock.emit('error', new Error('ECONNREFUSED 10.0.0.1:8021'))

    await expect(promise).rejects.toThrow(/connect_failed/)
  })

  it('timeout fires when FS sends nothing', async () => {
    const sock = makeFakeSocket()
    const promise = eslOriginate({
      targetPhone: '+49170',
      taskId: 't',
      password: 'pw',
      timeoutMs: 50,
      socketFactory: () => sock as unknown as never,
    })

    await expect(promise).rejects.toThrow(/timeout/)
  })

  it('missing password → auth_failed before any socket activity', async () => {
    await expect(
      eslOriginate({
        targetPhone: '+49170',
        taskId: 't',
        password: '',
        socketFactory: () => makeFakeSocket() as unknown as never,
      }),
    ).rejects.toThrow(/auth_failed/)
  })

  it('socket closes mid-flow → protocol_error', async () => {
    const sock = makeFakeSocket()
    const promise = eslOriginate({
      targetPhone: '+49170',
      taskId: 't',
      password: 'pw',
      socketFactory: () => sock as unknown as never,
    })

    await new Promise((r) => setImmediate(r))
    sock.__recv('Content-Type: auth/request\n\n')
    await new Promise((r) => setImmediate(r))
    sock.emit('close')

    await expect(promise).rejects.toThrow(/protocol_error/)
  })

  it('chunked data: header + body arrive in pieces', async () => {
    const sock = makeFakeSocket()
    const promise = eslOriginate({
      targetPhone: '+491708036426',
      taskId: 'task-chunked',
      password: 'pw',
      socketFactory: () => sock as unknown as never,
    })

    await new Promise((r) => setImmediate(r))
    // auth request split mid-line
    sock.__recv('Content-Type: ')
    sock.__recv('auth/request\n\n')
    await new Promise((r) => setImmediate(r))
    sock.__recv('Content-Type: command/reply\n')
    sock.__recv('Reply-Text: +OK accepted\n\n')
    await new Promise((r) => setImmediate(r))

    const body = '+OK abc-123\n'
    // header in one chunk, body in another
    sock.__recv(`Content-Type: api/response\nContent-Length: ${body.length}\n\n`)
    sock.__recv(body)

    const result = await promise
    expect(result.fsUuid).toBe('abc-123')
  })
})
