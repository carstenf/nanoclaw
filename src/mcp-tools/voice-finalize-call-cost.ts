/**
 * MCP tool: voice_finalize_call_cost
 *
 * Two responsibilities, both fired from the bridge's session.closed hook
 * (sideband.ts):
 *
 *   1. Deregister the call_id from voice-mid-call-gateway. Without this,
 *      calls stay registered as active and the post-call transcript
 *      chunks (voice_send_discord_message) get rejected by the REQ-DIR-17
 *      mid-call mutation gate, killing transcript delivery. THIS IS THE
 *      LOAD-BEARING BEHAVIOR — it must succeed even when the cost summary
 *      below fails.
 *
 *   2. Post a per-call cost summary to Carsten's voice-channel Discord:
 *      - this call's cost (SUM(voice_turn_costs WHERE call_id=?))
 *      - daily + monthly cumulative from the local ledger
 *      - month-to-date USD from OpenAI /v1/organization/costs (admin API),
 *        converted to EUR via the same constant the recon-invoice uses
 *      - rest = monthly_budget_eur - month_eur (when budget configured)
 *
 *      Failures here are logged + swallowed. The deregister still wins.
 *
 * 2026-05-07: rewritten from the deprecation-stub (cost-tracking was
 * deprecated 2026-05-05) after Carsten asked for per-call cost visibility.
 */
import { z } from 'zod';

import { deregisterActiveCall } from '../voice-mid-call-gateway.js';
import { logger } from '../logger.js';
import { getDatabase } from '../db.js';
import { readVoiceConfig } from '../voice-config.js';
import { getMonthToDateUsd } from '../openai-cost-client.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const VoiceFinalizeCallCostSchema = z.object({
  call_id: z.string().min(1).max(128),
  case_type: z.string().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  terminated_by: z.string().optional(),
  soft_warn_fired: z.number().optional(),
});

export type VoiceFinalizeCallCostInput = z.infer<
  typeof VoiceFinalizeCallCostSchema
>;

// Same conversion the recon-invoice cron uses (recon-invoice.ts:65).
const USD_TO_EUR = 0.93;

export interface VoiceFinalizeCallCostDeps {
  /** DI for tests; defaults to getDatabase(). */
  db?: import('better-sqlite3').Database;
  /** DI for tests; defaults to readVoiceConfig(). */
  readConfig?: typeof readVoiceConfig;
  /** DI for tests; defaults to getMonthToDateUsd(). */
  fetchOpenaiMonthUsd?: typeof getMonthToDateUsd;
  /** DI clock for tests; defaults to () => new Date(). */
  now?: () => Date;
  /**
   * Discord-send callback. When provided, the summary message is posted
   * to {channelId} after the deregister. Without this dep the deregister
   * still runs — Discord posting is best-effort. Signature matches the
   * channel-callback shape used elsewhere in NanoClaw (positional args,
   * not object) so register-tools can pass deps.sendDiscordMessage as-is.
   */
  sendDiscordMessage?: (channelId: string, text: string) => Promise<unknown>;
  /** Channel ID for the summary post. */
  discordChannelId?: string;
}

interface CallCostBreakdown {
  call_eur: number;
  day_eur: number;
  month_eur: number;
  turn_count: number;
}

export function readCallCostBreakdown(
  db: import('better-sqlite3').Database,
  call_id: string,
  now: Date,
): CallCostBreakdown {
  // Per-call: SUM + count of turns.
  const callRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_eur), 0) AS s, COUNT(*) AS c
       FROM voice_turn_costs WHERE call_id = ?`,
    )
    .get(call_id) as { s: number; c: number };

  // Day + month: same window the existing sumCostCurrent* helpers use,
  // computed from voice_turn_costs (the source of truth). voice_call_costs
  // has been empty since the 2026-05-05 deprecation; using turn_costs avoids
  // the upsertCallCost dependency.
  //
  // Window-bounds are computed in JS so the test clock can override `now`
  // without us having to monkey-patch SQLite's date('now').
  const dayStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  ).toISOString();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  ).toISOString();

  const dayRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_eur), 0) AS s
       FROM voice_turn_costs WHERE ts >= ?`,
    )
    .get(dayStart) as { s: number };
  const monthRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_eur), 0) AS s
       FROM voice_turn_costs WHERE ts >= ?`,
    )
    .get(monthStart) as { s: number };

  return {
    call_eur: callRow.s,
    day_eur: dayRow.s,
    month_eur: monthRow.s,
    turn_count: callRow.c,
  };
}

function formatEur(n: number): string {
  return n.toFixed(2);
}

export interface SummaryArgs {
  call_id: string;
  breakdown: CallCostBreakdown;
  budget_eur?: number;
  openai_month_usd?: number;
  openai_fetch_failed?: boolean;
}

/**
 * Compose the Discord summary text. Pure — exposed for unit tests.
 */
export function formatCallSummary(args: SummaryArgs): string {
  const { call_id, breakdown, budget_eur, openai_month_usd } = args;
  const lines: string[] = [];
  lines.push(`Call beendet — \`${call_id}\``);
  lines.push(
    `• Diese call: ${formatEur(breakdown.call_eur)} EUR (${breakdown.turn_count} turns)`,
  );
  lines.push(
    `• Heute: ${formatEur(breakdown.day_eur)} EUR | Diesen Monat: ${formatEur(breakdown.month_eur)} EUR (NanoClaw-ledger)`,
  );
  if (typeof openai_month_usd === 'number') {
    const openai_eur = openai_month_usd * USD_TO_EUR;
    lines.push(
      `• OpenAI org month-to-date: ${formatEur(openai_eur)} EUR (${openai_month_usd.toFixed(2)} USD)`,
    );
    if (typeof budget_eur === 'number' && budget_eur > 0) {
      const rest_eur = budget_eur - openai_eur;
      const tag = rest_eur < 0 ? '⚠️ BUDGET ÜBERSCHRITTEN' : 'Rest';
      lines.push(
        `• Budget: ${formatEur(budget_eur)} EUR/Mo — ${tag}: ${formatEur(rest_eur)} EUR`,
      );
    }
  } else if (args.openai_fetch_failed) {
    lines.push(`• OpenAI org-cost: nicht abrufbar (admin-key fehlt oder fehler)`);
  }
  return lines.join('\n');
}

export function makeVoiceFinalizeCallCost(
  deps: VoiceFinalizeCallCostDeps = {},
): ToolHandler {
  const nowFn = deps.now ?? (() => new Date());
  const readConfigFn = deps.readConfig ?? readVoiceConfig;
  const fetchOpenaiFn = deps.fetchOpenaiMonthUsd ?? getMonthToDateUsd;

  return async function voiceFinalizeCallCost(
    args: unknown,
  ): Promise<unknown> {
    const parsed = VoiceFinalizeCallCostSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }
    const { call_id, terminated_by } = parsed.data;

    // STEP 1 — load-bearing deregister. Must run before anything that can
    // throw, so a downstream Discord/SQLite glitch never blocks transcript
    // delivery (the post-call transcript chunk is gated by REQ-DIR-17).
    deregisterActiveCall(call_id);
    logger.info({
      event: 'voice_finalize_call_cost_handled',
      call_id,
      terminated_by: terminated_by ?? null,
    });

    // STEP 2 — best-effort cost summary. Wrapped in try so the tool always
    // returns ok:true; the deregister is what the bridge needs.
    if (deps.sendDiscordMessage && deps.discordChannelId) {
      try {
        const now = nowFn();
        const db = deps.db ?? getDatabase();
        const breakdown = readCallCostBreakdown(db, call_id, now);

        let openai_month_usd: number | undefined;
        let openai_fetch_failed = false;
        try {
          const oc = await fetchOpenaiFn({ now: () => now });
          openai_month_usd = oc.usd;
        } catch (err) {
          openai_fetch_failed = true;
          logger.warn({
            event: 'voice_finalize_openai_costs_failed',
            call_id,
            err: (err as Error).message,
          });
        }

        const cfg = readConfigFn();
        const text = formatCallSummary({
          call_id,
          breakdown,
          budget_eur:
            typeof cfg.monthly_budget_eur === 'number'
              ? cfg.monthly_budget_eur
              : undefined,
          openai_month_usd,
          openai_fetch_failed,
        });

        await deps.sendDiscordMessage(deps.discordChannelId, text);
        logger.info({
          event: 'voice_finalize_summary_posted',
          call_id,
          channel: deps.discordChannelId,
        });
      } catch (err) {
        logger.warn({
          event: 'voice_finalize_summary_failed',
          call_id,
          err: (err as Error).message,
        });
      }
    }

    return { ok: true, result: { call_id, deregistered: true } };
  };
}
