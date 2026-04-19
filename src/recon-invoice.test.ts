// src/recon-invoice.test.ts
// Phase 4 Plan 04-04 (COST-05): monthly state.db SUM vs OpenAI invoice CSV.
// RED during Wave-4: the module does not exist yet. Task 3 turns it GREEN.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { createSchema } from './cost-ledger.js';
import { runReconInvoice } from './recon-invoice.js';

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconinvoice-test-'));
  db = new Database(':memory:');
  createSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Freeze "now" to 2026-04-19 — "last month" resolves to 2026-03.
const BASE_NOW = new Date('2026-04-19T04:00:00Z').getTime();
const LAST_MONTH_DATE = '2026-03-15T12:00:00Z';

function seedCallCost(
  callId: string,
  startedAt: string,
  costEur: number,
): void {
  db.prepare(
    `INSERT INTO voice_call_costs (call_id, case_type, started_at, ended_at, cost_eur, turn_count, terminated_by, soft_warn_fired, model)
     VALUES (?, 'unknown', ?, ?, ?, 1, 'counterpart_bye', 0, 'gpt-realtime-mini')`,
  ).run(callId, startedAt, startedAt, costEur);
}

function writeCsv(monthKey: string, usd: number): string {
  const dir = path.join(tmpDir, 'openai-invoices');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${monthKey}.csv`);
  fs.writeFileSync(p, `month,usage_usd\n${monthKey},${usd}\n`);
  return dir;
}

describe('runReconInvoice', () => {
  it('no alert when ledger and invoice are within threshold', async () => {
    seedCallCost('c1', LAST_MONTH_DATE, 50.0);
    seedCallCost('c2', LAST_MONTH_DATE, 43.0);
    // 93 EUR ledger; CSV 100 USD * 0.93 = 93 EUR
    const csvDir = writeCsv('2026-03', 100);

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const openPointSpy = vi.fn();

    const result = await runReconInvoice({
      db,
      invoiceCsvDir: csvDir,
      sendDiscordAlert: alertSpy,
      writeStateRepoOpenPoint: openPointSpy,
      now: () => BASE_NOW,
    });

    expect(result.ledger_eur).toBeCloseTo(93.0);
    expect(result.invoice_eur).toBeCloseTo(93.0);
    expect(Math.abs(result.drift)).toBeLessThanOrEqual(0.05);
    expect(result.alerted).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('alerts when drift >5%', async () => {
    seedCallCost('c1', LAST_MONTH_DATE, 93.0);
    // CSV 120 USD * 0.93 = 111.60 EUR; drift vs ledger 93 = -16.7%
    const csvDir = writeCsv('2026-03', 120);

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const openPointSpy = vi.fn();

    const result = await runReconInvoice({
      db,
      invoiceCsvDir: csvDir,
      sendDiscordAlert: alertSpy,
      writeStateRepoOpenPoint: openPointSpy,
      now: () => BASE_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(Math.abs(result.drift)).toBeGreaterThan(0.05);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(openPointSpy).toHaveBeenCalledTimes(1);
    const msg = alertSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/drift/i);
    expect(msg).toMatch(/2026-03/);
  });

  it('graceful fallback when CSV missing (Pitfall 7): alert + open_points write, no throw', async () => {
    seedCallCost('c1', LAST_MONTH_DATE, 93.0);
    // CSV directory exists but no file for the target month
    fs.mkdirSync(path.join(tmpDir, 'openai-invoices'), { recursive: true });

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const openPointSpy = vi.fn();

    const result = await runReconInvoice({
      db,
      invoiceCsvDir: path.join(tmpDir, 'openai-invoices'),
      sendDiscordAlert: alertSpy,
      writeStateRepoOpenPoint: openPointSpy,
      now: () => BASE_NOW,
    });

    expect(result.alerted).toBe(true);
    expect(result.ledger_eur).toBeCloseTo(93.0);
    expect(result.invoice_eur).toBe(0);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(openPointSpy).toHaveBeenCalledTimes(1);
    const msg = alertSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/no invoice CSV|missing/i);
  });

  it('ignores calls from other months', async () => {
    seedCallCost('c1', LAST_MONTH_DATE, 93.0);
    // Previous-previous month: 2026-02
    seedCallCost('c-old', '2026-02-10T00:00:00Z', 200.0);
    const csvDir = writeCsv('2026-03', 100);

    const result = await runReconInvoice({
      db,
      invoiceCsvDir: csvDir,
      sendDiscordAlert: vi.fn().mockResolvedValue(undefined),
      writeStateRepoOpenPoint: vi.fn(),
      now: () => BASE_NOW,
    });

    expect(result.ledger_eur).toBeCloseTo(93.0);
    // Must NOT include €200 from the old month
  });

  it('returns 0/0 with no alert when ledger and invoice both empty', async () => {
    const csvDir = writeCsv('2026-03', 0);

    const alertSpy = vi.fn().mockResolvedValue(undefined);

    const result = await runReconInvoice({
      db,
      invoiceCsvDir: csvDir,
      sendDiscordAlert: alertSpy,
      writeStateRepoOpenPoint: vi.fn(),
      now: () => BASE_NOW,
    });

    expect(result.ledger_eur).toBe(0);
    expect(result.invoice_eur).toBe(0);
    expect(result.alerted).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
