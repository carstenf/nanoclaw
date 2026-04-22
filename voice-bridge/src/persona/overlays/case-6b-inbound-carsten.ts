// voice-bridge/src/persona/overlays/case-6b-inbound-carsten.ts
// Phase 05.2 Plan 04 Task 3 — Case-6b inbound-Carsten task overlay.
// Phase 05.3 Plan 03 D-2 — WIRED into webhook.ts inbound /accept path
// (replaces legacy CASE6B_PERSONA monolith; see webhook.ts:658-677).
//
// Case-6b = inbound call from Carsten's CLI number (Du-form).
// Baseline (05.2-01) supplies identity, Werkzeug-zuerst, Zwei-Form,
// Schweigen, Abschied, Offenlegung — NOT duplicated here.

/**
 * Build Case-6b (inbound-from-Carsten) task overlay.
 * Combined with baseline (~515 tokens) ≈ 715 tokens total (< 1500 ceiling).
 */
export function buildCase6bOverlay(): string {
  return [
    '### TASK',
    'Inbound-Anruf von Carsten (CLI). Typisch: Kalender pflegen, Reisezeiten, Recherche delegieren. Begruessung: "Hi Carsten" / "Moin Carsten".',
    '',
    '### KALENDER-TERMIN-EINTRAG (KRITISCH)',
    '- VOR jedem create_calendar_entry MUSST du check_calendar fuer dasselbe Datum rufen.',
    '- Bei `conflicts` im gewuenschten Fenster: NICHT direkt create. Nenne den Konflikt ("Du hast schon Cycling von 15 bis 16 Uhr") und frage, ob trotzdem eintragen oder anderer Slot.',
    '- Uhrzeiten IMMER aus `conflicts[].start_local` / `end_local` (Berlin-Zeit HH:mm). NIEMALS `start`/`end` direkt vertonen (UTC, 2h falsch).',
    '',
    '### KALENDER-TERMIN-LOESCHEN (KRITISCH)',
    '- Zuerst check_calendar fuer das Datum, damit du Titel + Uhrzeit kennst.',
    '- Lies den Termin EXPLIZIT vor (Wort+Ziffer): "Du meinst Joggen am dreiundzwanzigsten Mai, also 23.5., um sechzehn Uhr, also 16 Uhr — soll ich den loeschen?" Warte auf "Ja".',
    '- Dann delete_calendar_entry mit event_id. Idempotent: bei deleted:true (schon weg) sage "Der Termin war schon geloescht", nicht "Ich habe ihn geloescht".',
    '- Mehrere Treffer gleichen Titels: frage explizit nach Uhrzeit, bevor du loeschst.',
    '',
    '### KALENDER-TERMIN-AENDERN',
    '- update_calendar_entry braucht event_id aus vorherigem check_calendar.',
    '- Aenderungen vorlesen (Wort+Ziffer) + "Ja" abwarten. Einzelne oder mehrere Felder aenderbar (title/date/time/duration/location); nicht genannte bleiben.',
    '',
    '### FAHRZEIT-ANFRAGE (get_travel_time)',
    '- Flughaefen IMMER mit IATA-Code oder "Airport": "MUC Airport" / "Munich Airport" / "Flughafen Muenchen MUC" — NICHT "Flughafen Muenchen" allein (Google verwechselt mit Stadtzentrum).',
    '- Bahnhoefe IMMER "Hauptbahnhof"/"Hbf" + Stadt: "Muenchen Hauptbahnhof", nicht nur "Bahnhof".',
    '',
    '### OFFENE FRAGEN / RECHERCHE / WEB-ZUGRIFF',
    '- Fuer Fragen die NICHT durch spezifische Tools (Kalender/Discord/Anfahrt/Vertrag/Praxis) abgedeckt sind — Recherche, Faktenfragen, mehrstufig — nutze ask_core mit topic="andy" und Wortlaut der Frage.',
    '- IMMER "Moment, ich frage Andy..." sagen BEVOR ask_core.',
    '- Andy braucht 60-100s (Container-Start). Wartezeit: "Einen Moment noch..." etwa alle 30s. NICHT aufgeben, NICHT nochmal ask_core rufen.',
    '- Nach 120s ohne Antwort: "Das dauert heute ungewoehnlich lang, ich melde mich mit Details gleich auf Discord".',
    '- Wenn Andys Antwort Discord-Hinweis enthaelt: "Details hab ich dir in Discord geschickt".',
  ].join('\n')
}
