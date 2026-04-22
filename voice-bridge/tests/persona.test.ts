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

// Plan 05.3-03 D-2: legacy CASE6B_PERSONA constant is retired; inbound /accept
// webhook composes baseline + buildTaskOverlay('case_6b_inbound_carsten').
// Coverage for that composition now lives in tests/persona-migration-case-6b.test.ts
// (7 golden-regression assertions). The former six CASE6B_PERSONA-shape tests
// in this file are deleted (constant no longer exists to inspect).

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

// --- Plan 05-03 Task 2: CASE2_OUTBOUND_PERSONA blocks + buildCase2OutboundPersona ---
// Plan 05.3-01 D-1: legacy CASE2_TOLERANCE_DECISION_BLOCK +
// CASE2_HOLD_MUSIC_CLARIFYING_BLOCK constants are fully retired. Content now lives
// in persona/overlays/case-2.ts. Tests 1 + 2 below inspect the buildCase2Overlay
// output (kept as golden-regression coverage of the migrated text).
import { buildCase2OutboundPersona } from '../src/persona.js'
import { buildCase2Overlay } from '../src/persona/overlays/case-2.js'

describe('CASE2_OUTBOUND_PERSONA — Task 2 tests (≥9)', () => {
  it('test 1: Case-2 overlay contains tolerance-decision keywords (migrated to persona/overlays/case-2.ts)', () => {
    const overlay = buildCase2Overlay({
      restaurant_name: 'Adria',
      requested_date: '2026-05-15',
      requested_time: '19:00',
      time_tolerance_min: 30,
      party_size: 4,
    })
    expect(typeof overlay).toBe('string')
    expect(overlay).toContain('DECISION RULES')
    expect(overlay).toContain('ZUSAGE')
    expect(overlay).toContain('ABLEHNEN')
  })

  it('test 2: Case-2 overlay contains hold-music keywords (migrated to persona/overlays/case-2.ts)', () => {
    const overlay = buildCase2Overlay({
      restaurant_name: 'Adria',
      requested_date: '2026-05-15',
      requested_time: '19:00',
      time_tolerance_min: 30,
      party_size: 4,
    })
    expect(typeof overlay).toBe('string')
    expect(overlay).toContain('Moment bitte')
    expect(overlay).toContain('schweige')
    expect(overlay).toContain('60s')
  })

  it('test 4: buildCase2OutboundPersona output contains required content', () => {
    const result = buildCase2OutboundPersona({
      restaurant_name: 'Adria',
      requested_date: '2026-05-15',
      requested_time: '19:00',
      time_tolerance_min: 30,
      party_size: 4,
    })
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(200)
    // Contains base template content
    expect(result).toContain('NanoClaw')
    expect(result).toContain('Carsten')
    // Contains substituted Case-2 goal fields
    expect(result).toContain('Adria')
    expect(result).toContain('19:00')
    expect(result).toContain('30')
    // Contains 4 persons (number or word form)
    expect(result).toMatch(/4|vier/i)
  })

  it('test 5: notes undefined → output contains "Notizen: keine"', () => {
    const result = buildCase2OutboundPersona({
      restaurant_name: 'Testlokal',
      requested_date: '2026-06-01',
      requested_time: '18:00',
      time_tolerance_min: 15,
      party_size: 2,
    })
    expect(result).toContain('keine')
  })

  it('test 6: notes="draussen, ruhig" → output contains that literal', () => {
    const result = buildCase2OutboundPersona({
      restaurant_name: 'Testlokal',
      requested_date: '2026-06-01',
      requested_time: '18:00',
      time_tolerance_min: 15,
      party_size: 2,
      notes: 'draussen, ruhig',
    })
    expect(result).toContain('draussen, ruhig')
  })

  it('test 7: requested_date_wort + party_size_wort auto-generated if omitted', () => {
    const result = buildCase2OutboundPersona({
      restaurant_name: 'Adria',
      requested_date: '2026-05-15',
      requested_time: '19:00',
      time_tolerance_min: 30,
      party_size: 4,
      // No word-form overrides — should auto-generate
    })
    // party_size=4 should produce German word "vier" somewhere
    expect(result).toMatch(/vier/i)
    // requested_time_wort for 19:00 should produce "neunzehn"
    expect(result).toMatch(/neunzehn/i)
  })

  it('test 8: token budget — chars/3.5 approximation under 1700 ceiling (post-05.2-03 nudge ladders)', () => {
    // Ceiling raised from 1500 → 1700 after Plan 05.2-03 added
    // OUTBOUND_SCHWEIGEN + INBOUND_SCHWEIGEN ladder texts (D-1, D-2) to the
    // baseline — real new features (persona-driven nudge ladder per
    // feedback_no_timer_based_silence memory). Research §3.5 soft ceiling
    // is 2000 tokens; 1700 preserves headroom.
    const result = buildCase2OutboundPersona({
      restaurant_name: 'Adria',
      requested_date: '2026-05-15',
      requested_time: '19:00',
      time_tolerance_min: 30,
      party_size: 4,
      notes: 'Tisch draussen wenn moeglich',
    })
    const approxTokens = result.length / 3.5
    expect(approxTokens).toBeLessThan(1700)
  })

  // Plan 05.3-03 D-2: former "test 9: CASE6B_PERSONA byte-identical" DELETED —
  // constant no longer exists (retired in favor of baseline+overlay composition).
  // Equivalent coverage: tests/persona-migration-case-6b.test.ts (7 assertions on
  // the composed inbound Carsten instructions).

  it('test 3: CASE2_GOAL_SETTING_BLOCK via buildCase2OutboundPersona substitutes all fields', () => {
    const result = buildCase2OutboundPersona({
      restaurant_name: 'Bella Italia',
      requested_date: '2026-07-04',
      requested_time: '20:00',
      time_tolerance_min: 20,
      party_size: 6,
      requested_date_wort: 'vierten Juli',
      requested_time_wort: 'zwanzig Uhr',
      party_size_wort: 'sechs',
      notes: 'Geburtstag',
    })
    expect(result).toContain('Bella Italia')
    expect(result).toContain('2026-07-04')
    expect(result).toContain('vierten Juli')
    expect(result).toContain('zwanzig Uhr')
    expect(result).toContain('20:00')
    expect(result).toContain('sechs')
    expect(result).toContain('6')
    expect(result).toContain('Geburtstag')
    expect(result).toContain('20')  // time_tolerance_min
  })

  it('sanitization: curly braces in restaurant_name and notes are stripped', () => {
    const result = buildCase2OutboundPersona({
      restaurant_name: 'Adria {injection}',
      requested_date: '2026-05-15',
      requested_time: '19:00',
      time_tolerance_min: 30,
      party_size: 2,
      notes: 'test {evil} note',
    })
    expect(result).not.toContain('{injection}')
    expect(result).not.toContain('{evil}')
    expect(result).toContain('Adria injection')
    expect(result).toContain('test evil note')
  })
})
