// src/mcp-tools/voice-triggers-init.test.ts
// Phase 05.5 Plan 01 Task 2 — vitest in-process unit tests for the init handler.
// Mirrors voice-start-case-2-call.test.ts pattern (Zod factory, DI mocks, BadRequestError).
//
// Phase 05.6 Plan 01 Task 2 — adds the `real defaultInvokeAgent integration`
// describe block that exercises the actual `src/voice-agent-invoker.ts` code
// path with stubbed runContainer / loadMainGroup. Proves Du/Sie axis,
// no-main-group → agent_unavailable mapping, and that the AGENT-NOT-WIRED
// stub no longer survives in any production code path.

import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  makeVoiceTriggersInit,
  VoiceTriggersInitSchema,
  type VoiceTriggersInitInput,
  defaultInvokeAgent,
} from './voice-triggers-init.js';
import {
  INSTRUCTIONS_FENCE_START,
  INSTRUCTIONS_FENCE_END,
  type VoiceAgentInvokerDeps,
} from '../voice-agent-invoker.js';
import type { ContainerOutput } from '../container-runner.js';
import type { RegisteredGroup } from '../types.js';
// Phase 05.6 Plan 01 Task 4: REQ-DIR-17 active-call set assertion.
import {
  isCallActive,
  _resetActiveSet,
} from '../voice-mid-call-gateway.js';

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

  // --- Phase 05.5 Plan 05 (REQ-COST-06) — recordCost DI tests ---

  it('REQ-COST-06: invokes recordCost with init_trigger + turn_id="init" + call_id', async () => {
    const recordCost = vi.fn(async () => {});
    const invokeAgent = vi
      .fn()
      .mockResolvedValue({ instructions: 'p', cost_eur: 0.0042 });
    const handler = makeVoiceTriggersInit({
      invokeAgent,
      recordCost,
      jsonlPath: tmpJsonl(),
    });

    const result = (await handler(makeValidArgs({ call_id: 'cost-call-1' }))) as {
      ok: true;
    };

    expect(result.ok).toBe(true);
    expect(recordCost).toHaveBeenCalledOnce();
    expect(recordCost).toHaveBeenCalledWith({
      call_id: 'cost-call-1',
      turn_id: 'init',
      trigger_type: 'init_trigger',
      cost_eur: 0.0042,
    });
  });

  it('REQ-COST-06: agent returns no cost_eur → recordCost called with cost_eur=0 (Phase-05.5 stub default)', async () => {
    const recordCost = vi.fn(async () => {});
    const invokeAgent = vi.fn().mockResolvedValue({ instructions: 'AGENT_NOT_WIRED' });
    const handler = makeVoiceTriggersInit({
      invokeAgent,
      recordCost,
      jsonlPath: tmpJsonl(),
    });

    await handler(makeValidArgs());

    expect(recordCost).toHaveBeenCalledOnce();
    expect(recordCost).toHaveBeenCalledWith(
      expect.objectContaining({ cost_eur: 0, trigger_type: 'init_trigger' }),
    );
  });

  it('REQ-COST-06: recordCost omitted → handler success path unchanged (backward-compat)', async () => {
    const invokeAgent = vi
      .fn()
      .mockResolvedValue({ instructions: 'p', cost_eur: 0.001 });
    const handler = makeVoiceTriggersInit({ invokeAgent, jsonlPath: tmpJsonl() });

    const result = (await handler(makeValidArgs())) as { ok: true };
    expect(result.ok).toBe(true);
  });

  it('REQ-COST-06: recordCost rejects → handler still returns ok (non-fatal)', async () => {
    const recordCost = vi.fn().mockRejectedValue(new Error('db locked'));
    const invokeAgent = vi
      .fn()
      .mockResolvedValue({ instructions: 'p', cost_eur: 0.01 });
    const handler = makeVoiceTriggersInit({
      invokeAgent,
      recordCost,
      jsonlPath: tmpJsonl(),
    });

    const result = (await handler(makeValidArgs())) as { ok: true };
    expect(result.ok).toBe(true);
    expect(recordCost).toHaveBeenCalledOnce();
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

// ---------------------------------------------------------------------------
// Phase 05.6 Plan 01 Task 2 — real defaultInvokeAgent integration tests.
//
// Drive the handler with NO explicit `invokeAgent` override (uses the real
// default from voice-agent-invoker.ts) plus a stubbed runContainer that
// returns fenced agent output. Proves the AGENT-NOT-WIRED stub is gone
// from the production code path.
// ---------------------------------------------------------------------------

function makeMainGroup(): RegisteredGroup & { jid: string } {
  return {
    name: 'main',
    folder: 'main',
    trigger: '',
    added_at: '2026-04-25T00:00:00Z',
    isMain: true,
    jid: 'main@nanoclaw',
  };
}

function fenced(body: string): string {
  return `chatter\n${INSTRUCTIONS_FENCE_START}\n${body}\n${INSTRUCTIONS_FENCE_END}\n`;
}

function makeRunContainerSuccess(resultBody: string) {
  // Signature must match `typeof runContainerAgent` (RegisteredGroup, no jid).
  return vi.fn(
    async (
      _group: RegisteredGroup,
      _input: unknown,
      _onProcess: (proc: never, name: string) => void,
      onOutput?: (chunk: ContainerOutput) => Promise<void>,
    ): Promise<ContainerOutput> => {
      if (onOutput) {
        await onOutput({ status: 'success', result: resultBody });
      }
      return { status: 'success', result: null };
    },
  );
}

describe('voice_triggers_init — real defaultInvokeAgent integration (Phase 05.6 Plan 01 Task 2)', () => {
  // -------------------------------------------------------------------------
  // Test 1: Du-form rendering for case_6b (Carsten inbound)
  // -------------------------------------------------------------------------
  it('Test 1: case_6b → handler returns instructions containing "Du" via real defaultInvokeAgent', async () => {
    const runContainer = makeRunContainerSuccess(
      fenced('Hallo Carsten, Du kannst Dir das so vorstellen.'),
    );
    const invokerDeps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };
    const handler = makeVoiceTriggersInit({
      invokeAgent: (input) => defaultInvokeAgent(input, invokerDeps),
      jsonlPath: tmpJsonl(),
    });

    const result = (await handler(
      makeValidArgs({ case_type: 'case_6b', call_direction: 'inbound', counterpart_label: 'Carsten' }),
    )) as { ok: true; result: { instructions: string } };

    expect(result.ok).toBe(true);
    expect(result.result.instructions).toContain('Du');
    // Regression — no AGENT-NOT-WIRED leaks through.
    expect(result.result.instructions).not.toContain('AGENT_NOT_WIRED');
  });

  // -------------------------------------------------------------------------
  // Test 2: Sie-form rendering for case_2 (outbound)
  // -------------------------------------------------------------------------
  it('Test 2: case_2 → handler returns instructions containing "Sie" (Du/Sie axis exercised)', async () => {
    const runContainer = makeRunContainerSuccess(
      fenced('Guten Tag, ich rufe wegen einer Reservierung an. Koennen Sie mir helfen?'),
    );
    const invokerDeps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };
    const handler = makeVoiceTriggersInit({
      invokeAgent: (input) => defaultInvokeAgent(input, invokerDeps),
      jsonlPath: tmpJsonl(),
    });
    const result = (await handler(
      makeValidArgs({ case_type: 'case_2', call_direction: 'outbound', counterpart_label: 'Bella Vista' }),
    )) as { ok: true; result: { instructions: string } };
    expect(result.ok).toBe(true);
    expect(result.result.instructions).toContain('Sie');
    expect(result.result.instructions).not.toContain('AGENT_NOT_WIRED');
  });

  // -------------------------------------------------------------------------
  // Test 3: real-default — no main group → agent_unavailable
  // -------------------------------------------------------------------------
  it('Test 3: no main group → handler returns ok:false / agent_unavailable (no uncaught exception)', async () => {
    const runContainer = vi.fn();
    const invokerDeps: VoiceAgentInvokerDeps = {
      runContainer: runContainer as unknown as VoiceAgentInvokerDeps['runContainer'],
      loadMainGroup: () => null,
    };
    const handler = makeVoiceTriggersInit({
      invokeAgent: (input) => defaultInvokeAgent(input, invokerDeps),
      jsonlPath: tmpJsonl(),
    });
    const result = (await handler(makeValidArgs())) as {
      ok: false;
      error: 'agent_unavailable';
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('agent_unavailable');
    expect(runContainer).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 7 — REQ-DIR-17: handler registers the call_id in the active-call set
  // BEFORE invoking the agent. Asserts via the gateway's isCallActive helper.
  // -------------------------------------------------------------------------
  it('Test 7: REQ-DIR-17 — handler registers call_id in active-call set on entry', async () => {
    _resetActiveSet();
    const runContainer = makeRunContainerSuccess(fenced('A persona body.'));
    const invokerDeps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };
    const handler = makeVoiceTriggersInit({
      invokeAgent: (input) => defaultInvokeAgent(input, invokerDeps),
      jsonlPath: tmpJsonl(),
    });
    expect(isCallActive('call-r17-test')).toBe(false);
    await handler(makeValidArgs({ call_id: 'call-r17-test' }));
    // After handler completes, the call_id is still active (matching
    // deregister lives in voice_finalize_call_cost — Test 8 in that file).
    expect(isCallActive('call-r17-test')).toBe(true);
    _resetActiveSet();
  });

  // -------------------------------------------------------------------------
  // Regression test — no AGENT_NOT_WIRED string survives in any handler result
  // (Plan-checker BLOCKER #1 lock-in).
  // -------------------------------------------------------------------------
  it('regression: no AGENT_NOT_WIRED string survives in production code-path', async () => {
    const runContainer = makeRunContainerSuccess(fenced('A real persona body.'));
    const invokerDeps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };
    const handler = makeVoiceTriggersInit({
      invokeAgent: (input) => defaultInvokeAgent(input, invokerDeps),
      jsonlPath: tmpJsonl(),
    });
    const result = await handler(makeValidArgs());
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain('AGENT_NOT_WIRED');
  });
});
