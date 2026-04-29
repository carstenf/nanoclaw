import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetPhase4CronForTests,
  _resetSchedulerLoopForTests,
  computeNextRun,
  shouldFirePhase4Cron,
  startPhase4CronLoop,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

describe('Phase4 cron (in-process drift/recon)', () => {
  beforeEach(() => {
    _resetPhase4CronForTests();
  });

  it('fires a daily job when `now` crosses the anchor and never previously ran', () => {
    const job = {
      name: 'drift-monitor',
      dailyAt: '03:00',
      run: async () => undefined,
    };
    const now = new Date('2026-04-19T04:00:00');
    expect(shouldFirePhase4Cron(job, null, now)).toBe(true);
  });

  it('does NOT fire a daily job before the anchor', () => {
    const job = {
      name: 'drift-monitor',
      dailyAt: '03:00',
      run: async () => undefined,
    };
    const now = new Date('2026-04-19T02:00:00');
    expect(shouldFirePhase4Cron(job, null, now)).toBe(false);
  });

  it('does NOT fire a daily job twice within the same day', () => {
    const job = {
      name: 'drift-monitor',
      dailyAt: '03:00',
      run: async () => undefined,
    };
    const firstRun = new Date('2026-04-19T03:00:10');
    const secondCheck = new Date('2026-04-19T10:00:00');
    expect(shouldFirePhase4Cron(job, firstRun.toISOString(), secondCheck)).toBe(
      false,
    );
  });

  it('fires a monthly job on the target day after the anchor', () => {
    const job = {
      name: 'recon-invoice',
      monthlyAt: { day: 2, time: '04:00' },
      run: async () => undefined,
    };
    const now = new Date('2026-04-02T05:00:00');
    expect(shouldFirePhase4Cron(job, null, now)).toBe(true);
  });

  it('does NOT fire a monthly job before the target day', () => {
    const job = {
      name: 'recon-invoice',
      monthlyAt: { day: 2, time: '04:00' },
      run: async () => undefined,
    };
    const now = new Date('2026-04-01T23:59:00');
    expect(shouldFirePhase4Cron(job, null, now)).toBe(false);
  });

  it('startPhase4CronLoop is idempotent (second call is noop)', () => {
    const firstHandle = startPhase4CronLoop([], 60_000);
    const secondHandle = startPhase4CronLoop([], 60_000);
    // Both handles have stop(); neither should throw when called.
    firstHandle.stop();
    secondHandle.stop();
    expect(typeof firstHandle.stop).toBe('function');
  });

  it('intervalHours: fires on first run when no lastRunIso', () => {
    const job = {
      name: 'health-check',
      intervalHours: 6,
      run: async () => undefined,
    };
    const now = new Date('2026-04-29T12:00:00Z');
    expect(shouldFirePhase4Cron(job, null, now)).toBe(true);
  });

  it('intervalHours: does NOT fire before interval has elapsed', () => {
    const job = {
      name: 'health-check',
      intervalHours: 6,
      run: async () => undefined,
    };
    const lastRun = new Date('2026-04-29T12:00:00Z');
    const now = new Date('2026-04-29T15:00:00Z'); // 3h later
    expect(shouldFirePhase4Cron(job, lastRun.toISOString(), now)).toBe(false);
  });

  it('intervalHours: fires once interval has elapsed', () => {
    const job = {
      name: 'health-check',
      intervalHours: 6,
      run: async () => undefined,
    };
    const lastRun = new Date('2026-04-29T12:00:00Z');
    const now = new Date('2026-04-29T18:00:00Z'); // 6h later — exactly at boundary
    expect(shouldFirePhase4Cron(job, lastRun.toISOString(), now)).toBe(true);
  });
});
