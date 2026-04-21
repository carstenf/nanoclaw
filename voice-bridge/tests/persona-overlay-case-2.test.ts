// voice-bridge/tests/persona-overlay-case-2.test.ts
// Phase 05.2 Plan 04 — RED phase: failing tests for buildCase2Overlay.
// Verbatim assertion strings come from research §6.3.
//
// Token/cost budget note (research §3.5): 1500-token hard ceiling per
// OpenAI Realtime session.update payload. Legacy Case-2 persona measured
// ~586 tokens; new baseline(~515) + Case-2 overlay(~200) = ~715 tokens
// total — well under ceiling. This file enforces the overlay-slice portion
// via a byte budget (file < 4000 bytes, text < 1200 bytes).
//
// The import FAILS at compile time until Task 2 creates the module.

import { describe, it, expect } from 'vitest'
import { buildCase2Overlay } from '../src/persona/overlays/case-2.js'
import type { Case2OutboundPersonaArgs } from '../src/persona.js'

function defaults(overrides: Partial<Case2OutboundPersonaArgs> = {}): Case2OutboundPersonaArgs {
  return {
    restaurant_name: 'Bellavista',
    requested_date: '2026-05-23',
    requested_time: '19:00',
    time_tolerance_min: 30,
    party_size: 4,
    ...overrides,
  }
}

describe('Plan 05.2-04 — buildCase2Overlay (research §6.3 verbatim)', () => {
  it('Test A (structure): output contains TASK + DECISION RULES + CLARIFYING + HOLD-MUSIC sections', () => {
    const out = buildCase2Overlay(defaults())
    expect(typeof out).toBe('string')
    expect(out).toContain('TASK')
    expect(out).toContain('DECISION RULES')
    expect(out).toContain('CLARIFYING-QUESTION ANSWERS')
    expect(out).toContain('HOLD-MUSIC')
  })

  it('Test B (restaurant_name substitution + injection sanitization)', () => {
    // Verbatim
    const out1 = buildCase2Overlay(defaults({ restaurant_name: 'Bellavista' }))
    expect(out1).toContain('Bellavista')

    // Injection via curly braces: sanitizeForPersona must strip braces
    const out2 = buildCase2Overlay(defaults({ restaurant_name: 'Bellavista {injection}' }))
    expect(out2).not.toContain('{injection}')
    expect(out2).toContain('injection')
  })

  it('Test C (tolerance substitution): ±30 Min renders; changing value renders ±15 Min', () => {
    const out30 = buildCase2Overlay(defaults({ time_tolerance_min: 30 }))
    expect(out30).toContain('±30 Min')

    const out15 = buildCase2Overlay(defaults({ time_tolerance_min: 15 }))
    expect(out15).toContain('±15 Min')
    expect(out15).not.toContain('±30 Min')
  })

  it('Test D (clarifying-answer verbatim): Carsten Freek spelling + NIEMALS Handynummer', () => {
    const out = buildCase2Overlay(defaults())
    expect(out).toContain('Carsten Freek, Freek mit zwei Es')
    expect(out).toContain('NIEMALS Handynummer')
  })

  it('Test D2 (hold-music rule verbatim): 45s silence gate + 60s end_call', () => {
    const out = buildCase2Overlay(defaults())
    expect(out).toContain('Moment bitte')
    expect(out).toContain('Musik')
    expect(out).toContain('45')
    expect(out).toContain('60')
    expect(out).toContain('end_call')
  })

  it('Test D3 (notes fallback): undefined notes → "keine"', () => {
    const out = buildCase2Overlay(defaults())
    expect(out).toContain('keine')
  })

  it('Test D4 (notes verbatim when supplied, injection stripped)', () => {
    const out = buildCase2Overlay(defaults({ notes: 'draussen, ruhig {evil}' }))
    expect(out).toContain('draussen, ruhig')
    expect(out).not.toContain('{evil}')
    expect(out).toContain('evil')
  })
})
