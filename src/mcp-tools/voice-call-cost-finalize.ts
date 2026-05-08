/**
 * MCP tool: voice_call_cost_finalize
 *
 * Bridge calls this ~8s after teardown (lag-wait so OpenAI's billing
 * pipeline has the call's tokens cumulatively reflected). NanoClaw:
 *   1. Looks up the per-call snapshot (set by voice_call_cost_snapshot
 *      at /accept).
 *   2. Takes a second cost-snapshot now.
 *   3. delta_usd = now − baseline = actual billed cost of this call.
 *   4. Reads voice-balance.json + voice-config.json.
 *   5. Formats a multi-line German summary including:
 *        - this call's actual cost (provider-billed, not estimated)
 *        - prepaid balance + remaining (the "Restguthaben")
 *        - month-to-date OpenAI total (org-wide)
 *        - monthly budget rest (if configured)
 *   6. Posts to the standard voice-channel (env-configurable, defaults to
 *      first VOICE_DISCORD_ALLOWED_CHANNELS entry — NOT the transcript
 *      channel).
 *   7. Clears the snapshot.
 *
 * On any failure: log + return ok:false. Bridge call is fire-and-forget
 * so a missed summary post is non-fatal.
 */
import { z } from 'zod';

import { logger } from '../logger.js';
import { getCostProvider } from '../cost-providers.js';
import {
  clearSnapshot,
  getSnapshot,
} from '../voice-call-cost-snapshots.js';
import { readVoiceBalance } from '../voice-balance.js';
import { readVoiceConfig } from '../voice-config.js';
import { getCostsSinceUnix, getMonthToDateUsd } from '../openai-cost-client.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_call_cost_finalize' as const;

const USD_TO_EUR = 0.93;

export const VoiceCallCostFinalizeSchema = z.object({
  call_id: z.string().min(1).max(128),
  duration_ms: z.number().int().nonnegative().optional(),
  case_type: z.string().max(32).optional(),
});

export type VoiceCallCostFinalizeInput = z.infer<
  typeof VoiceCallCostFinalizeSchema
>;

export interface VoiceCallCostFinalizeResult {
  ok: true;
  result: {
    call_id: string;
    delta_usd: number;
    delta_eur: number;
    posted: boolean;
    summary_text: string;
  };
}

export interface VoiceCallCostFinalizeDeps {
  /** Discord-send callback. When undefined, summary is computed but not posted. */
  sendDiscordMessage?: (channelId: string, text: string) => Promise<unknown>;
  /** Channel ID for the cost-summary post. Default: first VOICE_DISCORD_ALLOWED_CHANNELS entry (resolved at registration time). */
  discordChannelId?: string;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function fmt4(n: number): string {
  return n.toFixed(4);
}

export function makeVoiceCallCostFinalize(
  deps: VoiceCallCostFinalizeDeps = {},
): ToolHandler {
  return async function voiceCallCostFinalize(
    args: unknown,
  ): Promise<VoiceCallCostFinalizeResult | { ok: false; error: string }> {
    const parsed = VoiceCallCostFinalizeSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }
    const { call_id, duration_ms, case_type } = parsed.data;

    const snap = getSnapshot(call_id);
    if (!snap) {
      logger.warn({
        event: 'voice_call_cost_finalize_no_snapshot',
        call_id,
      });
      return { ok: false, error: 'no_snapshot' };
    }

    let now_usd: number;
    try {
      now_usd = await getCostProvider(snap.provider).snapshotMtdUsd();
    } catch (err) {
      logger.warn({
        event: 'voice_call_cost_finalize_snapshot_failed',
        call_id,
        err: err instanceof Error ? err.message : String(err),
      });
      clearSnapshot(call_id);
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'snapshot_failed',
      };
    }

    const delta_usd = Math.max(0, now_usd - snap.baseline_usd);
    const delta_eur = delta_usd * USD_TO_EUR;

    // Read prepaid balance + monthly budget for the full summary. Currency
    // follows the operator's declaration (USD-native for OpenAI dashboard,
    // or EUR if they stated it that way).
    let prepaid_balance: number | undefined;
    let prepaid_currency: 'EUR' | 'USD' | undefined;
    let prepaid_remaining: number | undefined;
    let topup_at_iso: string | undefined;
    try {
      const bal = readVoiceBalance();
      if (bal) {
        prepaid_balance = bal.balance_amount;
        prepaid_currency = bal.currency;
        topup_at_iso = new Date(bal.topup_at_unix * 1000).toISOString();
        try {
          const since = await getCostsSinceUnix(bal.topup_at_unix);
          const since_in_balance_ccy =
            bal.currency === 'USD' ? since.usd : since.usd * USD_TO_EUR;
          prepaid_remaining = bal.balance_amount - since_in_balance_ccy;
        } catch (err) {
          logger.warn({
            event: 'voice_call_cost_finalize_balance_fetch_failed',
            call_id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn({
        event: 'voice_call_cost_finalize_balance_read_failed',
        call_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    let monthly_budget_eur: number | undefined;
    try {
      const cfg = readVoiceConfig();
      if (typeof cfg.monthly_budget_eur === 'number' && cfg.monthly_budget_eur > 0) {
        monthly_budget_eur = cfg.monthly_budget_eur;
      }
    } catch {
      /* ignore */
    }

    // Build summary lines.
    const lines: string[] = [];
    lines.push(`Call beendet — \`${call_id}\``);
    const sec = duration_ms ? Math.round(duration_ms / 1000) : null;
    const meta: string[] = [];
    if (case_type) meta.push(case_type);
    if (sec !== null) meta.push(`${sec}s`);
    const metaStr = meta.length ? ` (${meta.join(', ')})` : '';
    lines.push(`• Diese call: €${fmt4(delta_eur)} ($${fmt4(delta_usd)})${metaStr}`);
    if (
      typeof prepaid_remaining === 'number' &&
      typeof prepaid_balance === 'number' &&
      typeof prepaid_currency === 'string'
    ) {
      lines.push(
        `• OpenAI Restguthaben: ${fmt(prepaid_remaining)} ${prepaid_currency} von ${fmt(prepaid_balance)} ${prepaid_currency} (Topup: ${topup_at_iso?.slice(0, 10) ?? '?'})`,
      );
    } else if (typeof prepaid_balance === 'undefined') {
      lines.push(
        `• OpenAI Restguthaben: nicht trackbar — sag mir wann du das nächste Mal aufgeladen hast`,
      );
    }
    if (typeof monthly_budget_eur === 'number') {
      try {
        const mtd = await getMonthToDateUsd();
        const mtd_eur = mtd.usd * USD_TO_EUR;
        const rest = monthly_budget_eur - mtd_eur;
        const tag = rest < 0 ? '⚠️ ÜBERSCHRITTEN' : 'Rest';
        lines.push(
          `• Monatsbudget: ${fmt(monthly_budget_eur)} EUR — ${tag}: ${fmt(rest)} EUR`,
        );
      } catch {
        /* skip budget line */
      }
    }
    const summary_text = lines.join('\n');

    let posted = false;
    if (deps.sendDiscordMessage && deps.discordChannelId) {
      try {
        await deps.sendDiscordMessage(deps.discordChannelId, summary_text);
        posted = true;
      } catch (err) {
        logger.warn({
          event: 'voice_call_cost_finalize_discord_post_failed',
          call_id,
          channel: deps.discordChannelId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      logger.warn({
        event: 'voice_call_cost_finalize_no_discord_wiring',
        call_id,
        has_send: !!deps.sendDiscordMessage,
        has_channel: !!deps.discordChannelId,
      });
    }

    clearSnapshot(call_id);

    logger.info({
      event: 'voice_call_cost_finalize_ok',
      call_id,
      delta_usd,
      delta_eur,
      posted,
      duration_ms,
    });

    return {
      ok: true,
      result: {
        call_id,
        delta_usd,
        delta_eur,
        posted,
        summary_text,
      },
    };
  };
}
