// voice-bridge/src/tools/tool-output-emitter.test.ts
// TDD RED phase — tests for emitFunctionCallOutput + emitResponseCreate helpers.
import { describe, it, expect, vi } from 'vitest'
import type { WebSocket as WSType } from 'ws'
import {
  emitFunctionCallOutput,
  emitResponseCreate,
} from '../src/tools/tool-output-emitter.js'
import type { Logger } from 'pino'

function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: 'info',
  } as unknown as Logger
}

interface MockWS {
  send: ReturnType<typeof vi.fn>
}

function makeMockWS(): MockWS {
  return { send: vi.fn() }
}

describe('emitFunctionCallOutput', () => {
  it('sends conversation.item.create with function_call_output type and correct payload', () => {
    const ws = makeMockWS()
    const log = makeLog()
    const result = emitFunctionCallOutput(
      ws as unknown as WSType,
      'call_abc',
      { busy: [{ start: '09:00', end: '10:00' }] },
      log,
    )
    expect(result).toBe(true)
    expect(ws.send).toHaveBeenCalledTimes(1)
    const msg = JSON.parse(ws.send.mock.calls[0][0] as string)
    expect(msg.type).toBe('conversation.item.create')
    expect(msg.item.type).toBe('function_call_output')
    expect(msg.item.call_id).toBe('call_abc')
    const output = JSON.parse(msg.item.output as string)
    expect(output.busy).toBeDefined()
  })

  it('returns false and logs WARN when ws.send throws', () => {
    const ws = makeMockWS()
    ws.send.mockImplementation(() => {
      throw new Error('ws closed')
    })
    const log = makeLog()
    const result = emitFunctionCallOutput(
      ws as unknown as WSType,
      'call_fail',
      { error: 'tool_timeout' },
      log,
    )
    expect(result).toBe(false)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})

describe('emitResponseCreate', () => {
  it('sends response.create message', () => {
    const ws = makeMockWS()
    const log = makeLog()
    const result = emitResponseCreate(ws as unknown as WSType, log)
    expect(result).toBe(true)
    expect(ws.send).toHaveBeenCalledTimes(1)
    const msg = JSON.parse(ws.send.mock.calls[0][0] as string)
    expect(msg.type).toBe('response.create')
  })

  it('returns false and logs WARN when ws.send throws', () => {
    const ws = makeMockWS()
    ws.send.mockImplementation(() => {
      throw new Error('network error')
    })
    const log = makeLog()
    const result = emitResponseCreate(ws as unknown as WSType, log)
    expect(result).toBe(false)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('sequential emit calls: emitFunctionCallOutput then emitResponseCreate in order', () => {
    const ws = makeMockWS()
    const log = makeLog()
    const r1 = emitFunctionCallOutput(ws as unknown as WSType, 'call_seq', { ok: true }, log)
    const r2 = emitResponseCreate(ws as unknown as WSType, log)
    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(ws.send).toHaveBeenCalledTimes(2)
    const first = JSON.parse(ws.send.mock.calls[0][0] as string)
    const second = JSON.parse(ws.send.mock.calls[1][0] as string)
    expect(first.type).toBe('conversation.item.create')
    expect(second.type).toBe('response.create')
  })
})
