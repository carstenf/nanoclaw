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

// --- OUTBOUND_PERSONA_TEMPLATE + buildOutboundPersona tests (03-11) ---
import { OUTBOUND_PERSONA_TEMPLATE, buildOutboundPersona } from '../src/persona.js'

describe('OUTBOUND_PERSONA_TEMPLATE + buildOutboundPersona — Plan 03-11', () => {
  it('template is a non-empty string with both placeholders', () => {
    expect(typeof OUTBOUND_PERSONA_TEMPLATE).toBe('string')
    expect(OUTBOUND_PERSONA_TEMPLATE).toContain('{{goal}}')
    expect(OUTBOUND_PERSONA_TEMPLATE).toContain('{{context}}')
  })

  it('template contains Werkzeug-zuerst directive', () => {
    expect(OUTBOUND_PERSONA_TEMPLATE).toContain('WERKZEUG-ZUERST')
  })

  it('template contains passive-disclosure directive', () => {
    expect(OUTBOUND_PERSONA_TEMPLATE).toContain('Passive Disclosure')
  })

  it('template contains NanoClaw im Auftrag von Carsten branding', () => {
    expect(OUTBOUND_PERSONA_TEMPLATE).toContain('NanoClaw')
    expect(OUTBOUND_PERSONA_TEMPLATE).toContain('Carsten')
  })

  it('buildOutboundPersona substitutes {{goal}} placeholder', () => {
    const result = buildOutboundPersona('Arzttermin vereinbaren', '')
    expect(result).toContain('Arzttermin vereinbaren')
    expect(result).not.toContain('{{goal}}')
  })

  it('buildOutboundPersona substitutes {{context}} placeholder', () => {
    const result = buildOutboundPersona('Test goal', 'Extra context info')
    expect(result).toContain('Extra context info')
    expect(result).not.toContain('{{context}}')
  })

  it('buildOutboundPersona with empty context replaces placeholder with empty string', () => {
    const result = buildOutboundPersona('Some goal', '')
    expect(result).not.toContain('{{context}}')
    // Should not have the placeholder, empty replacement is fine
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(50)
  })

  it('buildOutboundPersona does not use eval or template engine (plain string)', () => {
    // Dangerous input should be returned verbatim, not executed
    const dangerous = '${process.exit(1)}'
    const result = buildOutboundPersona(dangerous, '')
    expect(result).toContain(dangerous)
  })
})
