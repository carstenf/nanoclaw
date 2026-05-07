// src/mcp-tools/voice-finalize-call-cost.test.ts
// Phase C of the 2026-05-07 cost re-introduction. Covers:
//   - load-bearing deregister always runs
//   - summary composes with ledger + OpenAI cost + budget
//   - graceful degrade when OpenAI fetch fails
//   - graceful degrade when sendDiscord callback omitted

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createSchema, insertTurnCost } from '../cost-ledger.js';
import {
  makeVoiceFinalizeCallCost,
  formatCallSummary,
  readCallCostBreakdown,
} from './voice-finalize-call-cost.js';
import {
  registerActiveCall,
  isCallActive,
  _resetActiveSet,
} from '../voice-mid-call-gateway.js';

const NOW = new Date('2026-05-07T18:00:00.000Z');

function seedTurns(db: Database.Database, call_id: string): void {
  // Two turns this call.
  insertTurnCost(db, {
    call_id,
    turn_id: 't1',
    ts: '2026-05-07T17:59:00.000Z',
    audio_in_tokens: 100,
    audio_out_tokens: 200,
    cached_in_tokens: 0,
    text_in_tokens: 0,
    text_out_tokens: 0,
    cost_eur: 0.05,
    trigger_type: 'turn',
  });
  insertTurnCost(db, {
    call_id,
    turn_id: 't2',
    ts: '2026-05-07T17:59:30.000Z',
    audio_in_tokens: 50,
    audio_out_tokens: 80,
    cached_in_tokens: 0,
    text_in_tokens: 0,
    text_out_tokens: 0,
    cost_eur: 0.03,
    trigger_type: 'turn',
  });
  // One earlier turn (same day) from another call.
  insertTurnCost(db, {
    call_id: 'rtc_other',
    turn_id: 't1',
    ts: '2026-05-07T08:00:00.000Z',
    audio_in_tokens: 0,
    audio_out_tokens: 0,
    cached_in_tokens: 0,
    text_in_tokens: 0,
    text_out_tokens: 0,
    cost_eur: 0.20,
    trigger_type: 'turn',
  });
  // Earlier in month, before today.
  insertTurnCost(db, {
    call_id: 'rtc_yesterday',
    turn_id: 't1',
    ts: '2026-05-06T10:00:00.000Z',
    audio_in_tokens: 0,
    audio_out_tokens: 0,
    cached_in_tokens: 0,
    text_in_tokens: 0,
    text_out_tokens: 0,
    cost_eur: 1.00,
    trigger_type: 'turn',
  });
}

describe('readCallCostBreakdown', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    seedTurns(db, 'rtc_subj');
  });

  it('sums per-call cost + day SUM + month SUM correctly', () => {
    const b = readCallCostBreakdown(db, 'rtc_subj', NOW);
    expect(b.call_eur).toBeCloseTo(0.08, 4); // 0.05 + 0.03
    expect(b.turn_count).toBe(2);
    expect(b.day_eur).toBeCloseTo(0.05 + 0.03 + 0.20, 4); // today only
    expect(b.month_eur).toBeCloseTo(0.05 + 0.03 + 0.20 + 1.00, 4); // whole month
  });
});

describe('formatCallSummary', () => {
  it('all sections present when budget + openai cost provided', () => {
    const text = formatCallSummary({
      call_id: 'rtc_x',
      breakdown: { call_eur: 0.08, day_eur: 0.28, month_eur: 1.28, turn_count: 2 },
      budget_eur: 50,
      openai_month_usd: 12.5,
    });
    expect(text).toContain('rtc_x');
    expect(text).toContain('Diese call: 0.08 EUR (2 turns)');
    expect(text).toContain('Heute: 0.28 EUR | Diesen Monat: 1.28 EUR');
    expect(text).toContain('OpenAI org month-to-date: 11.63 EUR (12.50 USD)'); // 12.5 * 0.93 = 11.625 → toFixed(2) = "11.63"
    expect(text).toContain('Budget: 50.00 EUR/Mo — Rest:');
  });

  it('omits budget line when budget unset', () => {
    const text = formatCallSummary({
      call_id: 'rtc_x',
      breakdown: { call_eur: 0.08, day_eur: 0.28, month_eur: 1.28, turn_count: 2 },
      openai_month_usd: 12.5,
    });
    expect(text).not.toMatch(/Budget:/);
    expect(text).toContain('OpenAI org month-to-date');
  });

  it('shows ueberschritten warning when month > budget', () => {
    const text = formatCallSummary({
      call_id: 'rtc_x',
      breakdown: { call_eur: 0.08, day_eur: 0.28, month_eur: 1.28, turn_count: 2 },
      budget_eur: 5,
      openai_month_usd: 12.5, // 11.62 EUR > 5 EUR
    });
    expect(text).toContain('BUDGET');
    expect(text).toContain('-6.63 EUR'); // 5 - 11.63 = -6.63
  });

  it('shows fetch-failed line when OpenAI cost not available', () => {
    const text = formatCallSummary({
      call_id: 'rtc_x',
      breakdown: { call_eur: 0.08, day_eur: 0.28, month_eur: 1.28, turn_count: 2 },
      openai_fetch_failed: true,
    });
    expect(text).toContain('OpenAI org-cost: nicht abrufbar');
    expect(text).not.toContain('OpenAI org month-to-date');
  });
});

describe('voice_finalize_call_cost handler', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    _resetActiveSet();
  });

  it('always deregisters, even when summary path fails', async () => {
    registerActiveCall('rtc_a');
    expect(isCallActive('rtc_a')).toBe(true);

    const sendDiscord = vi.fn().mockRejectedValue(new Error('discord 500'));
    const handler = makeVoiceFinalizeCallCost({
      db,
      sendDiscordMessage: sendDiscord,
      discordChannelId: 'ch1',
      readConfig: () => ({}),
      fetchOpenaiMonthUsd: vi
        .fn()
        .mockResolvedValue({ usd: 0, cache_age_s: 0, window_start: '', fetched_at: '' }),
    });
    const r = await handler({ call_id: 'rtc_a' });
    expect(r).toMatchObject({ ok: true, result: { deregistered: true } });
    expect(isCallActive('rtc_a')).toBe(false);
  });

  it('skips Discord post when sendDiscordMessage omitted (still deregisters)', async () => {
    registerActiveCall('rtc_b');
    const handler = makeVoiceFinalizeCallCost({ db });
    const r = await handler({ call_id: 'rtc_b' });
    expect(r).toMatchObject({ ok: true });
    expect(isCallActive('rtc_b')).toBe(false);
  });

  it('posts the formatted summary when wired up', async () => {
    seedTurns(db, 'rtc_c');
    const sendDiscord = vi.fn().mockResolvedValue(undefined);
    const handler = makeVoiceFinalizeCallCost({
      db,
      now: () => NOW,
      sendDiscordMessage: sendDiscord,
      discordChannelId: 'ch-summary',
      readConfig: () => ({ monthly_budget_eur: 50 }),
      fetchOpenaiMonthUsd: vi
        .fn()
        .mockResolvedValue({
          usd: 12.5,
          cache_age_s: 0,
          window_start: '2026-05-01T00:00:00.000Z',
          fetched_at: NOW.toISOString(),
        }),
    });
    await handler({ call_id: 'rtc_c' });
    expect(sendDiscord).toHaveBeenCalledTimes(1);
    const [channelId, text] = sendDiscord.mock.calls[0];
    expect(channelId).toBe('ch-summary');
    expect(text).toContain('Diese call: 0.08 EUR');
    expect(text).toContain('Budget: 50.00 EUR/Mo — Rest:');
  });

  it('degrades gracefully when OpenAI fetch fails (still posts ledger summary)', async () => {
    seedTurns(db, 'rtc_d');
    const sendDiscord = vi.fn().mockResolvedValue(undefined);
    const handler = makeVoiceFinalizeCallCost({
      db,
      now: () => NOW,
      sendDiscordMessage: sendDiscord,
      discordChannelId: 'ch1',
      readConfig: () => ({}),
      fetchOpenaiMonthUsd: vi
        .fn()
        .mockRejectedValue(new Error('admin key invalid')),
    });
    await handler({ call_id: 'rtc_d' });
    const [, text] = sendDiscord.mock.calls[0];
    expect(text).toContain('Diese call: 0.08 EUR');
    expect(text).toContain('OpenAI org-cost: nicht abrufbar');
  });
});
