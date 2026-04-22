// voice-bridge/tests/persona-migration-case-6b.test.ts
// Plan 05.3-03 D-2 — golden-regression test for inbound Carsten baseline+overlay
// composition (mirrors persona-migration-case-2.test.ts shape).
//
// Goal: lock the composed persona shape at the function-level BEFORE the
// webhook.ts callsite rewire in Task 2, so any drift during webhook refactor
// surfaces immediately.

import { describe, it, expect } from 'vitest'
import { buildBasePersona } from '../src/persona/baseline.js'
import { buildTaskOverlay } from '../src/persona/overlays/index.js'

function buildInboundCarstenInstructions(): string {
  const baseline = buildBasePersona({
    anrede_form: 'Du',
    counterpart_label: 'Carsten',
    goal: 'Inbound-Anruf von Carsten: Kalender pflegen, Reisezeiten, Recherche delegieren',
    context: 'Inbound-Anruf von Carstens CLI',
    call_direction: 'inbound',
  })
  const overlay = buildTaskOverlay('case_6b_inbound_carsten', {})
  return [baseline, overlay].join('\n\n')
}

describe('Plan 05.3-03 D-2 — inbound Carsten baseline+overlay migration golden-regression', () => {
  it('identity preserved: Carsten + NanoClaw', () => {
    const s = buildInboundCarstenInstructions()
    expect(s).toContain('Carsten')
    expect(s).toContain('NanoClaw')
  })

  it('ask_core routing from case-6b overlay', () => {
    expect(buildInboundCarstenInstructions()).toContain('ask_core')
  })

  it('truthful-bot disclosure from baseline OFFENLEGUNG (LEGAL-04)', () => {
    // Either literal question OR baseline's disclosure phrasing
    const s = buildInboundCarstenInstructions()
    expect(/Bist du ein Bot\?|ich bin KI|ich bin eine KI|ich bin ein Bot/i.test(s)).toBe(true)
  })

  it('Du-form anrede — contains lowercase "du" and Du-form disclosure ("Bist du")', () => {
    const s = buildInboundCarstenInstructions()
    // Du-form: 'du' or 'dir' as whole-word (case-insensitive in German baseline text)
    expect(/\bdu\b|\bdir\b/i.test(s)).toBe(true)
    // Du-form disclosure placeholder resolves to "Bist du" — concrete proof of anrede=Du
    expect(s).toContain('Bist du')
  })

  it('role-lock clause present (D-9 from Phase 05.2 baseline)', () => {
    const s = buildInboundCarstenInstructions()
    expect(/SPIELST NIEMALS|SPRICHST NUR|Rolle \(KRITISCH\)/i.test(s)).toBe(true)
  })

  it('byte budget: sanity lower bound + soft upper bound', () => {
    // Plan-frontmatter suggested 600-2500 chars (stale estimate). Actual
    // composition with Phase 05.2-03 OUTBOUND/INBOUND_SCHWEIGEN ladders added
    // to baseline yields ~6100 bytes. Relaxed ceiling to 7000 bytes — still
    // well under 2000-token OpenAI Realtime soft ceiling (research §3.5
    // ≈ 8000 bytes ASCII). Matches persona-migration-case-2.test.ts Test M
    // intent (sanity budget, not a hard product constraint).
    const len = buildInboundCarstenInstructions().length
    expect(len).toBeGreaterThan(600)
    expect(len).toBeLessThan(7000)
  })

  it('deterministic composition (two calls byte-identical)', () => {
    const a = buildInboundCarstenInstructions()
    const b = buildInboundCarstenInstructions()
    expect(a).toBe(b)
  })
})
