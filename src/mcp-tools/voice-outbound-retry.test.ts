// src/mcp-tools/voice-outbound-retry.test.ts
//
// Step 2C unit tests for voice_outbound_schedule_retry.
// scheduleCase2Retry is stubbed via DI; this suite asserts the wrapping
// contract (synthesised calendar_date + fresh per-attempt idempotency_key,
// outcome mapping, schema validation) — not the underlying ladder/cap logic
// (covered by voice-case-2-retry.test.ts).

import { describe, it, expect, vi } from 'vitest';

import { makeVoiceOutboundScheduleRetry } from './voice-outbound-retry.js';
import { BadRequestError } from './voice-on-transcript-turn.js';

describe('voice_outbound_schedule_retry', () => {
  it('happy path: synthesises calendar_date (today, Berlin) + fresh idempotency_key + delegates to scheduleCase2Retry', async () => {
    const stub = vi.fn().mockResolvedValue({
      ok: true,
      result: { scheduled: true, attempt_no: 1, not_before_ts: '2026-04-28T19:00:00.000Z' },
    });
    const handler = makeVoiceOutboundScheduleRetry({
      scheduleCase2Retry: stub,
    });
    const result = await handler({
      target_phone: '+491234567890',
      prev_outcome: 'voicemail',
    });
    expect(stub).toHaveBeenCalledTimes(1);
    const args = stub.mock.calls[0][0] as Record<string, unknown>;
    expect(args.target_phone).toBe('+491234567890');
    expect(args.prev_outcome).toBe('voicemail');
    expect(typeof args.calendar_date).toBe('string');
    expect(args.calendar_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof args.idempotency_key).toBe('string');
    expect(args.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toEqual({
      ok: true,
      result: { scheduled: true, attempt_no: 1, not_before_ts: '2026-04-28T19:00:00.000Z' },
    });
  });

  it('fresh key per call: two consecutive invocations get different idempotency_keys', async () => {
    const stub = vi.fn().mockResolvedValue({ ok: true });
    const handler = makeVoiceOutboundScheduleRetry({
      scheduleCase2Retry: stub,
    });
    await handler({ target_phone: '+491234567890', prev_outcome: 'voicemail' });
    await handler({ target_phone: '+491234567890', prev_outcome: 'voicemail' });
    const k1 = (stub.mock.calls[0][0] as Record<string, string>).idempotency_key;
    const k2 = (stub.mock.calls[1][0] as Record<string, string>).idempotency_key;
    expect(k1).not.toBe(k2);
  });

  it('prev_outcome=silence maps to voicemail (case_2 enum has no silence)', async () => {
    const stub = vi.fn().mockResolvedValue({ ok: true });
    const handler = makeVoiceOutboundScheduleRetry({
      scheduleCase2Retry: stub,
    });
    await handler({ target_phone: '+491234567890', prev_outcome: 'silence' });
    const args = stub.mock.calls[0][0] as Record<string, unknown>;
    expect(args.prev_outcome).toBe('voicemail');
  });

  it('prev_outcome omitted: not forwarded to scheduleCase2Retry (kept undefined)', async () => {
    const stub = vi.fn().mockResolvedValue({ ok: true });
    const handler = makeVoiceOutboundScheduleRetry({
      scheduleCase2Retry: stub,
    });
    await handler({ target_phone: '+491234567890' });
    const args = stub.mock.calls[0][0] as Record<string, unknown>;
    expect('prev_outcome' in args).toBe(false);
  });

  it('zod: rejects non-E164 target_phone', async () => {
    const handler = makeVoiceOutboundScheduleRetry({
      scheduleCase2Retry: vi.fn(),
    });
    await expect(
      handler({ target_phone: '0891234567', prev_outcome: 'voicemail' }),
    ).rejects.toThrow(BadRequestError);
  });

  it('zod: rejects unknown prev_outcome', async () => {
    const handler = makeVoiceOutboundScheduleRetry({
      scheduleCase2Retry: vi.fn(),
    });
    await expect(
      handler({ target_phone: '+491234567890', prev_outcome: 'something_else' }),
    ).rejects.toThrow(BadRequestError);
  });

  it('forwards call_id when supplied', async () => {
    const stub = vi.fn().mockResolvedValue({ ok: true });
    const handler = makeVoiceOutboundScheduleRetry({
      scheduleCase2Retry: stub,
    });
    await handler({
      call_id: 'rtc_test_123',
      target_phone: '+491234567890',
      prev_outcome: 'no_answer',
    });
    const args = stub.mock.calls[0][0] as Record<string, unknown>;
    expect(args.call_id).toBe('rtc_test_123');
  });

  it('clock injection: stable calendar_date + fresh keys regardless of clock', async () => {
    const stub = vi.fn().mockResolvedValue({ ok: true });
    // Pin clock to 2026-04-28 12:00 UTC. Berlin is UTC+2 in summer = 14:00,
    // so calendar_date is still 2026-04-28.
    const fixedTs = Date.UTC(2026, 3, 28, 12, 0, 0); // month is 0-indexed
    const handler = makeVoiceOutboundScheduleRetry({
      scheduleCase2Retry: stub,
      now: () => fixedTs,
    });
    await handler({ target_phone: '+491234567890', prev_outcome: 'voicemail' });
    const args = stub.mock.calls[0][0] as Record<string, string>;
    expect(args.calendar_date).toBe('2026-04-28');
  });
});
