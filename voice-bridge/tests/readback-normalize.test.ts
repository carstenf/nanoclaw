import { describe, it, expect } from 'vitest'
import {
  foldDiacritics,
  germanWordToNumber,
  normalizeGermanTime,
  normalizeGermanDate,
} from '../src/readback/normalize.js'

describe('foldDiacritics', () => {
  it('folds umlauts + ß into ASCII', () => {
    expect(foldDiacritics('Müller')).toBe('mueller')
    expect(foldDiacritics('Straße')).toBe('strasse')
    expect(foldDiacritics('ÖFB')).toBe('oefb')
    expect(foldDiacritics('Jörg')).toBe('joerg')
  })
})

describe('germanWordToNumber', () => {
  it('maps teens + tens directly', () => {
    expect(germanWordToNumber('siebzehn')).toBe(17)
    expect(germanWordToNumber('zwanzig')).toBe(20)
    expect(germanWordToNumber('sieben')).toBe(7)
    expect(germanWordToNumber('null')).toBe(0)
  })

  it('handles compound "NundM" and "N und M"', () => {
    expect(germanWordToNumber('dreiundzwanzig')).toBe(23)
    expect(germanWordToNumber('einundvierzig')).toBe(41)
    expect(germanWordToNumber('neunundneunzig')).toBe(99)
    expect(germanWordToNumber('drei und zwanzig')).toBe(23)
  })

  it('accepts raw digits', () => {
    expect(germanWordToNumber('17')).toBe(17)
    expect(germanWordToNumber('0')).toBe(0)
  })

  it('folds umlauts before lookup (fünf = fuenf)', () => {
    expect(germanWordToNumber('fünf')).toBe(5)
    expect(germanWordToNumber('zwölf')).toBe(12)
    expect(germanWordToNumber('dreißig')).toBe(30)
  })

  it('returns null on unknown tokens / empty', () => {
    expect(germanWordToNumber('foo')).toBeNull()
    expect(germanWordToNumber('')).toBeNull()
    expect(germanWordToNumber('   ')).toBeNull()
  })
})

describe('normalizeGermanTime', () => {
  it('parses explicit HH:MM', () => {
    expect(normalizeGermanTime('17:00')).toBe('17:00')
    expect(normalizeGermanTime('12:30')).toBe('12:30')
    expect(normalizeGermanTime('09:05')).toBe('09:05')
  })

  it('parses "<word> Uhr" and "<digits> Uhr"', () => {
    expect(normalizeGermanTime('siebzehn Uhr')).toBe('17:00')
    expect(normalizeGermanTime('17 Uhr')).toBe('17:00')
    expect(normalizeGermanTime('acht Uhr')).toBe('08:00')
  })

  it('returns AM|PM ambiguity for halb/viertel forms', () => {
    expect(normalizeGermanTime('halb drei')).toBe('02:30|14:30')
    expect(normalizeGermanTime('Viertel nach drei')).toBe('03:15|15:15')
    expect(normalizeGermanTime('Viertel vor drei')).toBe('02:45|14:45')
  })

  it('returns null on malformed input', () => {
    expect(normalizeGermanTime('pfui')).toBeNull()
    expect(normalizeGermanTime('25:00')).toBeNull()
    expect(normalizeGermanTime('')).toBeNull()
  })
})

describe('normalizeGermanDate', () => {
  it('maps ordinals to zero-padded DD', () => {
    expect(normalizeGermanDate('dreiundzwanzigste')).toBe('23')
    expect(normalizeGermanDate('erste')).toBe('01')
    expect(normalizeGermanDate('siebzehnte')).toBe('17')
  })

  it('accepts digit + trailing dot', () => {
    expect(normalizeGermanDate('17.')).toBe('17')
    expect(normalizeGermanDate('1.')).toBe('01')
  })

  it('accepts cardinal spelled-out numbers', () => {
    expect(normalizeGermanDate('dreiundzwanzig')).toBe('23')
  })

  it('rejects out-of-range / unknown', () => {
    expect(normalizeGermanDate('32')).toBeNull()
    expect(normalizeGermanDate('0')).toBeNull()
    expect(normalizeGermanDate('pfui')).toBeNull()
    expect(normalizeGermanDate('')).toBeNull()
  })

  it('handles dreißigste with umlaut fold', () => {
    expect(normalizeGermanDate('dreißigste')).toBe('30')
  })
})
