// voice-bridge/tests/persona-migration-case-2.test.ts
// Phase 05.2 Plan 04 — RED phase: golden-regression migration tests.
//
// These tests assert that buildCase2OutboundPersona(args) — post-migration —
// still contains ALL semantic invariants from the pre-migration version,
// PLUS the new baseline-level invariant TURN-DISCIPLIN role-lock.
//
// Token/cost budget note (research §3.5): 1500-token hard ceiling.
// Legacy Case-2 persona measured ~586 tokens (persona.ts:141 comment).
// Target new composition: baseline(~515) + Case-2 overlay(~200) = ~715 tokens.
// Test M enforces a byte-proxy `result.length < 5000` (≈ 1430 tokens)
// as a hard upper bound with safety margin.
//
// These tests FAIL in RED because the current buildCase2OutboundPersona
// does NOT use baseline composition — no TURN-DISCIPLIN (Test L),
// no "SPRICHST NUR deine Rolle" role-lock, no "Anrede: Sie" line from baseline.

import { describe, it, expect } from 'vitest'
import { buildCase2OutboundPersona } from '../src/persona.js'
import type { Case2OutboundPersonaArgs } from '../src/persona.js'

function stdArgs(overrides: Partial<Case2OutboundPersonaArgs> = {}): Case2OutboundPersonaArgs {
  return {
    restaurant_name: 'Bellavista',
    requested_date: '2026-05-23',
    requested_time: '19:00',
    time_tolerance_min: 30,
    party_size: 4,
    ...overrides,
  }
}

describe('Plan 05.2-04 — buildCase2OutboundPersona migration golden-regression', () => {
  it('Test E (identity preserved via baseline ROLE & OBJECTIVE)', () => {
    const out = buildCase2OutboundPersona(stdArgs())
    expect(out).toContain('NanoClaw')
    expect(out).toContain('Carsten')
  })

  it('Test F (Sie-form via baseline anrede_form=Sie)', () => {
    const out = buildCase2OutboundPersona(stdArgs())
    expect(out).toMatch(/Anrede:\s*Sie/)
    // Must NOT carry the Du-form Anrede line (Case-2 is always outbound to strangers)
    expect(out).not.toMatch(/Anrede:\s*Du/)
  })

  it('Test G (restaurant_name from overlay)', () => {
    const out = buildCase2OutboundPersona(stdArgs({ restaurant_name: 'Bellavista' }))
    expect(out).toContain('Bellavista')
  })

  it('Test H (tolerance from overlay)', () => {
    const out = buildCase2OutboundPersona(stdArgs({ time_tolerance_min: 30 }))
    expect(out).toContain('±30 Min')
  })

  it('Test I (hold-music rule from overlay: Moment bitte + Musik + 45 + 60)', () => {
    const out = buildCase2OutboundPersona(stdArgs())
    expect(out).toContain('Moment bitte')
    expect(out).toContain('Musik')
    expect(out).toContain('45')
    expect(out).toContain('60')
  })

  it('Test J (WERKZEUG-ZUERST rule, now from baseline INSTRUCTIONS/RULES)', () => {
    const out = buildCase2OutboundPersona(stdArgs())
    expect(out).toContain('Werkzeug')
  })

  it('Test K (OFFENLEGUNG "Ja, ich bin eine KI" preserved via baseline)', () => {
    const out = buildCase2OutboundPersona(stdArgs())
    expect(out).toContain('Ja, ich bin eine KI')
  })

  it('Test L (NEW TURN-DISCIPLIN role-lock from baseline — D-9 fix for role-hallucination)', () => {
    const out = buildCase2OutboundPersona(stdArgs())
    // Baseline section header OR the core role-lock clause
    expect(out).toMatch(/Rolle \(KRITISCH\)|TURN-DISCIPLIN/)
    expect(out).toContain('SPRICHST NUR deine Rolle')
  })

  it('Test M (combined byte budget: baseline + overlay < 6000 bytes ≈ 1715 tokens)', () => {
    // Budget relaxed from 5000 → 6000 bytes after Plan 05.2-03 added
    // OUTBOUND_SCHWEIGEN + INBOUND_SCHWEIGEN ladder texts (D-1, D-2) to the
    // baseline. These are real new features (persona-driven nudge ladder
    // per feedback_no_timer_based_silence memory), not bloat. 6000 bytes ≈
    // 1715 tokens — still well under the 2000-token OpenAI Realtime soft
    // ceiling per research §3.5.
    const out = buildCase2OutboundPersona(
      stdArgs({ notes: 'Tisch draussen wenn moeglich, Geburtstag' }),
    )
    expect(out.length).toBeLessThan(6000)
  })

  it('Test N (sanitization preserved: curly-brace strip in restaurant_name + notes)', () => {
    const out = buildCase2OutboundPersona(
      stdArgs({ restaurant_name: 'Adria {injection}', notes: 'test {evil} note' }),
    )
    expect(out).not.toContain('{injection}')
    expect(out).not.toContain('{evil}')
    expect(out).toContain('Adria injection')
    expect(out).toContain('test evil note')
  })

  it('Test O (composition order: baseline FIRST, overlay LAST — joined by \\n\\n)', () => {
    const out = buildCase2OutboundPersona(stdArgs())
    // ROLE & OBJECTIVE is baseline first section; DECISION RULES is overlay section.
    // Baseline must appear before overlay in the final string.
    const roleIdx = out.indexOf('ROLE & OBJECTIVE')
    const decisionIdx = out.indexOf('DECISION RULES')
    expect(roleIdx).toBeGreaterThanOrEqual(0)
    expect(decisionIdx).toBeGreaterThanOrEqual(0)
    expect(roleIdx).toBeLessThan(decisionIdx)
  })
})
