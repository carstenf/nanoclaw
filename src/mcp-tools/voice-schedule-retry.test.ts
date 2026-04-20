import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceScheduleRetry,
  VoiceScheduleRetryDeps,
} from './voice-schedule-retry.js';
import type { ScheduledTask } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscheduleretry-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const JSONL_PATH = () => path.join(tmpDir, 'voice-scheduler.jsonl');

const BASE_NOW = new Date('2026-01-01T12:00:00Z').getTime();
const NOT_BEFORE_VALID = new Date(BASE_NOW + 60 * 60 * 1000).toISOString(); // now + 1h
const NOT_BEFORE_PAST = new Date(BASE_NOW - 60 * 1000).toISOString(); // now - 1min
const NOT_BEFORE_FAR = new Date(
  BASE_NOW + 40 * 24 * 60 * 60 * 1000,
).toISOString(); // now + 40d

function makeDeps(
  overrides: Partial<VoiceScheduleRetryDeps> = {},
  existingTasks: ScheduledTask[] = [],
): VoiceScheduleRetryDeps & { capturedTask: ScheduledTask | null } {
  const deps: VoiceScheduleRetryDeps & { capturedTask: ScheduledTask | null } =
    {
      capturedTask: null,
      createTask: (task) => {
        deps.capturedTask = task as ScheduledTask;
      },
      getAllTasks: () => existingTasks,
      getMainGroupAndJid: () => ({
        folder: 'main',
        jid: 'main@g.us',
      }),
      jsonlPath: JSONL_PATH(),
      now: () => BASE_NOW,
      ...overrides,
    };
  return deps;
}

describe('makeVoiceScheduleRetry (REQ-TOOLS-07)', () => {
  it('happy path: schedules retry, returns {scheduled:true}, prompt synthesized internally', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    const result = (await handler({
      call_id: 'test-call-1',
      case_type: 'reservation',
      target_phone: '+491708036426',
      not_before_ts: NOT_BEFORE_VALID,
    })) as { ok: true; result: { scheduled: boolean } };

    expect(result.ok).toBe(true);
    expect(result.result.scheduled).toBe(true);

    // createTask was called with synthesized prompt
    const task = deps.capturedTask as ScheduledTask;
    expect(task).not.toBeNull();
    expect(task.prompt).toContain('reservation');
    expect(task.prompt).toContain('+491708036426');
    expect(task.schedule_type).toBe('once');
    expect(task.status).toBe('active');
  });

  it('idempotent: same (case_type, target_phone, not_before_ts) → scheduled:true, no new insert', async () => {
    const existingTask: ScheduledTask = {
      id: 'existing-uuid',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: "Retry for case 'reservation', target: +491708036426.",
      script: null,
      schedule_type: 'once',
      schedule_value: NOT_BEFORE_VALID,
      context_mode: 'isolated',
      next_run: NOT_BEFORE_VALID,
      status: 'active',
      created_at: '2026-01-01T10:00:00Z',
      last_run: null,
      last_result: null,
    };

    const deps = makeDeps({}, [existingTask]);
    const handler = makeVoiceScheduleRetry(deps);

    const result = (await handler({
      call_id: 'dedup-call',
      case_type: 'reservation',
      target_phone: '+491708036426',
      not_before_ts: NOT_BEFORE_VALID,
    })) as { ok: true; result: { scheduled: boolean } };

    expect(result.ok).toBe(true);
    expect(result.result.scheduled).toBe(true);
    // createTask NOT called (idempotent)
    expect(deps.capturedTask).toBeNull();
  });

  it('not_before_ts in past → throws BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await expect(
      handler({
        case_type: 'test',
        target_phone: '+491708036426',
        not_before_ts: NOT_BEFORE_PAST,
      }),
    ).rejects.toMatchObject({
      field: 'not_before_ts',
      expected: 'retry_at_in_past',
    });
  });

  it('not_before_ts too far in future → throws BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await expect(
      handler({
        case_type: 'test',
        target_phone: '+491708036426',
        not_before_ts: NOT_BEFORE_FAR,
      }),
    ).rejects.toMatchObject({
      field: 'not_before_ts',
      expected: 'retry_at_too_far',
    });
  });

  it('invalid E164 phone → throws BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await expect(
      handler({
        case_type: 'test',
        target_phone: '0170123456', // missing +
        not_before_ts: NOT_BEFORE_VALID,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('empty case_type → throws BadRequestError', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await expect(
      handler({
        case_type: '',
        target_phone: '+491708036426',
        not_before_ts: NOT_BEFORE_VALID,
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('no_main_group → returns {ok:false, error:"no_main_group"}', async () => {
    const deps = makeDeps({ getMainGroupAndJid: () => null });
    const handler = makeVoiceScheduleRetry(deps);

    const result = (await handler({
      case_type: 'test',
      target_phone: '+491708036426',
      not_before_ts: NOT_BEFORE_VALID,
    })) as { ok: false; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_main_group');
  });

  it('JSONL: retry_scheduled written without prompt text, with case_type', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await handler({
      call_id: 'jsonl-test',
      case_type: 'restaurant-reservation',
      target_phone: '+491708036426',
      not_before_ts: NOT_BEFORE_VALID,
    });

    const jsonl = fs.readFileSync(JSONL_PATH(), 'utf8');
    const entry = JSON.parse(jsonl.trim().split('\n').pop()!);

    expect(entry.event).toBe('retry_scheduled');
    expect(entry.tool).toBe('voice_schedule_retry');
    expect(entry).not.toHaveProperty('prompt');
    expect(entry).toHaveProperty('task_id');
    expect(entry).toHaveProperty('scheduled_for');
  });

  it('dedup JSONL: retry_scheduled_deduplicated event on idempotent call', async () => {
    const existingTask: ScheduledTask = {
      id: 'dup-uuid',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: "Retry for case 'delivery', target: +491708036426.",
      script: null,
      schedule_type: 'once',
      schedule_value: NOT_BEFORE_VALID,
      context_mode: 'isolated',
      next_run: NOT_BEFORE_VALID,
      status: 'active',
      created_at: '2026-01-01T10:00:00Z',
      last_run: null,
      last_result: null,
    };

    const deps = makeDeps({}, [existingTask]);
    const handler = makeVoiceScheduleRetry(deps);

    await handler({
      call_id: 'dedup-jsonl',
      case_type: 'delivery',
      target_phone: '+491708036426',
      not_before_ts: NOT_BEFORE_VALID,
    });

    const jsonl = fs.readFileSync(JSONL_PATH(), 'utf8');
    const entry = JSON.parse(jsonl.trim().split('\n').pop()!);
    expect(entry.event).toBe('retry_scheduled_deduplicated');
  });
});
