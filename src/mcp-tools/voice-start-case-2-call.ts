// src/mcp-tools/voice-start-case-2-call.ts
// Plan 05-02 Task 3 (GREEN): voice_start_case_2_call MCP tool.
//
// Accepts D-5 structured args (restaurant booking request), computes D-7
// idempotency key, checks for duplicate, inserts into voice_case_2_attempts,
// then forwards to Bridge /outbound with case_type='case_2'.
//
// D-7 revised 2026-04-20: call_id_originating_session EXCLUDED from the
// idempotency key — only phone+date+time+party_size are hashed. See code
// comment on computeIdempotencyKey() below.
//
// This tool is Core-MCP-only. NOT in Bridge allowlist (REQ-TOOLS-09 = 15).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { DATA_DIR, CASE_2_TIME_TOLERANCE_MIN_DEFAULT, CASE_2_PARTY_SIZE_TOLERANCE_DEFAULT } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

// Tool-name regex compliance validated at module load (D-4 locked constraint).
export const TOOL_NAME = 'voice_start_case_2_call' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

// REQ-C2-01: D-5 locked arg shape.
export const VoiceStartCase2CallSchema = z.object({
  call_id: z.string().optional(),
  restaurant_name: z.string().min(1).max(120),
  restaurant_phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'target_phone must be E.164 (+NNNN...)'),
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'requested_date must be YYYY-MM-DD'),
  requested_time: z.string().regex(/^\d{2}:\d{2}$/, 'requested_time must be HH:MM'),
  time_tolerance_min: z.number().int().min(0).max(240).default(CASE_2_TIME_TOLERANCE_MIN_DEFAULT),
  party_size: z.number().int().min(1).max(40),
  party_size_tolerance: z.number().int().min(0).max(10).default(CASE_2_PARTY_SIZE_TOLERANCE_DEFAULT),
  notes: z.string().max(500).optional(),
  // Source-address field — included if SPIKE-D chose option (b); optional otherwise.
  source_address: z.string().min(3).max(200).optional(),
  report_to_jid: z.string(),
});

export type VoiceStartCase2CallInput = z.infer<typeof VoiceStartCase2CallSchema>;

export type VoiceStartCase2CallResult =
  | {
      ok: true;
      result: {
        task_id: string;
        idempotency_key: string;
        duplicate: boolean;
        queue_position: number;
        /**
         * Phase 05.4 Block-1 follow-up: REQ-C6B-07 extension clause — when a
         * tool call's D-7 idempotency key matches an already-registered
         * attempt, the existing call identifier is returned here instead of
         * a new call being placed. `null` when `duplicate === false` (fresh
         * attempt), or when the existing row has no `originating_call_id`
         * (pre-Phase-05.4 records written before the field was wired
         * through).
         */
        existing_call_id: string | null;
      };
    }
  | { ok: false; error: 'already_booked' | 'queue_full' | 'bad_request' | 'internal' };

export interface VoiceStartCase2CallDeps {
  getDatabase: () => Database.Database;
  /** Bridge base URL, e.g. http://10.0.0.2:4402 */
  bridgeUrl: string;
  /** Optional Bearer token for /outbound. */
  bridgeAuthToken?: string;
  /** Injectable fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** JSONL path for PII-clean audit log. */
  jsonlPath?: string;
  /** Clock override for tests. */
  now?: () => number;
  /** Fetch timeout in ms (default 5000). */
  timeoutMs?: number;
}

// ---- PII helpers ----

function maskPhone(phone: string): string {
  if (phone.length <= 7) return phone.slice(0, 3) + '***';
  return phone.slice(0, 4) + '***' + phone.slice(-4);
}

function hashPhone(phone: string): string {
  return crypto.createHash('sha256').update(phone).digest('hex').slice(0, 12);
}

// ---- D-7 idempotency key (authoritative — D-7 revised 2026-04-20) ----
//
// D-7 revised 2026-04-20: call_id_originating_session EXCLUDED.
// Key is sha256(restaurant_phone + '|' + requested_date + '|' + requested_time + '|' + party_size).
// Rationale: the booking tuple (phone, date, time, party_size) uniquely identifies a
// reservation request. Including call_id would allow bypassing idempotency by using a
// different call_id for the same booking — that's the regression this revision prevents.
function computeIdempotencyKey(args: {
  restaurant_phone: string;
  requested_date: string;
  requested_time: string;
  party_size: number;
}): string {
  const payload = `${args.restaurant_phone}|${args.requested_date}|${args.requested_time}|${args.party_size}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
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
export function makeVoiceStartCase2Call(deps: VoiceStartCase2CallDeps): ToolHandler {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-case-2-start.jsonl');
  const nowFn = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? 5000;

  return async function voiceStartCase2Call(args: unknown): Promise<VoiceStartCase2CallResult> {
    const start = nowFn();

    // Zod parse — D-5 shape
    const parseResult = VoiceStartCase2CallSchema.safeParse(args);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstIssue?.path?.[0] ?? 'input'),
        firstIssue?.message ?? 'invalid',
      );
    }

    const {
      call_id,
      restaurant_name,
      restaurant_phone,
      requested_date,
      requested_time,
      time_tolerance_min,
      party_size,
      party_size_tolerance,
      notes,
      source_address,
      report_to_jid,
    } = parseResult.data;

    const phoneMask = maskPhone(restaurant_phone);
    const phoneHash = hashPhone(restaurant_phone);

    // D-7: compute idempotency key — excludes call_id per revised D-7 (2026-04-20)
    const idempotency_key = computeIdempotencyKey({
      restaurant_phone,
      requested_date,
      requested_time,
      party_size,
    });

    // DB access
    let db: Database.Database;
    try {
      db = deps.getDatabase();
    } catch (err) {
      logger.warn({ event: 'voice_start_case_2_db_error', err });
      return { ok: false, error: 'internal' };
    }

    // Duplicate detection: SELECT from voice_case_2_attempts WHERE idempotency_key=?
    // Phase 05.4 Block-1 follow-up: REQ-C6B-07 extension mandates returning
    // the existing `call_id` when a duplicate is detected (not just a
    // `duplicate:true` sentinel). SELECT originating_call_id alongside
    // outcome so Andy can reference the prior booking in his Carsten-facing
    // reply ("Schon gebucht, call XYZ").
    let existingRow:
      | { outcome: string | null; originating_call_id: string | null }
      | undefined;
    try {
      existingRow = db
        .prepare(
          'SELECT outcome, originating_call_id FROM voice_case_2_attempts WHERE idempotency_key=? LIMIT 1',
        )
        .get(idempotency_key) as
        | { outcome: string | null; originating_call_id: string | null }
        | undefined;
    } catch (err) {
      logger.warn({ event: 'voice_start_case_2_db_error', err });
      return { ok: false, error: 'internal' };
    }

    if (existingRow !== undefined) {
      // Duplicate detected — return ok:true with duplicate:true for Andy UX
      // (Andy can inform Carsten without treating it as an error) + carry
      // the existing_call_id per REQ-C6B-07 duplicate clause.
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'case_2_start_duplicate',
        call_id: call_id ?? null,
        phone_mask: phoneMask,
        phone_hash: phoneHash,
        idempotency_key,
        existing_outcome: existingRow.outcome,
        existing_call_id: existingRow.originating_call_id,
        latency_ms: nowFn() - start,
      });
      return {
        ok: true,
        result: {
          task_id: 'duplicate',
          idempotency_key,
          duplicate: true,
          queue_position: 0,
          existing_call_id: existingRow.originating_call_id,
        },
      };
    }

    // Plan 05.1-04 defect #5: allocate attempt_no transactionally so same (phone, date)
    // with different idempotency_keys (e.g. lunch + dinner at same restaurant) both
    // succeed. Pattern mirrors src/mcp-tools/voice-case-2-retry.ts:155-184.
    // D-7 preserved: idempotency_key dedupe happens at lines 163-197 (above) before
    // this block; this INSERT runs only when we know the key is NEW.
    //
    // Safe: voice-start-case-2-call is only called from a fresh MCP request handler;
    // no enclosing transaction context exists. See RESEARCH §8 Pitfall 4.
    const created_at = new Date(nowFn()).toISOString();
    const scheduled_for = created_at; // will be set by Bridge when call is placed

    let attempt_no = 1;
    try {
      const tx = db.transaction(() => {
        const row = db
          .prepare(
            `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_attempt_no
             FROM voice_case_2_attempts
             WHERE target_phone=? AND calendar_date=?`,
          )
          .get(restaurant_phone, requested_date) as { next_attempt_no: number };
        attempt_no = row.next_attempt_no;

        db.prepare(
          `INSERT INTO voice_case_2_attempts
             (target_phone, calendar_date, attempt_no, scheduled_for, idempotency_key,
              originating_call_id, restaurant_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          restaurant_phone,
          requested_date,
          attempt_no,
          scheduled_for,
          idempotency_key,
          call_id ?? null,
          restaurant_name,
          created_at,
        );
      });
      tx();
    } catch (err) {
      logger.warn({ event: 'voice_start_case_2_db_insert_error', err });
      return { ok: false, error: 'internal' };
    }

    // Build goal + context strings for Bridge /outbound
    const goal = `Tischreservierung bei ${restaurant_name} am ${requested_date} um ${requested_time} fuer ${party_size} Person(en). Toleranz: \u00b1${time_tolerance_min} Minuten.`;
    const context = `Notizen: ${notes ?? 'keine'}. Idempotency-Key: ${idempotency_key}.`;

    // All D-5 fields forwarded as case_payload for Wave 3 persona
    const case_payload: Record<string, unknown> = {
      restaurant_name,
      restaurant_phone,
      requested_date,
      requested_time,
      time_tolerance_min,
      party_size,
      party_size_tolerance,
      notes: notes ?? null,
      idempotency_key,
    };
    if (source_address) {
      case_payload.source_address = source_address;
    }

    // HTTP POST to Bridge /outbound
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let bridgeStatus = 0;
    let bridgeBody: unknown = null;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (deps.bridgeAuthToken) {
        headers['Authorization'] = `Bearer ${deps.bridgeAuthToken}`;
      }

      const res = await fetchFn(`${deps.bridgeUrl}/outbound`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          call_id,
          target_phone: restaurant_phone,
          goal,
          context,
          report_to_jid,
          case_type: 'case_2',
          case_payload,
        }),
        signal: ctrl.signal,
      });

      clearTimeout(timer);
      bridgeStatus = res.status;

      try {
        bridgeBody = await res.json();
      } catch {
        // ignore parse error
      }

      if (res.ok) {
        const resp = bridgeBody as Record<string, unknown>;
        const task_id = (resp.outbound_task_id as string | undefined) ?? '';
        const queue_position = (resp.queue_position as number | undefined) ?? 0;

        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'case_2_start_enqueued',
          call_id: call_id ?? null,
          phone_mask: phoneMask,
          phone_hash: phoneHash,
          idempotency_key,
          task_id,
          queue_position,
          latency_ms: nowFn() - start,
        });

        return {
          ok: true,
          result: {
            task_id,
            idempotency_key,
            duplicate: false,
            queue_position,
            existing_call_id: null,
          },
        };
      }

      // Error responses from Bridge
      const latency = nowFn() - start;
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'case_2_start_failed',
        call_id: call_id ?? null,
        phone_mask: phoneMask,
        phone_hash: phoneHash,
        idempotency_key,
        bridge_status: bridgeStatus,
        latency_ms: latency,
      });

      if (bridgeStatus === 400) return { ok: false, error: 'bad_request' };
      if (bridgeStatus === 429) return { ok: false, error: 'queue_full' };
      return { ok: false, error: 'internal' };
    } catch (err) {
      clearTimeout(timer);
      logger.warn({ event: 'voice_start_case_2_bridge_error', err });
      return { ok: false, error: 'internal' };
    }
  };
}
