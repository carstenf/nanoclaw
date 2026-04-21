// voice-bridge/tests/persona-overlay-case-6b.test.ts
// Phase 05.2 Plan 04 Task 3 — tests for buildCase6bOverlay.
//
// Case-6b (inbound from Carsten's CLI) overlay extracts the case-specific
// sections of the legacy CASE6B_PERSONA (persona.ts:14-90):
//   - KALENDER-TERMIN-EINTRAG (CRUD rules, conflict handling)
//   - KALENDER-TERMIN-LOESCHEN (explicit vorlesen before delete)
//   - KALENDER-TERMIN-AENDERN (event_id requirement)
//   - FAHRZEIT-ANFRAGE (IATA code rule for airports/Bahnhoefe)
//   - OFFENE FRAGEN / RECHERCHE (ask_core topic=andy routing)
//
// Baseline (buildBasePersona, 05.2-01) supplies identity, tool-first,
// disclosure, zwei-form, farewell — NOT duplicated here.
//
// Inbound webhook path is NOT rewired in this task — legacy CASE6B_PERSONA
// stays active. The overlay file + dispatcher entry are an ARTIFACT for a
// future inbound migration plan.

import { describe, it, expect } from 'vitest'
import { buildCase6bOverlay } from '../src/persona/overlays/case-6b-inbound-carsten.js'
import { buildTaskOverlay } from '../src/persona/overlays/index.js'
import fs from 'node:fs'

describe('Plan 05.2-04 Task 3 — buildCase6bOverlay', () => {
  it('Test O (calendar CRUD): KALENDER-TERMIN-EINTRAG + check_calendar + create_calendar_entry', () => {
    const out = buildCase6bOverlay()
    expect(typeof out).toBe('string')
    expect(out).toContain('KALENDER-TERMIN-EINTRAG')
    expect(out).toContain('check_calendar')
    expect(out).toContain('create_calendar_entry')
  })

  it('Test P (travel-time IATA): FAHRZEIT + IATA airport rule', () => {
    const out = buildCase6bOverlay()
    expect(out).toContain('FAHRZEIT')
    expect(out).toContain('IATA')
  })

  it('Test Q (Andy research routing): ask_core + andy + filler phrase', () => {
    const out = buildCase6bOverlay()
    expect(out).toContain('ask_core')
    expect(out).toContain('andy')
    expect(out).toContain('Moment, ich frage Andy')
  })

  it('Test R (baseline-level rules NOT duplicated): no WERKZEUG-ZUERST header, no OFFENLEGUNG header, no ABSCHIED header', () => {
    const out = buildCase6bOverlay()
    // Section headers that belong to baseline must NOT appear as overlay section headers.
    // Accept incidental mentions of "Werkzeug" in contextual rules (e.g. "rufe das Werkzeug...").
    expect(out).not.toMatch(/^WERKZEUG-ZUERST/m)
    expect(out).not.toMatch(/^OFFENLEGUNG/m)
    expect(out).not.toMatch(/^ABSCHIED/m)
    // "SCHWEIGEN" section header (10s silence prompt) is baseline-level
    expect(out).not.toMatch(/^SCHWEIGEN/m)
  })

  it('Test S (byte budget): overlay file < 4000 bytes', () => {
    const bytes = fs.statSync(
      new URL('../src/persona/overlays/case-6b-inbound-carsten.ts', import.meta.url),
    ).size
    expect(bytes).toBeLessThan(4000)
  })
})

describe('Plan 05.2-04 Task 3 — buildTaskOverlay dispatcher wires case_6b_inbound_carsten', () => {
  it('buildTaskOverlay("case_6b_inbound_carsten", {}) returns non-empty overlay string', () => {
    const out = buildTaskOverlay('case_6b_inbound_carsten', {})
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(200)
    expect(out).toContain('KALENDER-TERMIN')
  })
})
