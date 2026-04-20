import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR, VOICE_NOTIFY_LONG_TEXT_WORD_THRESHOLD } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

// Tool-name regex compliance validated at module load (D-4 locked constraint).
export const TOOL_NAME = 'voice_notify_user' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

// REQ-C2-04 / REQ-C2-05: zod schema — urgency enum locked to D-4 values.
export const VoiceNotifyUserSchema = z.object({
  call_id: z.string().optional(),
  turn_id: z.string().optional(),
  text: z.string().min(1).max(4000),
  urgency: z.enum(['info', 'decision', 'alert']),
  target_jid: z.string().optional(), // override — default = main group JID
});

export type VoiceNotifyUserInput = z.infer<typeof VoiceNotifyUserSchema>;

export type VoiceNotifyUserResult =
  | { ok: true; result: { routed_via: 'whatsapp' | 'discord'; delivered: true } }
  | { ok: false; error: 'no_main_group' | 'routing_failed' | 'long_text_but_no_discord' | 'internal' };

export interface VoiceNotifyUserDeps {
  /** Consult active-session-tracker for most-recently-active channel. */
  getActiveChannel: (jid: string, now: number) => 'whatsapp' | 'discord' | null;
  sendWhatsappMessage: (jid: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  sendDiscordMessage: (jid: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  /** Returns {folder, jid} for is_main=1 group, or null if no main group configured. */
  getMainGroupAndJid: () => { folder: string; jid: string } | null;
  isDiscordConnected: () => boolean;
  isWhatsappConnected: () => boolean;
  /** Override JSONL path (default: data/voice-notify.jsonl). */
  jsonlPath?: string;
  /** Injectable clock for testing. */
  now?: () => number;
  /** Override long-text threshold (default: VOICE_NOTIFY_LONG_TEXT_WORD_THRESHOLD). */
  longTextThreshold?: number;
}

/**
 * Count words using unicode-safe whitespace split.
 * Pitfall 3: use trim+split(/\s+/).filter(Boolean) — NOT text.split(' ').
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
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
export function makeVoiceNotifyUser(deps: VoiceNotifyUserDeps): ToolHandler {
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-notify.jsonl');
  const nowFn = deps.now ?? (() => Date.now());
  const threshold = deps.longTextThreshold ?? VOICE_NOTIFY_LONG_TEXT_WORD_THRESHOLD;

  return async function voiceNotifyUser(args: unknown): Promise<VoiceNotifyUserResult> {
    // Zod parse — fail fast with BadRequestError so MCP host sees a structured error.
    const parseResult = VoiceNotifyUserSchema.safeParse(args);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstIssue?.path?.[0] ?? 'input'),
        firstIssue?.message ?? 'invalid',
      );
    }

    const { call_id, turn_id, text, urgency, target_jid } = parseResult.data;
    const start = nowFn();

    // Resolve target JID: explicit override or main group.
    const mainGroup = deps.getMainGroupAndJid();
    if (!mainGroup) {
      logger.warn({ event: 'voice_notify_user_no_main_group', call_id });
      return { ok: false, error: 'no_main_group' };
    }
    const jid = target_jid ?? mainGroup.jid;

    const wordCount = countWords(text);

    // Routing decision — three-step rule per <interfaces>:
    // 1. Long-text override: >threshold words → force Discord.
    // 2. Active-session lookup.
    // 3. Fallback: attempt Discord if connected, else fail.

    let routeDecision: 'whatsapp' | 'discord' | null = null;
    let reason: string | undefined;

    if (wordCount > threshold) {
      // Step 1: long-text override — MUST be discord even if active=whatsapp.
      routeDecision = 'discord';
      reason = 'long_text_override';
    } else {
      // Step 2: consult active-session tracker.
      const activeChannel = deps.getActiveChannel(jid, start);
      if (activeChannel === 'whatsapp' && deps.isWhatsappConnected()) {
        routeDecision = 'whatsapp';
        reason = 'active_session';
      } else if (activeChannel === 'discord' && deps.isDiscordConnected()) {
        routeDecision = 'discord';
        reason = 'active_session';
      } else if (deps.isDiscordConnected()) {
        // Step 3: fallback to Discord.
        routeDecision = 'discord';
        reason = 'no_whatsapp_fallback';
      }
    }

    // No viable route.
    if (!routeDecision) {
      logger.warn({ event: 'voice_notify_user_no_route', call_id, urgency });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'voice_notify_user_routed',
        call_id: call_id ?? null,
        turn_id: turn_id ?? null,
        urgency,
        word_count: wordCount,
        routed_via: null,
        delivered: false,
        reason: 'no_channel',
        latency_ms: nowFn() - start,
      });
      return { ok: false, error: 'routing_failed' };
    }

    // Deliver.
    let deliveryResult: { ok: boolean; error?: string };
    if (routeDecision === 'whatsapp') {
      deliveryResult = await deps.sendWhatsappMessage(jid, text);
    } else {
      deliveryResult = await deps.sendDiscordMessage(jid, text);
    }

    const latencyMs = nowFn() - start;

    if (!deliveryResult.ok) {
      logger.warn({
        event: 'voice_notify_user_delivery_failed',
        call_id,
        routed_via: routeDecision,
        error: deliveryResult.error,
      });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'voice_notify_user_routed',
        call_id: call_id ?? null,
        turn_id: turn_id ?? null,
        urgency,
        word_count: wordCount,
        routed_via: routeDecision,
        delivered: false,
        reason,
        latency_ms: latencyMs,
      });
      return { ok: false, error: 'routing_failed' };
    }

    logger.info({
      event: 'voice_notify_user_routed',
      call_id: call_id ?? null,
      routed_via: routeDecision,
      urgency,
      word_count: wordCount,
      reason,
    });
    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'voice_notify_user_routed',
      call_id: call_id ?? null,
      turn_id: turn_id ?? null,
      urgency,
      word_count: wordCount,
      routed_via: routeDecision,
      delivered: true,
      reason,
      latency_ms: latencyMs,
    });

    return { ok: true, result: { routed_via: routeDecision, delivered: true } };
  };
}
