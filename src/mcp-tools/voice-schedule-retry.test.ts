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
const RETRY_AT_VALID = new Date(BASE_NOW + 60 * 60 * 1000).toISOString(); // now + 1h
const RETRY_AT_PAST = new Date(BASE_NOW - 60 * 1000).toISOString(); // now - 1min
const RETRY_AT_FAR = new Date(BASE_NOW + 40 * 24 * 60 * 60 * 1000).toISOString(); // now + 40d

function makeDeps(
  overrides: Partial<VoiceScheduleRetryDeps> = {},
): VoiceScheduleRetryDeps & { capturedTask: ScheduledTask | null } {
  let capturedTask: ScheduledTask | null = null;
  const deps: VoiceScheduleRetryDeps & { capturedTask: ScheduledTask | null } = {
    capturedTask,
    createTask: (task) => {
      deps.capturedTask = task as ScheduledTask;
    },
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

describe('makeVoiceScheduleRetry', () => {
  it('happy path: schedules retry and returns task_id + scheduled_for', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    const result = (await handler({
      call_id: 'test-call-1',
      retry_at: RETRY_AT_VALID,
      prompt: 'Bitte morgen nochmal anrufen.',
    })) as { ok: true; result: { task_id: string; scheduled_for: string } };

    expect(result.ok).toBe(true);
    expect(result.result.task_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.result.scheduled_for).toBe(RETRY_AT_VALID);
  });

  it('happy path: createTask called with schedule_type=once and correct fields', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await handler({
      retry_at: RETRY_AT_VALID,
      prompt: 'Test retry prompt',
    });

    const task = deps.capturedTask as ScheduledTask;
    expect(task).not.toBeNull();
    expect(task.schedule_type).toBe('once');
    expect(task.schedule_value).toBe(RETRY_AT_VALID);
    expect(task.next_run).toBe(RETRY_AT_VALID);
    expect(task.context_mode).toBe('isolated');
    expect(task.group_folder).toBe('main');
    expect(task.chat_jid).toBe('main@g.us');
    expect(task.prompt).toBe('Test retry prompt');
    expect(task.status).toBe('active');
    expect(task.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('retry_at in past → BadRequestError retry_at_in_past', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await expect(
      handler({
        retry_at: RETRY_AT_PAST,
        prompt: 'should fail',
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    await expect(
      handler({
        retry_at: RETRY_AT_PAST,
        prompt: 'should fail',
      }),
    ).rejects.toMatchObject({ field: 'retry_at', expected: 'retry_at_in_past' });
  });

  it('retry_at too far in future → BadRequestError retry_at_too_far', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await expect(
      handler({
        retry_at: RETRY_AT_FAR,
        prompt: 'should fail',
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    await expect(
      handler({
        retry_at: RETRY_AT_FAR,
        prompt: 'should fail',
      }),
    ).rejects.toMatchObject({ field: 'retry_at', expected: 'retry_at_too_far' });
  });

  it('prompt empty → BadRequestError (zod validation)', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await expect(
      handler({
        retry_at: RETRY_AT_VALID,
        prompt: '',
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('prompt too long → BadRequestError (zod validation)', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);

    await expect(
      handler({
        retry_at: RETRY_AT_VALID,
        prompt: 'x'.repeat(4001),
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('no_main_group → returns {ok:false, error:"no_main_group"}', async () => {
    const deps = makeDeps({
      getMainGroupAndJid: () => null,
    });
    const handler = makeVoiceScheduleRetry(deps);

    const result = (await handler({
      retry_at: RETRY_AT_VALID,
      prompt: 'Test prompt',
    })) as { ok: false; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_main_group');
  });

  it('JSONL success event written without prompt text, only prompt_len', async () => {
    const deps = makeDeps();
    const handler = makeVoiceScheduleRetry(deps);
    const prompt = 'Bitte morgen um 10 Uhr anrufen.';

    await handler({
      call_id: 'jsonl-test',
      retry_at: RETRY_AT_VALID,
      prompt,
    });

    const jsonl = fs.readFileSync(JSONL_PATH(), 'utf8');
    const entry = JSON.parse(jsonl.trim().split('\n').pop()!);

    expect(entry.event).toBe('retry_scheduled');
    expect(entry.tool).toBe('voice.schedule_retry');
    expect(entry.prompt_len).toBe(prompt.length);
    expect(entry).not.toHaveProperty('prompt');
    expect(entry).toHaveProperty('task_id');
    expect(entry).toHaveProperty('scheduled_for');
    expect(entry).toHaveProperty('ts');
  });
});
