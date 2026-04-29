// src/mcp-tools/voice-set-language.ts
// Phase 06.x — mid-call language switch MCP tool.
//
// Bot-facing contract: the bot MAY call this tool when the counterpart
// consistently answers in a language that's in the per-call lang_whitelist
// (set by Andy at voice_request_outbound_call time and stored in the active-
// call gateway). The tool re-renders the persona in the requested language
// and tells the Bridge to push the new persona + voice + transcription
// language via session.update.
//
// Security: lang_whitelist is enforced server-side. Even if the bot tries
// to switch to a lang outside the per-call whitelist (mis-trigger,
// hallucination), the tool returns 'lang_not_in_whitelist' and the Bridge
// keeps the current persona.
//
// Atomicity: the tool returns the new lang plus the rendered persona; the
// Bridge applies it via TWO-STEP session.update (audio first, then
// instructions) per Q7 atomicity finding mitigation. See voice-bridge/src/
// sideband.ts updateAudioConfig + updateInstructions.

import { z } from 'zod';

import {
  type CallLang,
  getActiveRenderCtx,
  getActiveWhitelist,
  setActiveLang,
} from '../voice-mid-call-gateway.js';
import { logger } from '../logger.js';

import { renderPersona, loadVoicePersonaSkillDefault } from '../voice-agent-invoker.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_set_language' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

export const VoiceSetLanguageSchema = z.object({
  call_id: z.string().min(1),
  lang: z.enum(['de', 'en', 'it']),
});

export type VoiceSetLanguageInput = z.infer<typeof VoiceSetLanguageSchema>;

export type VoiceSetLanguageResult =
  | {
      ok: true;
      result: {
        instructions: string;
        lang: CallLang;
      };
    }
  | {
      ok: false;
      error:
        | 'call_unknown'
        | 'lang_not_in_whitelist'
        | 'render_failed'
        | 'same_lang_no_op';
    };

export interface VoiceSetLanguageDeps {
  /** Override skill-files reader for tests. Default: loadVoicePersonaSkillDefault. */
  loadSkillFiles?: typeof loadVoicePersonaSkillDefault;
}

export function makeVoiceSetLanguage(
  deps: VoiceSetLanguageDeps = {},
): ToolHandler {
  const loadSkill = deps.loadSkillFiles ?? loadVoicePersonaSkillDefault;

  return async function voiceSetLanguage(
    args: unknown,
  ): Promise<VoiceSetLanguageResult> {
    const parsed = VoiceSetLanguageSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }

    const { call_id, lang } = parsed.data;

    const whitelist = getActiveWhitelist(call_id);
    const renderCtx = getActiveRenderCtx(call_id);
    if (whitelist === null || renderCtx === null) {
      logger.warn({
        event: 'voice_set_language_call_unknown',
        call_id,
        lang,
      });
      return { ok: false, error: 'call_unknown' };
    }

    if (!whitelist.includes(lang)) {
      logger.warn({
        event: 'voice_set_language_off_whitelist',
        call_id,
        lang,
        whitelist,
      });
      return { ok: false, error: 'lang_not_in_whitelist' };
    }

    let skill;
    try {
      skill = loadSkill(renderCtx.case_type, lang);
    } catch (err) {
      logger.warn({
        event: 'voice_set_language_skill_load_failed',
        call_id,
        lang,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'render_failed' };
    }

    const instructions = renderPersona(skill, {
      call_id,
      case_type: renderCtx.case_type,
      call_direction: renderCtx.call_direction,
      counterpart_label: renderCtx.counterpart_label,
      lang,
      lang_whitelist: whitelist,
      goal: renderCtx.goal,
    });

    setActiveLang(call_id, lang);

    logger.info({
      event: 'voice_set_language_ok',
      call_id,
      lang,
      instructions_len: instructions.length,
    });

    return {
      ok: true,
      result: { instructions, lang },
    };
  };
}
