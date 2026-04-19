import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}

// ---------------------------------------------------------------------------
// Phase 4 in-process cron loop — runDriftMonitor / runRecon3Way / runReconInvoice
// ---------------------------------------------------------------------------
// Reasoning (CLAUDE.md): NanoClaw runs as a single Node.js process. The
// drift + recon jobs are lightweight (file scan + SQLite SUM + Discord
// POST) and must share the Core's SQLite handle + config. Spinning up
// separate systemd services for them would either require IPC back to Core
// (for the DB handle) or a second DB opener (which sqlite-wal permits but
// invites write contention). Instead we register them as in-process cron
// callbacks that fire from a tiny poller running alongside the main
// scheduler loop.
//
// Systemd-unit-based jobs (§201 audit + pricing refresh) live OUTSIDE this
// poller — those are shell scripts invoked by systemd/user timers.

export interface Phase4CronJob {
  name: string;
  /** Daily local-time anchor as "HH:MM" (24h). */
  dailyAt?: string;
  /** Monthly anchor as `{day: 1-28, time: "HH:MM"}`. */
  monthlyAt?: { day: number; time: string };
  run: () => Promise<unknown>;
}

interface Phase4CronState {
  lastRunIso: string | null;
}

/**
 * Parses "HH:MM" → minutes-since-midnight local-time. Returns null on bad input.
 */
function parseHHMM(s: string): number | null {
  const m = s.match(/^([0-9]{1,2}):([0-9]{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Returns true if `now` has crossed the daily/monthly anchor since the
 * job's `lastRunIso`. Missed anchors fire on the next tick (Persistent=true
 * equivalent).
 */
export function shouldFirePhase4Cron(
  job: Phase4CronJob,
  lastRunIso: string | null,
  now: Date,
): boolean {
  if (job.dailyAt) {
    const anchor = parseHHMM(job.dailyAt);
    if (anchor === null) return false;
    const todayAnchor = new Date(now);
    todayAnchor.setHours(Math.floor(anchor / 60), anchor % 60, 0, 0);
    if (now.getTime() < todayAnchor.getTime()) return false;
    if (!lastRunIso) return true;
    return new Date(lastRunIso).getTime() < todayAnchor.getTime();
  }
  if (job.monthlyAt) {
    const anchor = parseHHMM(job.monthlyAt.time);
    if (anchor === null) return false;
    if (now.getDate() < job.monthlyAt.day) return false;
    const monthAnchor = new Date(
      now.getFullYear(),
      now.getMonth(),
      job.monthlyAt.day,
      Math.floor(anchor / 60),
      anchor % 60,
      0,
      0,
    );
    if (now.getTime() < monthAnchor.getTime()) return false;
    if (!lastRunIso) return true;
    return new Date(lastRunIso).getTime() < monthAnchor.getTime();
  }
  return false;
}

let phase4CronRunning = false;

/**
 * Start the in-process cron poller for Phase-4 drift/recon jobs.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * `pollIntervalMs` defaults to 60_000 (check every minute). Each registered
 * job fires at most once per day (or month for monthlyAt) even if the poller
 * runs late; missed anchors on restart are handled via Persistent=true
 * semantics — we fire on the first poll tick where the anchor is in the past
 * and the job hasn't run since the anchor.
 */
export function startPhase4CronLoop(
  jobs: Phase4CronJob[],
  pollIntervalMs = 60_000,
): { stop: () => void } {
  if (phase4CronRunning) {
    logger.debug('Phase4 cron loop already running — noop');
    return { stop: () => {} };
  }
  phase4CronRunning = true;
  const state = new Map<string, Phase4CronState>();
  for (const j of jobs) {
    state.set(j.name, { lastRunIso: null });
    logger.info(
      {
        event: 'phase4_cron_registered',
        job: j.name,
        daily_at: j.dailyAt ?? null,
        monthly_at: j.monthlyAt ?? null,
      },
      `registered phase-4 cron job ${j.name}`,
    );
  }

  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    const now = new Date();
    for (const job of jobs) {
      const s = state.get(job.name);
      if (!s) continue;
      if (!shouldFirePhase4Cron(job, s.lastRunIso, now)) continue;
      s.lastRunIso = now.toISOString();
      try {
        await job.run();
        logger.info({ event: 'phase4_cron_fired', job: job.name });
      } catch (err) {
        logger.error({
          event: 'phase4_cron_failed',
          job: job.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, pollIntervalMs);
  if (timer.unref) timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      phase4CronRunning = false;
    },
  };
}

/** @internal — for tests only. */
export function _resetPhase4CronForTests(): void {
  phase4CronRunning = false;
}
