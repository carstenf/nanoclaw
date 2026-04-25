// src/mcp-tools/voice-triggers-init.test.ts
// Phase 05.5 Plan 01 Task 2 — vitest in-process unit tests for the init handler.
// Mirrors voice-start-case-2-call.test.ts pattern (Zod factory, DI mocks, BadRequestError).

import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceTriggersInit,
  VoiceTriggersInitSchema,
  type VoiceTriggersInitInput,
} from './voice-triggers-init.js';

function tmpJsonl(): string {
  return path.join(os.tmpdir(), `voice-triggers-init-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function makeValidArgs(overrides: Partial<VoiceTriggersInitInput> = {}): VoiceTriggersInitInput {
  return {
    call_id: 'call-123',
    case_type: 'case_2',
    call_direction: 'outbound',
    counterpart_label: 'Bella Vista',
    ...overrides,
  };
}

describe('voice_triggers_init', () => {
  // --- Test 1: Schema validates D-8 args; missing call_id throws BadRequestError ---
  it('rejects missing call_id with BadRequestError', async () => {
    const handler = makeVoiceTriggersInit({
      invokeAgent: async () => ({ instructions: 'unused' }),
    });
    const { call_id: _drop, ...rest } = makeValidArgs();
    void _drop;
    await expect(handler(rest)).rejects.toBeInstanceOf(BadRequestError);
  });

  // --- Test 2: Valid args + happy invokeAgent → ok:true with rendered instructions ---
  it('happy-path: returns ok:true with rendered instructions string', async () => {
    const invokeAgent = vi
      .fn()
      .mockResolvedValue({ instructions: 'You are NanoClaw. Say hi.' });
    const handler = makeVoiceTriggersInit({ invokeAgent, jsonlPath: tmpJsonl() });

    const result = (await handler(makeValidArgs())) as {
      ok: true;
      result: { instructions: string };
    };

    expect(result.ok).toBe(true);
    expect(result.result.instructions).toBe('You are NanoClaw. Say hi.');
    expect(invokeAgent).toHaveBeenCalledOnce();
    expect(invokeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        call_id: 'call-123',
        case_type: 'case_2',
        call_direction: 'outbound',
        counterpart_label: 'Bella Vista',
      }),
    );
  });

  // --- Test 3: invokeAgent rejects → ok:false, error:'agent_unavailable' (never throws) ---
  it('agent failure returns ok:false / agent_unavailable (never throws)', async () => {
    const invokeAgent = vi.fn().mockRejectedValue(new Error('container down'));
    const handler = makeVoiceTriggersInit({ invokeAgent, jsonlPath: tmpJsonl() });

    const result = (await handler(makeValidArgs())) as {
      ok: false;
      error: 'agent_unavailable';
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('agent_unavailable');
  });

  // --- Test 4: case_type enum accepts case_2/case_6a/case_6b; rejects others ---
  it('case_type accepts case_2, case_6a, case_6b; rejects others with BadRequestError', async () => {
    const invokeAgent = vi.fn().mockResolvedValue({ instructions: 'x' });
    const handler = makeVoiceTriggersInit({ invokeAgent, jsonlPath: tmpJsonl() });

    // Allowed values
    for (const ct of ['case_2', 'case_6a', 'case_6b'] as const) {
      const r = (await handler(makeValidArgs({ case_type: ct }))) as {
        ok: true;
      };
      expect(r.ok).toBe(true);
    }

    // Disallowed value
    await expect(
      handler(makeValidArgs({ case_type: 'case_99' as never })),
    ).rejects.toBeInstanceOf(BadRequestError);

    // Schema sanity check: zod parses the three valid values directly.
    expect(VoiceTriggersInitSchema.safeParse(makeValidArgs({ case_type: 'case_6a' })).success).toBe(true);
  });

  // --- Test 5: JSONL audit line written with init_trigger_done + latency_ms + call_id ---
  it('writes JSONL audit line with event init_trigger_done, latency_ms, call_id', async () => {
    const jsonlPath = tmpJsonl();
    let t = 1_000_000;
    const handler = makeVoiceTriggersInit({
      invokeAgent: async () => ({ instructions: 'x' }),
      jsonlPath,
      now: () => {
        t += 7; // simulate elapsed 7ms
        return t;
      },
    });

    await handler(makeValidArgs({ call_id: 'jsonl-call-1' }));

    expect(fs.existsSync(jsonlPath)).toBe(true);
    const contents = fs.readFileSync(jsonlPath, 'utf8').trim();
    const lines = contents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.event).toBe('init_trigger_done');
    expect(entry.call_id).toBe('jsonl-call-1');
    expect(typeof entry.latency_ms).toBe('number');
    expect(entry.latency_ms).toBeGreaterThanOrEqual(0);

    // Cleanup
    try {
      fs.unlinkSync(jsonlPath);
    } catch {
      // ignore
    }
  });
});
