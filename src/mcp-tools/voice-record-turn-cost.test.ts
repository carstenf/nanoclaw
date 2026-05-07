// src/mcp-tools/voice-record-turn-cost.test.ts
// Phase A of the 2026-05-07 cost re-introduction (un-stub of the
// voice_record_turn_cost MCP tool). Bridge has been firing this on every
// response.done since Phase 4; the handler was deleted in the 2026-05-05
// deprecation and now lives again so Carsten can see per-call costs.

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { createSchema } from '../cost-ledger.js';
import {
  makeVoiceRecordTurnCost,
  VoiceRecordTurnCostSchema,
} from './voice-record-turn-cost.js';
import { BadRequestError } from './voice-on-transcript-turn.js';

describe('voice_record_turn_cost', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('inserts a row into voice_turn_costs with trigger_type="turn"', async () => {
    const handler = makeVoiceRecordTurnCost({ db, now: () => '2026-05-07T18:00:00.000Z' });
    const r = await handler({
      call_id: 'rtc_abc',
      turn_id: 'resp_xyz',
      audio_in_tokens: 1500,
      audio_out_tokens: 800,
      cached_in_tokens: 100,
      text_in_tokens: 50,
      text_out_tokens: 60,
      cost_eur: 0.0123,
    });
    expect(r).toMatchObject({
      ok: true,
      result: { call_id: 'rtc_abc', turn_id: 'resp_xyz', cost_eur: 0.0123 },
    });

    const row = db
      .prepare(
        'SELECT * FROM voice_turn_costs WHERE call_id = ? AND turn_id = ?',
      )
      .get('rtc_abc', 'resp_xyz') as Record<string, unknown>;
    expect(row).toMatchObject({
      call_id: 'rtc_abc',
      turn_id: 'resp_xyz',
      ts: '2026-05-07T18:00:00.000Z',
      audio_in_tokens: 1500,
      audio_out_tokens: 800,
      cached_in_tokens: 100,
      text_in_tokens: 50,
      text_out_tokens: 60,
      cost_eur: 0.0123,
      trigger_type: 'turn',
    });
  });

  it('idempotent on (call_id, turn_id) — duplicate fire dropped silently (INSERT OR IGNORE)', async () => {
    const handler = makeVoiceRecordTurnCost({ db });
    const args = {
      call_id: 'rtc_dup',
      turn_id: 'resp_1',
      audio_in_tokens: 100,
      audio_out_tokens: 200,
      cost_eur: 0.005,
    };
    await handler(args);
    await handler({ ...args, cost_eur: 0.999 }); // second fire with different cost
    const rows = db
      .prepare('SELECT cost_eur FROM voice_turn_costs WHERE call_id = ?')
      .all('rtc_dup') as Array<{ cost_eur: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_eur).toBe(0.005); // first write wins
  });

  it('defaults missing token fields to 0', async () => {
    const handler = makeVoiceRecordTurnCost({ db });
    await handler({
      call_id: 'rtc_minimal',
      turn_id: 'resp_1',
      cost_eur: 0.001,
    });
    const row = db
      .prepare('SELECT * FROM voice_turn_costs WHERE call_id = ?')
      .get('rtc_minimal') as Record<string, number>;
    expect(row.audio_in_tokens).toBe(0);
    expect(row.audio_out_tokens).toBe(0);
    expect(row.cached_in_tokens).toBe(0);
    expect(row.text_in_tokens).toBe(0);
    expect(row.text_out_tokens).toBe(0);
  });

  it('rejects missing call_id with BadRequestError', async () => {
    const handler = makeVoiceRecordTurnCost({ db });
    await expect(
      handler({ turn_id: 'r1', cost_eur: 0.001 }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects negative cost_eur with BadRequestError', async () => {
    const handler = makeVoiceRecordTurnCost({ db });
    await expect(
      handler({ call_id: 'rtc_a', turn_id: 'r1', cost_eur: -0.01 }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('schema accepts the exact bridge payload shape (sideband.ts:748)', () => {
    // Regression: locks in the field names the bridge sends. If the bridge
    // renames one, this test fails before the handler silently ignores it.
    const r = VoiceRecordTurnCostSchema.safeParse({
      call_id: 'rtc_test',
      turn_id: 'resp_test',
      audio_in_tokens: 0,
      audio_out_tokens: 0,
      cached_in_tokens: 0,
      text_in_tokens: 0,
      text_out_tokens: 0,
      cost_eur: 0,
    });
    expect(r.success).toBe(true);
  });
});
