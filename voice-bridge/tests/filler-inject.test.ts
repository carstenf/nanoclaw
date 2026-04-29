// voice-bridge/tests/filler-inject.test.ts
// Phase 06.x: filler is language-neutral. emitFillerPhrase emits one
// response.create with an English instruction-override; the model produces
// the spoken filler in whatever language the call is currently in.
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

describe('emitFillerPhrase — language-neutral filler injection (Phase 06.x)', () => {
  it('happy path ask_core: emits one response.create (audio-only, tool_choice:none, instruction-override)', async () => {
    const ws = makeMockWS()
    const log = makeLog()

    const result = await emitFillerPhrase(ws, 'ask_core', 'call_1', log)

    expect(result).toBe(true)
    expect(ws.send).toHaveBeenCalledTimes(1)

    const sent = JSON.parse(
      (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    )
    expect(sent.type).toBe('response.create')
    expect(sent.response.output_modalities).toEqual(['audio'])
    expect(sent.response.tool_choice).toBe('none')
    // Override-instruction must tell the model to speak in the call's
    // active language — without that clause the model would use the
    // override's own language (English).
    expect(typeof sent.response.instructions).toBe('string')
    expect(sent.response.instructions.toLowerCase()).toContain('language')
    // Must NOT carry a literal text payload (no conversation.item.create
    // with quoted text — Phase 06.x removes language-specific wording).
    expect(sent.response.instructions).not.toMatch(/^["'].*["']$/)
  })

  it('does not emit conversation.item.create (no literal filler text)', async () => {
    const types: string[] = []
    const ws = {
      send: vi.fn((msg: string) => {
        types.push(JSON.parse(msg).type as string)
      }),
    } as unknown as WSType
    const log = makeLog()

    await emitFillerPhrase(ws, 'ask_core', 'call_no_text', log)

    expect(types).toEqual(['response.create'])
    expect(types).not.toContain('conversation.item.create')
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

  it('dedup: same call+tool inside cooldown window emits only once', async () => {
    const ws = makeMockWS()
    const log = makeLog()

    const r1 = await emitFillerPhrase(ws, 'ask_core', 'call_dedup', log)
    const r2 = await emitFillerPhrase(ws, 'ask_core', 'call_dedup', log)

    expect(r1).toBe(true)
    expect(r2).toBe(false)
    expect(ws.send).toHaveBeenCalledTimes(1)
  })
})
