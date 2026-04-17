import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import {
  makeKey,
  canonicalJson,
  invokeIdempotent,
  clearCall,
  _cacheSize,
} from '../src/idempotency.js'

function mockLog(): Logger {
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

describe('idempotency.makeKey — D-02 key formula', () => {
  beforeEach(() => clearCall('*'))

  it('returns a 64-char hex sha256 digest', () => {
    const k = makeKey('call-1', 'turn-1', 'create_calendar_entry', { a: 1 })
    expect(k).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic — same inputs = same key', () => {
    const a = makeKey('c', 't', 'n', { x: 1, y: 2 })
    const b = makeKey('c', 't', 'n', { x: 1, y: 2 })
    expect(a).toBe(b)
  })

  it('is key-order independent — RFC 8785 canonical JSON', () => {
    const a = makeKey('c', 't', 'n', { foo: 1, bar: 2 })
    const b = makeKey('c', 't', 'n', { bar: 2, foo: 1 })
    expect(a).toBe(b)
  })

  it('recurses into nested objects', () => {
    const a = makeKey('c', 't', 'n', { outer: { z: 1, a: 2 } })
    const b = makeKey('c', 't', 'n', { outer: { a: 2, z: 1 } })
    expect(a).toBe(b)
  })

  it('treats arrays as ordered — reordering yields different key', () => {
    const a = makeKey('c', 't', 'n', [1, 2, 3])
    const b = makeKey('c', 't', 'n', [3, 2, 1])
    expect(a).not.toBe(b)
  })

  it('null-byte separator prevents callId/turnId concatenation collision', () => {
    const a = makeKey('ab', 'c', 'n', { x: 1 })
    const b = makeKey('a', 'bc', 'n', { x: 1 })
    expect(a).not.toBe(b)
  })

  it('throws on missing callId', () => {
    expect(() => makeKey('', 't', 'n', {})).toThrow(/requires non-empty/)
  })

  it('throws on missing turnId or toolName', () => {
    expect(() => makeKey('c', '', 'n', {})).toThrow(/requires non-empty/)
    expect(() => makeKey('c', 't', '', {})).toThrow(/requires non-empty/)
  })

  it('throws on undefined args', () => {
    expect(() => makeKey('c', 't', 'n', undefined)).toThrow(/requires args/)
  })

  it('accepts null args as valid', () => {
    expect(() => makeKey('c', 't', 'n', null)).not.toThrow()
  })
})

describe('idempotency.canonicalJson — structural regressions', () => {
  it('strips whitespace and sorts keys deeply', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    )
  })

  it('preserves array element order', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 'x'])).toBe('[{"a":2,"b":1},"x"]')
  })
})

describe('idempotency.invokeIdempotent — D-06 cache-hit semantics', () => {
  beforeEach(() => clearCall('*'))

  it('invokes invoker exactly once across two identical calls', async () => {
    const invoker = vi.fn().mockResolvedValue({ ok: true, id: 'abc' })
    const log = mockLog()
    const r1 = await invokeIdempotent(
      'c',
      't',
      'create_calendar_entry',
      { a: 1 },
      invoker,
      log,
    )
    const r2 = await invokeIdempotent(
      'c',
      't',
      'create_calendar_entry',
      { a: 1 },
      invoker,
      log,
    )
    expect(invoker).toHaveBeenCalledTimes(1)
    expect(r1).toEqual(r2)
  })

  it('logs idempotency_hit with 16-char key_hash on cache-hit', async () => {
    const invoker = vi.fn().mockResolvedValue({ ok: true })
    const log = mockLog()
    await invokeIdempotent('c', 't', 'n', { a: 1 }, invoker, log)
    await invokeIdempotent('c', 't', 'n', { a: 1 }, invoker, log)
    const infoCalls = (log.info as ReturnType<typeof vi.fn>).mock.calls
    const hitCall = infoCalls.find((c) => c[0]?.event === 'idempotency_hit')
    expect(hitCall).toBeDefined()
    expect(hitCall?.[0].key_hash).toMatch(/^[0-9a-f]{16}$/)
    expect(hitCall?.[0].call_id).toBe('c')
    expect(hitCall?.[0].turn_id).toBe('t')
    expect(hitCall?.[0].tool_name).toBe('n')
  })

  it('clearCall empties the cache — next invocation re-invokes (D-04)', async () => {
    const invoker = vi.fn().mockResolvedValue({ ok: true })
    const log = mockLog()
    await invokeIdempotent('c', 't', 'n', { a: 1 }, invoker, log)
    expect(_cacheSize()).toBe(1)
    clearCall('c')
    expect(_cacheSize()).toBe(0)
    await invokeIdempotent('c', 't', 'n', { a: 1 }, invoker, log)
    expect(invoker).toHaveBeenCalledTimes(2)
  })

  it('different args -> different key -> separate invocations', async () => {
    const invoker = vi.fn().mockImplementation(async (...args) => ({ args }))
    const log = mockLog()
    await invokeIdempotent('c', 't', 'n', { a: 1 }, invoker, log)
    await invokeIdempotent('c', 't', 'n', { a: 2 }, invoker, log)
    expect(invoker).toHaveBeenCalledTimes(2)
  })
})
