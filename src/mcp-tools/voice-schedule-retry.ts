import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { ScheduledTask } from '../types.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

// REQ-TOOLS-07: args {case_type, target_phone (E.164), not_before_ts (ISO)}
const ScheduleRetrySchema = z.object({
  call_id: z.string().optional(),
  case_type: z.string().min(1).max(64),
  target_phone: z
    .string()
    .regex(/^\+\d{8,15}$/, 'target_phone must be E.164 format (+NNNN...)'),
  not_before_ts: z.string(),
});

export interface VoiceScheduleRetryDeps {
  createTask: (task: Omit<ScheduledTask, 'last_run' | 'last_result'>) => void;
  getAllTasks: () => ScheduledTask[];
  getMainGroupAndJid: () => { folder: string; jid: string } | null;
  jsonlPath?: string;
  now?: () => number;
  maxFutureMs?: number;
}

export function makeVoiceScheduleRetry(
  deps: VoiceScheduleRetryDeps,
): ToolHandler {
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-scheduler.jsonl');
  const now = deps.now ?? (() => Date.now());
  const maxFutureMs = deps.maxFutureMs ?? 30 * 24 * 60 * 60 * 1000;

  return async function voiceScheduleRetry(args: unknown): Promise<unknown> {
    const start = now();

    // Zod parse — REQ-TOOLS-07 shape
    const parseResult = ScheduleRetrySchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      const field = String(firstError?.path?.[0] ?? 'input');
      const message = firstError?.message ?? 'invalid';
      throw new BadRequestError(field, message);
    }

    const { call_id, case_type, target_phone, not_before_ts } =
      parseResult.data;

    // not_before_ts bounds check
    const nowMs = now();
    const notBeforeMs = new Date(not_before_ts).getTime();
    if (isNaN(notBeforeMs)) {
      throw new BadRequestError('not_before_ts', 'invalid_not_before_ts');
    }
    if (notBeforeMs <= nowMs) {
      throw new BadRequestError('not_before_ts', 'retry_at_in_past');
    }
    if (notBeforeMs > nowMs + maxFutureMs) {
      throw new BadRequestError('not_before_ts', 'retry_at_too_far');
    }

    // Resolve main group
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

    // Synthesize internal prompt
    const prompt = `Retry for case '${case_type}', target: ${target_phone}. Scheduled by voice at ${call_id ?? 'voice'}.`;

    // Idempotency: check existing active tasks for same (case_type, target_phone, not_before_ts)
    const existingTasks = deps.getAllTasks();
    const duplicate = existingTasks.find(
      (t) =>
        t.status === 'active' &&
        t.prompt.includes(`case '${case_type}'`) &&
        t.prompt.includes(target_phone) &&
        t.schedule_value === not_before_ts,
    );

    if (duplicate) {
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'retry_scheduled_deduplicated',
        tool: 'voice.schedule_retry',
        call_id: call_id ?? null,
        existing_task_id: duplicate.id,
        scheduled_for: not_before_ts,
        latency_ms: now() - start,
      });
      return { ok: true, result: { scheduled: true } };
    }

    const task_id = crypto.randomUUID();
    const created_at = new Date(nowMs).toISOString();

    try {
      deps.createTask({
        id: task_id,
        group_folder: main.folder,
        chat_jid: main.jid,
        prompt,
        script: null,
        schedule_type: 'once',
        schedule_value: not_before_ts,
        context_mode: 'isolated',
        next_run: not_before_ts,
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
      scheduled_for: not_before_ts,
      latency_ms: now() - start,
    });

    return { ok: true, result: { scheduled: true } };
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
