// src/mcp-tools/voice-record-turn-cost.ts
// Phase 4 (INFRA-06): Bridge-internal housekeeping MCP-tool.
// Bridge posts one record per response.done event; Core persists the row
// via insertTurnCost() (INSERT OR IGNORE on PRIMARY KEY (call_id, turn_id)).
// Not exposed to OpenAI Realtime — no schema in voice-bridge allowlist.
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { VoiceTurnCostRow } from '../cost-ledger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

// Phase 05.5 / REQ-COST-06: trigger_type extends the schema so each
// container-agent invocation produces a distinguishable cost-ledger row.
// Defaults to 'turn' so all existing Phase-4 cost-recording call sites keep
// working unchanged. Synthetic turn_id convention for triggers: 'init'
// (init-trigger) or 'trigger-N' (transcript-trigger turn N) — these never
// collide with the monotonic numeric turn_id used by existing Realtime turns,
// so PRIMARY KEY (call_id, turn_id) dedup remains intact across both paths.
export const RecordTurnCostSchema = z.object({
  call_id: z.string().min(1),
  turn_id: z.string().min(1),
  audio_in_tokens: z.number().int().nonnegative().default(0),
  audio_out_tokens: z.number().int().nonnegative().default(0),
  cached_in_tokens: z.number().int().nonnegative().default(0),
  text_in_tokens: z.number().int().nonnegative().default(0),
  text_out_tokens: z.number().int().nonnegative().default(0),
  cost_eur: z.number().nonnegative(),
  trigger_type: z
    .enum(['turn', 'init_trigger', 'transcript_trigger'])
    .default('turn'),
});

export interface VoiceRecordTurnCostDeps {
  insertTurnCost: (row: VoiceTurnCostRow) => void;
  jsonlPath?: string;
  now?: () => number;
}

export function makeVoiceRecordTurnCost(
  deps: VoiceRecordTurnCostDeps,
): ToolHandler {
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-cost.jsonl');
  const now = deps.now ?? (() => Date.now());

  return async function voiceRecordTurnCost(args: unknown): Promise<unknown> {
    const start = now();

    const parseResult = RecordTurnCostSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      const field = String(firstError?.path?.[0] ?? 'input');
      const message = firstError?.message ?? 'invalid';
      throw new BadRequestError(field, message);
    }

    const row: VoiceTurnCostRow = {
      ts: new Date().toISOString(),
      call_id: parseResult.data.call_id,
      turn_id: parseResult.data.turn_id,
      audio_in_tokens: parseResult.data.audio_in_tokens,
      audio_out_tokens: parseResult.data.audio_out_tokens,
      cached_in_tokens: parseResult.data.cached_in_tokens,
      text_in_tokens: parseResult.data.text_in_tokens,
      text_out_tokens: parseResult.data.text_out_tokens,
      cost_eur: parseResult.data.cost_eur,
      trigger_type: parseResult.data.trigger_type,
    };

    try {
      deps.insertTurnCost(row);
    } catch (err: unknown) {
      // Graceful degrade — JSONL audit trail is the last-resort record.
      logger.warn({
        event: 'voice_record_turn_cost_db_fail',
        err: (err as Error).message,
      });
    }

    appendJsonl(jsonlPath, {
      ts: row.ts,
      event: 'turn_cost_recorded',
      tool: 'voice_record_turn_cost',
      call_id: row.call_id,
      turn_id: row.turn_id,
      cost_eur: row.cost_eur,
      trigger_type: row.trigger_type,
      latency_ms: now() - start,
    });

    return { ok: true, result: { recorded: true } };
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
