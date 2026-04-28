// src/voice-agent-invoker.ts
//
// Phase 05.6 Plan 02 — pure-template render path (Option E).
//
// History:
//   - Phase 05.6 Plan 01: wired voice_triggers_* to runContainerAgent. Cold-
//     start + Claude Agent SDK + multi-turn loop = 30s+, never fit /accept.
//   - Phase 05.6 Plan 02 first attempt (Option A): direct Anthropic API call
//     from NanoClaw process. Smoke-tested live: even Haiku takes 10-18s for
//     a 1500-token persona render — also overshoots the 5s /accept budget.
//   - Phase 05.6 Plan 02 final (Option E, this file): deterministic TypeScript
//     template renderer. NanoClaw reads the voice-personas skill files from
//     disk and applies regex placeholder substitution + SCHWEIGEN-block pick
//     + Du/Sie derivation in pure code — no LLM call. Render time <100ms.
//
// MOS-4 stays intact: the persona content (skill files, baseline, overlay)
// lives in NanoClaw — not the Bridge. The Bridge still holds only the
// FALLBACK_PERSONA constant per REQ-DIR-18.
//
// Defense-in-depth for REQ-DIR-17 (read-only mid-call) is unchanged:
//   1. Persona text in baseline.md + overlay forbids mutating tools mid-call.
//   2. NanoClaw-side gateway rejects mutating tools at dispatch path
//      (`src/voice-mid-call-gateway.ts`).
//   3. `__MUTATION_ATTEMPT__` sentinel gate at handler boundary in
//      `src/mcp-tools/voice-triggers-transcript.ts`.
//
// REQ-DIR-09: render fits comfortably in <5000ms /accept budget (<100ms).
// REQ-DIR-12: render failure (fs read error) → throw `agent_unavailable` →
//   Bridge falls back to FALLBACK_PERSONA.
// REQ-DIR-16: transcript-trigger receives full turn-history. For now the
//   transcript path returns NULL_NO_UPDATE by default (no mid-call persona
//   re-render); a smarter mid-call decision policy can be layered on later
//   without architecture change.

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import type { VoiceTriggersInitInput } from './mcp-tools/voice-triggers-init.js';
import type { VoiceTriggersTranscriptInput } from './mcp-tools/voice-triggers-transcript.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Output fences — kept for backwards compat (the synth test harness still
// references them) and for any future mid-call re-render path.
export const INSTRUCTIONS_FENCE_START = '---NANOCLAW_INSTRUCTIONS_START---';
export const INSTRUCTIONS_FENCE_END = '---NANOCLAW_INSTRUCTIONS_END---';
export const NULL_SENTINEL = 'NULL_NO_UPDATE';

const VOICE_PERSONAS_DIR = path.resolve(
  process.cwd(),
  'container',
  'skills',
  'voice-personas',
);

// Map case_type → overlay filename (relative to the language dir or to the
// flat skill root for the legacy layout). Mirrors SKILL.md
// `case_type-to-overlay` table.
const CASE_OVERLAY_MAP: Record<string, string | null> = {
  case_2: 'overlays/case-2-restaurant-outbound.md',
  case_6b: 'overlays/case-6b-inbound-carsten.md',
};

// Multilingual layout (Phase 06.x): per-language baselines + overlays under
// `i18n/{lang}/`. Loader prefers `i18n/{lang}/`, falls back to the flat
// layout (`baseline.md` + `overlays/...`) so a language without a folder
// degrades gracefully to the German default content.
const SUPPORTED_LANGS = ['de', 'en', 'it'] as const;
type Lang = typeof SUPPORTED_LANGS[number];
const DEFAULT_LANG: Lang = 'de';

// ---------------------------------------------------------------------------
// DI seam — kept for tests; default uses fs.readFileSync.
// ---------------------------------------------------------------------------

export interface VoicePersonaSkillFiles {
  /** SKILL.md body (kept for compatibility — not used by the pure renderer). */
  skill: string;
  /** baseline.md body. Holds all baseline `{{...}}` placeholders. */
  baseline: string;
  /** Overlay body for the requested case_type, or empty if no overlay maps. */
  overlay: string;
  /** Resolved overlay path (or null if unmapped) — for logging only. */
  overlayPath: string | null;
}

export interface VoiceAgentInvokerDeps {
  /** Override the skill-files reader. Default: fs.readFileSync from VOICE_PERSONAS_DIR. */
  loadSkillFiles?: (caseType: string, lang?: Lang) => VoicePersonaSkillFiles;
  /** Clock override for latency metrics in tests. */
  now?: () => number;
}

/**
 * Default skill-files reader. Reads from VOICE_PERSONAS_DIR on the host.
 * Throws if SKILL.md or baseline.md are missing — those are non-recoverable.
 *
 * Layout resolution:
 *   1. `i18n/{lang}/baseline.md` + `i18n/{lang}/overlays/...` (multilingual).
 *   2. Falls back to flat `baseline.md` + `overlays/...` (legacy DE-only).
 * This lets Step 2 land the i18n folder structure without breaking the
 * default DE path before the move is in.
 */
export function loadVoicePersonaSkillDefault(
  caseType: string,
  lang: Lang = DEFAULT_LANG,
): VoicePersonaSkillFiles {
  const skill = fs.readFileSync(
    path.join(VOICE_PERSONAS_DIR, 'SKILL.md'),
    'utf8',
  );

  const langDir = path.join(VOICE_PERSONAS_DIR, 'i18n', lang);
  const langBaseline = path.join(langDir, 'baseline.md');
  const flatBaseline = path.join(VOICE_PERSONAS_DIR, 'baseline.md');
  const baseline = fs.readFileSync(
    fs.existsSync(langBaseline) ? langBaseline : flatBaseline,
    'utf8',
  );

  const overlayRel = CASE_OVERLAY_MAP[caseType] ?? null;
  let overlay = '';
  let overlayPath: string | null = null;
  if (overlayRel) {
    const langOverlay = path.join(langDir, overlayRel);
    const flatOverlay = path.join(VOICE_PERSONAS_DIR, overlayRel);
    overlayPath = fs.existsSync(langOverlay) ? langOverlay : flatOverlay;
    try {
      overlay = fs.readFileSync(overlayPath, 'utf8');
    } catch {
      overlay = '';
      overlayPath = null;
    }
  }
  return { skill, baseline, overlay, overlayPath };
}

// ---------------------------------------------------------------------------
// Anrede derivation (lang-aware)
// ---------------------------------------------------------------------------
// DE: Du/Sie axis (case-conditional — Carsten=Du, restaurant=Sie).
// IT: tu/Lei axis (case-conditional — same shape as DE).
// EN: no T-V distinction; "you" everywhere. Disclosure question form
//     ("Are you a bot?") still varies, kept as a separate token.

interface AnredeAxis {
  form: string;       // Du / Sie / tu / Lei / you
  capitalized: string; // Re-ask accusative form (DE: dich/Sie; IT: te/Lei; EN: you)
  pronoun: string;    // Re-ask nominative form (DE: du/Sie; IT: tu/Lei; EN: you)
  disclosure: string; // Bot-disclosure question form ("Are you", "Bist du", "Sind Sie", "Sei", "Lei è")
}

function deriveAnrede(caseType: string, lang: Lang): AnredeAxis {
  if (lang === 'de') {
    if (caseType === 'case_6b') {
      return { form: 'Du', capitalized: 'dich', pronoun: 'du', disclosure: 'Bist du' };
    }
    return { form: 'Sie', capitalized: 'Sie', pronoun: 'Sie', disclosure: 'Sind Sie' };
  }
  if (lang === 'it') {
    if (caseType === 'case_6b') {
      return { form: 'tu', capitalized: 'te', pronoun: 'tu', disclosure: 'Sei' };
    }
    return { form: 'Lei', capitalized: 'Lei', pronoun: 'Lei', disclosure: 'Lei è' };
  }
  // en — single form, no T-V distinction
  return { form: 'you', capitalized: 'you', pronoun: 'you', disclosure: 'Are you' };
}

// ---------------------------------------------------------------------------
// SCHWEIGEN block picker
// ---------------------------------------------------------------------------

/**
 * Replace the dual SCHWEIGEN_LADDER block in baseline.md with the single
 * block matching the call direction. The baseline ships:
 *
 *   <!-- BEGIN SCHWEIGEN_LADDER call_direction=inbound --> ... <!-- END ... -->
 *   <!-- BEGIN SCHWEIGEN_LADDER call_direction=outbound --> ... <!-- END ... -->
 *
 * After this transform exactly one ladder remains; the other is dropped.
 */
function pickSchweigenLadder(baseline: string, direction: string): string {
  const wantedTag = `BEGIN SCHWEIGEN_LADDER call_direction=${direction}`;
  const otherTag = direction === 'inbound'
    ? 'BEGIN SCHWEIGEN_LADDER call_direction=outbound'
    : 'BEGIN SCHWEIGEN_LADDER call_direction=inbound';

  // Drop the OTHER ladder block entirely (BEGIN to END inclusive of the markers).
  const dropOther = new RegExp(
    `\\n?<!--\\s*${otherTag}\\s*-->[\\s\\S]*?<!--\\s*END SCHWEIGEN_LADDER\\s*-->`,
    'g',
  );

  // Strip the wanted block's BEGIN/END comment markers but keep the body.
  const keepWantedBegin = new RegExp(`<!--\\s*${wantedTag}\\s*-->\\s*\\n?`, 'g');
  const keepWantedEnd = /<!--\s*END SCHWEIGEN_LADDER\s*-->\s*\n?/g;

  return baseline
    .replace(dropOther, '')
    .replace(keepWantedBegin, '')
    .replace(keepWantedEnd, '');
}

// ---------------------------------------------------------------------------
// Goal / context defaults (case_type + direction-driven)
// ---------------------------------------------------------------------------

function deriveGoalAndContext(
  caseType: string,
  direction: string,
  counterpart: string,
  lang: Lang,
): { goal: string; context: string } {
  if (lang === 'en') {
    if (caseType === 'case_6b' && direction === 'inbound') {
      return {
        goal:
          'Help Carsten directly via CLI — manage calendar, look up travel times, delegate research, recall memory.',
        context: 'Inbound call from Carsten via CLI whitelist (case_6b).',
      };
    }
    if (caseType === 'case_2' && direction === 'outbound') {
      return {
        goal: 'Book a table on Carstens behalf.',
        context: `Outbound to ${counterpart} (case_2 restaurant booking).`,
      };
    }
    return {
      goal: `Resolve the matter with ${counterpart}.`,
      context: `${direction === 'inbound' ? 'Inbound' : 'Outbound'} (${caseType}).`,
    };
  }
  if (lang === 'it') {
    if (caseType === 'case_6b' && direction === 'inbound') {
      return {
        goal:
          'Aiutare Carsten direttamente via CLI — gestire il calendario, controllare i tempi di viaggio, delegare ricerche, recuperare la memoria.',
        context: 'Chiamata in entrata da Carsten via CLI whitelist (case_6b).',
      };
    }
    if (caseType === 'case_2' && direction === 'outbound') {
      return {
        goal: 'Prenotare un tavolo per conto di Carsten.',
        context: `Chiamata in uscita a ${counterpart} (case_2 prenotazione ristorante).`,
      };
    }
    return {
      goal: `Risolvere la questione con ${counterpart}.`,
      context: `${direction === 'inbound' ? 'In entrata' : 'In uscita'} (${caseType}).`,
    };
  }
  // de (default)
  if (caseType === 'case_6b' && direction === 'inbound') {
    return {
      goal:
        'Carsten ueber CLI direkt helfen — Kalender pflegen, Reisezeiten klaeren, Recherche delegieren, Erinnerungen aus dem Memory holen.',
      context: 'Inbound-Anruf von Carsten via CLI-Whitelist (case_6b).',
    };
  }
  if (caseType === 'case_2' && direction === 'outbound') {
    return {
      goal: 'Tisch reservieren auf Carstens Wunsch.',
      context: `Outbound an ${counterpart} (case_2 Restaurant-Reservierung).`,
    };
  }
  return {
    goal: `Anliegen mit ${counterpart} klaeren.`,
    context: `${direction === 'inbound' ? 'Inbound' : 'Outbound'} (${caseType}).`,
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render a complete persona string from the skill files + typed inputs.
 * Pure deterministic transformation — no I/O, no LLM, no awaits.
 *
 * Public for tests and any future inline use.
 */
export function renderPersona(
  skill: VoicePersonaSkillFiles,
  input: VoiceTriggersInitInput,
): string {
  const lang: Lang = (input.lang ?? DEFAULT_LANG) as Lang;
  const anrede = deriveAnrede(input.case_type, lang);
  const { goal, context } = deriveGoalAndContext(
    input.case_type,
    input.call_direction,
    input.counterpart_label,
    lang,
  );

  // 1. Pick the SCHWEIGEN block matching call_direction (drops the other
  //    block entirely). Done on baseline before placeholder substitution
  //    because the BEGIN/END markers are baseline-only.
  let body = pickSchweigenLadder(skill.baseline, input.call_direction);

  // 2. Append overlay (if any). Overlays are pure prose — no placeholders
  //    of their own that the baseline doesn't already define for case_6b.
  //    For case_2 the overlay does declare extra placeholders (restaurant_name
  //    etc.) — see "Future work" note below.
  if (skill.overlay) {
    body = `${body}\n\n${skill.overlay}`;
  }

  // 3. Substitute baseline placeholders.
  const subs: Record<string, string> = {
    goal,
    context,
    counterpart_label: input.counterpart_label,
    call_direction: input.call_direction,
    anrede_form: anrede.form,
    anrede_capitalized: anrede.capitalized,
    anrede_pronoun: anrede.pronoun,
    anrede_disclosure: anrede.disclosure,
  };

  for (const [token, value] of Object.entries(subs)) {
    body = body.replace(new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, 'g'), value);
  }

  // 4. Future work for case_2: restaurant_name / requested_date / etc.
  //    placeholders need to come from the outbound-call request
  //    (voice_request_outbound_call / voice_start_case_2_call args). For
  //    now the baseline only references the 8 baseline placeholders that
  //    are all derived above, so case_6b inbound renders cleanly. case_2
  //    outbound will leave its overlay-specific tokens unsubstituted until
  //    the args-passthrough wiring lands as a follow-up.

  return body;
}

// ---------------------------------------------------------------------------
// Output extractor — kept for tests + any future LLM-render path.
// ---------------------------------------------------------------------------

export interface ExtractedRender {
  instructions: string;
  placeholderLeak: boolean;
  fenced: boolean;
}

export function extractRenderedString(
  raw: string | null,
): ExtractedRender {
  const text = (raw ?? '').toString();
  const startIdx = text.indexOf(INSTRUCTIONS_FENCE_START);
  const endIdx = text.indexOf(INSTRUCTIONS_FENCE_END);
  let body: string;
  let fenced: boolean;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    body = text
      .slice(startIdx + INSTRUCTIONS_FENCE_START.length, endIdx)
      .trim();
    fenced = true;
  } else {
    body = text.trim();
    fenced = false;
  }
  const placeholderLeak = /\{\{[a-z_]+\}\}/i.test(body);
  return { instructions: body, placeholderLeak, fenced };
}

// ---------------------------------------------------------------------------
// defaultInvokeAgent — voice_triggers_init render path
// ---------------------------------------------------------------------------

/**
 * `defaultInvokeAgent` for the `voice_triggers_init` MCP-tool.
 *
 * Loads skill files, runs the pure-template renderer, returns the persona.
 * Throws `agent_unavailable` only if the skill files cannot be read at all
 * — there is no network, no API, nothing else that can hang or time out.
 */
export async function defaultInvokeAgent(
  input: VoiceTriggersInitInput,
  deps: VoiceAgentInvokerDeps = {},
): Promise<{ instructions: string }> {
  const _loadSkill = deps.loadSkillFiles ?? loadVoicePersonaSkillDefault;
  const now = deps.now ?? (() => Date.now());
  const start = now();
  const lang: Lang = (input.lang ?? DEFAULT_LANG) as Lang;

  let skill: VoicePersonaSkillFiles;
  try {
    skill = _loadSkill(input.case_type, lang);
  } catch (err) {
    logger.warn({
      event: 'voice_render_skill_load_failed',
      call_id: input.call_id,
      case_type: input.case_type,
      lang,
      err: err instanceof Error ? err.message : String(err),
    });
    const e = new Error('agent_unavailable: skill load failed');
    (e as { code?: string }).code = 'agent_unavailable';
    throw e;
  }

  if (!skill.overlayPath) {
    logger.warn({
      event: 'voice_render_no_overlay_for_case',
      call_id: input.call_id,
      case_type: input.case_type,
      lang,
    });
  }

  const instructions = renderPersona(skill, input);
  const latency = now() - start;
  const placeholderLeak = /\{\{[a-z_]+\}\}/i.test(instructions);

  if (placeholderLeak) {
    logger.warn({
      event: 'voice_render_init_placeholder_leak',
      call_id: input.call_id,
      latency_ms: latency,
    });
  }

  logger.info({
    event: 'voice_render_init_ok',
    call_id: input.call_id,
    latency_ms: latency,
    case_type: input.case_type,
    lang,
    instructions_len: instructions.length,
    anrede: deriveAnrede(input.case_type, lang).form,
  });

  return { instructions };
}

// ---------------------------------------------------------------------------
// defaultInvokeAgentTurn — voice_triggers_transcript render path
// ---------------------------------------------------------------------------

/**
 * `defaultInvokeAgentTurn` for the `voice_triggers_transcript` MCP-tool.
 *
 * Mid-call decision: should the persona be re-rendered given this turn?
 * For now the answer is always NO (return `instructions_update: null`).
 * The OpenAI Realtime model handles intra-call adaptation via the persona
 * already given at /accept; persona drift is rare. A smarter decision
 * policy (e.g. "user changed booking time → re-render with new args") can
 * be layered on later without an architecture change. The full turn-history
 * is forwarded into this function so the policy upgrade has all the inputs
 * it needs (REQ-DIR-16 contract preserved).
 */
export async function defaultInvokeAgentTurn(
  input: VoiceTriggersTranscriptInput,
  deps: VoiceAgentInvokerDeps = {},
): Promise<{ instructions_update: string | null }> {
  const now = deps.now ?? (() => Date.now());
  const start = now();
  const latency = now() - start;
  logger.info({
    event: 'voice_render_turn_no_update',
    call_id: input.call_id,
    turn_id: input.turn_id,
    latency_ms: latency,
    turns_received: input.transcript.turns.length,
  });
  return { instructions_update: null };
}

// ---------------------------------------------------------------------------
// Legacy prompt builders — kept as no-ops for back-compat with any caller
// that still imports them. The pure-template renderer doesn't need them.
// ---------------------------------------------------------------------------

export function buildPersonaRenderPrompt(input: VoiceTriggersInitInput): string {
  return [
    `# Persona render request`,
    `case_type: ${input.case_type}`,
    `call_direction: ${input.call_direction}`,
    `counterpart_label: ${input.counterpart_label}`,
  ].join('\n');
}

export function buildPersonaTurnPrompt(
  input: VoiceTriggersTranscriptInput,
): string {
  const turnsBlock = input.transcript.turns
    .map((t, i) => `${i + 1}. [${t.role}] ${t.text}`)
    .join('\n');
  return [
    `# Transcript turn ${input.turn_id}`,
    `call_id: ${input.call_id}`,
    turnsBlock || '(no turns)',
  ].join('\n');
}

export function buildSystemPrompt(skill: VoicePersonaSkillFiles): string {
  return [
    '## SKILL',
    skill.skill,
    '',
    '## BASELINE',
    skill.baseline,
    '',
    skill.overlay
      ? `## OVERLAY\n${skill.overlay}`
      : '## OVERLAY (none)',
  ].join('\n');
}
