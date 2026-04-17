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
