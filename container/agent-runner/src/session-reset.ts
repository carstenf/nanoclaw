/**
 * Agent-triggered session reset (`reset_session`): shared state and guardrails.
 *
 * The MCP tool runs in a separate stdio process, so the request travels
 * through mailbox session_state: the tool records `pending_reset`, the poll
 * loop executes it once the active query has answered every queued turn
 * (never mid-turn), then starts a fresh query with the resume prompt.
 * Both sides run the rate-limit checks; the loop re-checks because two
 * requests can race and because limits may have changed in between.
 */
import fs from 'fs';
import path from 'path';

import type { ReplyRoute } from './db/session-state.js';
import { getAgentMailbox } from './mailbox/index.js';

export const PENDING_RESET_KEY = 'pending_reset';
export const LAST_RESET_KEY = 'last_reset';
export const RESET_HISTORY_KEY = 'reset_history';

const DAY_MS = 86_400_000;

export interface PendingReset {
  handover_path: string;
  resume_prompt: string;
  reason: string;
  requested_at: string;
  /** Reply route of the turn that requested the reset (current_reply_route). */
  route: ReplyRoute | null;
}

export interface LastReset {
  at: string;
  reason: string;
  handover_path: string;
  previous_session: string | null;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Guardrail limits; overridable per container env. */
export function resetLimits(): { minIntervalMs: number; maxPerDay: number; handoverMaxAgeMs: number } {
  return {
    minIntervalMs: intEnv('NANOCLAW_RESET_MIN_INTERVAL_MIN', 15) * 60_000,
    maxPerDay: intEnv('NANOCLAW_RESET_MAX_PER_DAY', 6),
    handoverMaxAgeMs: intEnv('NANOCLAW_RESET_HANDOVER_MAX_AGE_MIN', 30) * 60_000,
  };
}

function getJson<T>(key: string): T | null {
  const row = getAgentMailbox().operations.getState(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

function setJson(key: string, value: unknown): void {
  getAgentMailbox().operations.setState(key, JSON.stringify(value));
}

export function getPendingReset(): PendingReset | null {
  const pending = getJson<PendingReset>(PENDING_RESET_KEY);
  return pending && typeof pending.handover_path === 'string' ? pending : null;
}

export function hasPendingReset(): boolean {
  return getAgentMailbox().operations.getState(PENDING_RESET_KEY) !== undefined;
}

export function setPendingReset(pending: PendingReset): void {
  setJson(PENDING_RESET_KEY, pending);
}

/** Read and delete the pending request (a corrupt row is dropped, returns null). */
export function takePendingReset(): PendingReset | null {
  const pending = getPendingReset();
  getAgentMailbox().operations.deleteState(PENDING_RESET_KEY);
  return pending;
}

export function getLastReset(): LastReset | null {
  return getJson<LastReset>(LAST_RESET_KEY);
}

/** Epoch-ms timestamps of resets within the last 24 h. */
export function getResetHistory(now = Date.now()): number[] {
  const history = getJson<unknown>(RESET_HISTORY_KEY);
  if (!Array.isArray(history)) return [];
  return history.filter((t): t is number => typeof t === 'number' && now - t < DAY_MS).sort((a, b) => a - b);
}

/** Record an executed reset: `last_reset` for the next session, history for rate limits. */
export function recordReset(entry: LastReset, now = Date.now()): void {
  setJson(RESET_HISTORY_KEY, [...getResetHistory(now), now]);
  setJson(LAST_RESET_KEY, entry);
}

/** Null when a reset is allowed now, otherwise the refusal reason. */
export function checkRateLimits(now = Date.now()): string | null {
  const limits = resetLimits();
  const history = getResetHistory(now);
  const last = history.at(-1);
  if (last !== undefined && now - last < limits.minIntervalMs) {
    return (
      `a reset already happened ${Math.floor((now - last) / 60_000)} min ago ` +
      `(minimum interval ${limits.minIntervalMs / 60_000} min)`
    );
  }
  if (history.length >= limits.maxPerDay) {
    return `already ${history.length} resets in the last 24 h (limit ${limits.maxPerDay})`;
  }
  return null;
}

/** Null when the handover file is usable, otherwise the refusal reason. */
export function checkHandover(handoverPath: string, now = Date.now()): string | null {
  if (!path.isAbsolute(handoverPath)) return `handover_path must be absolute: ${handoverPath}`;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(handoverPath);
  } catch {
    return `handover file not found: ${handoverPath}`;
  }
  if (!stat.isFile()) return `handover path is not a file: ${handoverPath}`;
  if (stat.size === 0) return `handover file is empty: ${handoverPath}`;
  const maxAge = resetLimits().handoverMaxAgeMs;
  const age = now - stat.mtimeMs;
  if (age > maxAge) {
    return (
      `handover file is ${Math.floor(age / 60_000)} min old (max ${maxAge / 60_000} min) — ` +
      `write a current handover first`
    );
  }
  return null;
}

/** The first input of the fresh session, marked as system-origin. */
export function formatResumePrompt(pending: PendingReset, previousSession: string | null): string {
  return (
    `<system origin="session-reset">This is a fresh session. Your previous session` +
    `${previousSession ? ` (${previousSession})` : ''} was reset at your own request via reset_session ` +
    `(reason: ${pending.reason}). The handover is at ${pending.handover_path}.\n\n` +
    `${pending.resume_prompt}</system>`
  );
}
