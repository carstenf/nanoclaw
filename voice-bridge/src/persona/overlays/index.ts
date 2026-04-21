// voice-bridge/src/persona/overlays/index.ts
// Phase 05.2 Plan 01 — Task-overlay dispatcher skeleton. Bodies land in
// 05.2-04 (Case-2 migration). This plan ships the registration surface only;
// Wave 1 is purely additive (new files), legacy persona.ts untouched.

/**
 * CaseKey union — registered task-overlay keys.
 *
 * - case_2: Case-2 restaurant reservation (outbound, Sie-form)
 * - case_6b_inbound_carsten: Case-6b inbound from Carsten (Du-form)
 * - outbound_default_sie: Default outbound without specific case overlay (Case-1 general)
 * - amd_classifier_mode_noop: Sentinel — AMD classifier stays on separate prompt (D-10)
 */
export type CaseKey =
  | 'case_2'
  | 'case_6b_inbound_carsten'
  | 'outbound_default_sie'
  | 'amd_classifier_mode_noop'

/**
 * Dispatch a task-overlay string for the given case.
 *
 * Wave 1 skeleton:
 *   'outbound_default_sie' and 'amd_classifier_mode_noop' return ''.
 *   'case_2' and 'case_6b_inbound_carsten' throw until 05.2-04 lands bodies.
 *
 * @param caseKey - registered case identifier
 * @param _caseArgs - case-specific overlay arguments (unused in skeleton; shape
 *                   defined per case in 05.2-04)
 */
export function buildTaskOverlay(caseKey: CaseKey, _caseArgs: unknown): string {
  switch (caseKey) {
    case 'outbound_default_sie':
    case 'amd_classifier_mode_noop':
      return ''
    case 'case_2':
    case 'case_6b_inbound_carsten':
      throw new Error(
        `buildTaskOverlay: caseKey='${caseKey}' not yet implemented (lands in 05.2-04)`,
      )
  }
}
