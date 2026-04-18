import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

const DEFAULT_TIMEOUT_MS = 8000;

const SendDiscordMessageSchema = z.object({
  call_id: z.string().optional(),
  channel_id: z.string().regex(/^\d{17,20}$/, 'invalid snowflake'),
  text: z.string().min(1).max(4000),
});

export interface VoiceSendDiscordMessageDeps {
  sendDiscordMessage: (channelId: string, text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  allowedChannels: Set<string>;
  jsonlPath?: string;
  timeoutMs?: number;
  now?: () => number;
}

export function makeVoiceSendDiscordMessage(deps: VoiceSendDiscordMessageDeps): ToolHandler {
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-discord.jsonl');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());

  return async function voiceSendDiscordMessage(args: unknown): Promise<unknown> {
    // Zod parse
    const parseResult = SendDiscordMessageSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstError?.path?.[0] ?? 'input'),
        firstError?.message ?? 'invalid',
      );
    }

    const { call_id, channel_id, text } = parseResult.data;

    // Allowlist check — deny-all if channel not in set
    if (!deps.allowedChannels.has(channel_id)) {
      throw new BadRequestError('channel_id', 'channel_not_allowed');
    }

    const start = now();
    const length = text.length;
    const chunks = Math.ceil(length / 2000);

    // AbortController for timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: { ok: true } | { ok: false; error: string };
    try {
      const sendPromise = deps.sendDiscordMessage(channel_id, text);
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
          channel_id,
          length,
          chunks,
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
        channel_id,
        length,
        chunks,
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
        channel_id,
        length,
        chunks,
        latency_ms: now() - start,
        error: res.error,
      });
      return { ok: false, error: res.error };
    }

    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'discord_message_sent',
      tool: 'voice.send_discord_message',
      call_id: call_id ?? null,
      channel_id,
      length,
      chunks,
      latency_ms: now() - start,
    });

    return {
      ok: true,
      result: {
        delivered: true,
        channel_id,
        length,
        chunks,
      },
    };
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
