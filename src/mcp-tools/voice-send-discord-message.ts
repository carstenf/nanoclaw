import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_DEDUP_TTL_MS = parseInt(
  process.env.SEND_DISCORD_DEDUP_TTL_MS ?? '300000',
  10,
);

// REQ-TOOLS-03: args {channel: snowflake, content: 1..4000}
export const SendDiscordMessageSchema = z.object({
  call_id: z.string().optional(),
  channel: z.string().regex(/^\d{17,20}$/, 'invalid snowflake'),
  content: z.string().min(1).max(4000),
});

// In-memory dedup map: channel+sha256(content) → timestamp
const dedupMap = new Map<string, number>();

export interface VoiceSendDiscordMessageDeps {
  sendDiscordMessage: (
    channelId: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  allowedChannels: Set<string>;
  jsonlPath?: string;
  timeoutMs?: number;
  now?: () => number;
  dedupTtlMs?: number;
}

export function makeVoiceSendDiscordMessage(
  deps: VoiceSendDiscordMessageDeps,
): ToolHandler {
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-discord.jsonl');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const dedupTtlMs = deps.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS;

  return async function voiceSendDiscordMessage(
    args: unknown,
  ): Promise<unknown> {
    // Zod parse — REQ-TOOLS-03 shape
    const parseResult = SendDiscordMessageSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstError?.path?.[0] ?? 'input'),
        firstError?.message ?? 'invalid',
      );
    }

    const { call_id, channel, content } = parseResult.data;

    // Allowlist check — deny-all if channel not in set
    if (!deps.allowedChannels.has(channel)) {
      throw new BadRequestError('channel', 'channel_not_allowed');
    }

    // Content hash for dedup + JSONL (first 8 hex chars)
    const contentHash = crypto
      .createHash('sha256')
      .update(content)
      .digest('hex');
    const contentHashShort = contentHash.slice(0, 8);
    const dedupKey = `${channel}:${contentHash}`;

    const start = now();

    // Idempotency: check dedup map
    const lastSent = dedupMap.get(dedupKey);
    if (lastSent !== undefined && now() - lastSent < dedupTtlMs) {
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'discord_message_deduplicated',
        tool: 'voice.send_discord_message',
        call_id: call_id ?? null,
        channel,
        content_hash: contentHashShort,
        latency_ms: now() - start,
      });
      return { ok: true, result: { ok: true } };
    }

    // AbortController for timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: { ok: true } | { ok: false; error: string };
    try {
      const sendPromise = deps.sendDiscordMessage(channel, content);
      const abortPromise = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
      res = await Promise.race([sendPromise, abortPromise]);
    } catch (err) {
      clearTimeout(timer);
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('Aborted'));
      if (isAbort) {
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'discord_message_failed',
          tool: 'voice.send_discord_message',
          call_id: call_id ?? null,
          channel,
          content_hash: contentHashShort,
          latency_ms: now() - start,
          error: 'discord_timeout',
        });
        return { ok: false, error: 'discord_timeout' };
      }
      logger.warn({ event: 'voice_send_discord_error', err });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'discord_message_failed',
        tool: 'voice.send_discord_message',
        call_id: call_id ?? null,
        channel,
        content_hash: contentHashShort,
        latency_ms: now() - start,
        error: 'internal',
      });
      return { ok: false, error: 'internal' };
    }
    clearTimeout(timer);

    if (!res.ok) {
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'discord_message_failed',
        tool: 'voice.send_discord_message',
        call_id: call_id ?? null,
        channel,
        content_hash: contentHashShort,
        latency_ms: now() - start,
        error: res.error,
      });
      return { ok: false, error: res.error };
    }

    // Record in dedup map
    dedupMap.set(dedupKey, now());

    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'discord_message_sent',
      tool: 'voice.send_discord_message',
      call_id: call_id ?? null,
      channel,
      content_hash: contentHashShort,
      latency_ms: now() - start,
    });

    return { ok: true, result: { ok: true } };
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
