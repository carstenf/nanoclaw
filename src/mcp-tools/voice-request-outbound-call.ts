import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

// ---- Schema ----

export const RequestOutboundCallSchema = z.object({
  call_id: z.string().optional(),
  target_phone: z
    .string()
    .regex(/^\+[1-9]\d{1,14}$/, 'target_phone must be E.164'),
  goal: z.string().min(1).max(500),
  context: z.string().max(2000).default(''),
  report_to_jid: z.string().min(1),
});

// ---- Deps ----

export interface VoiceRequestOutboundCallDeps {
  /** Bridge base URL, e.g. http://10.0.0.2:4402 */
  bridgeUrl: string;
  /** Optional Bearer token for /outbound (if configured on bridge). */
  bridgeAuthToken?: string;
  /** Injectable fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** JSONL path for audit log. */
  jsonlPath?: string;
  /** Clock override for tests. */
  now?: () => number;
  /** Fetch timeout in ms (default 5000). */
  timeoutMs?: number;
}

// ---- PII helper ----

/**
 * Mask phone number: first 3 digits + *** + last 4 digits.
 * E.g. +491234567890 → "+491***7890"
 */
function maskPhone(phone: string): string {
  if (phone.length <= 7) return phone.slice(0, 3) + '***';
  return phone.slice(0, 4) + '***' + phone.slice(-4);
}

// ---- Implementation ----

export function makeVoiceRequestOutboundCall(
  deps: VoiceRequestOutboundCallDeps,
): ToolHandler {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-outbound.jsonl');
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? 5000;

  return async function voiceRequestOutboundCall(
    args: unknown,
  ): Promise<unknown> {
    const start = now();

    // Zod parse
    const parseResult = RequestOutboundCallSchema.safeParse(args);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }

    const { call_id, target_phone, goal, context, report_to_jid } =
      parseResult.data;

    const phoneMask = maskPhone(target_phone);
    const phoneHash = crypto
      .createHash('sha256')
      .update(target_phone)
      .digest('hex')
      .slice(0, 12);

    // Build request with timeout
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let bridgeStatus = 0;
    let bridgeBody: unknown = null;

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (deps.bridgeAuthToken) {
        headers['Authorization'] = `Bearer ${deps.bridgeAuthToken}`;
      }

      const res = await fetchFn(`${deps.bridgeUrl}/outbound`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          call_id,
          target_phone,
          goal,
          context,
          report_to_jid,
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

      // Success
      if (res.ok) {
        const resp = bridgeBody as Record<string, unknown>;
        const latency = now() - start;
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'outbound_call_requested',
          tool: 'voice.request_outbound_call',
          call_id: call_id ?? null,
          target_phone_hash: phoneHash,
          phone_mask: phoneMask,
          goal_len: goal.length,
          context_len: context.length,
          outbound_task_id: resp.outbound_task_id ?? null,
          latency_ms: latency,
        });
        return {
          ok: true,
          result: {
            queued: true,
            outbound_task_id: resp.outbound_task_id,
            estimated_start_ts: resp.estimated_start_ts,
          },
        };
      }

      // Error responses
      const latency = now() - start;
      const errBody = bridgeBody as Record<string, unknown> | null;

      if (bridgeStatus === 400) {
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'outbound_call_failed',
          tool: 'voice.request_outbound_call',
          call_id: call_id ?? null,
          target_phone_hash: phoneHash,
          goal_len: goal.length,
          context_len: context.length,
          error: 'bad_request',
          bridge_status: bridgeStatus,
          latency_ms: latency,
        });
        return { ok: false, error: 'bad_request', detail: errBody };
      }

      if (bridgeStatus === 401) {
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'outbound_call_failed',
          tool: 'voice.request_outbound_call',
          call_id: call_id ?? null,
          target_phone_hash: phoneHash,
          goal_len: goal.length,
          context_len: context.length,
          error: 'unauthorized',
          bridge_status: bridgeStatus,
          latency_ms: latency,
        });
        return { ok: false, error: 'unauthorized' };
      }

      if (bridgeStatus === 429) {
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'outbound_call_failed',
          tool: 'voice.request_outbound_call',
          call_id: call_id ?? null,
          target_phone_hash: phoneHash,
          goal_len: goal.length,
          context_len: context.length,
          error: 'queue_full',
          bridge_status: bridgeStatus,
          latency_ms: latency,
        });
        return { ok: false, error: 'queue_full' };
      }

      // 5xx or other
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'outbound_call_failed',
        tool: 'voice.request_outbound_call',
        call_id: call_id ?? null,
        target_phone_hash: phoneHash,
        goal_len: goal.length,
        context_len: context.length,
        error: 'tool_unavailable',
        bridge_status: bridgeStatus,
        latency_ms: latency,
      });
      return { ok: false, error: 'tool_unavailable' };
    } catch (err) {
      clearTimeout(timer);
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('aborted'));
      const latency = now() - start;
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'outbound_call_failed',
        tool: 'voice.request_outbound_call',
        call_id: call_id ?? null,
        target_phone_hash: phoneHash,
        goal_len: goal.length,
        context_len: context.length,
        error: 'tool_unavailable',
        reason: isAbort ? 'timeout' : 'network_error',
        latency_ms: latency,
      });
      return { ok: false, error: 'tool_unavailable' };
    }
  };
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}
