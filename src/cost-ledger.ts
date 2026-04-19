// src/cost-ledger.ts
// Phase 4 (INFRA-06, COST-01..05): SQLite accessors for voice cost ledger.
// Schema is ALSO created in src/db.ts createSchema() for the production DB;
// this module re-exposes createSchema() so in-memory unit tests can spin up
// the voice_* tables without dragging the full NanoClaw schema.
// Bridge writes via voice.record_turn_cost + voice.finalize_call_cost MCP-tools.
// Pitfall 3 (RESEARCH.md): persistence is per-turn, not per-call — a Bridge
// restart mid-call loses the per-call RAM total but not the already-recorded
// turn rows; finalize recomputes cost_eur from SUM(voice_turn_costs).
import Database from 'better-sqlite3';

import { getDatabase } from './db.js';

export interface VoiceTurnCostRow {
  call_id: string;
  turn_id: string;
  ts: string;
  audio_in_tokens: number;
  audio_out_tokens: number;
  cached_in_tokens: number;
  text_in_tokens: number;
  text_out_tokens: number;
  cost_eur: number;
}

export interface VoiceCallCostRow {
  call_id: string;
  case_type: string;
  started_at: string;
  ended_at: string | null;
  cost_eur: number;
  turn_count: number;
  terminated_by: string | null;
  soft_warn_fired: 0 | 1;
  model: string;
}

export interface VoicePriceSnapshotRow {
  ts: string;
  model: string;
  audio_in_usd: number;
  audio_out_usd: number;
  audio_cached_usd: number;
  text_in_usd: number;
  text_out_usd: number;
  usd_to_eur: number;
  source: string;
}

/**
 * Create the voice_* cost-ledger tables. Idempotent.
 *
 * Production DB runs this inline via src/db.ts createSchema() — this export
 * is for in-memory unit testing (`new Database(':memory:')`).
 */
export function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS voice_call_costs (
      call_id          TEXT PRIMARY KEY,
      case_type        TEXT NOT NULL,
      started_at       TEXT NOT NULL,
      ended_at         TEXT,
      cost_eur         REAL NOT NULL DEFAULT 0,
      turn_count       INTEGER NOT NULL DEFAULT 0,
      terminated_by    TEXT,
      soft_warn_fired  INTEGER NOT NULL DEFAULT 0,
      model            TEXT NOT NULL DEFAULT 'gpt-realtime-mini'
    );
    CREATE INDEX IF NOT EXISTS idx_voice_call_costs_started ON voice_call_costs(started_at);

    CREATE TABLE IF NOT EXISTS voice_turn_costs (
      call_id          TEXT NOT NULL,
      turn_id          TEXT NOT NULL,
      ts               TEXT NOT NULL,
      audio_in_tokens  INTEGER NOT NULL DEFAULT 0,
      audio_out_tokens INTEGER NOT NULL DEFAULT 0,
      cached_in_tokens INTEGER NOT NULL DEFAULT 0,
      text_in_tokens   INTEGER NOT NULL DEFAULT 0,
      text_out_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_eur         REAL NOT NULL,
      PRIMARY KEY (call_id, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_voice_turn_costs_call ON voice_turn_costs(call_id);

    CREATE TABLE IF NOT EXISTS voice_price_snapshots (
      ts               TEXT PRIMARY KEY,
      model            TEXT NOT NULL,
      audio_in_usd     REAL NOT NULL,
      audio_out_usd    REAL NOT NULL,
      audio_cached_usd REAL NOT NULL,
      text_in_usd      REAL NOT NULL,
      text_out_usd     REAL NOT NULL,
      usd_to_eur       REAL NOT NULL,
      source           TEXT NOT NULL
    );
  `);
}

/**
 * INSERT OR IGNORE — A12: duplicate turn (same call_id+turn_id) is silently
 * dropped. PRIMARY KEY (call_id, turn_id) is the natural dedup key.
 */
export function insertTurnCost(
  database: Database.Database,
  row: VoiceTurnCostRow,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO voice_turn_costs
        (call_id, turn_id, ts, audio_in_tokens, audio_out_tokens, cached_in_tokens, text_in_tokens, text_out_tokens, cost_eur)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.call_id,
      row.turn_id,
      row.ts,
      row.audio_in_tokens,
      row.audio_out_tokens,
      row.cached_in_tokens,
      row.text_in_tokens,
      row.text_out_tokens,
      row.cost_eur,
    );
}

/**
 * Upsert on call_id — one row per call, last-write-wins on SUM.
 * Pitfall 3: cost_eur should come from SUM(voice_turn_costs) computed by caller
 * (see voice-finalize-call-cost.ts sumTurnCosts DI).
 */
export function upsertCallCost(
  database: Database.Database,
  row: VoiceCallCostRow,
): void {
  database
    .prepare(
      `INSERT INTO voice_call_costs
        (call_id, case_type, started_at, ended_at, cost_eur, turn_count, terminated_by, soft_warn_fired, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(call_id) DO UPDATE SET
         ended_at=excluded.ended_at,
         cost_eur=excluded.cost_eur,
         turn_count=excluded.turn_count,
         terminated_by=excluded.terminated_by,
         soft_warn_fired=excluded.soft_warn_fired`,
    )
    .run(
      row.call_id,
      row.case_type,
      row.started_at,
      row.ended_at,
      row.cost_eur,
      row.turn_count,
      row.terminated_by,
      row.soft_warn_fired,
      row.model,
    );
}

/**
 * SUM(cost_eur) for current local day. Used by Bridge /accept daily-cap gate
 * (COST-02) in Plan 04-02.
 */
export function sumCostCurrentDay(database?: Database.Database): number {
  const db = database ?? getDatabase();
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(cost_eur), 0) AS s FROM voice_call_costs WHERE started_at >= datetime('now','localtime','start of day')`,
    )
    .get() as { s: number };
  return r.s;
}

/**
 * SUM(cost_eur) for current local month. Used by Bridge /accept monthly-cap
 * gate (COST-03) in Plan 04-02.
 */
export function sumCostCurrentMonth(database?: Database.Database): number {
  const db = database ?? getDatabase();
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(cost_eur), 0) AS s FROM voice_call_costs WHERE started_at >= datetime('now','localtime','start of month')`,
    )
    .get() as { s: number };
  return r.s;
}

/**
 * Insert / replace pricing snapshot row. Pricing-refresh cron (Plan 04-04)
 * writes one row per successful scrape; drift alerts compare to prior rows.
 */
export function insertPriceSnapshot(
  database: Database.Database,
  row: VoicePriceSnapshotRow,
): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO voice_price_snapshots
        (ts, model, audio_in_usd, audio_out_usd, audio_cached_usd, text_in_usd, text_out_usd, usd_to_eur, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.ts,
      row.model,
      row.audio_in_usd,
      row.audio_out_usd,
      row.audio_cached_usd,
      row.text_in_usd,
      row.text_out_usd,
      row.usd_to_eur,
      row.source,
    );
}
