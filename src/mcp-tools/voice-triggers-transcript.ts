// src/mcp-tools/voice-triggers-transcript.ts
// Phase 05.5 Plan 01 Task 3: voice_triggers_transcript MCP-tool.
//
// Container-agent reasoning trigger — per-turn FIFO. Returns the agent's
// `instructions_update` string (or null if no update needed).
//
// D-8 schema (locked):
//   call_id: string
//   turn_id: number (monotonic per call)
//   transcript: { turns: [{role, text, started_at}] }
//   fast_brain_state: { readback_pending?, confirm_action_pending?, silence_nudge_level? }
// Returns: { ok: true, result: { instructions_update: string | null } } on success
//        | { ok: false, error: 'mutation_blocked_mid_call' } on REQ-DIR-17 gate
//        | throws BadRequestError on schema failure
//
// FIFO: per-call_id queue (D-11 / D-12). Turn N+1 waits for N's resolution
// on the same call_id; different call_ids run concurrently.
//
// REQ-DIR-17 mutation gate: read-only mid-call only. The container-agent
// enforces read-only at its own boundary; this gate exists so a misbehaving
// agent emission cannot escape the MCP-server boundary. We use a sentinel
// string at the handler boundary (`__MUTATION_ATTEMPT__`) — the container
// returns that sentinel when its tool-dispatch denies a mutating call mid-
// turn. Phase 05.6 wires the real signal; Phase 05.5 ships the contract.
//
// D-24 (Phase 05.5 / 05.6 boundary): handler accepts a DI-injectable
// `invokeAgentTurn` callback. Phase 05.5 ships a no-op default in
// `mcp-tools/index.ts` returning `{ instructions_update: null }`; Phase
// 05.6 replaces with a real `src/container-runner.ts` integration.
import path from 'path';
import fs from 'fs';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';
import { VoiceTriggerQueue } from '../voice-trigger-queue.js';

// Tool-name regex compliance validated at module load.
export const TOOL_NAME = 'voice_triggers_transcript' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

// REQ-DIR-17 sentinel — see header comment.
const MUTATION_ATTEMPT_SENTINEL = '__MUTATION_ATTEMPT__';

// D-8 locked schema.
export const VoiceTriggersTranscriptSchema = z.object({
  call_id: z.string().min(1),
  turn_id: z.number().int().nonnegative(),
  transcript: z.object({
    turns: z.array(
      z.object({
        role: z.enum(['counterpart', 'assistant']),
        text: z.string(),
        started_at: z.string(),
      }),
    ),
  }),
  fast_brain_state: z
    .object({
      readback_pending: z.string().optional(),
      confirm_action_pending: z.string().optional(),
      silence_nudge_level: z.number().int().min(0).max(3).optional(),
    })
    .default({}),
});

export type VoiceTriggersTranscriptInput = z.infer<
  typeof VoiceTriggersTranscriptSchema
>;

export type VoiceTriggersTranscriptResult =
  | { ok: true; result: { instructions_update: string | null } }
  | { ok: false; error: 'mutation_blocked_mid_call' };

export interface VoiceTriggersTranscriptDeps {
  /** Per-call_id FIFO queue (D-11 / D-12). */
  queue: VoiceTriggerQueue;
  /**
   * D-24 DI seam — Phase 05.5 ships a no-op default; Phase 05.6 replaces
   * with the real `src/container-runner.ts` integration.
   */
  invokeAgentTurn: (
    input: VoiceTriggersTranscriptInput,
  ) => Promise<{ instructions_update: string | null }>;
  /** JSONL path for per-trigger audit log. */
  jsonlPath?: string;
  /** Clock override for tests. */
  now?: () => number;
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}

export function makeVoiceTriggersTranscript(
  deps: VoiceTriggersTranscriptDeps,
): ToolHandler {
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-triggers.jsonl');
  const nowFn = deps.now ?? (() => Date.now());

  return async function voiceTriggersTranscript(args: unknown) {
    const parsed = VoiceTriggersTranscriptSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }

    // FIFO-enqueue keyed by call_id (D-11). The returned promise resolves
    // after every prior turn on this call_id has resolved. Different
    // call_ids run concurrently because they have independent chains.
    return await deps.queue.enqueue(parsed.data.call_id, async () => {
      const start = nowFn();
      try {
        const r = await deps.invokeAgentTurn(parsed.data);

        // REQ-DIR-17 mutation gate. The agent should never emit mutating
        // tool calls mid-call; if a misbehaving emission propagates the
        // sentinel up, refuse the result and audit it.
        if (r.instructions_update === MUTATION_ATTEMPT_SENTINEL) {
          logger.warn({
            event: 'voice_triggers_transcript_mutation_blocked',
            call_id: parsed.data.call_id,
            turn_id: parsed.data.turn_id,
          });
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'transcript_trigger_mutation_blocked',
            call_id: parsed.data.call_id,
            turn_id: parsed.data.turn_id,
            latency_ms: nowFn() - start,
          });
          return {
            ok: false as const,
            error: 'mutation_blocked_mid_call' as const,
          };
        }

        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'transcript_trigger_done',
          call_id: parsed.data.call_id,
          turn_id: parsed.data.turn_id,
          had_update: r.instructions_update !== null,
          latency_ms: nowFn() - start,
        });

        return {
          ok: true as const,
          result: { instructions_update: r.instructions_update },
        };
      } catch (err: unknown) {
        logger.warn({
          event: 'voice_triggers_transcript_failed',
          call_id: parsed.data.call_id,
          turn_id: parsed.data.turn_id,
          err: (err as Error)?.message ?? String(err),
        });
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'transcript_trigger_failed',
          call_id: parsed.data.call_id,
          turn_id: parsed.data.turn_id,
          latency_ms: nowFn() - start,
          err: (err as Error)?.message ?? String(err),
        });
        // Per D-12, failures do not poison the chain — re-throw so the
        // queue's `.then(fn, fn)` semantics propagate to the caller; the
        // caller (Bridge) treats it as a degraded turn and keeps running.
        throw err;
      }
    });
  };
}
