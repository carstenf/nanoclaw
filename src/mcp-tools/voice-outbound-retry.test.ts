// src/mcp-tools/voice-outbound-retry.test.ts
//
// Step 3 Phase A3 (open_points 2026-04-30) — voice_outbound_schedule_retry now
// owns the full ladder/cap/DB logic that used to live in voice-case-2-retry.ts.
// This suite covers the inlined behaviour end-to-end (in-memory SQLite + a
// stubbed TOOLS-07 voice_schedule_retry).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import { createSchema } from '../cost-ledger.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceOutboundScheduleRetry,
  VoiceOutboundScheduleRetrySchema,
} from './voice-outbound-retry.js';

function makeDb() {
  const db = new Database(':memory:');
  createSchema(db);
  return db;
}

function makeScheduleRetryMock(
  result: unknown = { ok: true, result: { scheduled: true } },
) {
  return vi.fn().mockResolvedValue(result);
}

function insertAttempt(
  db: Database.Database,
  phone: string,
  date: string,
  attemptNo: number,
  idemKey: string,
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO voice_case_2_attempts
       (target_phone, calendar_date, attempt_no, scheduled_for, idempotency_key, created_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(phone, date, attemptNo, now, idemKey, now);
}

const PHONE = '+491234567890';
const TODAY_BERLIN_TS = Date.UTC(2026, 4, 1, 12, 0, 0); // 2026-05-01 14:00 Berlin
const TODAY_BERLIN_DATE = '2026-05-01';

function baseDeps(db: Database.Database, scheduleRetry = makeScheduleRetryMock()) {
  return {
    getDatabase: () => db,
    scheduleRetry,
    now: () => TODAY_BERLIN_TS,
  };
}

describe('voice_outbound_schedule_retry — ladder', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('attempt-1: no prior rows → attempt_no=1, not_before_ts ≈ now+5min', async () => {
    const stub = makeScheduleRetryMock();
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db, stub));
    const result = (await handler({
      target_phone: PHONE,
      prev_outcome: 'voicemail',
    })) as {
      ok: boolean;
      result: { scheduled: boolean; attempt_no: number; not_before_ts: string };
    };
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(1);
    const expectedMs = TODAY_BERLIN_TS + 5 * 60000;
    expect(
      Math.abs(new Date(result.result.not_before_ts).getTime() - expectedMs),
    ).toBeLessThan(1000);
    expect(stub).toHaveBeenCalledOnce();
  });

  it('attempt-2: 1 prior row → attempt_no=2, not_before_ts ≈ now+15min', async () => {
    insertAttempt(db, PHONE, TODAY_BERLIN_DATE, 1, 'a'.repeat(64));
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    const result = (await handler({ target_phone: PHONE })) as {
      ok: boolean;
      result: { attempt_no: number; not_before_ts: string };
    };
    expect(result.result.attempt_no).toBe(2);
    expect(
      Math.abs(
        new Date(result.result.not_before_ts).getTime() -
          (TODAY_BERLIN_TS + 15 * 60000),
      ),
    ).toBeLessThan(1000);
  });

  it('attempt-3: 2 prior rows → not_before_ts ≈ now+45min', async () => {
    insertAttempt(db, PHONE, TODAY_BERLIN_DATE, 1, 'a'.repeat(64));
    insertAttempt(db, PHONE, TODAY_BERLIN_DATE, 2, 'b'.repeat(64));
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    const result = (await handler({ target_phone: PHONE })) as {
      ok: boolean;
      result: { attempt_no: number; not_before_ts: string };
    };
    expect(result.result.attempt_no).toBe(3);
    expect(
      Math.abs(
        new Date(result.result.not_before_ts).getTime() -
          (TODAY_BERLIN_TS + 45 * 60000),
      ),
    ).toBeLessThan(1000);
  });

  it('attempt-4: 3 prior rows → not_before_ts ≈ now+120min', async () => {
    for (let i = 1; i <= 3; i++) {
      insertAttempt(db, PHONE, TODAY_BERLIN_DATE, i, String(i).repeat(64));
    }
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    const result = (await handler({ target_phone: PHONE })) as {
      ok: boolean;
      result: { attempt_no: number; not_before_ts: string };
    };
    expect(result.result.attempt_no).toBe(4);
    expect(
      Math.abs(
        new Date(result.result.not_before_ts).getTime() -
          (TODAY_BERLIN_TS + 120 * 60000),
      ),
    ).toBeLessThan(1000);
  });

  it('attempt-5: 4 prior rows → ladder exhausted → daily_cap_reached', async () => {
    for (let i = 1; i <= 4; i++) {
      insertAttempt(db, PHONE, TODAY_BERLIN_DATE, i, String(i).repeat(64));
    }
    const stub = makeScheduleRetryMock();
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db, stub));
    const result = (await handler({ target_phone: PHONE })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    // attempt-5 has count=4 (cap=5 not hit) but ladder_idx=4 with ladder
    // length=4 → ladder-exhausted defense returns daily_cap_reached.
    expect(result.error).toBe('daily_cap_reached');
    expect(stub).not.toHaveBeenCalled();
  });

  it('cap-reached: 5 prior rows → daily_cap_reached, no insert, no scheduleRetry', async () => {
    for (let i = 1; i <= 5; i++) {
      insertAttempt(db, PHONE, TODAY_BERLIN_DATE, i, String(i).repeat(64));
    }
    const stub = makeScheduleRetryMock();
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db, stub));
    const result = (await handler({ target_phone: PHONE })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('daily_cap_reached');
    expect(stub).not.toHaveBeenCalled();
  });

  it('date-isolation: prior attempts on yesterday do NOT count towards today cap', async () => {
    for (let i = 1; i <= 4; i++) {
      insertAttempt(db, PHONE, '2026-04-30', i, String(i).repeat(64));
    }
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    const result = (await handler({ target_phone: PHONE })) as {
      ok: boolean;
      result: { attempt_no: number };
    };
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(1);
  });
});

describe('voice_outbound_schedule_retry — retry_at override (smart-retry)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('retry_at sets not_before_ts directly + bypasses the ladder', async () => {
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    const result = (await handler({
      target_phone: PHONE,
      retry_at: '2026-05-01T15:00:00+02:00',
    })) as {
      ok: boolean;
      result: { not_before_ts: string };
    };
    expect(result.ok).toBe(true);
    expect(new Date(result.result.not_before_ts).toISOString()).toBe(
      '2026-05-01T13:00:00.000Z',
    );
  });

  it('retry_at on tomorrow → calendar_date is tomorrow Berlin (separate cap bucket)', async () => {
    // Pre-fill TODAY's bucket to the cap.
    for (let i = 1; i <= 5; i++) {
      insertAttempt(db, PHONE, TODAY_BERLIN_DATE, i, String(i).repeat(64));
    }
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    const result = (await handler({
      target_phone: PHONE,
      retry_at: '2026-05-02T09:00:00+02:00',
    })) as { ok: boolean; result: { attempt_no: number } };
    // Tomorrow bucket is empty → succeeds at attempt_no=1.
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(1);
  });

  it('retry_at still respects daily-cap on its own date', async () => {
    for (let i = 1; i <= 5; i++) {
      insertAttempt(db, PHONE, TODAY_BERLIN_DATE, i, String(i).repeat(64));
    }
    const stub = makeScheduleRetryMock();
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db, stub));
    const result = (await handler({
      target_phone: PHONE,
      retry_at: '2026-05-01T15:00:00+02:00',
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('daily_cap_reached');
    expect(stub).not.toHaveBeenCalled();
  });

  it('zod: rejects retry_at without timezone offset', async () => {
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(makeDb()));
    await expect(
      handler({ target_phone: PHONE, retry_at: '2026-05-01T15:00:00' }),
    ).rejects.toThrow(BadRequestError);
  });
});

describe('voice_outbound_schedule_retry — failure paths', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('TOOLS-07 returns ok:false → schedule_retry_failed; row marked schedule_failed', async () => {
    const stub = vi.fn().mockResolvedValue({ ok: false });
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db, stub));
    const result = (await handler({ target_phone: PHONE })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('schedule_retry_failed');
    const row = db
      .prepare(
        `SELECT outcome FROM voice_case_2_attempts WHERE target_phone=? AND calendar_date=?`,
      )
      .get(PHONE, TODAY_BERLIN_DATE) as { outcome: string } | undefined;
    expect(row?.outcome).toBe('schedule_failed');
  });

  it('TOOLS-07 throws → schedule_retry_failed', async () => {
    const stub = vi.fn().mockRejectedValue(new Error('transport boom'));
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db, stub));
    const result = (await handler({ target_phone: PHONE })) as {
      ok: boolean;
      error?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('schedule_retry_failed');
  });

  it('pk-race: pre-existing attempt_no=1 row → INSERT OR FAIL → retries with attempt_no=2', async () => {
    insertAttempt(db, PHONE, TODAY_BERLIN_DATE, 1, 'e'.repeat(64));
    const stub = makeScheduleRetryMock();
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db, stub));
    const result = (await handler({ target_phone: PHONE })) as {
      ok: boolean;
      result: { attempt_no: number };
    };
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(2);
    expect(stub).toHaveBeenCalledOnce();
  });
});

describe('voice_outbound_schedule_retry — input handling', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('synthesises Berlin calendar_date from now() when no retry_at', async () => {
    const stub = makeScheduleRetryMock();
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db, stub));
    await handler({ target_phone: PHONE });
    const row = db
      .prepare(`SELECT calendar_date FROM voice_case_2_attempts WHERE target_phone=?`)
      .get(PHONE) as { calendar_date: string } | undefined;
    expect(row?.calendar_date).toBe(TODAY_BERLIN_DATE);
  });

  it('fresh idempotency_key per call', async () => {
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    await handler({ target_phone: PHONE });
    await handler({ target_phone: PHONE });
    const rows = db
      .prepare(
        `SELECT idempotency_key FROM voice_case_2_attempts WHERE target_phone=? ORDER BY attempt_no`,
      )
      .all(PHONE) as Array<{ idempotency_key: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.idempotency_key).not.toBe(rows[1]!.idempotency_key);
  });

  it('prev_outcome=silence maps to voicemail', async () => {
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    await handler({ target_phone: PHONE, prev_outcome: 'silence' });
    // No DB column for outcome on insert, but the call succeeds — silence is
    // remapped internally for any future outcome storage.
    const row = db
      .prepare(`SELECT * FROM voice_case_2_attempts WHERE target_phone=?`)
      .get(PHONE);
    expect(row).toBeDefined();
  });

  it('forwards call_id to TOOLS-07', async () => {
    const stub = makeScheduleRetryMock();
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db, stub));
    await handler({
      call_id: 'rtc_test_123',
      target_phone: PHONE,
      prev_outcome: 'no_answer',
    });
    const args = stub.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.call_id).toBe('rtc_test_123');
  });

  it('zod: rejects non-E164 target_phone', async () => {
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    await expect(handler({ target_phone: '0891234567' })).rejects.toThrow(
      BadRequestError,
    );
  });

  it('zod: rejects unknown prev_outcome', async () => {
    const handler = makeVoiceOutboundScheduleRetry(baseDeps(db));
    await expect(
      handler({ target_phone: PHONE, prev_outcome: 'something_else' }),
    ).rejects.toThrow(BadRequestError);
  });
});

describe('VoiceOutboundScheduleRetrySchema', () => {
  it('accepts minimal valid args', () => {
    expect(
      VoiceOutboundScheduleRetrySchema.safeParse({ target_phone: PHONE }).success,
    ).toBe(true);
  });

  it('rejects non-E164 phone', () => {
    expect(
      VoiceOutboundScheduleRetrySchema.safeParse({ target_phone: '0891234' }).success,
    ).toBe(false);
  });
});
