/**
 * MCP tool: voice_call_cost_snapshot
 *
 * Bridge calls this at /accept (call start). NanoClaw fetches the current
 * provider-cost (USD month-to-date) and stores it as the baseline for that
 * call_id. voice_call_cost_finalize subtracts the baseline from a second
 * snapshot at hangup to get the actual billed cost of the call.
 *
 * Why two snapshots: /v1/organization/costs returns daily-bucket
 * cumulative-cost values that update live. Snapshot-at-start vs snapshot-
 * at-end isolates this call's spend even when other LLM activity (Andy
 * reasoning, parallel side-band tools) is concurrent with the call.
 *
 * Provider param defaults to 'openai' (only one wired today). Phase 2+
 * will add anthropic / others as they expose admin-cost APIs.
 */
import { z } from 'zod';

import { logger } from '../logger.js';
import { getCostProvider } from '../cost-providers.js';
import { setSnapshot } from '../voice-call-cost-snapshots.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

export const TOOL_NAME = 'voice_call_cost_snapshot' as const;

export const VoiceCallCostSnapshotSchema = z.object({
  call_id: z.string().min(1).max(128),
  provider: z.enum(['openai']).optional(),
});

export type VoiceCallCostSnapshotInput = z.infer<
  typeof VoiceCallCostSnapshotSchema
>;

export interface VoiceCallCostSnapshotResult {
  ok: true;
  result: {
    call_id: string;
    provider: 'openai';
    baseline_usd: number;
    taken_at_iso: string;
  };
}

export function makeVoiceCallCostSnapshot(): ToolHandler {
  return async function voiceCallCostSnapshot(
    args: unknown,
  ): Promise<VoiceCallCostSnapshotResult | { ok: false; error: string }> {
    const parsed = VoiceCallCostSnapshotSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }
    const { call_id } = parsed.data;
    const provider = parsed.data.provider ?? 'openai';

    try {
      const baseline_usd = await getCostProvider(provider).snapshotMtdUsd();
      const taken_at_unix = Math.floor(Date.now() / 1000);
      setSnapshot({ call_id, provider, baseline_usd, taken_at_unix });

      logger.info({
        event: 'voice_call_cost_snapshot_ok',
        call_id,
        provider,
        baseline_usd,
      });
      return {
        ok: true,
        result: {
          call_id,
          provider,
          baseline_usd,
          taken_at_iso: new Date(taken_at_unix * 1000).toISOString(),
        },
      };
    } catch (err) {
      logger.warn({
        event: 'voice_call_cost_snapshot_failed',
        call_id,
        provider,
        err: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'snapshot_failed',
      };
    }
  };
}
