/**
 * MCP tool: voice_set_prepaid_balance
 *
 * Andy-facing chat tool. User says "ich hab gerade 100 EUR aufgeladen",
 * Andy calls this tool to record the new balance + topup timestamp.
 *
 * Why this exists: OpenAI's API does NOT expose remaining prepaid balance
 * (only cumulative spent via /v1/organization/costs). Operator declares
 * the balance manually; system computes remaining = balance − spent-since-
 * topup using the cost endpoint with start_time = topup_at_unix.
 *
 * State: ~/.config/nanoclaw/voice-balance.json (single writer = this tool).
 *
 * voice_get_budget_status reads this file and returns
 * prepaid_remaining_eur as part of its response. Bridge post-call summary
 * (Phase 2) will use the same data for the per-call breakdown.
 */
import { z } from 'zod';

import { logger } from '../logger.js';
import { writeVoiceBalance } from '../voice-balance.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_set_prepaid_balance' as const;

export const VoiceSetPrepaidBalanceSchema = z.object({
  amount_eur: z
    .number()
    .nonnegative()
    .describe('Prepaid balance amount the user just topped up to, in EUR.'),
  currency: z
    .enum(['EUR', 'USD'])
    .optional()
    .describe('Currency of the amount. Defaults to EUR.'),
});

export type VoiceSetPrepaidBalanceInput = z.infer<
  typeof VoiceSetPrepaidBalanceSchema
>;

export interface VoiceSetPrepaidBalanceResult {
  ok: true;
  result: {
    balance_eur: number;
    currency: 'EUR' | 'USD';
    topup_at_iso: string;
    summary_text: string;
  };
}

export interface VoiceSetPrepaidBalanceDeps {
  now?: () => Date;
  /** DI for tests; defaults to writeVoiceBalance(). */
  write?: typeof writeVoiceBalance;
}

export function makeVoiceSetPrepaidBalance(
  deps: VoiceSetPrepaidBalanceDeps = {},
): ToolHandler {
  const nowFn = deps.now ?? (() => new Date());
  const writeFn = deps.write ?? writeVoiceBalance;

  return async function voiceSetPrepaidBalance(
    args: unknown,
  ): Promise<VoiceSetPrepaidBalanceResult> {
    const parsed = VoiceSetPrepaidBalanceSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }

    const now = nowFn();
    const topup_at_unix = Math.floor(now.getTime() / 1000);
    const currency = parsed.data.currency ?? 'EUR';

    writeFn({
      balance_eur: parsed.data.amount_eur,
      currency,
      topup_at_unix,
    });

    logger.info({
      event: 'voice_set_prepaid_balance_ok',
      balance_eur: parsed.data.amount_eur,
      currency,
      topup_at_iso: now.toISOString(),
    });

    const summary_text = `Prepaid-balance gespeichert: ${parsed.data.amount_eur.toFixed(2)} ${currency} (Topup: ${now.toISOString()}). Restguthaben wird ab jetzt aus diesem Wert minus den OpenAI-Costs seit Topup berechnet.`;

    return {
      ok: true,
      result: {
        balance_eur: parsed.data.amount_eur,
        currency,
        topup_at_iso: now.toISOString(),
        summary_text,
      },
    };
  };
}
