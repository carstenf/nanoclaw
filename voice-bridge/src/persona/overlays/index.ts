// voice-bridge/src/persona/overlays/index.ts
// Phase 05.2 Plan 01 — Task-overlay dispatcher skeleton.
// Phase 05.2 Plan 04 Task 2 — body filled for case_2.
// Phase 05.2 Plan 04 Task 3 — body filled for case_6b_inbound_carsten.
// Phase 05.3 Plan 03 D-2 — case_6b_inbound_carsten now wired into webhook.ts
//   inbound /accept (legacy CASE6B_PERSONA monolith retired).

import type { Case2OutboundPersonaArgs } from '../../persona.js'
import { buildCase2Overlay } from './case-2.js'
import { buildCase6bOverlay } from './case-6b-inbound-carsten.js'

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
 * - 'outbound_default_sie' and 'amd_classifier_mode_noop' return '' (no overlay).
 * - 'case_2' returns buildCase2Overlay(args) — args typed as Case2OutboundPersonaArgs.
 * - 'case_6b_inbound_carsten' returns buildCase6bOverlay() — no per-call args.
 *
 * @param caseKey - registered case identifier
 * @param caseArgs - case-specific overlay arguments (shape defined per case)
 */
export function buildTaskOverlay(caseKey: CaseKey, caseArgs: unknown): string {
  switch (caseKey) {
    case 'outbound_default_sie':
    case 'amd_classifier_mode_noop':
      return ''
    case 'case_2':
      return buildCase2Overlay(caseArgs as Case2OutboundPersonaArgs)
    case 'case_6b_inbound_carsten':
      return buildCase6bOverlay()
  }
}
