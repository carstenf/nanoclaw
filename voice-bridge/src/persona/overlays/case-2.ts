// voice-bridge/src/persona/overlays/case-2.ts
// Phase 05.2 Plan 04 — Case-2 restaurant reservation task overlay.
//
// Verbatim from research §6.3. The baseline (persona/baseline.ts, plan 05.2-01)
// supplies identity, ROLE (TURN-DISCIPLIN), PERSONALITY, PRONUNCIATIONS,
// INSTRUCTIONS (Werkzeug-zuerst, Zwei-Form, Füll-Phrasen, Schweigen,
// Abschied, Offenlegung), and SAFETY & ESCALATION. They are NOT duplicated
// here — this overlay only contains the Case-2-SPECIFIC rules:
//   1. TASK (goal description with restaurant/date/time/tolerance/party)
//   2. DECISION RULES (tolerance decision + personenzahl + rueckruf)
//   3. CLARIFYING-QUESTION ANSWERS (allergien/anlass/name/telefon/vorauszahlung)
//   4. HOLD-MUSIC HANDLING (45s silence then "Hallo?", 60s end_call)
//
// ASCII-umlaut convention enforced project-wide (Phase 2 CASE6B_PERSONA truths[8]):
// 'Gegenueber', 'fuer', 'Wuensche', 'Bueros', etc.

import type { Case2OutboundPersonaArgs } from '../../persona.js'
import {
  sanitizeForPersona,
  toGermanNumber,
  timeToGerman,
} from '../../persona.js'

/**
 * Build Case-2 task overlay string.
 *
 * Composition: the 4 case-specific sections joined by newlines. Intended to
 * be concatenated AFTER the baseline persona via `[baseline, overlay].join('\n\n')`.
 *
 * Token budget: ~200 tokens / ~700 bytes of overlay text (research §6.3).
 * Combined with baseline (~515 tokens) = ~715 tokens total — well under
 * 1500-token hard ceiling (research §3.5).
 *
 * Injection safety: restaurant_name and notes pass through sanitizeForPersona
 * (curly-brace strip) before substitution. T-05.2-04-01 mitigation.
 */
export function buildCase2Overlay(args: Case2OutboundPersonaArgs): string {
  const restaurantName = sanitizeForPersona(args.restaurant_name)
  const notes = args.notes ? sanitizeForPersona(args.notes) : 'keine'

  // Word-forms (auto-generate if caller did not supply overrides)
  const timeWort = args.requested_time_wort ?? timeToGerman(args.requested_time)
  const partySizeWort = args.party_size_wort ?? toGermanNumber(args.party_size)
  const dateWort = args.requested_date_wort ?? args.requested_date

  return [
    '### TASK',
    `Reservierung fuer ${restaurantName} am ${dateWort}, also ${args.requested_date},`,
    `um ${timeWort}, also ${args.requested_time}, fuer ${partySizeWort} Personen.`,
    `Besondere Wuensche: ${notes}.`,
    `Toleranz auf die Uhrzeit: ±${args.time_tolerance_min} Min. Personenzahl exakt.`,
    '',
    '### DECISION RULES',
    `- Gegenangebot innerhalb ±${args.time_tolerance_min} Min -> ZUSAGE (Zwei-Form Readback, dann create_calendar_entry).`,
    `- Gegenangebot ausserhalb Toleranz -> HOEFLICH ABLEHNEN: "${args.requested_time} passt leider nicht. Wir versuchen es nochmal."`,
    '- Andere Personenzahl -> ABLEHNEN.',
    '- Counterpart kann an diesem Tag nicht -> ABLEHNEN + voice_notify_user(urgency=decision).',
    '- Counterpart will zurueckrufen -> ABLEHNEN: "Bitte geben Sie mir jetzt eine direkte Antwort."',
    '',
    '### CLARIFYING-QUESTION ANSWERS',
    `- "Allergien?" -> ${notes} ODER "Nein, danke."`,
    `- "Anlass?" -> ${notes} ODER "Nein, einfach ein schoener Abend."`,
    `- "Kinderstuehle?" -> ${notes} ODER "Nein, danke."`,
    '- "Name?" -> "Carsten Freek, Freek mit zwei Es."',
    '- "Telefon fuer Rueckfragen?" -> NIEMALS Handynummer. Sage: "Die Sipgate-Nummer von der Sie angerufen wurden."',
    '- "Vorauszahlung?" -> NIEMALS zusagen.',
    '- Unbekannt -> "Dazu kann ich gerade nichts Verbindliches sagen."',
    '',
    '### HOLD-MUSIC HANDLING',
    '- "Moment bitte" + Musik -> schweige bis zu 45s. Dann einmal: "Hallo? Sind Sie noch da?" Bei 60s kumulativ: "Ich versuche es nochmal spaeter" + end_call.',
  ].join('\n')
}
