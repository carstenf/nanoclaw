// src/voice-balance.ts
//
// 2026-05-08 — operator-managed prepaid-balance state for the OpenAI account.
//
// OpenAI's public API does NOT expose remaining prepaid credit balance
// (verified 2026-05-08: 17 plausible endpoint URLs probed, all 404 except
// /v1/dashboard/billing/credit_grants which rejects API keys with 403 and
// requires a browser session cookie). What the API DOES expose is cumulative
// cost via /v1/organization/costs.
//
// Workaround: operator declares the prepaid balance manually after each
// top-up via the `voice_set_prepaid_balance` MCP tool ("Andy, ich hab
// gerade 100 EUR aufgeladen"). We snapshot the topup timestamp and compute
//
//   remaining_eur = balance_eur − SUM(/costs?start_time=topup_at_unix) × USD_TO_EUR
//
// The /costs endpoint accepts arbitrary start_time so we get total spent
// since topup directly without month-boundary math.
//
// Storage matches voice-config.ts conventions (~/.config/nanoclaw/, atomic
// tmp-file + rename, env override via VOICE_BALANCE_PATH). Single writer:
// voice-set-prepaid-balance MCP tool.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

export interface VoiceBalance {
  /** Prepaid balance amount in the declared currency (raw value as the
   *  operator stated it — OpenAI dashboard is USD-native, so USD is the
   *  common case). */
  balance_amount: number;
  /** Currency the operator declared. */
  currency: 'EUR' | 'USD';
  /** Unix timestamp (seconds) of the top-up declaration. */
  topup_at_unix: number;
}

export const DEFAULT_VOICE_BALANCE_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
  'voice-balance.json',
);

function resolvePath(override?: string): string {
  return override ?? process.env.VOICE_BALANCE_PATH ?? DEFAULT_VOICE_BALANCE_PATH;
}

export function readVoiceBalance(override?: string): VoiceBalance | null {
  const p = resolvePath(override);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    // 2026-05-08: schema migrated balance_eur → balance_amount + currency.
    // Read both forms for backward-compat with files written before the
    // migration; new writes always use balance_amount.
    const amount =
      typeof parsed?.balance_amount === 'number'
        ? parsed.balance_amount
        : typeof parsed?.balance_eur === 'number'
          ? parsed.balance_eur
          : null;
    if (amount !== null && typeof parsed.topup_at_unix === 'number') {
      return {
        balance_amount: amount,
        currency: parsed.currency === 'USD' ? 'USD' : 'EUR',
        topup_at_unix: parsed.topup_at_unix,
      };
    }
    logger.warn({
      event: 'voice_balance_read_invalid',
      path: p,
    });
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({
        event: 'voice_balance_read_failed',
        path: p,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

export function writeVoiceBalance(
  balance: VoiceBalance,
  override?: string,
): void {
  const p = resolvePath(override);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(balance, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(tmp, p);
  logger.info({
    event: 'voice_balance_written',
    path: p,
    balance_amount: balance.balance_amount,
    currency: balance.currency,
    topup_at_unix: balance.topup_at_unix,
  });
}
