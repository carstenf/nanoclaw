// voice-bridge/tests/persona-baseline-nudge.test.ts
// Phase 05.2 Plan 03 — RED phase: baseline persona nudge-ladder tests.
// D-1 (3 attempts) + D-2 (apologetic Sie-form outbound, Du-form inbound
// Carsten). Ladder text is prompt-driven per feedback_no_timer_based_silence.
//
// These tests FAIL until Task 2 (GREEN) adds OUTBOUND_SCHWEIGEN and
// INBOUND_SCHWEIGEN blocks to baseline.ts + buildBasePersona substitution.

import { describe, it, expect } from 'vitest'
import {
  buildBasePersona,
  type BasePersonaArgs,
} from '../src/persona/baseline.js'

function outboundSie(overrides: Partial<BasePersonaArgs> = {}): BasePersonaArgs {
  return {
    anrede_form: 'Sie',
    counterpart_label: 'der Restaurant-Gegenueber',
    goal: 'Reservierung fuer Carsten anfragen',
    context: 'Outbound an Restaurant Bellavista',
    call_direction: 'outbound',
    ...overrides,
  }
}

function inboundDu(overrides: Partial<BasePersonaArgs> = {}): BasePersonaArgs {
  return {
    anrede_form: 'Du',
    counterpart_label: 'Carsten',
    goal: 'Carsten unterstuetzen',
    context: 'Inbound von Carstens CLI-Nummer',
    call_direction: 'inbound',
    ...overrides,
  }
}

describe('Plan 05.2-03 — baseline persona nudge ladder (D-1, D-2)', () => {
  it('Test E (outbound nudge-1 verbatim): "Hallo, ist da jemand?"', () => {
    const out = buildBasePersona(outboundSie())
    expect(out).toContain('Hallo, ist da jemand?')
  })

  it('Test F (outbound nudge-2 verbatim): "Hallo? Hoeren Sie mich?"', () => {
    const out = buildBasePersona(outboundSie())
    expect(out).toContain('Hallo? Hoeren Sie mich?')
  })

  it('Test G (outbound D-2 farewell): "ich versuche es spaeter nochmal"', () => {
    const out = buildBasePersona(outboundSie())
    expect(out).toContain('ich versuche es spaeter nochmal')
    // Guarded by D-1: "NIEMALS mehr als 3 Nudges"
    expect(out).toContain('NIEMALS mehr als 3 Nudges')
  })

  it('Test H (inbound nudge-1 Du-form): "Hallo, bist du da?" — does NOT contain outbound Sie-form ladder', () => {
    const out = buildBasePersona(inboundDu())
    expect(out).toContain('Hallo, bist du da?')
    // Cross-contamination guard: outbound Sie-form nudge-1 must NOT appear
    expect(out).not.toContain('Hallo, ist da jemand?')
  })

  it('Test I (inbound nudge-2 + farewell Du-form): "Hoerst du mich, Carsten?" + "Ich melde mich spaeter nochmal, Carsten"', () => {
    const out = buildBasePersona(inboundDu())
    expect(out).toContain('Hoerst du mich, Carsten?')
    expect(out).toContain('Ich melde mich spaeter nochmal, Carsten')
    // Outbound farewell phrase (with "Auf Wiederhoeren") must NOT bleed into inbound
    expect(out).not.toContain('Auf Wiederhoeren')
  })
})
