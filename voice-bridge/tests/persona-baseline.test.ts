// voice-bridge/tests/persona-baseline.test.ts
// Phase 05.2 Plan 01 — RED phase: failing tests for buildBasePersona +
// buildTaskOverlay skeleton (research §6.2 verbatim, D-9 role-lock).
//
// These imports FAIL at compile time until Task 2 (GREEN) lands the modules.

import { describe, it, expect } from 'vitest'
import {
  buildBasePersona,
  BASELINE_PERSONA_TEMPLATE,
  type BasePersonaArgs,
} from '../src/persona/baseline.js'
import { buildTaskOverlay, type CaseKey } from '../src/persona/overlays/index.js'

function defaults(overrides: Partial<BasePersonaArgs> = {}): BasePersonaArgs {
  return {
    anrede_form: 'Du',
    counterpart_label: 'Carsten',
    goal: 'Kalender-Assistenz fuer Carsten',
    context: 'Inbound von Carstens CLI-Nummer',
    call_direction: 'inbound',
    ...overrides,
  }
}

describe('Plan 05.2-01 — buildBasePersona (research §6.2 verbatim)', () => {
  it('Test A (structure): output contains the 5 load-bearing Cookbook section headers', () => {
    const out = buildBasePersona(defaults())
    expect(typeof out).toBe('string')
    expect(out).toContain('ROLE & OBJECTIVE')
    expect(out).toContain('PERSONALITY & TONE')
    expect(out).toContain('REFERENCE PRONUNCIATIONS')
    expect(out).toContain('INSTRUCTIONS / RULES')
    expect(out).toContain('SAFETY & ESCALATION')
  })

  it('Test B (role-lock / D-9): verbatim "Rolle (KRITISCH)" clause present', () => {
    const out = buildBasePersona(defaults())
    expect(out).toContain('Rolle (KRITISCH)')
    expect(out).toContain('SPRICHST NUR deine Rolle')
    expect(out).toContain('ERFINDEST NIEMALS')
  })

  it('Test C (language-lock): Deutsch de-DE + NIEMALS andere Sprache', () => {
    const out = buildBasePersona(defaults())
    expect(out).toContain('Deutsch (de-DE)')
    expect(out).toContain('Sprich NIEMALS eine andere Sprache')
  })

  it('Test D (anrede Du): Du-form appears, counterpart_label Carsten substituted', () => {
    const out = buildBasePersona(defaults({ anrede_form: 'Du', counterpart_label: 'Carsten' }))
    // Anrede line must mention Du
    expect(out).toMatch(/Anrede:\s*Du/)
    // counterpart_label must appear
    expect(out).toContain('Carsten')
    // Placeholder must be fully substituted
    expect(out).not.toContain('{{anrede_form}}')
    expect(out).not.toContain('{{counterpart_label}}')
  })

  it('Test E (anrede Sie): Sie-form appears, counterpart_label substituted verbatim', () => {
    const out = buildBasePersona(
      defaults({
        anrede_form: 'Sie',
        counterpart_label: 'der Restaurant-Gegenueber',
        call_direction: 'outbound',
      }),
    )
    expect(out).toMatch(/Anrede:\s*Sie/)
    expect(out).toContain('der Restaurant-Gegenueber')
    // Sie-form should NOT carry the Du-form Anrede line
    expect(out).not.toMatch(/Anrede:\s*Du/)
    expect(out).not.toContain('{{anrede_form}}')
    expect(out).not.toContain('{{counterpart_label}}')
  })

  it('Test F (token budget): length < 3500 chars (1000-token ceiling with buffer)', () => {
    const out = buildBasePersona(defaults())
    expect(out.length).toBeLessThan(3500)
  })

  it('Test G (disclosure + farewell preserved from legacy)', () => {
    const out = buildBasePersona(defaults())
    // Offenlegung: "Bot?" + "KI"
    expect(out).toContain('Bot?')
    expect(out).toContain('KI')
    // Abschied: "end_call" + "farewell"
    expect(out).toContain('end_call')
    expect(out).toContain('farewell')
  })

  it('Test G2 (no named human identity / LEGAL-04): Offenlegung preserves identity rule', () => {
    const out = buildBasePersona(defaults())
    expect(out).toContain('namentlich genannte Person')
  })

  it('BASELINE_PERSONA_TEMPLATE is a non-empty string constant', () => {
    expect(typeof BASELINE_PERSONA_TEMPLATE).toBe('string')
    expect(BASELINE_PERSONA_TEMPLATE.length).toBeGreaterThan(500)
  })
})

describe('Plan 05.2-01 — buildTaskOverlay dispatcher skeleton', () => {
  it('Test H.1: outbound_default_sie returns empty string (skeleton)', () => {
    expect(buildTaskOverlay('outbound_default_sie', {})).toBe('')
  })

  it('Test H.2: amd_classifier_mode_noop returns empty string (sentinel, D-10)', () => {
    expect(buildTaskOverlay('amd_classifier_mode_noop', {})).toBe('')
  })

  it('Test H.3 (Plan 05.2-04 Task 2 MIGRATED): case_2 returns buildCase2Overlay(args) — dispatcher wired', () => {
    // Plan 05.2-04 Task 2 filled the case_2 body. Dispatcher now returns a non-empty
    // overlay string containing Case-2-specific markers.
    const out = buildTaskOverlay('case_2', {
      restaurant_name: 'Bellavista',
      requested_date: '2026-05-23',
      requested_time: '19:00',
      time_tolerance_min: 30,
      party_size: 4,
    })
    expect(typeof out).toBe('string')
    expect(out).toContain('Bellavista')
    expect(out).toContain('DECISION RULES')
  })

  it('Test H.4: case_6b_inbound_carsten throws NotImplemented with 05.2-04 reference (Task 3 pending)', () => {
    expect(() => buildTaskOverlay('case_6b_inbound_carsten', {})).toThrow(/05\.2-04/)
  })

  it('CaseKey union accepts all four registered keys (compile-time check)', () => {
    const keys: CaseKey[] = [
      'case_2',
      'case_6b_inbound_carsten',
      'outbound_default_sie',
      'amd_classifier_mode_noop',
    ]
    expect(keys).toHaveLength(4)
  })
})
