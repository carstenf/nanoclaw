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
