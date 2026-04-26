// voice-bridge/tests/filler-inject.test.ts
// Plan 02-14: Tests for code-side filler-phrase injection (emitFillerPhrase).
import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'
import { emitFillerPhrase } from '../src/tools/filler-inject.js'

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

function makeMockWS(sendImpl?: () => void) {
  return {
    send: sendImpl ? vi.fn(sendImpl) : vi.fn(),
  } as unknown as WSType
}

describe('emitFillerPhrase — code-side filler injection (02-14)', () => {
  it('happy path ask_core: sends conversation.item.create then response.create (2 messages)', async () => {
    const ws = makeMockWS()
    const log = makeLog()

    const result = await emitFillerPhrase(ws, 'ask_core', 'call_1', log)

    expect(result).toBe(true)
    expect(ws.send).toHaveBeenCalledTimes(2)

    const firstCall = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)
    expect(firstCall.type).toBe('conversation.item.create')
    expect(firstCall.item.type).toBe('message')
    expect(firstCall.item.role).toBe('assistant')
    // Current OpenAI Realtime schema: assistant-message content uses
    // `output_text` (not `text`). Old field name triggers session_update_rejected
    // — see filler-inject.ts:68 production comment.
    expect(firstCall.item.content[0].type).toBe('output_text')
    expect(firstCall.item.content[0].text).toContain('Moment, ich frage Andy')

    const secondCall = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as string)
    expect(secondCall.type).toBe('response.create')
    // Current schema also requires output_modalities (not modalities).
    expect(secondCall.response.output_modalities).toEqual(['audio'])
  })

  it('unknown tool name returns false without sending', async () => {
    const ws = makeMockWS()
    const log = makeLog()

    const result = await emitFillerPhrase(ws, 'check_calendar', 'call_2', log)

    expect(result).toBe(false)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('ws.send throws — returns false and logs warn, does not throw', async () => {
    const ws = makeMockWS(() => { throw new Error('WebSocket not open') })
    const log = makeLog()

    const result = await emitFillerPhrase(ws, 'ask_core', 'call_3', log)

    expect(result).toBe(false)
    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
  })

  it('empty tool name returns false without sending', async () => {
    const ws = makeMockWS()
    const log = makeLog()

    const result = await emitFillerPhrase(ws, '', 'call_4', log)

    expect(result).toBe(false)
    expect(ws.send).not.toHaveBeenCalled()
  })

  it('sequence order: conversation.item.create BEFORE response.create', async () => {
    const calls: string[] = []
    const ws = {
      send: vi.fn((msg: string) => { calls.push(JSON.parse(msg).type as string) }),
    } as unknown as WSType
    const log = makeLog()

    await emitFillerPhrase(ws, 'ask_core', 'call_5', log)

    expect(calls[0]).toBe('conversation.item.create')
    expect(calls[1]).toBe('response.create')
  })
})
