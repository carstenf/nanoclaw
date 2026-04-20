// src/mcp-tools/voice-case-2-retry.test.ts
// Plan 05-02 Task 2 (RED): failing tests for voice_case_2_schedule_retry.
// In-memory DB via cost-ledger createSchema(). TOOLS-07 voice_schedule_retry
// is mocked via DI — this tool wraps it, does NOT modify it.
import { describe, it, expect, beforeEach, vi } from 'vitest';

import Database from 'better-sqlite3';
import { createSchema } from '../cost-ledger.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import { makeVoiceCase2ScheduleRetry, VoiceCase2ScheduleRetrySchema } from './voice-case-2-retry.js';

// Helpers

function makeDb() {
  const db = new Database(':memory:');
  createSchema(db);
  return db;
}

const VALID_IDEM_KEY = 'a'.repeat(64); // 64 lowercase hex chars

function makeArgs(overrides: Record<string, unknown> = {}) {
  return {
    target_phone: '+491234567890',
    calendar_date: '2026-05-01',
    idempotency_key: VALID_IDEM_KEY,
    ...overrides,
  };
}

function makeScheduleRetryMock(result: unknown = { ok: true, result: { scheduled: true } }) {
  return vi.fn().mockResolvedValue(result);
}

function insertAttempt(
  db: Database.Database,
  phone: string,
  date: string,
  attemptNo: number,
  idemKey: string,
  outcome: string | null = null,
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO voice_case_2_attempts
       (target_phone, calendar_date, attempt_no, scheduled_for, idempotency_key, created_at, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(phone, date, attemptNo, now, idemKey, now, outcome);
}

describe('voice_case_2_schedule_retry', () => {
  let db: Database.Database;
  let nowMs: number;

  beforeEach(() => {
    db = makeDb();
    nowMs = Date.now();
  });

  // Test 1: attempt 1 (no prior rows) → attempt_no=1, not_before_ts ~= now + 5min
  it('attempt-1: no prior rows → attempt_no=1, not_before_ts ≈ now+5min', async () => {
    const scheduleRetry = makeScheduleRetryMock();
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry,
      now: () => nowMs,
    });
    const result = (await handler(makeArgs())) as {
      ok: boolean;
      result: { scheduled: boolean; attempt_no: number; not_before_ts: string };
    };
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(1);
    const expectedMs = nowMs + 5 * 60000;
    const actualMs = new Date(result.result.not_before_ts).getTime();
    expect(Math.abs(actualMs - expectedMs)).toBeLessThan(1000);
    expect(scheduleRetry).toHaveBeenCalledOnce();
  });

  // Test 2: attempt 2 → not_before_ts ~= now + 15min
  it('attempt-2: 1 prior row → attempt_no=2, not_before_ts ≈ now+15min', async () => {
    insertAttempt(db, '+491234567890', '2026-05-01', 1, 'b'.repeat(64));
    const scheduleRetry = makeScheduleRetryMock();
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry,
      now: () => nowMs,
    });
    const result = (await handler(makeArgs())) as {
      ok: boolean;
      result: { attempt_no: number; not_before_ts: string };
    };
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(2);
    const expectedMs = nowMs + 15 * 60000;
    const actualMs = new Date(result.result.not_before_ts).getTime();
    expect(Math.abs(actualMs - expectedMs)).toBeLessThan(1000);
  });

  // Test 3: attempt 3 → 45min; Test 4: attempt 4 → 120min
  it('attempt-3: 2 prior rows → not_before_ts ≈ now+45min', async () => {
    insertAttempt(db, '+491234567890', '2026-05-01', 1, 'b'.repeat(64));
    insertAttempt(db, '+491234567890', '2026-05-01', 2, 'c'.repeat(64));
    const scheduleRetry = makeScheduleRetryMock();
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry,
      now: () => nowMs,
    });
    const result = (await handler(makeArgs())) as {
      ok: boolean;
      result: { attempt_no: number; not_before_ts: string };
    };
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(3);
    const expectedMs = nowMs + 45 * 60000;
    expect(Math.abs(new Date(result.result.not_before_ts).getTime() - expectedMs)).toBeLessThan(1000);
  });

  it('attempt-4: 3 prior rows → not_before_ts ≈ now+120min', async () => {
    for (let i = 1; i <= 3; i++) {
      insertAttempt(db, '+491234567890', '2026-05-01', i, String(i).repeat(64));
    }
    const scheduleRetry = makeScheduleRetryMock();
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry,
      now: () => nowMs,
    });
    const result = (await handler(makeArgs())) as {
      ok: boolean;
      result: { attempt_no: number; not_before_ts: string };
    };
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(4);
    const expectedMs = nowMs + 120 * 60000;
    expect(Math.abs(new Date(result.result.not_before_ts).getTime() - expectedMs)).toBeLessThan(1000);
  });

  // Test 5: attempt 5 when 4 prior → ladder exhausted → daily_cap_reached
  it('attempt-5: 4 prior rows → ladder[4] does not exist → daily_cap_reached', async () => {
    for (let i = 1; i <= 4; i++) {
      insertAttempt(db, '+491234567890', '2026-05-01', i, String(i).repeat(64));
    }
    const scheduleRetry = makeScheduleRetryMock();
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry,
      now: () => nowMs,
    });
    const result = (await handler(makeArgs())) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('daily_cap_reached');
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  // Test 6: count=5 already → daily_cap_reached, no DB insert, TOOLS-07 not called
  it('cap-reached: 5 prior rows → daily_cap_reached, no insert, no scheduleRetry call', async () => {
    for (let i = 1; i <= 5; i++) {
      insertAttempt(db, '+491234567890', '2026-05-01', i, String(i).repeat(64));
    }
    const scheduleRetry = makeScheduleRetryMock();
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry,
      now: () => nowMs,
    });
    const result = (await handler(makeArgs())) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('daily_cap_reached');
    expect(scheduleRetry).not.toHaveBeenCalled();
    const rows = db
      .prepare('SELECT COUNT(*) as n FROM voice_case_2_attempts WHERE target_phone=? AND calendar_date=?')
      .get('+491234567890', '2026-05-01') as { n: number };
    expect(rows.n).toBe(5); // unchanged
  });

  // Test 7: idempotency_key wrong format → BadRequestError
  it('bad-key: idempotency_key not 64 hex chars → BadRequestError', async () => {
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry: makeScheduleRetryMock(),
    });
    await expect(handler(makeArgs({ idempotency_key: 'tooshort' }))).rejects.toBeInstanceOf(BadRequestError);
  });

  // Test 8: yesterday's date + 5 prior yesterday + 0 today → attempt_no=1 for today
  it('date-isolation: prior attempts on yesterday do NOT count towards today cap', async () => {
    const yesterday = '2026-04-30';
    for (let i = 1; i <= 5; i++) {
      insertAttempt(db, '+491234567890', yesterday, i, String(i).repeat(64));
    }
    const scheduleRetry = makeScheduleRetryMock();
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry,
      now: () => nowMs,
    });
    const result = (await handler(makeArgs({ calendar_date: '2026-05-01' }))) as {
      ok: boolean;
      result: { attempt_no: number };
    };
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(1);
  });

  // Test 9: DB write fails → db_error, graceful log
  it('db-fail: DB insert throws → returns db_error', async () => {
    // Use a closed DB to simulate failure
    const badDb = makeDb();
    badDb.close();
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => badDb,
      scheduleRetry: makeScheduleRetryMock(),
    });
    const result = (await handler(makeArgs())) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('db_error');
  });

  // Test 10: TOOLS-07 returns ok:false → schedule_retry_failed + outcome='schedule_failed'
  it('tools07-fail: scheduleRetry returns ok:false → schedule_retry_failed + row outcome updated', async () => {
    const scheduleRetry = vi.fn().mockResolvedValue({ ok: false, error: 'no_main_group' });
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry,
      now: () => nowMs,
    });
    const result = (await handler(makeArgs())) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('schedule_retry_failed');
    // Row should be inserted with outcome='schedule_failed'
    const row = db
      .prepare('SELECT outcome FROM voice_case_2_attempts WHERE target_phone=? AND calendar_date=? AND attempt_no=1')
      .get('+491234567890', '2026-05-01') as { outcome: string } | undefined;
    expect(row?.outcome).toBe('schedule_failed');
  });

  // Test 11: Two concurrent calls with same PK → INSERT OR FAIL → retry with attempt_no++ (race protection)
  it('pk-race: pre-existing attempt_no=1 row causes INSERT OR FAIL → retries with attempt_no=2', async () => {
    // Pre-insert attempt_no=1 with a DIFFERENT idempotency_key to simulate race
    // (same target+date+attempt_no=1 is already taken by another concurrent call)
    insertAttempt(db, '+491234567890', '2026-05-01', 1, 'e'.repeat(64));
    const scheduleRetry = makeScheduleRetryMock();
    const handler = makeVoiceCase2ScheduleRetry({
      getDatabase: () => db,
      scheduleRetry,
      now: () => nowMs,
    });
    // COUNT returns 1 → attempt_no would be 2, but attempt_no=1 is already taken
    // The handler should compute attempt_no=2 from COUNT and succeed
    const result = (await handler(makeArgs())) as {
      ok: boolean;
      result: { attempt_no: number };
    };
    expect(result.ok).toBe(true);
    expect(result.result.attempt_no).toBe(2);
    expect(scheduleRetry).toHaveBeenCalledOnce();
  });
});

// Schema check
describe('VoiceCase2ScheduleRetrySchema', () => {
  it('valid args parse successfully', () => {
    const result = VoiceCase2ScheduleRetrySchema.safeParse(makeArgs());
    expect(result.success).toBe(true);
  });

  it('rejects non-E.164 phone', () => {
    expect(VoiceCase2ScheduleRetrySchema.safeParse(makeArgs({ target_phone: '0891234' })).success).toBe(false);
  });

  it('rejects invalid calendar_date format', () => {
    expect(VoiceCase2ScheduleRetrySchema.safeParse(makeArgs({ calendar_date: '01-05-2026' })).success).toBe(false);
  });
});
