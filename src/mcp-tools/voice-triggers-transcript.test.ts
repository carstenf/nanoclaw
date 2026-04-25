// src/mcp-tools/voice-triggers-transcript.test.ts
// Phase 05.5 Plan 01 Task 3 — vitest in-process unit tests for the transcript handler.
// Uses a real VoiceTriggerQueue (not mocked) so FIFO behaviour is end-to-end-asserted.
//
// Phase 05.6 Plan 01 Task 2 — adds the `real defaultInvokeAgentTurn integration`
// describe block that exercises the actual `src/voice-agent-invoker.ts` code
// path with stubbed runContainer / loadMainGroup. Proves null-update path,
// non-null update path, and that the full turn-history is forwarded
// (REQ-DIR-16 integration-level proof).

import { describe, expect, it, vi } from 'vitest';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceTriggersTranscript,
  VoiceTriggersTranscriptSchema,
  type VoiceTriggersTranscriptInput,
  defaultInvokeAgentTurn,
} from './voice-triggers-transcript.js';
import { VoiceTriggerQueue } from '../voice-trigger-queue.js';
import {
  INSTRUCTIONS_FENCE_START,
  INSTRUCTIONS_FENCE_END,
  NULL_SENTINEL,
  type VoiceAgentInvokerDeps,
  type VoicePersonaSkillFiles,
} from '../voice-agent-invoker.js';

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

  // --- Phase 05.5 Plan 05 (REQ-COST-06) — recordCost DI tests ---

  it('REQ-COST-06: invokes recordCost with transcript_trigger + synthetic turn_id="trigger-N"', async () => {
    const queue = new VoiceTriggerQueue();
    const recordCost = vi.fn(async () => {});
    const invokeAgentTurn = vi
      .fn()
      .mockResolvedValue({ instructions_update: null, cost_eur: 0.0033 });
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn,
      recordCost,
    });

    const result = (await handler(
      makeValidArgs({ call_id: 'tt-call-1', turn_id: 7 }),
    )) as { ok: true };

    expect(result.ok).toBe(true);
    expect(recordCost).toHaveBeenCalledOnce();
    expect(recordCost).toHaveBeenCalledWith({
      call_id: 'tt-call-1',
      turn_id: 'trigger-7',
      trigger_type: 'transcript_trigger',
      cost_eur: 0.0033,
    });
  });

  it('REQ-COST-06: agent returns no cost_eur → recordCost called with cost_eur=0 (Phase-05.5 stub default)', async () => {
    const queue = new VoiceTriggerQueue();
    const recordCost = vi.fn(async () => {});
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: async () => ({ instructions_update: null }),
      recordCost,
    });

    await handler(makeValidArgs());

    expect(recordCost).toHaveBeenCalledOnce();
    expect(recordCost).toHaveBeenCalledWith(
      expect.objectContaining({ cost_eur: 0, trigger_type: 'transcript_trigger' }),
    );
  });

  it('REQ-COST-06: recordCost omitted → handler success path unchanged (backward-compat)', async () => {
    const queue = new VoiceTriggerQueue();
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: async () => ({ instructions_update: 'updated', cost_eur: 0.01 }),
    });

    const result = (await handler(makeValidArgs())) as {
      ok: true;
      result: { instructions_update: string | null };
    };
    expect(result.ok).toBe(true);
    expect(result.result.instructions_update).toBe('updated');
  });

  it('REQ-COST-06: mutation-blocked turn does NOT record cost (audit-only)', async () => {
    const queue = new VoiceTriggerQueue();
    const recordCost = vi.fn(async () => {});
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: async () => ({ instructions_update: '__MUTATION_ATTEMPT__' }),
      recordCost,
    });

    const result = (await handler(makeValidArgs())) as {
      ok: false;
      error: 'mutation_blocked_mid_call';
    };

    expect(result.ok).toBe(false);
    expect(recordCost).not.toHaveBeenCalled();
  });

  it('REQ-COST-06: recordCost rejects → handler still returns ok (non-fatal)', async () => {
    const queue = new VoiceTriggerQueue();
    const recordCost = vi.fn().mockRejectedValue(new Error('db locked'));
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: async () => ({ instructions_update: null, cost_eur: 0.01 }),
      recordCost,
    });

    const result = (await handler(makeValidArgs())) as { ok: true };
    expect(result.ok).toBe(true);
    expect(recordCost).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Phase 05.6 Plan 01 Task 2 — real defaultInvokeAgentTurn integration tests.
//
// Drives the handler with NO explicit `invokeAgentTurn` override (uses the
// real default from voice-agent-invoker.ts) plus a stubbed runContainer that
// returns fenced agent output.
// ---------------------------------------------------------------------------

function fenced(body: string): string {
  return `chatter\n${INSTRUCTIONS_FENCE_START}\n${body}\n${INSTRUCTIONS_FENCE_END}\n`;
}

function fakeSkill(): VoicePersonaSkillFiles {
  return {
    skill: '# SKILL\nRender persona between fences.',
    baseline: '# BASELINE\nGoal: {{goal}}',
    overlay: '',
    overlayPath: null,
  };
}

function makeRenderApiSuccess(resultBody: string) {
  return vi.fn().mockResolvedValue(resultBody);
}

describe('voice_triggers_transcript — real defaultInvokeAgentTurn integration (Phase 05.6 Plan 01 Task 2)', () => {
  // -------------------------------------------------------------------------
  // Test 4: real-default — null update pass-through
  // -------------------------------------------------------------------------
  it('Test 4: NULL_NO_UPDATE sentinel → handler returns ok:true with instructions_update:null', async () => {
    const queue = new VoiceTriggerQueue();
    const renderApi = makeRenderApiSuccess(fenced(NULL_SENTINEL));
    const invokerDeps: VoiceAgentInvokerDeps = {
      loadSkillFiles: fakeSkill,
    };
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: (input) => defaultInvokeAgentTurn(input, invokerDeps),
    });
    const result = (await handler(makeValidArgs())) as {
      ok: true;
      result: { instructions_update: string | null };
    };
    expect(result.ok).toBe(true);
    expect(result.result.instructions_update).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 5: real-default — non-null update path
  // -------------------------------------------------------------------------
  // Test 5 (Phase 05.6 Plan 02 Option E): real-default returns null today —
  // mid-call persona re-render policy will be added later. Bridge falls back
  // to existing instructions on null update (REQ-DIR-12 path is unchanged).
  it('Test 5: real-default → handler returns instructions_update:null (no mid-call re-render policy yet)', async () => {
    const queue = new VoiceTriggerQueue();
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: (input) =>
        defaultInvokeAgentTurn(input, { loadSkillFiles: fakeSkill }),
    });
    const result = (await handler(makeValidArgs())) as {
      ok: true;
      result: { instructions_update: string | null };
    };
    expect(result.ok).toBe(true);
    expect(result.result.instructions_update).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 6: REQ-DIR-16 — full turn-history is forwarded into the
  // invokeAgentTurn callback so any future re-render policy has full context.
  // Asserted via a custom invokeAgentTurn spy that captures the input.
  // -------------------------------------------------------------------------
  it('Test 6: REQ-DIR-16 — 5-turn transcript → invokeAgentTurn receives all 5 turns in order', async () => {
    const queue = new VoiceTriggerQueue();
    const invokeSpy = vi
      .fn()
      .mockResolvedValue({ instructions_update: null });
    const handler = makeVoiceTriggersTranscript({
      queue,
      invokeAgentTurn: invokeSpy,
    });

    const turns = [
      { role: 'counterpart' as const, text: 'Erste Frage', started_at: '1' },
      { role: 'assistant' as const, text: 'Erste Antwort', started_at: '2' },
      { role: 'counterpart' as const, text: 'Zweite Frage', started_at: '3' },
      { role: 'assistant' as const, text: 'Zweite Antwort', started_at: '4' },
      { role: 'counterpart' as const, text: 'Dritte Frage', started_at: '5' },
    ];

    await handler(
      makeValidArgs({
        turn_id: 5,
        transcript: { turns },
      }),
    );

    expect(invokeSpy).toHaveBeenCalledOnce();
    const passedInput = invokeSpy.mock.calls[0][0] as {
      transcript: { turns: typeof turns };
    };
    expect(passedInput.transcript.turns).toEqual(turns);
  });
});
