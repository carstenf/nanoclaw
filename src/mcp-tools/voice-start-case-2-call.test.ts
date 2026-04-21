// src/mcp-tools/voice-start-case-2-call.test.ts
// Plan 05-02 Task 3 (RED): failing tests for voice_start_case_2_call.
// In-memory DB via cost-ledger createSchema(). Bridge /outbound is mocked.
import { describe, it, expect, beforeEach, vi } from 'vitest';

import crypto from 'crypto';
import Database from 'better-sqlite3';
import { createSchema } from '../cost-ledger.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceStartCase2Call,
  VoiceStartCase2CallSchema,
} from './voice-start-case-2-call.js';

// Helpers

function makeDb() {
  const db = new Database(':memory:');
  createSchema(db);
  return db;
}

/** D-7 authoritative key computation (copy of the one in the implementation). */
function computeKey(phone: string, date: string, time: string, partySize: number): string {
  const payload = `${phone}|${date}|${time}|${partySize}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function makeValidArgs(overrides: Record<string, unknown> = {}) {
  return {
    restaurant_name: 'La Piazza',
    restaurant_phone: '+491234567890',
    requested_date: '2026-05-01',
    requested_time: '19:00',
    party_size: 4,
    report_to_jid: 'dc:1490365616518070407',
    ...overrides,
  };
}

/** Mock Bridge /outbound — returns 200 by default. */
function makeFetchMock(status = 200, body: unknown = { outbound_task_id: 'task-abc', queue_position: 0 }) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('voice_start_case_2_call', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  // Test 1: all D-5 fields valid → enqueue called with case_type='case_2', returns ok:true
  it('happy-path: valid D-5 args → ok:true, task_id, idempotency_key, duplicate:false', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = (await handler(makeValidArgs())) as {
      ok: boolean;
      result: { task_id: string; idempotency_key: string; duplicate: boolean; queue_position: number };
    };
    expect(result.ok).toBe(true);
    expect(result.result.task_id).toBeDefined();
    expect(result.result.idempotency_key).toHaveLength(64);
    expect(result.result.duplicate).toBe(false);
    expect(typeof result.result.queue_position).toBe('number');
    // Bridge was called with case_type='case_2'
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(callBody.case_type).toBe('case_2');
  });

  // Test 2: restaurant_phone not E.164 → BadRequestError
  it('bad-phone: not E.164 → BadRequestError', async () => {
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: makeFetchMock() as unknown as typeof fetch,
    });
    await expect(handler(makeValidArgs({ restaurant_phone: '0891234567' }))).rejects.toBeInstanceOf(BadRequestError);
  });

  // Test 3: requested_date not YYYY-MM-DD → BadRequestError
  it('bad-date: not YYYY-MM-DD → BadRequestError', async () => {
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: makeFetchMock() as unknown as typeof fetch,
    });
    await expect(handler(makeValidArgs({ requested_date: '01-05-2026' }))).rejects.toBeInstanceOf(BadRequestError);
  });

  // Test 4: requested_time not HH:MM → BadRequestError
  it('bad-time: not HH:MM → BadRequestError', async () => {
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: makeFetchMock() as unknown as typeof fetch,
    });
    await expect(handler(makeValidArgs({ requested_time: '7pm' }))).rejects.toBeInstanceOf(BadRequestError);
  });

  // Test 5: party_size = 0 → BadRequestError
  it('bad-party-size: party_size=0 → BadRequestError', async () => {
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: makeFetchMock() as unknown as typeof fetch,
    });
    await expect(handler(makeValidArgs({ party_size: 0 }))).rejects.toBeInstanceOf(BadRequestError);
  });

  // Test 6: time_tolerance_min omitted → default 30 applied (no error)
  it('tolerance-default: time_tolerance_min omitted → default 30, succeeds', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const args = { ...makeValidArgs() };
    // do NOT set time_tolerance_min
    const result = (await handler(args)) as { ok: boolean };
    expect(result.ok).toBe(true);
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    const payload = (callBody.case_payload as Record<string, unknown>);
    expect(payload.time_tolerance_min).toBe(30);
  });

  // Test 7: duplicate booking (same phone+date+time+party_size) → {ok:true, duplicate:true}
  it('duplicate: same idempotency_key → ok:true, duplicate:true (no second Bridge call)', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const args = makeValidArgs();
    // First call
    await handler(args);
    fetchMock.mockClear();
    // Second call with same args
    const result = (await handler(args)) as { ok: boolean; result: { duplicate: boolean } };
    expect(result.ok).toBe(true);
    expect(result.result.duplicate).toBe(true);
    // Bridge should NOT have been called again
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Test 8: D-7 key is deterministic — sha256('+491234|2026-05-01|19:00|4') matches tool output
  it('d7-key: idempotency_key matches sha256(phone+date+time+party_size)', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const args = makeValidArgs({
      restaurant_phone: '+491234567890',
      requested_date: '2026-05-01',
      requested_time: '19:00',
      party_size: 4,
    });
    const result = (await handler(args)) as { ok: boolean; result: { idempotency_key: string } };
    expect(result.ok).toBe(true);
    const expected = computeKey('+491234567890', '2026-05-01', '19:00', 4);
    expect(result.result.idempotency_key).toBe(expected);
  });

  // Test 9: notes length 501 → BadRequestError
  it('bad-notes: length 501 → BadRequestError', async () => {
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: makeFetchMock() as unknown as typeof fetch,
    });
    await expect(handler(makeValidArgs({ notes: 'x'.repeat(501) }))).rejects.toBeInstanceOf(BadRequestError);
  });

  // Test 10: notes with curly braces → stored verbatim, round-trips clean
  it('notes-curly-braces: {{goal}} notes pass through verbatim', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const notes = '{{goal}} {{context}} some notes';
    const result = (await handler(makeValidArgs({ notes }))) as { ok: boolean };
    expect(result.ok).toBe(true);
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    const payload = (callBody.case_payload as Record<string, unknown>);
    expect(payload.notes).toBe(notes);
  });

  // Test 11: Bridge /outbound returns 429 → {ok:false, error:'queue_full'}
  it('queue-full: Bridge 429 → ok:false, error:queue_full', async () => {
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: makeFetchMock(429, { error: 'queue_full' }) as unknown as typeof fetch,
    });
    const result = (await handler(makeValidArgs())) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('queue_full');
  });
});

describe('defect #5 — same-day different-key attempt_no allocation (Plan 05.1)', () => {
  // Fresh DB per test — ensures counter state doesn't leak across tests.
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  // Test 1 (defect #5 core): two distinct idempotency_keys for SAME (phone, date)
  // → both INSERTs succeed, lunch gets attempt_no=1, dinner gets attempt_no=2.
  // RED state: hardcoded attempt_no=1 causes the SECOND call to fail with
  // SqliteError UNIQUE constraint (PK collision on (phone, date, 1)).
  it('two distinct keys same (phone, date) → attempt_no 1 and 2', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });

    // Lunch booking — time=13:00, party=2
    const r1 = (await handler(
      makeValidArgs({ requested_time: '13:00', party_size: 2 }),
    )) as { ok: boolean; result: { duplicate: boolean } };
    // Dinner booking — time=19:30, party=4 → different idempotency_key
    const r2 = (await handler(
      makeValidArgs({ requested_time: '19:30', party_size: 4 }),
    )) as { ok: boolean; result: { duplicate: boolean } };

    expect(r1.ok).toBe(true);
    expect(r1.result.duplicate).toBe(false);
    expect(r2.ok).toBe(true);
    expect(r2.result.duplicate).toBe(false);

    // Assert DB state: two rows with attempt_no 1 and 2
    const rows = db
      .prepare(
        'SELECT attempt_no FROM voice_case_2_attempts WHERE target_phone=? AND calendar_date=? ORDER BY attempt_no',
      )
      .all('+491234567890', '2026-05-01') as Array<{ attempt_no: number }>;
    expect(rows).toEqual([{ attempt_no: 1 }, { attempt_no: 2 }]);
  });

  // Test 2 (D-7 regression — duplicate key): same idempotency_key → duplicate:true,
  // exactly ONE row, attempt_no NOT incremented. This test may already PASS at RED
  // because the duplicate-check short-circuit (lines 163-197) runs BEFORE the
  // buggy INSERT block — it's a regression guard for the GREEN implementation.
  it('same idempotency_key → duplicate:true, exactly one row, attempt_no=1', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const args = makeValidArgs();
    const r1 = (await handler(args)) as { ok: boolean; result: { duplicate: boolean } };
    const r2 = (await handler(args)) as { ok: boolean; result: { duplicate: boolean } };

    expect(r1.ok).toBe(true);
    expect(r1.result.duplicate).toBe(false);
    expect(r2.ok).toBe(true);
    expect(r2.result.duplicate).toBe(true);

    const rows = db
      .prepare('SELECT attempt_no FROM voice_case_2_attempts ORDER BY attempt_no')
      .all() as Array<{ attempt_no: number }>;
    expect(rows).toEqual([{ attempt_no: 1 }]);
  });

  // Test 3 (three distinct bookings): three different-key same-(phone,date) calls
  // → attempt_no 1, 2, 3. RED state: second call fails with UNIQUE constraint.
  it('three distinct keys same (phone, date) → attempt_no 1, 2, 3', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const r1 = (await handler(
      makeValidArgs({ requested_time: '12:00', party_size: 2 }),
    )) as { ok: boolean };
    const r2 = (await handler(
      makeValidArgs({ requested_time: '15:00', party_size: 3 }),
    )) as { ok: boolean };
    const r3 = (await handler(
      makeValidArgs({ requested_time: '19:00', party_size: 6 }),
    )) as { ok: boolean };

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);

    const rows = db
      .prepare(
        'SELECT attempt_no FROM voice_case_2_attempts WHERE target_phone=? AND calendar_date=? ORDER BY attempt_no',
      )
      .all('+491234567890', '2026-05-01') as Array<{ attempt_no: number }>;
    expect(rows).toEqual([{ attempt_no: 1 }, { attempt_no: 2 }, { attempt_no: 3 }]);
  });

  // Test 4 (different dates, same phone): counter is per (phone, date), not per phone.
  // Both inserts land attempt_no=1 because calendar_date differs. RED state: passes
  // (no collision since the PK tuple differs in the date dimension).
  it('same phone, different dates → both get attempt_no=1', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const r1 = (await handler(
      makeValidArgs({ requested_date: '2026-05-01' }),
    )) as { ok: boolean };
    const r2 = (await handler(
      makeValidArgs({ requested_date: '2026-05-02' }),
    )) as { ok: boolean };

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const rowsMay1 = db
      .prepare(
        'SELECT attempt_no FROM voice_case_2_attempts WHERE target_phone=? AND calendar_date=?',
      )
      .all('+491234567890', '2026-05-01') as Array<{ attempt_no: number }>;
    const rowsMay2 = db
      .prepare(
        'SELECT attempt_no FROM voice_case_2_attempts WHERE target_phone=? AND calendar_date=?',
      )
      .all('+491234567890', '2026-05-02') as Array<{ attempt_no: number }>;

    expect(rowsMay1).toEqual([{ attempt_no: 1 }]);
    expect(rowsMay2).toEqual([{ attempt_no: 1 }]);
  });

  // Test 5 (MAX+1 gap tolerance): pre-seed rows at attempt_no=1, 2, 5 (simulating
  // gaps from retries in voice-case-2-retry); call tool with a NEW idempotency_key.
  // GREEN expectation: new row inserts at attempt_no=6 (COALESCE(MAX+1), not COUNT+1).
  // RED state: hardcoded attempt_no=1 fails with UNIQUE constraint (1 is occupied).
  // RESEARCH §9 explicitly accepts gaps.
  it('pre-seeded gaps (1, 2, 5) → new insert lands at attempt_no=6 (MAX+1 over gap)', async () => {
    const fetchMock = makeFetchMock();
    const handler = makeVoiceStartCase2Call({
      getDatabase: () => db,
      bridgeUrl: 'http://10.0.0.2:4402',
      fetch: fetchMock as unknown as typeof fetch,
    });

    // Seed rows at attempt_no 1, 2, 5 — all with distinct idempotency_keys and
    // distinct times so the computed key for the tool call (time=20:00, party=8)
    // doesn't collide.
    const seedIns = db.prepare(
      `INSERT INTO voice_case_2_attempts
         (target_phone, calendar_date, attempt_no, scheduled_for, idempotency_key,
          originating_call_id, restaurant_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    seedIns.run(
      '+491234567890',
      '2026-05-01',
      1,
      '2026-05-01T10:00:00Z',
      'seed-key-1',
      null,
      'Seed',
      '2026-05-01T09:00:00Z',
    );
    seedIns.run(
      '+491234567890',
      '2026-05-01',
      2,
      '2026-05-01T10:00:00Z',
      'seed-key-2',
      null,
      'Seed',
      '2026-05-01T09:00:00Z',
    );
    seedIns.run(
      '+491234567890',
      '2026-05-01',
      5,
      '2026-05-01T10:00:00Z',
      'seed-key-5',
      null,
      'Seed',
      '2026-05-01T09:00:00Z',
    );

    // New booking — key differs from seed keys (different time/party)
    const r = (await handler(
      makeValidArgs({ requested_time: '20:00', party_size: 8 }),
    )) as { ok: boolean };
    expect(r.ok).toBe(true);

    // Assert new row landed at attempt_no=6 (MAX(5)+1, NOT COUNT(3)+1=4)
    const allRows = db
      .prepare(
        'SELECT attempt_no FROM voice_case_2_attempts WHERE target_phone=? AND calendar_date=? ORDER BY attempt_no',
      )
      .all('+491234567890', '2026-05-01') as Array<{ attempt_no: number }>;
    expect(allRows).toEqual([
      { attempt_no: 1 },
      { attempt_no: 2 },
      { attempt_no: 5 },
      { attempt_no: 6 },
    ]);
  });
});

describe('VoiceStartCase2CallSchema', () => {
  it('valid args parse successfully', () => {
    expect(VoiceStartCase2CallSchema.safeParse(makeValidArgs()).success).toBe(true);
  });

  it('rejects party_size > 40', () => {
    expect(VoiceStartCase2CallSchema.safeParse(makeValidArgs({ party_size: 41 })).success).toBe(false);
  });

  it('rejects time_tolerance_min > 240', () => {
    expect(VoiceStartCase2CallSchema.safeParse(makeValidArgs({ time_tolerance_min: 241 })).success).toBe(false);
  });
});
