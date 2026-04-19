// src/mcp-tools/voice-insert-price-snapshot.ts
// Phase 4 Plan 04-04 (INFRA-07): Bridge/Hetzner-scraper → Core housekeeping MCP-tool.
// The Hetzner `pricing-refresh.sh` cron fetches the OpenAI Realtime docs,
// parses the pricing block, and POSTs one snapshot row per daily run via
// this tool. Core persists via insertPriceSnapshot() (INSERT OR REPLACE on
// ts PRIMARY KEY in voice_price_snapshots). Recon-invoice + manual drift
// review read this table.
//
// Pitfall 5 invariant: this handler ONLY writes the snapshot row. It MUST
// NOT in any form mutate `voice-bridge/src/cost/prices.ts` or otherwise
// trigger price-constant updates. Manual bump of the TS pinned prices
// remains Carsten's decision after reviewing the Discord drift alert.
//
// Not exposed to OpenAI Realtime — no schema in voice-bridge allowlist.
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { VoicePriceSnapshotRow } from '../cost-ledger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

const InsertPriceSnapshotSchema = z.object({
  ts: z.string().min(1),
  model: z.string().min(1).max(64),
  audio_in_usd: z.number().nonnegative(),
  audio_out_usd: z.number().nonnegative(),
  audio_cached_usd: z.number().nonnegative(),
  text_in_usd: z.number().nonnegative(),
  text_out_usd: z.number().nonnegative(),
  // usd_to_eur must be strictly positive; zero would divide-by-zero downstream.
  usd_to_eur: z.number().positive(),
  source: z.string().min(1).max(32),
});

export interface VoiceInsertPriceSnapshotDeps {
  insertPriceSnapshot: (row: VoicePriceSnapshotRow) => void;
  jsonlPath?: string;
  now?: () => number;
}

export function makeVoiceInsertPriceSnapshot(
  deps: VoiceInsertPriceSnapshotDeps,
): ToolHandler {
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-cost.jsonl');
  const now = deps.now ?? (() => Date.now());

  return async function voiceInsertPriceSnapshot(
    args: unknown,
  ): Promise<unknown> {
    const start = now();

    const parseResult = InsertPriceSnapshotSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      const field = String(firstError?.path?.[0] ?? 'input');
      const message = firstError?.message ?? 'invalid';
      throw new BadRequestError(field, message);
    }

    const row: VoicePriceSnapshotRow = {
      ts: parseResult.data.ts,
      model: parseResult.data.model,
      audio_in_usd: parseResult.data.audio_in_usd,
      audio_out_usd: parseResult.data.audio_out_usd,
      audio_cached_usd: parseResult.data.audio_cached_usd,
      text_in_usd: parseResult.data.text_in_usd,
      text_out_usd: parseResult.data.text_out_usd,
      usd_to_eur: parseResult.data.usd_to_eur,
      source: parseResult.data.source,
    };

    try {
      deps.insertPriceSnapshot(row);
    } catch (err: unknown) {
      // Graceful degrade — JSONL is the audit trail of last resort. Return
      // ok:true so the Hetzner scraper doesn't retry-storm a transient
      // SQLite lock; the next daily run will INSERT OR REPLACE anyway.
      logger.warn({
        event: 'voice_insert_price_snapshot_db_fail',
        err: (err as Error).message,
      });
    }

    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'price_snapshot_inserted',
      tool: 'voice.insert_price_snapshot',
      snapshot_ts: row.ts,
      model: row.model,
      audio_in_usd: row.audio_in_usd,
      source: row.source,
      latency_ms: now() - start,
    });

    return { ok: true, result: { inserted: true } };
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
