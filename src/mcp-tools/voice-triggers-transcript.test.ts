// src/mcp-tools/voice-triggers-transcript.test.ts
// Phase 05.5 Plan 01 Task 3 — vitest in-process unit tests for the transcript handler.
// Uses a real VoiceTriggerQueue (not mocked) so FIFO behaviour is end-to-end-asserted.

import { describe, expect, it, vi } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceTriggersTranscript,
  VoiceTriggersTranscriptSchema,
  type VoiceTriggersTranscriptInput,
} from './voice-triggers-transcript.js';
import { VoiceTriggerQueue } from '../voice-trigger-queue.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeValidArgs(
  overrides: Partial<VoiceTriggersTranscriptInput> = {},
): unknown {
  return {
    call_id: 'call-1',
    turn_id: 1,
    transcript: {
      turns: [
        {
          role: 'counterpart',
          text: 'Hallo, ist hier noch frei?',
          started_at: '2026-04-25T10:00:00.000Z',
        },
      ],
    },
    fast_brain_state: {},
    ...overrides,
  };
}

describe('voice_triggers_transcript', () => {
  // --- Test 1: Schema validates D-8 transcript args ---
  it('rejects missing transcript.turns with BadRequestError', async () => {
    const queue = new VoiceTriggerQueue();
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: async () => ({ instructions_update: null }),
    });
    // Drop transcript entirely → schema fail.
    await expect(
      handler({
        call_id: 'call-1',
        turn_id: 1,
        fast_brain_state: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  // --- Test 2: Two sequential calls with same call_id execute FIFO ---
  it('FIFO ordering: turn 1 finishes before turn 2 starts on same call_id', async () => {
    const queue = new VoiceTriggerQueue();
    const events: string[] = [];

    const invokeAgentTurn = vi.fn(async (input: VoiceTriggersTranscriptInput) => {
      events.push(`start:${input.turn_id}`);
      await delay(input.turn_id === 1 ? 50 : 10);
      events.push(`end:${input.turn_id}`);
      return { instructions_update: null };
    });

    const handler = makeVoiceTriggersTranscript({ queue, invokeAgentTurn });

    const p1 = handler(makeValidArgs({ turn_id: 1 }));
    const p2 = handler(makeValidArgs({ turn_id: 2 }));

    await Promise.all([p1, p2]);

    // Strict ordering on same call_id.
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  // --- Test 3: Different call_ids run concurrently (no cross-call blocking) ---
  it('different call_ids run concurrently (REQ-DIR-15 invariant)', async () => {
    const queue = new VoiceTriggerQueue();

    const invokeAgentTurn = vi.fn(async (input: VoiceTriggersTranscriptInput) => {
      // call-A blocks 50ms, call-B 0ms — concurrent → both finish < 80ms.
      const ms = input.call_id === 'call-A' ? 50 : 0;
      await delay(ms);
      return { instructions_update: null };
    });

    const handler = makeVoiceTriggersTranscript({ queue, invokeAgentTurn });

    const t0 = Date.now();
    await Promise.all([
      handler(makeValidArgs({ call_id: 'call-A', turn_id: 1 })),
      handler(makeValidArgs({ call_id: 'call-B', turn_id: 1 })),
    ]);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(120);
  });

  // --- Test 4: instructions_update:null pass-through (not coerced to undefined) ---
  it('pass-through of null instructions_update (D-8 contract)', async () => {
    const queue = new VoiceTriggerQueue();
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: async () => ({ instructions_update: null }),
    });

    const result = (await handler(makeValidArgs())) as {
      ok: true;
      result: { instructions_update: string | null };
    };

    expect(result.ok).toBe(true);
    // Strict null, not undefined.
    expect(result.result.instructions_update).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result.result, 'instructions_update')).toBe(true);
  });

  // --- Test 5: fast_brain_state defaults to {} when omitted ---
  it('fast_brain_state defaults to {} when omitted', async () => {
    const queue = new VoiceTriggerQueue();
    let captured: VoiceTriggersTranscriptInput | null = null;
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: async (input) => {
        captured = input;
        return { instructions_update: null };
      },
    });

    const args = makeValidArgs();
    delete (args as Record<string, unknown>).fast_brain_state;
    await handler(args);

    expect(captured).not.toBeNull();
    expect(captured!.fast_brain_state).toEqual({});

    // Schema sanity check.
    const parsed = VoiceTriggersTranscriptSchema.safeParse({
      call_id: 'x',
      turn_id: 0,
      transcript: { turns: [] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fast_brain_state).toEqual({});
    }
  });

  // --- Test 6: REQ-DIR-17 mutation gate (sentinel string blocks the result) ---
  it('REQ-DIR-17: blocks __MUTATION_ATTEMPT__ sentinel and returns mutation_blocked_mid_call', async () => {
    const queue = new VoiceTriggerQueue();
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: async () => ({ instructions_update: '__MUTATION_ATTEMPT__' }),
    });

    const result = (await handler(makeValidArgs())) as {
      ok: false;
      error: 'mutation_blocked_mid_call';
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('mutation_blocked_mid_call');
  });
});
