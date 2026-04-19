// Phase 4 (INFRA-06): cost-ledger.ts — SQLite CRUD + SUM queries unit tests.
// RED during Wave-0: cost-ledger.ts does not exist yet; Task 3 turns this GREEN.
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  createSchema,
  insertTurnCost,
  upsertCallCost,
  sumCostCurrentDay,
  sumCostCurrentMonth,
  insertPriceSnapshot,
} from './cost-ledger.js';

describe('cost-ledger — schema + SUMs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('creates voice_call_costs + voice_turn_costs + voice_price_snapshots tables', () => {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'voice_%'",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'voice_call_costs',
        'voice_turn_costs',
        'voice_price_snapshots',
      ]),
    );
  });

  it('voice_turn_costs has PRIMARY KEY (call_id, turn_id)', () => {
    // Sanity-check via pragma: rowid-less compound PK.
    const info = db
      .prepare('PRAGMA table_info(voice_turn_costs)')
      .all() as Array<{ name: string; pk: number }>;
    const pkCols = info.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(['call_id', 'turn_id']);
  });

  it('insertTurnCost + upsertCallCost + sumCostCurrentDay aggregate correctly', () => {
    const now = new Date().toISOString();
    insertTurnCost(db, {
      call_id: 'c1',
      turn_id: 't1',
      ts: now,
      audio_in_tokens: 100,
      audio_out_tokens: 50,
      cached_in_tokens: 0,
      text_in_tokens: 0,
      text_out_tokens: 0,
      cost_eur: 0.25,
    });
    upsertCallCost(db, {
      call_id: 'c1',
      case_type: 'case_6a',
      started_at: now,
      ended_at: now,
      cost_eur: 0.25,
      turn_count: 1,
      terminated_by: 'counterpart_bye',
      soft_warn_fired: 0,
      model: 'gpt-realtime-mini',
    });
    expect(sumCostCurrentDay(db)).toBeCloseTo(0.25, 5);
    expect(sumCostCurrentMonth(db)).toBeCloseTo(0.25, 5);
  });

  it('PRIMARY KEY (call_id, turn_id) prevents duplicate insert (INSERT OR IGNORE)', () => {
    const now = new Date().toISOString();
    const row = {
      call_id: 'c1',
      turn_id: 't1',
      ts: now,
      audio_in_tokens: 0,
      audio_out_tokens: 0,
      cached_in_tokens: 0,
      text_in_tokens: 0,
      text_out_tokens: 0,
      cost_eur: 0.1,
    };
    insertTurnCost(db, row);
    insertTurnCost(db, row); // second is no-op
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM voice_turn_costs').get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it('upsertCallCost updates existing call row (ON CONFLICT) without duplicate', () => {
    const now = new Date().toISOString();
    upsertCallCost(db, {
      call_id: 'c1',
      case_type: 'case_6a',
      started_at: now,
      ended_at: null,
      cost_eur: 0.0,
      turn_count: 0,
      terminated_by: null,
      soft_warn_fired: 0,
      model: 'gpt-realtime-mini',
    });
    upsertCallCost(db, {
      call_id: 'c1',
      case_type: 'case_6a',
      started_at: now,
      ended_at: now,
      cost_eur: 0.75,
      turn_count: 5,
      terminated_by: 'counterpart_bye',
      soft_warn_fired: 1,
      model: 'gpt-realtime-mini',
    });
    const rows = db
      .prepare('SELECT * FROM voice_call_costs WHERE call_id = ?')
      .all('c1') as Array<{ cost_eur: number; turn_count: number; soft_warn_fired: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_eur).toBeCloseTo(0.75, 5);
    expect(rows[0].turn_count).toBe(5);
    expect(rows[0].soft_warn_fired).toBe(1);
  });

  it('insertPriceSnapshot persists pricing row', () => {
    insertPriceSnapshot(db, {
      ts: new Date().toISOString(),
      model: 'gpt-realtime-mini',
      audio_in_usd: 10.0,
      audio_out_usd: 20.0,
      audio_cached_usd: 0.3,
      text_in_usd: 0.6,
      text_out_usd: 2.4,
      usd_to_eur: 0.93,
      source: 'test',
    });
    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM voice_price_snapshots').get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });
});
