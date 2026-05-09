// src/voice-render.ts
//
// Deterministic TypeScript persona renderer. Ports the core of v1's
// voice-agent-invoker.ts (the "Option E pure-template" path) into a slim
// standalone file that voice-channel-handlers.ts calls.
//
// Reads three skill files from container/skills/voice-personas/:
//   • SKILL.md     — kept for compat, not used by the renderer
//   • baseline.md  — single shared baseline with multilingual phrase lists
//   • overlays/*.md — per-case overlay prose (only case_6b today)
//
// Render is pure CPU/IO: regex placeholder substitution + direction-block
// pick + lang-switch instruction synthesis. Sub-100ms on a warm fs cache.
// No LLM, no network, no async work apart from fs reads.
//
// Pure-template history (post-2026-04-30): earlier attempts wired this to
// the Claude Agent SDK (Plan 01, ~30s) and the direct Anthropic API (Plan
// 02 first pass, 10-18s). Both overshot the /accept budget. The current
// deterministic renderer fits in <100ms and never ran out of budget.

import fs from 'node:fs';
import path from 'node:path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { readVoiceConfig } from './voice-config.js';

const _envFile = readEnvFile(['OPERATOR_NAME', 'ASSISTANT_NAME']);

export const SUPPORTED_LANGS = ['de', 'en', 'it'] as const;
export type Lang = typeof SUPPORTED_LANGS[number];
const DEFAULT_LANG: Lang = 'de';

const VOICE_PERSONAS_DIR = path.resolve(
  process.cwd(),
  'container',
  'skills',
  'voice-personas',
);

const CASE_OVERLAY_MAP: Record<string, string | null> = {
  case_6b: 'overlays/case-6b-inbound-operator.md',
};

const LANG_DESCRIPTIVE: Record<Lang, string> = {
  de: 'German (de-DE)',
  en: 'English',
  it: 'Italian (it-IT)',
};

const LANG_NAME_EN: Record<Lang, string> = {
  de: 'German',
  en: 'English',
  it: 'Italian',
};

export interface VoicePersonaInput {
  call_id: string;
  case_type: string;
  call_direction: 'inbound' | 'outbound';
  counterpart_label: string;
  lang?: Lang;
  goal?: string;
  lang_whitelist?: readonly Lang[];
}

export interface VoicePersonaSkillFiles {
  baseline: string;
  overlay: string;
  overlayPath: string | null;
}

function operatorName(lang: Lang): string {
  const cfg = readVoiceConfig();
  const fromCfg = (cfg.operator_name ?? '').trim();
  if (fromCfg.length > 0) return fromCfg;
  const fromEnv = (process.env.OPERATOR_NAME ?? _envFile.OPERATOR_NAME ?? '').trim();
  if (fromEnv.length > 0) return fromEnv;
  if (lang === 'de') return 'der Nutzer';
  if (lang === 'it') return 'il proprietario';
  return 'the operator';
}

export function loadVoicePersonaSkill(caseType: string): VoicePersonaSkillFiles {
  const baseline = fs.readFileSync(
    path.join(VOICE_PERSONAS_DIR, 'baseline.md'),
    'utf8',
  );
  const overlayRel = CASE_OVERLAY_MAP[caseType] ?? null;
  let overlay = '';
  let overlayPath: string | null = null;
  if (overlayRel) {
    overlayPath = path.join(VOICE_PERSONAS_DIR, overlayRel);
    try {
      overlay = fs.readFileSync(overlayPath, 'utf8');
    } catch {
      overlay = '';
      overlayPath = null;
    }
  }
  return { baseline, overlay, overlayPath };
}

interface AnredeAxis {
  form: string;
  capitalized: string;
  pronoun: string;
  disclosure: string;
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
    return { form: 'Lei', capitalized: 'Lei', pronoun: 'Lei', disclosure: "Lei e'" };
  }
  return { form: 'you', capitalized: 'you', pronoun: 'you', disclosure: 'Are you' };
}

/**
 * Drop the non-matching direction variant of a baseline block-pair and strip
 * the BEGIN/END markers around the wanted variant. Used for SCHWEIGEN_LADDER
 * + GREETING which differ between inbound and outbound calls.
 */
function pickDirectionBlock(
  baseline: string,
  blockName: string,
  direction: string,
): string {
  const wantedTag = `BEGIN ${blockName} call_direction=${direction}`;
  const otherTag = direction === 'inbound'
    ? `BEGIN ${blockName} call_direction=outbound`
    : `BEGIN ${blockName} call_direction=inbound`;
  const endTag = `END ${blockName}`;

  const dropOther = new RegExp(
    `\\n?<!--\\s*${otherTag}\\s*-->[\\s\\S]*?<!--\\s*${endTag}\\s*-->`,
    'g',
  );
  const keepWantedBegin = new RegExp(`<!--\\s*${wantedTag}\\s*-->\\s*\\n?`, 'g');
  const keepWantedEnd = new RegExp(`<!--\\s*${endTag}\\s*-->\\s*\\n?`, 'g');

  return baseline
    .replace(dropOther, '')
    .replace(keepWantedBegin, '')
    .replace(keepWantedEnd, '');
}

function deriveGoalAndContext(
  caseType: string,
  direction: string,
  counterpart: string,
  lang: Lang,
): { goal: string; context: string } {
  const op = operatorName(lang);
  if (lang === 'en') {
    if (caseType === 'case_6b' && direction === 'inbound') {
      return {
        goal: `Help ${op} directly via CLI — manage calendar, look up travel times, delegate research, recall memory.`,
        context: `Inbound call from ${op} via CLI whitelist (case_6b).`,
      };
    }
    return {
      goal: `Resolve the matter with ${counterpart}.`,
      context: `${direction === 'inbound' ? 'Inbound' : 'Outbound'} call.`,
    };
  }
  if (lang === 'it') {
    if (caseType === 'case_6b' && direction === 'inbound') {
      return {
        goal: `Aiutare ${op} direttamente via CLI — gestire il calendario, controllare i tempi di viaggio, delegare ricerche, recuperare la memoria.`,
        context: `Chiamata in entrata da ${op} via CLI whitelist (case_6b).`,
      };
    }
    return {
      goal: `Risolvere la questione con ${counterpart}.`,
      context: `Chiamata ${direction === 'inbound' ? 'in entrata' : 'in uscita'}.`,
    };
  }
  if (caseType === 'case_6b' && direction === 'inbound') {
    return {
      goal: `${op} ueber CLI direkt helfen — Kalender pflegen, Reisezeiten klaeren, Recherche delegieren, Erinnerungen aus dem Memory holen.`,
      context: `Inbound-Anruf von ${op} via CLI-Whitelist (case_6b).`,
    };
  }
  return {
    goal: `Anliegen mit ${counterpart} klaeren.`,
    context: `${direction === 'inbound' ? 'Inbound' : 'Outbound'}-Anruf.`,
  };
}

/**
 * Resolve the effective per-call lang whitelist. Empty / undefined falls
 * back to all SUPPORTED_LANGS so a case=unknown call still allows mid-call
 * language switches instead of locking to a single language by default.
 */
export function effectiveLangWhitelist(
  whitelist: readonly Lang[] | undefined,
): readonly Lang[] {
  if (whitelist && whitelist.length > 0) return whitelist;
  return SUPPORTED_LANGS;
}

function buildLangSwitchBlock(
  active: Lang,
  whitelist: readonly Lang[] | undefined,
): string {
  const effective = effectiveLangWhitelist(whitelist);
  const switchable = effective.filter((l) => l !== active);

  if (switchable.length === 0) {
    return `Speak ${LANG_NAME_EN[active]} throughout this call. If the counterpart speaks another language, politely refuse in your current speaking language, explain you can only handle ${LANG_NAME_EN[active]}, and ask them to use it. If the counterpart insists in an off-language a second time, repeat the polite refusal in English regardless of your current speaking language. Do not switch to the off-language.`;
  }

  const allowed: Lang[] = [active, ...switchable];
  const allowedNames = allowed.map((l) => LANG_NAME_EN[l]).join(' / ');
  const allowedCodes = allowed.join('/');
  const switchableCodes = switchable.join('/');

  return `Start this call in ${LANG_NAME_EN[active]}. Allowed languages for a mid-call switch: ${allowedNames} (${allowedCodes}). If the counterpart consistently answers in one of the allowed switch languages (${switchableCodes}), call the \`voice_set_language\` tool with that language code — the persona reloads in the new language. For any language outside the allowed list: politely refuse in your CURRENT speaking language, naming the allowed languages, and ask the counterpart to use one of them. If the counterpart insists in an off-list language a second time, repeat the polite refusal in English regardless of your current speaking language. Never switch to a language that is not in the allowed list.`;
}

/**
 * Render the persona string for a given call. Pure deterministic
 * transformation — same input always produces the same output.
 */
export function renderPersona(
  skill: VoicePersonaSkillFiles,
  input: VoicePersonaInput,
): string {
  const lang: Lang = (input.lang ?? DEFAULT_LANG) as Lang;
  const anrede = deriveAnrede(input.case_type, lang);
  const derived = deriveGoalAndContext(
    input.case_type,
    input.call_direction,
    input.counterpart_label,
    lang,
  );
  const goal = input.goal && input.goal.length > 0 ? input.goal : derived.goal;
  const context = derived.context;

  let body = pickDirectionBlock(skill.baseline, 'SCHWEIGEN_LADDER', input.call_direction);
  body = pickDirectionBlock(body, 'GREETING', input.call_direction);

  if (skill.overlay) {
    body = `${body}\n\n${skill.overlay}`;
  }

  const lang_switch_block = buildLangSwitchBlock(lang, input.lang_whitelist);
  const subs: Record<string, string> = {
    goal,
    context,
    counterpart_label: input.counterpart_label,
    call_direction: input.call_direction,
    anrede_form: anrede.form,
    anrede_capitalized: anrede.capitalized,
    anrede_pronoun: anrede.pronoun,
    anrede_disclosure: anrede.disclosure,
    speaking_language: LANG_DESCRIPTIVE[lang],
    lang_switch_block,
    assistant_name:
      (process.env.ASSISTANT_NAME ?? _envFile.ASSISTANT_NAME ?? '').trim() ||
      'Andy',
    operator_name: operatorName(lang),
  };

  for (const [token, value] of Object.entries(subs)) {
    body = body.replace(new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, 'g'), value);
  }
  return body;
}

/**
 * Convenience: load skill + render. Throws `agent_unavailable` on fs
 * failure so callers map cleanly to the dispatch error contract.
 */
export function renderPersonaForCall(input: VoicePersonaInput): {
  instructions: string;
} {
  const start = Date.now();
  let skill: VoicePersonaSkillFiles;
  try {
    skill = loadVoicePersonaSkill(input.case_type);
  } catch (err) {
    logger.warn({
      event: 'voice_render_skill_load_failed',
      call_id: input.call_id,
      case_type: input.case_type,
      err: err instanceof Error ? err.message : String(err),
    });
    const e = new Error('agent_unavailable: skill load failed');
    (e as { code?: string }).code = 'agent_unavailable';
    throw e;
  }

  const instructions = renderPersona(skill, input);
  const placeholderLeak = /\{\{[a-z_]+\}\}/i.test(instructions);
  if (placeholderLeak) {
    logger.warn({
      event: 'voice_render_placeholder_leak',
      call_id: input.call_id,
    });
  }
  logger.info({
    event: 'voice_render_ok',
    call_id: input.call_id,
    case_type: input.case_type,
    lang: input.lang ?? DEFAULT_LANG,
    latency_ms: Date.now() - start,
    instructions_len: instructions.length,
  });
  return { instructions };
}
