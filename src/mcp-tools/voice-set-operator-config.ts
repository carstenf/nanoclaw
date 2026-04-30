// src/mcp-tools/voice-set-operator-config.ts
//
// v1.4.0 — bot-managed deployment config. The operator tells Andy their
// name and/or phone number through chat, and Andy persists it to
// ~/.config/nanoclaw/voice-config.json so future calls render the persona
// correctly + the bridge picks the right case_6b CLI on inbound.
//
// Replaces the v1.3.x model where these values had to be hand-edited in
// two .env files (NanoClaw + voice-bridge).
//
// Read path (no restart needed for either side):
//   - NanoClaw `voice-agent-invoker.ts` reads the file fresh on every render.
//   - Bridge `config.ts` reads on each inbound /accept (same source-of-truth
//     via bind-mounted /etc/nanoclaw/voice-config.json).

import { z } from 'zod';

import { logger } from '../logger.js';
import { writeVoiceConfig, type VoiceConfig } from '../voice-config.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_set_operator_config' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

// E.164: leading '+' followed by 8-15 digits. Strict — rejects the common
// "0049…" / "+49 170 …" / "+49-170-…" formats so the operator gets a clear
// error instead of a silently malformed value that breaks CLI matching.
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

// Plain z.object (no .refine wrapper) so the SDK can expose `.shape` to MCP
// `tools/list` consumers. The "at least one of" rule lives in the handler
// below — wrapping the object in .refine() produces ZodEffects which has no
// `.shape` and would result in an empty inputSchema being published.
export const VoiceSetOperatorConfigSchema = z.object({
  operator_name: z.string().min(1).max(120).optional(),
  operator_cli_number: z
    .string()
    .min(1)
    .max(20)
    .refine((v) => E164_REGEX.test(v), {
      message:
        'must be E.164 (e.g. +491701234567) — leading + then country code + digits, no spaces',
    })
    .optional(),
});

export type VoiceSetOperatorConfigInput = z.infer<
  typeof VoiceSetOperatorConfigSchema
>;

export type VoiceSetOperatorConfigResult =
  | { ok: true; result: { config: VoiceConfig } }
  | { ok: false; error: 'write_failed' };

export interface VoiceSetOperatorConfigDeps {
  /** Override the writer for tests. Default: writeVoiceConfig from voice-config.ts. */
  write?: (partial: Partial<VoiceConfig>) => VoiceConfig;
}

export function makeVoiceSetOperatorConfig(
  deps: VoiceSetOperatorConfigDeps = {},
): ToolHandler {
  const write = deps.write ?? writeVoiceConfig;

  return async function voiceSetOperatorConfig(
    args: unknown,
  ): Promise<VoiceSetOperatorConfigResult> {
    const parsed = VoiceSetOperatorConfigSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }

    if (
      parsed.data.operator_name === undefined &&
      parsed.data.operator_cli_number === undefined
    ) {
      throw new BadRequestError(
        'input',
        'at least one of operator_name / operator_cli_number must be set',
      );
    }

    const partial: Partial<VoiceConfig> = {};
    if (parsed.data.operator_name !== undefined) {
      partial.operator_name = parsed.data.operator_name.trim();
    }
    if (parsed.data.operator_cli_number !== undefined) {
      partial.operator_cli_number = parsed.data.operator_cli_number.trim();
    }

    let next: VoiceConfig;
    try {
      next = write(partial);
    } catch (err) {
      logger.warn({
        event: 'voice_set_operator_config_write_failed',
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'write_failed' };
    }

    logger.info({
      event: 'voice_set_operator_config_ok',
      // Log which keys changed (not the values — operator_cli_number is PII).
      changed: Object.keys(partial),
    });

    return { ok: true, result: { config: next } };
  };
}
