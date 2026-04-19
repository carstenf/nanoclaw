// src/recon-invoice.ts
// Phase 4 Plan 04-04 (REQ-COST-05): monthly invoice reconciliation.
//
// Compares SUM(cost_eur) from voice_call_costs for the previous calendar
// month against the OpenAI invoice CSV exported manually to
// ~/nanoclaw-state/openai-invoices/YYYY-MM.csv (format: `month,usage_usd`
// with a single data row). Pitfall 7: OpenAI's billing API is not
// programmatically exposed for fine-grained line items today — so the
// source of truth is the manual CSV export (Carsten pastes the dashboard
// total). If the CSV is missing, we alert + write an open_points.md entry
// instead of crashing.
//
// Drift >5% → Discord alert + state-repo open_points.md write. On missing
// CSV: treated as drift=0% but alerted=true with a "please export" message.
//
// Scheduled in-process (CLAUDE.md single-process constraint) monthly on
// the 2nd @ 04:00.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type Database from 'better-sqlite3';

import { logger } from './logger.js';

export interface ReconInvoiceDeps {
  db: Database.Database;
  /** CSV directory. Default ~/nanoclaw-state/openai-invoices. */
  invoiceCsvDir?: string;
  sendDiscordAlert: (msg: string) => Promise<void>;
  writeStateRepoOpenPoint: (content: string) => void;
  /** USD→EUR conversion. Default 0.93 (matches Plan 04-01 USD_TO_EUR default). */
  usdToEur?: number;
  /** Drift threshold as fraction. Default 0.05 (5%). */
  driftThreshold?: number;
  /** Clock for "previous month" calculation. Default Date.now. */
  now?: () => number;
}

export interface ReconInvoiceResult {
  ledger_eur: number;
  invoice_eur: number;
  drift: number;
  alerted: boolean;
}

function defaultCsvDir(): string {
  return path.join(os.homedir(), 'nanoclaw-state', 'openai-invoices');
}

/** Build YYYY-MM key for "previous month" anchored on `nowMs`. */
function previousMonthKey(nowMs: number): string {
  const d = new Date(nowMs);
  d.setUTCDate(1); // avoid Feb-29/Mar-3 roll issues
  d.setUTCMonth(d.getUTCMonth() - 1);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export async function runReconInvoice(
  deps: ReconInvoiceDeps,
): Promise<ReconInvoiceResult> {
  const now = deps.now ?? Date.now;
  const usdToEur = deps.usdToEur ?? 0.93;
  const threshold = deps.driftThreshold ?? 0.05;
  const csvDir = deps.invoiceCsvDir ?? defaultCsvDir();

  const monthKey = previousMonthKey(now());

  // -------- Ledger: SUM(cost_eur) for the target month --------
  const ledgerRow = deps.db
    .prepare(
      `SELECT COALESCE(SUM(cost_eur), 0) AS s FROM voice_call_costs
       WHERE strftime('%Y-%m', started_at) = ?`,
    )
    .get(monthKey) as { s: number };
  const ledger_eur = Number(ledgerRow.s);

  // -------- Invoice CSV --------
  const csvPath = path.join(csvDir, `${monthKey}.csv`);
  if (!fs.existsSync(csvPath)) {
    const msg = `Recon-invoice: no invoice CSV for ${monthKey} at ${csvPath}. Export from OpenAI dashboard (https://platform.openai.com/account/billing/history) and commit to state-repo.`;
    await deps.sendDiscordAlert(msg);
    try {
      deps.writeStateRepoOpenPoint(
        `## Recon-invoice: missing CSV for ${monthKey}\n\n${msg}\n`,
      );
    } catch (err: unknown) {
      logger.warn({
        event: 'recon_invoice_open_point_write_failed',
        err: (err as Error).message,
      });
    }
    logger.info({
      event: 'recon_invoice_missing_csv',
      month: monthKey,
      csv_path: csvPath,
      ledger_eur,
    });
    return { ledger_eur, invoice_eur: 0, drift: 0, alerted: true };
  }

  // Simple CSV: header row + one data row "YYYY-MM,USD".
  let invoice_eur = 0;
  try {
    const raw = fs.readFileSync(csvPath, 'utf8').trim();
    const lines = raw.split('\n');
    const dataLine = lines[lines.length - 1].split(',');
    // Second column is USD; first column is month. Fall back to first
    // column if only one numeric value is present.
    const usdRaw = dataLine.length >= 2 ? dataLine[1] : dataLine[0];
    const usd = Number(String(usdRaw).trim());
    if (!Number.isFinite(usd) || usd < 0) {
      throw new Error(`malformed usage_usd value: ${usdRaw}`);
    }
    invoice_eur = usd * usdToEur;
  } catch (err: unknown) {
    const emsg = (err as Error).message;
    const msg = `Recon-invoice: parse-error on ${csvPath}: ${emsg}. Carsten: verify CSV is <month,usage_usd> with a single data row.`;
    await deps.sendDiscordAlert(msg);
    try {
      deps.writeStateRepoOpenPoint(
        `## Recon-invoice: CSV parse fail ${monthKey}\n\n${msg}\n`,
      );
    } catch {
      /* best-effort */
    }
    return { ledger_eur, invoice_eur: 0, drift: 0, alerted: true };
  }

  const drift =
    invoice_eur === 0 && ledger_eur === 0
      ? 0
      : invoice_eur === 0
        ? Number.POSITIVE_INFINITY
        : (ledger_eur - invoice_eur) / invoice_eur;
  const driftAbs = Math.abs(drift);
  const alerted = driftAbs > threshold;

  logger.info({
    event: 'recon_invoice_run',
    month: monthKey,
    ledger_eur,
    invoice_eur,
    drift,
    threshold,
  });

  if (alerted) {
    const msg = `Invoice-recon drift for ${monthKey}: ledger=€${ledger_eur.toFixed(2)}, invoice=€${invoice_eur.toFixed(2)}, drift=${(drift * 100).toFixed(1)}% (threshold ${(threshold * 100).toFixed(0)}%) — REQ-COST-05`;
    await deps.sendDiscordAlert(msg);
    try {
      deps.writeStateRepoOpenPoint(
        `## Invoice-recon drift ${monthKey}\n\n${msg}\n`,
      );
    } catch (err: unknown) {
      logger.warn({
        event: 'recon_invoice_open_point_write_failed',
        err: (err as Error).message,
      });
    }
  }

  return { ledger_eur, invoice_eur, drift, alerted };
}
