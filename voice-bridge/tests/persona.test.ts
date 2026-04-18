import { describe, it, expect } from 'vitest'
import { PHASE2_PERSONA } from '../src/persona.js'

describe('PHASE2_PERSONA — required directives', () => {
  it('is a non-empty German prompt', () => {
    expect(typeof PHASE2_PERSONA).toBe('string')
    expect(PHASE2_PERSONA.length).toBeGreaterThan(400)
  })

  it.each([
    ['German-only mandate', 'de-DE'],
    ['Tool-first prohibition', 'aus dem Gedächtnis'],
    ['Two-form readback (time)', 'siebzehn Uhr'],
    ['Two-form readback (date)', 'dreiundzwanzigsten Mai'],
    ['Filler phrase', 'Einen Moment bitte'],
    ['10s silence prompt', 'Sind Sie noch da?'],
    ['Passive disclosure', 'Sind Sie ein Bot?'],
    ['No named human identity', 'namentlich genannte Person'],
  ])('contains %s directive', (_label, marker) => {
    expect(PHASE2_PERSONA).toContain(marker)
  })
})

// --- CASE6B_PERSONA tests (02-14) ---
import { CASE6B_PERSONA } from '../src/persona.js'

describe('CASE6B_PERSONA — Case-6b persona for Carsten CLI calls', () => {
  it('is a non-empty string', () => {
    expect(typeof CASE6B_PERSONA).toBe('string')
    expect(CASE6B_PERSONA.length).toBeGreaterThan(200)
  })

  it('contains greeting hint for Carsten', () => {
    expect(CASE6B_PERSONA).toContain('Carsten')
  })

  it('contains ask_core delegation instruction', () => {
    expect(CASE6B_PERSONA).toContain('ask_core')
  })

  it("contains Filler-Phrase 'Moment, ich frage Andy'", () => {
    expect(CASE6B_PERSONA).toContain('Moment, ich frage Andy')
  })

  it('contains passive disclosure directive', () => {
    expect(CASE6B_PERSONA).toContain('Bist du ein Bot?')
  })

  it('is different from PHASE2_PERSONA', () => {
    expect(CASE6B_PERSONA).not.toBe(PHASE2_PERSONA)
  })
})
