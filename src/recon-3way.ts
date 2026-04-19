// src/recon-3way.ts
// Phase 4 Plan 04-04 (Success-Criterion 5): 3-way reconciliation.
//
// Cross-checks three sources of truth for calls in the last 24h:
//   1. state.db voice_call_costs  — the finalize side (was a call finalised?)
//   2. turns-*.jsonl events       — the Bridge side (was a readback-gated
//                                    mutating tool actually dispatched?)
//   3. Discord summary channel    — the user side (was a summary message
//                                    posted after the call?)
//
// Pitfall 9 handling: phase-2 readback validator only emits
// `readback_mismatch` on FAILURE — no positive `readback_confirmed` event
// exists in the repo today. We therefore treat ANY of the following events
// as a positive "tool dispatched" signal, most of which are actually emitted
// by voice-bridge/src/tools/dispatch.ts today:
//   - tool_dispatch_ok       (verified live in dispatch.ts L283)
//   - tool_dispatch_done     (verified live in dispatch.ts L214/240/295/344)
//   - readback_confirmed     (speculative name for future positive emission)
//   - readback_ok            (speculative alternative)
//   - readback_validated     (speculative alternative)
//   - two_form_readback_pass (speculative alternative)
// New emissions added in later phases will be picked up automatically if
// their name matches any candidate.
//
// Scheduled in-process (CLAUDE.md single-process constraint) daily 03:15.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type Database from 'better-sqlite3';

import { logger } from './logger.js';

/** Events that — if present on a call's turns-*.jsonl — count as a positive
 * readback/dispatch signal. See Pitfall 9 note at top of file. */
const READBACK_EVENT_NAMES = [
  'tool_dispatch_ok',
  'tool_dispatch_done',
  'readback_confirmed',
  'readback_ok',
  'readback_validated',
  'two_form_readback_pass',
];

export interface DiscordSummaryMessage {
  call_id?: string;
  confirmation_id?: string;
}

export interface Recon3WayDeps {
  db: Database.Database;
  baseDir?: string;
  listDiscordSummaryMessages: (
    sinceIso: string,
  ) => Promise<DiscordSummaryMessage[]>;
  sendDiscordAlert: (msg: string) => Promise<void>;
  writeStateRepoOpenPoint: (content: string) => void;
  now?: () => number;
}

export interface Recon3WayResult {
  checked: number;
  drift: number;
}

function defaultBaseDir(): string {
  return (
    process.env.BRIDGE_LOG_DIR ??
    path.join(os.homedir(), 'nanoclaw', 'voice-container', 'runs')
  );
}

export async function runRecon3Way(
  deps: Recon3WayDeps,
): Promise<Recon3WayResult> {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  const now = deps.now ?? Date.now;
  const sinceMs = now() - 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();

  // -------- Source 1: state.db voice_call_costs (calendar-ish / "was finalised") --------
  // Calls terminated by cost_cap are excluded — they're a different failure
  // class and recon should only flag genuine inter-surface disagreement.
  const calendarRows = deps.db
    .prepare(
      `SELECT call_id FROM voice_call_costs
       WHERE started_at >= ? AND (terminated_by IS NULL OR terminated_by != 'cost_cap_call')`,
    )
    .all(sinceIso) as Array<{ call_id: string }>;

  // -------- Source 2: turns-*.jsonl with positive readback/dispatch signal --------
  const readbackCalls = new Set<string>();
  if (fs.existsSync(baseDir)) {
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(baseDir)
        .filter((n) => n.startsWith('turns-') && n.endsWith('.jsonl'));
    } catch {
      /* empty */
    }
    for (const f of files) {
      // Extract the call_id from the filename as a best-effort default
      // (the Bridge writes one file per call). Any explicit `call_id`
      // inside a JSON line takes precedence per event.
      const fileCallId = f.replace(/^turns-/, '').replace(/\.jsonl$/, '');
      let raw = '';
      try {
        raw = fs.readFileSync(path.join(baseDir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let e: Record<string, unknown> | null = null;
        try {
          e = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!e || !READBACK_EVENT_NAMES.includes(String(e.event))) continue;
        const cid =
          typeof e.call_id === 'string' && e.call_id.length > 0
            ? e.call_id
            : fileCallId;
        readbackCalls.add(cid);
      }
    }
  }

  // -------- Source 3: Discord summary channel --------
  let discordMsgs: DiscordSummaryMessage[] = [];
  try {
    discordMsgs = await deps.listDiscordSummaryMessages(sinceIso);
  } catch (err: unknown) {
    logger.warn({
      event: 'recon_3way_discord_fetch_failed',
      err: (err as Error).message,
    });
  }
  const discordCalls = new Set(
    discordMsgs.map((m) => m.call_id).filter((x): x is string => !!x),
  );

  // -------- Compare: 2-of-3 drift --------
  const drifted: string[] = [];
  for (const row of calendarRows) {
    const inCal = true; // by construction
    const inReadback = readbackCalls.has(row.call_id);
    const inDiscord = discordCalls.has(row.call_id);
    const agreeCount = [inCal, inReadback, inDiscord].filter(Boolean).length;
    if (agreeCount === 2) drifted.push(row.call_id);
  }

  logger.info({
    event: 'recon_3way_run',
    checked: calendarRows.length,
    drift: drifted.length,
    since_iso: sinceIso,
  });

  if (drifted.length > 0) {
    const header = `3-way recon drift (${drifted.length} of ${calendarRows.length} calls) since ${sinceIso}`;
    const body = drifted.map((c) => `- ${c}`).join('\n');
    const msg = `${header}\n${body}`;
    await deps.sendDiscordAlert(msg);
    try {
      deps.writeStateRepoOpenPoint(
        `## Recon 3-way drift ${new Date(now()).toISOString()}\n\n${msg}\n`,
      );
    } catch (err: unknown) {
      logger.warn({
        event: 'recon_3way_open_point_write_failed',
        err: (err as Error).message,
      });
    }
  }

  return { checked: calendarRows.length, drift: drifted.length };
}
