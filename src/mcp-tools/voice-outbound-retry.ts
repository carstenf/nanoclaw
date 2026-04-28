// src/mcp-tools/voice-outbound-retry.ts
// Step 2C (open_points 2026-04-28): voice_outbound_schedule_retry — generic
// retry-scheduling MCP tool for ANY outbound voicemail/no-answer.
//
// Why a separate tool from voice_case_2_schedule_retry:
//   - voice_case_2_schedule_retry requires `calendar_date` + `idempotency_key`
//     (sourced from voice_start_case_2_call's restaurant booking digest).
//     voice_request_outbound_call (Andy's unified outbound entry) has no
//     such structured fields — only target_phone + goal text.
//   - Generalizing voice_case_2 in-place would break the Case-2 chaining
//     contract (multiple attempts share one idempotency_key for the same
//     booking). The clean separation lets both coexist until Step 3 collapses
//     them into one canonical tool.
//
// Implementation: thin wrapper around voice_case_2_schedule_retry. Synthesises
// today's calendar_date and a fresh idempotency_key per attempt, then
// delegates. Fresh keys per attempt sidestep the UNIQUE constraint on
// voice_case_2_attempts.idempotency_key — generic outbound retries do not
// need cross-attempt chaining (each is its own atomic retry of "reach this
// person at this number").
//
// Same 5/15/45/120-min ladder + 5/day cap as case_2 (config.ts
// CASE_2_RETRY_LADDER_MIN + CASE_2_DAILY_CAP, shared until Step 3 renames).
import crypto from 'crypto';

import { z } from 'zod';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_outbound_schedule_retry' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

// Generic outbound retry schema — no calendar_date, no idempotency_key.
// prev_outcome enum mirrors voice_case_2_schedule_retry's plus 'silence' for
// AMD-silence verdicts the case_2 path didn't enumerate.
export const VoiceOutboundScheduleRetrySchema = z.object({
  call_id: z.string().optional(),
  target_phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'target_phone must be E.164'),
  prev_outcome: z
    .enum(['no_answer', 'busy', 'voicemail', 'silence', 'out_of_tolerance'])
    .optional(),
});

export type VoiceOutboundScheduleRetryInput = z.infer<
  typeof VoiceOutboundScheduleRetrySchema
>;

export interface VoiceOutboundScheduleRetryDeps {
  /**
   * The voice_case_2_schedule_retry handler — invoked with synthesised
   * calendar_date + idempotency_key. Provided via DI so unit tests can stub
   * the cap/ladder/scheduler chain.
   */
  scheduleCase2Retry: (args: unknown) => Promise<unknown>;
  /** Injectable clock for testing — defaults to Date.now. */
  now?: () => number;
}

/**
 * Synthesise today's calendar_date in Europe/Berlin local time as YYYY-MM-DD.
 * Pinning to Berlin matches the case_2 invariant (calendar_date is always
 * local Berlin date) so the daily-cap counter shares the same bucket whether
 * the booking was case_2 or generic outbound.
 */
function todayBerlinIso(now: number): string {
  // toLocaleDateString with explicit timeZone produces a stable date string
  // independent of host TZ. Format normalised to YYYY-MM-DD.
  const dt = new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
  // 'en-CA' yields YYYY-MM-DD already.
  return parts;
}

/**
 * Mint a fresh idempotency_key per attempt. UNIQUE on
 * voice_case_2_attempts.idempotency_key forbids reusing a key, so generic
 * outbound retries each get their own digest of (phone | iso-ts | random).
 * 64 lowercase hex chars to satisfy voice_case_2_schedule_retry's regex.
 */
function freshIdempotencyKey(targetPhone: string, now: number): string {
  const random = crypto.randomBytes(16).toString('hex');
  return crypto
    .createHash('sha256')
    .update(`${targetPhone}|${now}|${random}`)
    .digest('hex');
}

export function makeVoiceOutboundScheduleRetry(
  deps: VoiceOutboundScheduleRetryDeps,
): ToolHandler {
  const nowFn = deps.now ?? (() => Date.now());

  return async function voiceOutboundScheduleRetry(args: unknown) {
    const parseResult = VoiceOutboundScheduleRetrySchema.safeParse(args);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstIssue?.path?.[0] ?? 'input'),
        firstIssue?.message ?? 'invalid',
      );
    }

    const { call_id, target_phone, prev_outcome } = parseResult.data;
    const now = nowFn();
    const calendar_date = todayBerlinIso(now);
    const idempotency_key = freshIdempotencyKey(target_phone, now);

    // Map 'silence' (Step 2A AMD verdict) to 'voicemail' for the case_2
    // schema — the case_2 enum doesn't include 'silence' yet. Treats
    // silence-after-pickup the same as voicemail for retry scheduling
    // (counts as a failed attempt, keeps the ladder progressing).
    const mappedOutcome =
      prev_outcome === 'silence' ? 'voicemail' : prev_outcome;

    return deps.scheduleCase2Retry({
      call_id,
      target_phone,
      calendar_date,
      idempotency_key,
      ...(mappedOutcome ? { prev_outcome: mappedOutcome } : {}),
    });
  };
}
