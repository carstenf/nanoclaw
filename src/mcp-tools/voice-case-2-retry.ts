// src/mcp-tools/voice-case-2-retry.ts
// Plan 05-02 Task 2 (GREEN): voice_case_2_schedule_retry MCP tool.
//
// Wraps TOOLS-07 (voice_schedule_retry) with:
//   - Daily cap enforcement: max CASE_2_DAILY_CAP attempts per (target_phone, calendar_date)
//   - Retry ladder: 5/15/45/120 min offsets for attempts 1→2, 2→3, 3→4, 4→5
//   - INSERT OR FAIL with up-to-10 retries on PK collision (Pitfall-7 race protection)
//   - JSONL audit trail at data/voice-case-2-retry.jsonl
//
// This tool is Core-MCP-only. It is NOT registered in voice-bridge/src/tools/allowlist.ts
// (REQ-TOOLS-09 ceiling = 15, unchanged).
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

// Tool-name regex compliance validated at module load (D-4 locked constraint).
export const TOOL_NAME = 'voice_case_2_schedule_retry' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

// REQ-C2-02: zod schema for voice_case_2_schedule_retry args.
export const VoiceCase2ScheduleRetrySchema = z.object({
  call_id: z.string().optional(),
  target_phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'target_phone must be E.164'),
  calendar_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'calendar_date must be YYYY-MM-DD'),
  /** Reason this attempt failed, for audit + outcome field. */
  prev_outcome: z.enum(['no_answer', 'busy', 'voicemail', 'out_of_tolerance']).optional(),
  /** idempotency_key from voice_start_case_2_call — chains retries to the original booking. */
  idempotency_key: z.string().length(64).regex(/^[0-9a-f]{64}$/, 'idempotency_key must be 64 lowercase hex chars'),
});

export type VoiceCase2ScheduleRetryInput = z.infer<typeof VoiceCase2ScheduleRetrySchema>;

export type VoiceCase2ScheduleRetryResult =
  | { ok: true; result: { scheduled: true; attempt_no: number; not_before_ts: string } }
  | { ok: false; error: 'daily_cap_reached' | 'db_error' | 'schedule_retry_failed' | 'internal' };

export interface VoiceCase2ScheduleRetryDeps {
  /** Accessor to the SQLite DB (same DI pattern as other Phase-5 tools). */
  getDatabase: () => Database.Database;
  /** TOOLS-07 voice_schedule_retry handler — this tool wraps it, does NOT modify it. */
  scheduleRetry: (args: unknown) => Promise<unknown>;
  /** JSONL path for audit trail. Default: data/voice-case-2-retry.jsonl */
  jsonlPath?: string;
  /** Injectable clock for testing. */
  now?: () => number;
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}

/**
 * Factory — DI pattern mirrors voice-send-discord-message.ts.
 */
export function makeVoiceCase2ScheduleRetry(
  deps: VoiceCase2ScheduleRetryDeps,
): ToolHandler {
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-case-2-retry.jsonl');
  const nowFn = deps.now ?? (() => Date.now());

  return async function voiceCase2ScheduleRetry(
    args: unknown,
  ): Promise<VoiceCase2ScheduleRetryResult> {
    // Zod parse — fail fast
    const parseResult = VoiceCase2ScheduleRetrySchema.safeParse(args);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstIssue?.path?.[0] ?? 'input'),
        firstIssue?.message ?? 'invalid',
      );
    }

    const { call_id, target_phone, calendar_date, prev_outcome, idempotency_key } =
      parseResult.data;

    let db: Database.Database;
    try {
      db = deps.getDatabase();
    } catch (err) {
      logger.warn({ event: 'voice_case_2_retry_db_error', err });
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
      logger.warn({ event: 'voice_case_2_retry_db_error', err });
      return { ok: false, error: 'db_error' };
    }

    // Step 2: Daily cap check
    if (count >= CASE_2_DAILY_CAP) {
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'case_2_daily_cap_reached',
        call_id: call_id ?? null,
        target_phone_hash: crypto.createHash('sha256').update(target_phone).digest('hex').slice(0, 12),
        calendar_date,
        count,
      });
      return { ok: false, error: 'daily_cap_reached' };
    }

    // Steps 3-5: Compute attempt_no and ladder offset
    const attempt_no = count + 1;
    const ladder_idx = attempt_no - 1; // 0-based

    // Defense-in-depth: if ladder exhausted (attempt >= 5) → cap
    if (ladder_idx >= CASE_2_RETRY_LADDER_MIN.length) {
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'case_2_daily_cap_reached',
        call_id: call_id ?? null,
        target_phone_hash: crypto.createHash('sha256').update(target_phone).digest('hex').slice(0, 12),
        calendar_date,
        count,
        reason: 'ladder_exhausted',
      });
      return { ok: false, error: 'daily_cap_reached' };
    }

    // Step 6: Compute not_before_ts
    const ladderOffsetMs = CASE_2_RETRY_LADDER_MIN[ladder_idx]! * 60000;
    const not_before_ts = new Date(nowFn() + ladderOffsetMs).toISOString();
    const created_at = new Date(nowFn()).toISOString();

    // Step 7: INSERT OR FAIL — up to 10 retries on PK collision (Pitfall-7 race).
    // If another concurrent call already claimed this attempt_no, increment and retry.
    let insertedAttemptNo = attempt_no;
    let inserted = false;

    for (let retry = 0; retry < 10; retry++) {
      try {
        db.prepare(
          `INSERT INTO voice_case_2_attempts
             (target_phone, calendar_date, attempt_no, scheduled_for, idempotency_key, created_at, outcome)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        ).run(target_phone, calendar_date, insertedAttemptNo, not_before_ts, idempotency_key, created_at);
        inserted = true;
        break;
      } catch (err) {
        // PK collision — try next attempt_no
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('primary key')) {
          insertedAttemptNo++;
          // Re-check cap
          if (insertedAttemptNo > CASE_2_DAILY_CAP) {
            return { ok: false, error: 'daily_cap_reached' };
          }
          continue;
        }
        // Other DB error
        logger.warn({ event: 'voice_case_2_retry_db_error', err });
        return { ok: false, error: 'db_error' };
      }
    }

    if (!inserted) {
      return { ok: false, error: 'db_error' };
    }

    // Step 8: Delegate to TOOLS-07 voice_schedule_retry
    let retryResult: unknown;
    try {
      retryResult = await deps.scheduleRetry({
        call_id,
        case_type: 'case_2',
        target_phone,
        not_before_ts,
      });
    } catch (err) {
      logger.warn({ event: 'voice_case_2_retry_tools07_error', err });
      // Mark row as schedule_failed
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

    // Step 9: Check TOOLS-07 result
    const r = retryResult as { ok?: boolean };
    if (!r?.ok) {
      // Mark row as schedule_failed
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
        event: 'case_2_retry_schedule_failed',
        call_id: call_id ?? null,
        target_phone_hash: crypto.createHash('sha256').update(target_phone).digest('hex').slice(0, 12),
        calendar_date,
        attempt_no: insertedAttemptNo,
        prev_outcome: prev_outcome ?? null,
      });
      return { ok: false, error: 'schedule_retry_failed' };
    }

    // Step 10: Success
    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'case_2_retry_scheduled',
      call_id: call_id ?? null,
      target_phone_hash: crypto.createHash('sha256').update(target_phone).digest('hex').slice(0, 12),
      calendar_date,
      attempt_no: insertedAttemptNo,
      not_before_ts,
      prev_outcome: prev_outcome ?? null,
      idempotency_key,
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
