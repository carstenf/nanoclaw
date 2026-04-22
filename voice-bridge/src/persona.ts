// voice-bridge/src/persona.ts
// Phase-2 persona prompt. Hard-coded German (REQ-VOICE-06) + directive
// tool-first prohibition (AC-06) + readback mandate (persona-side text;
// DIR-13 validator enforcement lives in src/readback/validator.ts,
// Plan 02-04) + silence prompts (REQ-VOICE-08) + filler directive
// (REQ-VOICE-07) + passive disclosure (DISC-01..03, LEGAL-04).
//
// This constant is the "floor" instructions passed at /accept (D-40..D-42).
// Slow-Brain may push instructions-only session.update on top of this floor
// (D-26); the floor persona always governs in fallback scenarios (D-27).
//
// Plan 05.2-04: buildCase2OutboundPersona migrated to baseline+overlay
// composition (see buildBasePersona / buildCase2Overlay imports below).
// Legacy CASE2_TOLERANCE_DECISION_BLOCK + CASE2_HOLD_MUSIC_CLARIFYING_BLOCK
// removed; Case-2 specific text now lives in persona/overlays/case-2.ts.

import { buildBasePersona } from './persona/baseline.js'
import { buildCase2Overlay } from './persona/overlays/case-2.js'

// Plan 05.3-03 D-2: CASE6B_PERSONA const DELETED (inbound /accept webhook now
// composes baseline + buildTaskOverlay('case_6b_inbound_carsten') per
// Plan 05.2-04 artifact). Grep-verified: no external references remained
// in voice-bridge/src/ outside tests/persona.test.ts (updated as part of
// this migration).

// ---- Plan 03-11: Outbound persona (expanded in Task 05) ----

export const OUTBOUND_PERSONA_TEMPLATE = [
  'Du bist NanoClaw, ein freundlicher deutscher Sprach-Assistent im Auftrag von Carsten Freek.',
  '',
  'AUFTRAG: Du rufst im Auftrag von Carsten an. Dein Ziel ist: {{goal}}. Kontext: {{context}}.',
  "Stelle dich hoeflich vor als 'NanoClaw im Auftrag von Carsten'.",
  '',
  'SPRACHE: Deutsch (de-DE), Sie-Form (gegenueber unbekannten Personen).',
  '',
  'WERKZEUG-ZUERST (KRITISCH):',
  '  - Du DARFST niemals Termine, Daten oder andere Fachwerte aus dem Gedaechtnis nennen.',
  '  - Fuer JEDE solche Anfrage MUSST du ein spezifisches Werkzeug aufrufen.',
  '',
  'ZWEI-FORM BESTAETIGUNG (vor jedem veraendernden Werkzeug):',
  "  - Nenne Uhrzeiten in Wort UND Ziffer: 'siebzehn Uhr, also 17 Uhr.'",
  "  - Nenne Daten in Wort UND Ziffer: 'am dreiundzwanzigsten Mai, also 23.5.'",
  "  - Frage: 'Korrekt?' und warte auf ein explizites 'Ja'.",
  '',
  'FUELL-PHRASEN (vor Werkzeugen mit erwarteter Dauer > 500 ms):',
  "  - Sage IMMER 'Einen Moment bitte...' bevor du ein Werkzeug nutzt.",
  '',
  'OFFENLEGUNG (Passive Disclosure):',
  '  - Du identifizierst dich NICHT proaktiv als KI.',
  "  - Auf die direkte Frage 'Bist du ein Bot?' antwortest du wahrheitsgemaess: 'Ja, ich bin eine KI.'",
  '  - Du gibst dich NIEMALS als namentlich genannte Person aus.',
].join('\n')

/**
 * Build outbound persona by substituting {{goal}} and {{context}} placeholders.
 * Plain string replacement — no eval, no template engine.
 */
export function buildOutboundPersona(goal: string, context: string): string {
  return OUTBOUND_PERSONA_TEMPLATE.replace('{{goal}}', goal).replace(
    '{{context}}',
    context,
  )
}

// ---- Plan 05-03 Task 2 / Plan 05.2-04: Case-2 Outbound Persona helpers ----
// sanitizeForPersona + toGermanNumber + timeToGerman are shared with the new
// Case-2 task overlay (persona/overlays/case-2.ts). Security invariant:
// restaurant_name + notes are curly-brace-stripped before substitution to
// prevent template-injection via user-supplied fields (T-05.2-04-01).
//
// Token budget (post-migration): baseline (~515 tokens, buildBasePersona) +
// Case-2 overlay (~200 tokens, buildCase2Overlay) ≈ 715 tokens — well under
// the 1500-token hard ceiling from Research §3.5.

/**
 * Strip curly braces to prevent template injection via user-supplied strings.
 * Exported for overlay consumers (Plan 05.2-04: persona/overlays/case-2.ts).
 */
export function sanitizeForPersona(s: string): string {
  return s.replace(/[{}]/g, '')
}

/**
 * German number-to-word for 1..30 (simple lookup for time/party).
 * Falls back to numeric. Exported for overlay consumers (Plan 05.2-04).
 */
export function toGermanNumber(n: number): string {
  const words: Record<number, string> = {
    1: 'einem', 2: 'zwei', 3: 'drei', 4: 'vier', 5: 'fünf',
    6: 'sechs', 7: 'sieben', 8: 'acht', 9: 'neun', 10: 'zehn',
    11: 'elf', 12: 'zwölf', 13: 'dreizehn', 14: 'vierzehn', 15: 'fünfzehn',
    16: 'sechzehn', 17: 'siebzehn', 18: 'achtzehn', 19: 'neunzehn', 20: 'zwanzig',
    21: 'einundzwanzig', 22: 'zweiundzwanzig', 23: 'dreiundzwanzig',
    24: 'vierundzwanzig', 25: 'fünfundzwanzig', 26: 'sechsundzwanzig',
    27: 'siebenundzwanzig', 28: 'achtundzwanzig', 29: 'neunundzwanzig',
    30: 'dreißig',
  }
  return words[n] ?? String(n)
}

/**
 * Convert HH:MM time string to German spoken form e.g. "19:00" → "neunzehn Uhr".
 * Exported for overlay consumers (Plan 05.2-04).
 */
export function timeToGerman(hhmm: string): string {
  const parts = hhmm.split(':')
  const hour = parseInt(parts[0] ?? '0', 10)
  const minute = parseInt(parts[1] ?? '0', 10)
  const hourWord = toGermanNumber(hour)
  if (minute === 0) return `${hourWord} Uhr`
  if (minute === 30) return `halb ${toGermanNumber(hour + 1)}`
  return `${hourWord} Uhr ${toGermanNumber(minute)}`
}

// Plan 05.3-01 D-1: CASE2_TOLERANCE_DECISION_BLOCK + CASE2_HOLD_MUSIC_CLARIFYING_BLOCK
// constants DELETED (0 src refs; migrated into voice-bridge/src/persona/overlays/case-2.ts
// during Phase 05.2). Grep-verified: no external references remained in voice-bridge/src/
// outside tests/persona.test.ts (updated as part of this migration).

export interface Case2OutboundPersonaArgs {
  restaurant_name: string
  requested_date: string
  requested_time: string
  time_tolerance_min: number
  party_size: number
  notes?: string
  requested_date_wort?: string
  requested_time_wort?: string
  party_size_wort?: string
}

/**
 * Build Case-2 outbound persona — MIGRATED in Plan 05.2-04.
 *
 * External signature UNCHANGED (webhook.ts keeps passing the same args).
 * Internal composition REWIRED:
 *   baseline (buildBasePersona, outbound + Sie-form) + '\n\n' + buildCase2Overlay(args)
 *
 * Baseline supplies: identity, ROLE/TURN-DISCIPLIN role-lock (D-9 fix for
 * role-hallucination observed 2026-04-21), PERSONALITY, PRONUNCIATIONS,
 * INSTRUCTIONS (Werkzeug-zuerst, Zwei-Form, Füll-Phrasen, Schweigen,
 * Abschied, Offenlegung), SAFETY & ESCALATION.
 *
 * Overlay supplies: TASK, DECISION RULES, CLARIFYING-QUESTION ANSWERS,
 * HOLD-MUSIC HANDLING (the 4 Case-2-specific sections from research §6.3).
 *
 * Token budget: baseline (~515 tokens) + overlay (~200 tokens) ≈ 715 tokens —
 * well under the 1500-token hard ceiling (research §3.5).
 */
export function buildCase2OutboundPersona(args: Case2OutboundPersonaArgs): string {
  const restaurantName = sanitizeForPersona(args.restaurant_name)

  // Human-readable goal + context strings for the baseline placeholders.
  // These are INSIDE the baseline ROLE & OBJECTIVE / Kontext lines; the
  // overlay's own ### TASK section repeats the authoritative full task detail.
  //
  // "im Auftrag von Carsten" preserved from legacy OUTBOUND_PERSONA_TEMPLATE:
  // this phrasing appears in the persona floor and is load-bearing for
  // existing integration tests (accept.test.ts:680) AND for the model's
  // self-introduction — "NanoClaw im Auftrag von Carsten" is how outbound
  // calls open to the counterpart.
  const goal =
    `Im Auftrag von Carsten eine Reservierung bei ${restaurantName} erwirken — ` +
    `${args.requested_date} um ${args.requested_time} fuer ${args.party_size} Personen ` +
    `(Toleranz ±${args.time_tolerance_min} Min)`
  const context =
    `Outbound-Anruf im Auftrag von Carsten. Restaurant ${restaurantName}, ` +
    `Datum ${args.requested_date}, ±${args.time_tolerance_min} Min Toleranz.`

  const baseline = buildBasePersona({
    anrede_form: 'Sie',
    counterpart_label: 'der Restaurant-Gegenueber',
    goal,
    context,
    call_direction: 'outbound',
  })

  const overlay = buildCase2Overlay(args)

  return [baseline, overlay].join('\n\n')
}

export const PHASE2_PERSONA = [
  'Du bist NanoClaw, ein freundlicher deutscher Sprach-Assistent.',
  '',
  'SPRACHE: Antworte IMMER auf Deutsch (de-DE). Kein Englisch, kein Code-Switch.',
  '',
  'WERKZEUG-ZUERST (KRITISCH):',
  '  - Du DARFST niemals Termine, Verträge, Praxis-Daten oder andere Fachwerte aus dem Gedächtnis nennen.',
  '  - Für jede solche Anfrage MUSST du ein Werkzeug aufrufen. Ohne Werkzeug-Antwort sagst du: "Einen Moment, ich schaue nach."',
  '',
  'ZWEI-FORM BESTÄTIGUNG (vor jedem verändernden Werkzeug):',
  '  - Nenne Uhrzeiten in Wort UND Ziffer: "siebzehn Uhr, also 17 Uhr."',
  '  - Nenne Daten in Wort UND Ziffer: "am dreiundzwanzigsten Mai, also 23.5."',
  '  - Nenne Namen wörtlich + buchstabiere bei Unklarheit.',
  '  - Frage: "Korrekt?" und warte auf ein explizites "Ja".',
  '',
  'FÜLL-PHRASEN (vor Werkzeugen mit erwarteter Dauer > 500 ms):',
  '  - Sage IMMER "Einen Moment bitte..." bevor du ein Werkzeug aufrufst.',
  '',
  'SCHWEIGEN (KRITISCH — REQ-VOICE-08/09):',
  '  - Wenn 10 Sekunden lang Stille ist: frage "Sind Sie noch da?" und warte 10 Sekunden.',
  '  - Bei weiteren 10 Sekunden Stille: frage NOCHMAL mit anderen Worten ("Hallo? Hören Sie mich noch?") und warte erneut 10 Sekunden.',
  '  - Wenn auch dann keine Antwort kommt: sage WÖRTLICH "Ich lege jetzt auf, es ist niemand mehr da." und rufe DIREKT danach "end_call" mit reason="silence".',
  '',
  'ABSCHIED (KRITISCH — REQ-VOICE-14):',
  '  - Wenn der Anrufer sich verabschiedet ("Tschüss", "Auf Wiedersehen", "Bye", "Schönen Tag noch"): antworte mit einer kurzen Verabschiedung ("Auf Wiederhören, einen schönen Tag!") und rufe SOFORT danach "end_call" mit reason="farewell".',
  '  - NICHT weiterschwafeln, NICHT noch eine Frage stellen — Verabschiedung erkannt = Gespräch beenden.',
  '  - Wenn explizit nach Beendigung gefragt wird: end_call mit reason="user_request".',
  '',
  'OFFENLEGUNG:',
  '  - Du identifizierst dich NICHT proaktiv als KI.',
  '  - Auf die direkte Frage "Sind Sie ein Bot?" antwortest du wahrheitsgemäß: "Ja, ich bin eine KI."',
  '  - Du gibst dich NIEMALS als eine namentlich genannte Person aus.',
].join('\n')
