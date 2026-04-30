// src/mcp-tools/voice-outbound-retry.ts
// voice_outbound_schedule_retry — canonical retry-scheduling MCP tool for any
// outbound voicemail/no-answer/busy. Step 3 Phase A3 (open_points 2026-04-30)
// inlined the former voice_case_2_schedule_retry implementation here, so this
// is the single source for the 5/15/45/120-min ladder + 5/day cap.
//
// Behaviour:
//   - Daily cap: max CASE_2_DAILY_CAP attempts per (target_phone, calendar_date).
//   - Ladder: 5/15/45/120 min offsets for attempts 1→2, 2→3, 3→4, 4→5.
//   - retry_at override: bypass the ladder when the voicemail-analyzer extracted
//     a concrete re-opening time. calendar_date is derived from retry_at
//     (Berlin local) so a "tomorrow 09:00" override lands in tomorrow's bucket.
//   - INSERT OR FAIL with up-to-10 PK retries (concurrent-call race protection).
//   - JSONL audit trail at data/voice-outbound-retry.jsonl.
//   - Delegates to TOOLS-07 voice_schedule_retry for the actual scheduling.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import {
  CASE_2_RETRY_LADDER_MIN,
  CASE_2_DAILY_CAP,
  DATA_DIR,
} from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_outbound_schedule_retry' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

export const VoiceOutboundScheduleRetrySchema = z.object({
  call_id: z.string().optional(),
  target_phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'target_phone must be E.164'),
  prev_outcome: z
    .enum(['no_answer', 'busy', 'voicemail', 'silence', 'out_of_tolerance'])
    .optional(),
  /**
   * Smart-retry override (open_points 2026-04-29). When set, the retry is
   * scheduled at this exact ISO timestamp instead of running through the
   * 5/15/45/120 ladder. calendar_date for the daily-cap bucket is derived
   * from retry_at in Europe/Berlin local time so a "tomorrow 9 am" override
   * lands in tomorrow's bucket (not today's).
   */
  retry_at: z.string().datetime({ offset: true }).optional(),
});

export type VoiceOutboundScheduleRetryInput = z.infer<
  typeof VoiceOutboundScheduleRetrySchema
>;

export type VoiceOutboundScheduleRetryResult =
  | { ok: true; result: { scheduled: true; attempt_no: number; not_before_ts: string } }
  | { ok: false; error: 'daily_cap_reached' | 'db_error' | 'schedule_retry_failed' | 'internal' };

export interface VoiceOutboundScheduleRetryDeps {
  /** Accessor to the SQLite DB (same DI pattern as other Phase-5 tools). */
  getDatabase: () => Database.Database;
  /** TOOLS-07 voice_schedule_retry handler — this tool wraps it. */
  scheduleRetry: (args: unknown) => Promise<unknown>;
  /** JSONL path for audit trail. Default DATA_DIR/voice-outbound-retry.jsonl. */
  jsonlPath?: string;
  /** Injectable clock for testing. */
  now?: () => number;
}

/**
 * Format a calendar_date in Europe/Berlin local time as YYYY-MM-DD. Used both
 * for "today" (no retry_at override) and for retry_at-derived buckets so a
 * smart-retry override at "tomorrow 09:00" counts against tomorrow's daily-cap
 * bucket, not today's.
 */
function berlinIsoDate(epochMs: number): string {
  const dt = new Date(epochMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
  return parts;
}

/**
 * Mint a fresh idempotency_key per attempt. UNIQUE on
 * voice_case_2_attempts.idempotency_key forbids reusing a key, so each retry
 * gets a digest of (phone | iso-ts | random). 64 lowercase hex.
 */
function freshIdempotencyKey(targetPhone: string, now: number): string {
  const random = crypto.randomBytes(16).toString('hex');
  return crypto
    .createHash('sha256')
    .update(`${targetPhone}|${now}|${random}`)
    .digest('hex');
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}

export function makeVoiceOutboundScheduleRetry(
  deps: VoiceOutboundScheduleRetryDeps,
): ToolHandler {
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-outbound-retry.jsonl');
  const nowFn = deps.now ?? (() => Date.now());

  return async function voiceOutboundScheduleRetry(
    args: unknown,
  ): Promise<VoiceOutboundScheduleRetryResult> {
    const parseResult = VoiceOutboundScheduleRetrySchema.safeParse(args);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstIssue?.path?.[0] ?? 'input'),
        firstIssue?.message ?? 'invalid',
      );
    }

    const { call_id, target_phone, prev_outcome, retry_at } = parseResult.data;
    const now = nowFn();

    // calendar_date derives from retry_at when provided so a "tomorrow 9 am"
    // smart-retry counts against tomorrow's daily-cap bucket.
    const calendar_date = retry_at
      ? berlinIsoDate(Date.parse(retry_at))
      : berlinIsoDate(now);
    const idempotency_key = freshIdempotencyKey(target_phone, now);

    // Map 'silence' (Step 2A AMD verdict) to 'voicemail' for outcome storage —
    // legacy enum doesn't include 'silence'; treat as voicemail.
    const mappedOutcome =
      prev_outcome === 'silence' ? 'voicemail' : prev_outcome;

    let db: Database.Database;
    try {
      db = deps.getDatabase();
    } catch (err) {
      logger.warn({ event: 'voice_outbound_retry_db_error', err });
      return { ok: false, error: 'db_error' };
    }

    // Step 1: COUNT existing attempts for this (phone, date)
    let count: number;
    try {
      const row = db
        .prepare(
          'SELECT COUNT(*) as n FROM voice_case_2_attempts WHERE target_phone=? AND calendar_date=?',
        )
        .get(target_phone, calendar_date) as { n: number };
      count = row.n;
    } catch (err) {
      logger.warn({ event: 'voice_outbound_retry_db_error', err });
      return { ok: false, error: 'db_error' };
    }

    // Step 2: Daily cap check
    if (count >= CASE_2_DAILY_CAP) {
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'outbound_retry_daily_cap_reached',
        call_id: call_id ?? null,
        target_phone_hash: crypto.createHash('sha256').update(target_phone).digest('hex').slice(0, 12),
        calendar_date,
        count,
      });
      return { ok: false, error: 'daily_cap_reached' };
    }

    // Step 3: Compute attempt_no and ladder offset
    const attempt_no = count + 1;
    const ladder_idx = attempt_no - 1;

    // Defense-in-depth: ladder exhausted (attempt >= 5) → cap (only matters
    // when retry_at is NOT supplied; with an override, the ladder is bypassed
    // but cap still applies via Step 2 above).
    if (!retry_at && ladder_idx >= CASE_2_RETRY_LADDER_MIN.length) {
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'outbound_retry_daily_cap_reached',
        call_id: call_id ?? null,
        target_phone_hash: crypto.createHash('sha256').update(target_phone).digest('hex').slice(0, 12),
        calendar_date,
        count,
        reason: 'ladder_exhausted',
      });
      return { ok: false, error: 'daily_cap_reached' };
    }

    // Step 4: Compute not_before_ts. retry_at override bypasses the ladder.
    const not_before_ts = retry_at
      ? new Date(retry_at).toISOString()
      : new Date(now + CASE_2_RETRY_LADDER_MIN[ladder_idx]! * 60000).toISOString();
    const created_at = new Date(now).toISOString();

    // Step 5: INSERT OR FAIL — retry on PK collision (concurrent-call race).
    let insertedAttemptNo = attempt_no;
    let inserted = false;

    for (let r = 0; r < 10; r++) {
      try {
        db.prepare(
          `INSERT INTO voice_case_2_attempts
             (target_phone, calendar_date, attempt_no, scheduled_for, idempotency_key, created_at, outcome)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        ).run(target_phone, calendar_date, insertedAttemptNo, not_before_ts, idempotency_key, created_at);
        inserted = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('primary key')) {
          insertedAttemptNo++;
          if (insertedAttemptNo > CASE_2_DAILY_CAP) {
            return { ok: false, error: 'daily_cap_reached' };
          }
          continue;
        }
        logger.warn({ event: 'voice_outbound_retry_db_error', err });
        return { ok: false, error: 'db_error' };
      }
    }

    if (!inserted) {
      return { ok: false, error: 'db_error' };
    }

    // Step 6: Delegate to TOOLS-07 voice_schedule_retry
    let retryResult: unknown;
    try {
      retryResult = await deps.scheduleRetry({
        call_id,
        case_type: 'case_2',
        target_phone,
        not_before_ts,
      });
    } catch (err) {
      logger.warn({ event: 'voice_outbound_retry_tools07_error', err });
      try {
        db.prepare(
          `UPDATE voice_case_2_attempts SET outcome='schedule_failed'
           WHERE target_phone=? AND calendar_date=? AND attempt_no=?`,
        ).run(target_phone, calendar_date, insertedAttemptNo);
      } catch {
        /* best-effort */
      }
      return { ok: false, error: 'schedule_retry_failed' };
    }

    // Step 7: Check TOOLS-07 result
    const r = retryResult as { ok?: boolean };
    if (!r?.ok) {
      try {
        db.prepare(
          `UPDATE voice_case_2_attempts SET outcome='schedule_failed'
           WHERE target_phone=? AND calendar_date=? AND attempt_no=?`,
        ).run(target_phone, calendar_date, insertedAttemptNo);
      } catch {
        /* best-effort */
      }
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'outbound_retry_schedule_failed',
        call_id: call_id ?? null,
        target_phone_hash: crypto.createHash('sha256').update(target_phone).digest('hex').slice(0, 12),
        calendar_date,
        attempt_no: insertedAttemptNo,
        prev_outcome: mappedOutcome ?? null,
      });
      return { ok: false, error: 'schedule_retry_failed' };
    }

    // Step 8: Success
    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'outbound_retry_scheduled',
      call_id: call_id ?? null,
      target_phone_hash: crypto.createHash('sha256').update(target_phone).digest('hex').slice(0, 12),
      calendar_date,
      attempt_no: insertedAttemptNo,
      not_before_ts,
      prev_outcome: mappedOutcome ?? null,
      idempotency_key,
      retry_at_override: retry_at ?? null,
    });

    return {
      ok: true,
      result: {
        scheduled: true,
        attempt_no: insertedAttemptNo,
        not_before_ts,
      },
    };
  };
}
