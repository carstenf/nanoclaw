/**
 * MCP tool: voice_get_budget_status
 *
 * Andy-facing chat tool. Lets the user ask "wieviel guthaben hab ich noch?"
 * via WhatsApp / Discord / etc. and get a current OpenAI org month-to-date
 * spend + budget rest answer.
 *
 * Reuses the same data sources as voice_finalize_call_cost:
 *   - voice-config.json → monthly_budget_eur (operator-set ceiling)
 *   - openai-cost-client → /v1/organization/costs (5min cache)
 *   - voice_turn_costs ledger → daily + monthly sums (NanoClaw side)
 *
 * Returns structured fields so Andy can format short ("Noch €38.37 von €50")
 * or long (full breakdown). Includes a `summary_text` matching the
 * post-call-summary format for one-line copy.
 */
import { z } from 'zod';

import { logger } from '../logger.js';
import { getDatabase } from '../db.js';
import { readVoiceConfig } from '../voice-config.js';
import { getMonthToDateUsd, getCostsSinceUnix } from '../openai-cost-client.js';
import { readVoiceBalance } from '../voice-balance.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_get_budget_status' as const;

// Same constant as voice-finalize-call-cost.ts and recon-invoice.ts. Kept
// in-sync manually because tests pin to specific values; no runtime FX feed.
const USD_TO_EUR = 0.93;

export const VoiceGetBudgetStatusSchema = z.object({});

export type VoiceGetBudgetStatusInput = z.infer<
  typeof VoiceGetBudgetStatusSchema
>;

export interface VoiceGetBudgetStatusResult {
  ok: true;
  result: {
    /** Monthly cap from voice-config.json. undefined = no budget configured. */
    budget_eur: number | undefined;
    /** OpenAI org month-to-date in USD (raw from admin API). */
    openai_month_usd: number | undefined;
    /** Same value converted via USD_TO_EUR. */
    openai_month_eur: number | undefined;
    /** budget_eur - openai_month_eur. Negative when over-budget. */
    rest_eur: number | undefined;
    /** voice_turn_costs ledger sum for current UTC day. */
    day_eur: number;
    /** voice_turn_costs ledger sum for current UTC month. */
    month_eur: number;
    /**
     * Operator-declared prepaid balance from voice-balance.json (set via
     * voice_set_prepaid_balance). undefined = no balance ever declared.
     * Currency is the one the operator stated (USD / EUR).
     */
    prepaid_balance: number | undefined;
    /** Currency of the declared balance. */
    prepaid_currency: 'EUR' | 'USD' | undefined;
    /** ISO timestamp of the topup declaration. */
    topup_at_iso: string | undefined;
    /** Cost since topup_at_unix in prepaid_currency (USD raw, or EUR-converted). */
    spent_since_topup: number | undefined;
    /** prepaid_balance - spent_since_topup. The "noch verfügbares Guthaben". */
    prepaid_remaining: number | undefined;
    /**
     * Multi-line German summary mirroring the post-call format. Useful
     * when the user asks for the full picture; Andy can also ignore this
     * and format from the structured fields above.
     */
    summary_text: string;
    /** True when OpenAI fetch failed (rest_eur will be undefined then). */
    openai_fetch_failed: boolean;
  };
}

export interface VoiceGetBudgetStatusDeps {
  db?: import('better-sqlite3').Database;
  readConfig?: typeof readVoiceConfig;
  fetchOpenaiMonthUsd?: typeof getMonthToDateUsd;
  fetchOpenaiCostsSince?: typeof getCostsSinceUnix;
  readBalance?: typeof readVoiceBalance;
  now?: () => Date;
}

interface LedgerSums {
  day_eur: number;
  month_eur: number;
}

function readLedgerSums(
  db: import('better-sqlite3').Database,
  now: Date,
): LedgerSums {
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
  return { day_eur: dayRow.s, month_eur: monthRow.s };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export function makeVoiceGetBudgetStatus(
  deps: VoiceGetBudgetStatusDeps = {},
): ToolHandler {
  const nowFn = deps.now ?? (() => new Date());
  const readConfigFn = deps.readConfig ?? readVoiceConfig;
  const fetchOpenaiFn = deps.fetchOpenaiMonthUsd ?? getMonthToDateUsd;
  const fetchSinceFn = deps.fetchOpenaiCostsSince ?? getCostsSinceUnix;
  const readBalanceFn = deps.readBalance ?? readVoiceBalance;

  return async function voiceGetBudgetStatus(
    args: unknown,
  ): Promise<VoiceGetBudgetStatusResult> {
    const parsed = VoiceGetBudgetStatusSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }

    const now = nowFn();
    const db = deps.db ?? getDatabase();
    const sums = readLedgerSums(db, now);

    let budget_eur: number | undefined;
    try {
      const cfg = readConfigFn();
      if (typeof cfg.monthly_budget_eur === 'number' && cfg.monthly_budget_eur > 0) {
        budget_eur = cfg.monthly_budget_eur;
      }
    } catch (err) {
      logger.warn({
        event: 'voice_get_budget_status_config_read_failed',
        err: err instanceof Error ? err.message : String(err),
      });
    }

    let openai_month_usd: number | undefined;
    let openai_month_eur: number | undefined;
    let openai_fetch_failed = false;
    try {
      const mtd = await fetchOpenaiFn();
      openai_month_usd = mtd.usd;
      openai_month_eur = mtd.usd * USD_TO_EUR;
    } catch (err) {
      openai_fetch_failed = true;
      logger.warn({
        event: 'voice_get_budget_status_openai_fetch_failed',
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const rest_eur =
      typeof budget_eur === 'number' && typeof openai_month_eur === 'number'
        ? budget_eur - openai_month_eur
        : undefined;

    // Prepaid balance state (operator-declared via voice_set_prepaid_balance).
    // Computation runs in the operator's declared currency: if they said
    // "7.35 USD" we report remaining in USD (OpenAI dashboard is USD-
    // native, so USD is the common case); EUR is also supported and
    // converts the cost-API USD response via USD_TO_EUR.
    let prepaid_balance: number | undefined;
    let prepaid_currency: 'EUR' | 'USD' | undefined;
    let topup_at_iso: string | undefined;
    let spent_since_topup: number | undefined;
    let prepaid_remaining: number | undefined;
    try {
      const bal = readBalanceFn();
      if (bal) {
        prepaid_balance = bal.balance_amount;
        prepaid_currency = bal.currency;
        topup_at_iso = new Date(bal.topup_at_unix * 1000).toISOString();
        try {
          const since = await fetchSinceFn(bal.topup_at_unix);
          // OpenAI cost API returns USD. Convert if the operator declared EUR.
          spent_since_topup =
            bal.currency === 'USD' ? since.usd : since.usd * USD_TO_EUR;
          prepaid_remaining = bal.balance_amount - spent_since_topup;
        } catch (err) {
          openai_fetch_failed = true;
          logger.warn({
            event: 'voice_get_budget_status_since_fetch_failed',
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn({
        event: 'voice_get_budget_status_balance_read_failed',
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Build summary_text — prepaid line is the headline (what the user
    // actually asks about). Budget line is secondary.
    const lines: string[] = [];
    lines.push(`Voice-Guthaben-Status`);
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
        `• OpenAI Restguthaben: nicht trackbar — bitte melde mir den letzten Topup über voice_set_prepaid_balance`,
      );
    }
    lines.push(
      `• Heute: ${fmt(sums.day_eur)} EUR | Diesen Monat: ${fmt(sums.month_eur)} EUR (NanoClaw-ledger)`,
    );
    if (typeof openai_month_usd === 'number' && typeof openai_month_eur === 'number') {
      lines.push(
        `• OpenAI org month-to-date: ${fmt(openai_month_eur)} EUR (${openai_month_usd.toFixed(2)} USD)`,
      );
      if (typeof budget_eur === 'number' && typeof rest_eur === 'number') {
        const tag = rest_eur < 0 ? '⚠️ BUDGET ÜBERSCHRITTEN' : 'Rest';
        lines.push(
          `• Monatsbudget: ${fmt(budget_eur)} EUR — ${tag}: ${fmt(rest_eur)} EUR`,
        );
      }
    } else {
      lines.push(`• OpenAI org-cost: nicht abrufbar (admin-key fehlt oder fehler)`);
    }
    const summary_text = lines.join('\n');

    return {
      ok: true,
      result: {
        budget_eur,
        openai_month_usd,
        openai_month_eur,
        rest_eur,
        day_eur: sums.day_eur,
        month_eur: sums.month_eur,
        prepaid_balance,
        prepaid_currency,
        topup_at_iso,
        spent_since_topup,
        prepaid_remaining,
        summary_text,
        openai_fetch_failed,
      },
    };
  };
}
