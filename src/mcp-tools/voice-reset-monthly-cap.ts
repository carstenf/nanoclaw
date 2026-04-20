// src/mcp-tools/voice-reset-monthly-cap.ts
// Phase 4 Plan 04-02 (COST-03): Manual reset of the voice_channel_suspended
// flag after the monthly €25 cap has been hit. Audited via JSONL (event:
// monthly_cap_reset). Invoked by Carsten from the iPhone/Chat or CLI when he
// deliberately wants to re-enable the voice channel before month-end.
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const ResetMonthlyCapSchema = z.object({
  reason: z.string().min(1).max(200),
  authorized_by: z.string().min(1).max(64),
});

export interface VoiceResetMonthlyCapDeps {
  setRouterState: (key: string, value: string) => void;
  getRouterState: (key: string) => string | undefined;
  jsonlPath?: string;
  now?: () => number;
}

export function makeVoiceResetMonthlyCap(
  deps: VoiceResetMonthlyCapDeps,
): ToolHandler {
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-cost.jsonl');
  const now = deps.now ?? (() => Date.now());

  return async function voiceResetMonthlyCap(args: unknown): Promise<unknown> {
    const parseResult = ResetMonthlyCapSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      const field = String(firstError?.path?.[0] ?? 'input');
      const message = firstError?.message ?? 'invalid';
      throw new BadRequestError(field, message);
    }

    const before = deps.getRouterState('voice_channel_suspended') ?? '0';
    deps.setRouterState('voice_channel_suspended', '0');

    appendJsonl(jsonlPath, {
      ts: new Date().toISOString(),
      event: 'monthly_cap_reset',
      tool: 'voice.reset_monthly_cap',
      before,
      after: '0',
      reason: parseResult.data.reason,
      authorized_by: parseResult.data.authorized_by,
      at_ms: now(),
    });

    logger.info({
      event: 'voice_channel_suspension_cleared',
      reason: parseResult.data.reason,
      by: parseResult.data.authorized_by,
    });

    return {
      ok: true,
      result: { reset: true, was_suspended: before === '1' },
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
