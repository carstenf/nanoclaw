/**
 * MCP tool: voice_set_prepaid_balance
 *
 * Andy-facing chat tool. User says "ich hab gerade 7.35 USD auf OpenAI
 * stehen" (or "100 EUR aufgeladen", etc.), Andy calls this tool to record
 * the new balance + topup timestamp.
 *
 * Why this exists: OpenAI's API does NOT expose remaining prepaid balance
 * (only cumulative spent via /v1/organization/costs). Operator declares
 * the balance manually; system computes remaining = balance − spent-since-
 * topup using the cost endpoint with start_time = topup_at_unix.
 *
 * State: ~/.config/nanoclaw/voice-balance.json (single writer = this tool).
 *
 * Currency: OpenAI's dashboard is USD-native, so USD is the common case —
 * pass currency='USD' when the user says dollars. EUR also accepted; the
 * computation handles both via USD_TO_EUR conversion when comparing
 * against the EUR-denominated cost API response.
 */
import { z } from 'zod';

import { logger } from '../logger.js';
import { writeVoiceBalance } from '../voice-balance.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_set_prepaid_balance' as const;

export const VoiceSetPrepaidBalanceSchema = z.object({
  amount: z
    .number()
    .nonnegative()
    .describe(
      'Prepaid balance amount as the user stated it (raw number, e.g. 100 for "100 EUR" or 7.35 for "7.35 USD"). Currency goes in the separate field.',
    ),
  currency: z
    .enum(['EUR', 'USD'])
    .describe(
      'Currency of the amount. Use "USD" when the user said dollars (OpenAI dashboard is USD-native). Use "EUR" when the user said euros.',
    ),
});

export type VoiceSetPrepaidBalanceInput = z.infer<
  typeof VoiceSetPrepaidBalanceSchema
>;

export interface VoiceSetPrepaidBalanceResult {
  ok: true;
  result: {
    balance_amount: number;
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
    const { amount, currency } = parsed.data;

    writeFn({
      balance_amount: amount,
      currency,
      topup_at_unix,
    });

    logger.info({
      event: 'voice_set_prepaid_balance_ok',
      balance_amount: amount,
      currency,
      topup_at_iso: now.toISOString(),
    });

    const summary_text = `Prepaid-balance gespeichert: ${amount.toFixed(2)} ${currency} (Topup: ${now.toISOString()}). Restguthaben wird ab jetzt aus diesem Wert minus den OpenAI-Costs seit Topup berechnet.`;

    return {
      ok: true,
      result: {
        balance_amount: amount,
        currency,
        topup_at_iso: now.toISOString(),
        summary_text,
      },
    };
  };
}
