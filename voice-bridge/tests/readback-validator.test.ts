import { describe, it, expect, vi } from 'vitest'
import type { Logger } from 'pino'
import { validateReadback } from '../src/readback/validator.js'

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

describe('validateReadback — time dimension (D-13 exact)', () => {
  it('passes when persona says "siebzehn Uhr" for time=17:00', () => {
    const r = validateReadback(
      { time: '17:00' },
      'siebzehn Uhr',
      mockLog(),
      'c',
      't',
      'create_calendar_entry',
    )
    expect(r.ok).toBe(true)
  })

  it('passes for ambiguous "halb drei" matching 14:30', () => {
    const r = validateReadback(
      { time: '14:30' },
      'halb drei',
      mockLog(),
      'c',
      't',
      'create_calendar_entry',
    )
    expect(r.ok).toBe(true)
  })

  it('passes for ambiguous "halb drei" matching 02:30 as well', () => {
    const r = validateReadback(
      { time: '02:30' },
      'halb drei',
      mockLog(),
      'c',
      't',
      'create_calendar_entry',
    )
    expect(r.ok).toBe(true)
  })

  it('fails canonical siebzig/siebzehn misrecognition (SC-3 gate)', () => {
    const r = validateReadback(
      { time: '17:00' },
      'siebzig Uhr',
      mockLog(),
      'c',
      't',
      'create_calendar_entry',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.dimension).toBe('time')
  })

  it('logs readback_mismatch JSONL on fail (D-14)', () => {
    const log = mockLog()
    validateReadback({ time: '17:00' }, 'achtzehn Uhr', log, 'c', 't', 'x')
    const warn = log.warn as ReturnType<typeof vi.fn>
    expect(warn.mock.calls.some((c) => c[0]?.event === 'readback_mismatch')).toBe(
      true,
    )
    const hit = warn.mock.calls.find(
      (c) => c[0]?.event === 'readback_mismatch',
    )
    expect(hit?.[0].tolerance_dim).toBe('time')
    expect(hit?.[0].expected).toBe('17:00')
    expect(hit?.[0].observed).toBe('achtzehn Uhr')
  })
})

describe('validateReadback — date dimension', () => {
  it('passes "dreiundzwanzigste" for date=2026-05-23', () => {
    const r = validateReadback(
      { date: '2026-05-23' },
      'dreiundzwanzigste',
      mockLog(),
      'c',
      't',
      'create_calendar_entry',
    )
    expect(r.ok).toBe(true)
  })

  it('fails "siebzehnte" for date=2026-05-23', () => {
    const r = validateReadback(
      { date: '2026-05-23' },
      'siebzehnte',
      mockLog(),
      'c',
      't',
      'create_calendar_entry',
    )
    expect(r.ok).toBe(false)
  })
})

describe('validateReadback — name dimension (Levenshtein <= 2)', () => {
  it('passes close match with umlaut fold (Müller/Mueller)', () => {
    const r = validateReadback(
      { title: 'Müller' },
      'Mueller',
      mockLog(),
      'c',
      't',
      'schedule_retry',
    )
    expect(r.ok).toBe(true)
  })

  it('passes one-char typo (Schmidt/Schmit)', () => {
    const r = validateReadback(
      { title: 'Schmidt' },
      'Schmit',
      mockLog(),
      'c',
      't',
      'schedule_retry',
    )
    expect(r.ok).toBe(true)
  })

  it('fails totally different name', () => {
    const r = validateReadback(
      { title: 'Schmidt' },
      'Bundeskanzler',
      mockLog(),
      'c',
      't',
      'schedule_retry',
    )
    expect(r.ok).toBe(false)
  })
})

describe('validateReadback — freetext (dice >= 0.85)', () => {
  it('passes identical tokens (case + casing irrelevant)', () => {
    const r = validateReadback(
      { content: 'Hallo Carsten schick Termin' },
      'hallo carsten schick termin',
      mockLog(),
      'c',
      't',
      'send_discord_message',
    )
    expect(r.ok).toBe(true)
  })

  it('fails when content diverges heavily', () => {
    const r = validateReadback(
      { content: 'Hallo Carsten schick Termin' },
      'komplett anderer satz wirklich sehr anders',
      mockLog(),
      'c',
      't',
      'send_discord_message',
    )
    expect(r.ok).toBe(false)
  })
})

describe('validateReadback — empty-args edge case', () => {
  it('passes when toolArgs is empty (schema-validation already vetted shape)', () => {
    const r = validateReadback({}, 'egal', mockLog(), 'c', 't', 'x')
    expect(r.ok).toBe(true)
  })

  it('passes when toolArgs is null', () => {
    const r = validateReadback(null, 'egal', mockLog(), 'c', 't', 'x')
    expect(r.ok).toBe(true)
  })
})
