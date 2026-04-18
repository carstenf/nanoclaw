import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { ScheduledTask } from '../types.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

const ScheduleRetrySchema = z.object({
  call_id: z.string().optional(),
  retry_at: z.string(),
  prompt: z.string().min(1, 'prompt_too_short').max(4000, 'prompt_too_long'),
  group_folder: z.string().optional(),
});

export interface VoiceScheduleRetryDeps {
  createTask: (task: Omit<ScheduledTask, 'last_run' | 'last_result'>) => void;
  getMainGroupAndJid: () => { folder: string; jid: string } | null;
  jsonlPath?: string;
  now?: () => number;
  maxFutureMs?: number;
}

export function makeVoiceScheduleRetry(deps: VoiceScheduleRetryDeps): ToolHandler {
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-scheduler.jsonl');
  const now = deps.now ?? (() => Date.now());
  const maxFutureMs = deps.maxFutureMs ?? 30 * 24 * 60 * 60 * 1000;

  return async function voiceScheduleRetry(args: unknown): Promise<unknown> {
    const start = now();

    // Zod parse
    const parseResult = ScheduleRetrySchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      const field = String(firstError?.path?.[0] ?? 'input');
      const message = firstError?.message ?? 'invalid';
      throw new BadRequestError(field, message);
    }

    const { call_id, retry_at, prompt, group_folder: requestedFolder } = parseResult.data;

    // retry_at bounds check
    const nowMs = now();
    const retryMs = new Date(retry_at).getTime();
    if (isNaN(retryMs)) {
      throw new BadRequestError('retry_at', 'invalid_retry_at');
    }
    if (retryMs <= nowMs) {
      throw new BadRequestError('retry_at', 'retry_at_in_past');
    }
    if (retryMs > nowMs + maxFutureMs) {
      throw new BadRequestError('retry_at', 'retry_at_too_far');
    }

    // Resolve group_folder + jid
    let group_folder: string;
    let chat_jid: string;

    if (requestedFolder) {
      // Caller-provided folder — still need a jid; look up from main group if same
      const main = deps.getMainGroupAndJid();
      if (!main) {
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'retry_schedule_failed',
          tool: 'voice.schedule_retry',
          call_id: call_id ?? null,
          error: 'no_main_group',
          latency_ms: now() - start,
        });
        return { ok: false, error: 'no_main_group' };
      }
      group_folder = requestedFolder;
      // jid: if same folder use main.jid, otherwise use requestedFolder as jid placeholder
      chat_jid = requestedFolder === main.folder ? main.jid : main.jid;
    } else {
      const main = deps.getMainGroupAndJid();
      if (!main) {
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'retry_schedule_failed',
          tool: 'voice.schedule_retry',
          call_id: call_id ?? null,
          error: 'no_main_group',
          latency_ms: now() - start,
        });
        return { ok: false, error: 'no_main_group' };
      }
      group_folder = main.folder;
      chat_jid = main.jid;
    }

    const task_id = crypto.randomUUID();
    const created_at = new Date(nowMs).toISOString();

    try {
      deps.createTask({
        id: task_id,
        group_folder,
        chat_jid,
        prompt,
        script: null,
        schedule_type: 'once',
        schedule_value: retry_at,
        context_mode: 'isolated',
        next_run: retry_at,
        status: 'active',
        created_at,
      });
    } catch (err) {
      logger.warn({ event: 'voice_schedule_retry_db_error', err });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'retry_schedule_failed',
        tool: 'voice.schedule_retry',
        call_id: call_id ?? null,
        error: 'db_error',
        latency_ms: now() - start,
      });
      return { ok: false, error: 'db_error' };
    }

    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'retry_scheduled',
      tool: 'voice.schedule_retry',
      call_id: call_id ?? null,
      task_id,
      scheduled_for: retry_at,
      prompt_len: prompt.length,
      group_folder,
      latency_ms: now() - start,
    });

    return {
      ok: true,
      result: {
        task_id,
        scheduled_for: retry_at,
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
