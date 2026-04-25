// src/voice-agent-invoker.test.ts
//
// Phase 05.6 Plan 01 Task 1 — vitest unit tests for the real
// defaultInvokeAgent / defaultInvokeAgentTurn implementations.
//
// All container interactions are stubbed via the DI seam; no real container
// spawn, no real DB.

import { describe, expect, it, vi } from 'vitest';

import {
  defaultInvokeAgent,
  defaultInvokeAgentTurn,
  buildPersonaRenderPrompt,
  buildPersonaTurnPrompt,
  extractRenderedString,
  INSTRUCTIONS_FENCE_START,
  INSTRUCTIONS_FENCE_END,
  NULL_SENTINEL,
  type VoiceAgentInvokerDeps,
} from './voice-agent-invoker.js';
import type { VoiceTriggersInitInput } from './mcp-tools/voice-triggers-init.js';
import type { VoiceTriggersTranscriptInput } from './mcp-tools/voice-triggers-transcript.js';
import type { ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
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
  return `ignored agent chatter\n${INSTRUCTIONS_FENCE_START}\n${body}\n${INSTRUCTIONS_FENCE_END}\nmore chatter`;
}

function makeRunContainerSuccess(resultBody: string) {
  return vi.fn(
    async (
      _group: RegisteredGroup & { jid: string },
      _input: { prompt: string },
      _onProcess: (proc: unknown, name: string) => void,
      onOutput?: (chunk: ContainerOutput) => Promise<void>,
    ): Promise<ContainerOutput> => {
      // Stream the result through onOutput like the real container-runner.
      if (onOutput) {
        await onOutput({ status: 'success', result: resultBody });
      }
      return { status: 'success', result: null };
    },
  );
}

function makeRunContainerError(errorStr: string) {
  return vi.fn(
    async (): Promise<ContainerOutput> => ({
      status: 'error',
      result: null,
      error: errorStr,
    }),
  );
}

function makeInitInput(
  overrides: Partial<VoiceTriggersInitInput> = {},
): VoiceTriggersInitInput {
  return {
    call_id: 'rtc_unit_init',
    case_type: 'case_6b',
    call_direction: 'inbound',
    counterpart_label: 'Carsten',
    ...overrides,
  };
}

function makeTranscriptInput(
  overrides: Partial<VoiceTriggersTranscriptInput> = {},
): VoiceTriggersTranscriptInput {
  return {
    call_id: 'rtc_unit_turn',
    turn_id: 1,
    transcript: {
      turns: [
        {
          role: 'counterpart',
          text: 'Hallo',
          started_at: '2026-04-25T10:00:00.000Z',
        },
      ],
    },
    fast_brain_state: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — init happy path (case_6b inbound, Carsten, Du-form prompt content)
// ---------------------------------------------------------------------------

describe('defaultInvokeAgent — init', () => {
  it('Test 1: happy path — calls runContainer with isMain:true and prompt naming voice-personas, case_6b, Carsten, inbound, Du-rule', async () => {
    const runContainer = makeRunContainerSuccess(
      fenced('Hallo Carsten — Du kannst Dir das so vorstellen.'),
    );
    const deps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };

    const result = await defaultInvokeAgent(makeInitInput(), deps);

    expect(result.instructions).toContain('Du');
    expect(result.instructions).toContain('Carsten');

    expect(runContainer).toHaveBeenCalledOnce();
    const call = runContainer.mock.calls[0];
    const containerInput = call[1] as { prompt: string; isMain: boolean };
    expect(containerInput.isMain).toBe(true);
    // Prompt content checks (REQ-DIR-16/REQ-DIR-17/D-25/D-27).
    expect(containerInput.prompt).toContain('voice-personas');
    expect(containerInput.prompt).toContain('case_6b');
    expect(containerInput.prompt).toContain('Carsten');
    expect(containerInput.prompt).toContain('inbound');
    // Du/Sie rule visible: literal 'Du' OR 'anrede_form' (D-25 defense-in-depth).
    expect(
      containerInput.prompt.includes('anrede_form') ||
        / Du\b/.test(containerInput.prompt),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2 — init container error
  // -------------------------------------------------------------------------
  it('Test 2: container error → throws with code/message identifiable as agent_unavailable', async () => {
    const runContainer = makeRunContainerError('spawn_failed');
    const deps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };

    let thrown: unknown = null;
    try {
      await defaultInvokeAgent(makeInitInput(), deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('agent_unavailable');
    expect(((thrown as Error) as { code?: string }).code).toBe('agent_unavailable');
  });

  // -------------------------------------------------------------------------
  // Test 3 — init no main group
  // -------------------------------------------------------------------------
  it('Test 3: no main group → throws agent_unavailable', async () => {
    const runContainer = vi.fn();
    const deps: VoiceAgentInvokerDeps = {
      runContainer: runContainer as unknown as VoiceAgentInvokerDeps['runContainer'],
      loadMainGroup: () => null,
    };

    let thrown: unknown = null;
    try {
      await defaultInvokeAgent(makeInitInput(), deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('agent_unavailable');
    expect(runContainer).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 10 — timeout
  // -------------------------------------------------------------------------
  it('Test 10: container hangs past timeoutMs → throws timeout error (default 4500ms — overridden to 30ms here)', async () => {
    // Stub never calls onOutput and never resolves the run.
    const runContainer = vi.fn(
      () =>
        new Promise<ContainerOutput>(() => {
          /* never resolve */
        }),
    );
    const deps: VoiceAgentInvokerDeps = {
      runContainer: runContainer as unknown as VoiceAgentInvokerDeps['runContainer'],
      loadMainGroup: () => makeMainGroup(),
      timeoutMs: 30,
    };

    let thrown: unknown = null;
    try {
      await defaultInvokeAgent(makeInitInput(), deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('timeout');
  });
});

// ---------------------------------------------------------------------------
// Tests 4 + 5 + 6 — extractRenderedString
// ---------------------------------------------------------------------------

describe('extractRenderedString', () => {
  it('Test 4: returns ONLY the body between fences, trimmed, multi-line preserved', async () => {
    const body = 'line one\nline two\n  with indent  ';
    const wrapped = `chatter before\n${INSTRUCTIONS_FENCE_START}\n${body}\n${INSTRUCTIONS_FENCE_END}\nchatter after`;
    const r = extractRenderedString(wrapped);
    expect(r.fenced).toBe(true);
    // body trim() — leading/trailing whitespace + lines preserved.
    expect(r.instructions).toBe('line one\nline two\n  with indent');
  });

  it('Test 5: no fence markers → returns trimmed full string AND fenced=false (caller logs)', async () => {
    const r = extractRenderedString('  some agent chatter without fences  ');
    expect(r.fenced).toBe(false);
    expect(r.instructions).toBe('some agent chatter without fences');
  });

  it('Test 6: detects placeholderLeak when {{...}} survives in body', async () => {
    const wrapped = `${INSTRUCTIONS_FENCE_START}\nHallo {{anrede_form}}\n${INSTRUCTIONS_FENCE_END}`;
    const r = extractRenderedString(wrapped);
    expect(r.placeholderLeak).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5 (warn-log no_fence) and Test 6 (warn-log placeholder_leak) at the
// invoker level — verify defaultInvokeAgent logs the warn events but still
// returns the string (does NOT throw on graceful fallback paths).
// ---------------------------------------------------------------------------

describe('defaultInvokeAgent — warn-log paths', () => {
  it('Test 5 (invoker): no fence in result → emits voice_agent_invoker_no_fence warn and still returns a string', async () => {
    const runContainer = makeRunContainerSuccess(
      'just plain text without any fence markers at all',
    );
    const deps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };
    // Spy on logger.warn to confirm event name.
    const loggerMod = await import('./logger.js');
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn');
    try {
      const result = await defaultInvokeAgent(makeInitInput(), deps);
      expect(result.instructions).toContain('plain text');
      const events = warnSpy.mock.calls.map(
        (c) => (c[0] as { event?: string })?.event,
      );
      expect(events).toContain('voice_agent_invoker_no_fence');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('Test 6 (invoker): placeholder leak → emits voice_agent_invoker_placeholder_leak warn but still returns the string', async () => {
    const runContainer = makeRunContainerSuccess(
      fenced('Hallo {{anrede_form}}'),
    );
    const deps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };
    const loggerMod = await import('./logger.js');
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn');
    try {
      const result = await defaultInvokeAgent(makeInitInput(), deps);
      expect(result.instructions).toContain('{{anrede_form}}');
      const events = warnSpy.mock.calls.map(
        (c) => (c[0] as { event?: string })?.event,
      );
      expect(events).toContain('voice_agent_invoker_placeholder_leak');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7 — transcript happy path
// ---------------------------------------------------------------------------

describe('defaultInvokeAgentTurn — transcript', () => {
  it('Test 7: happy path — prompt contains turn 1 marker, counterpart text "Hallo", voice-personas, read-only guidance', async () => {
    const runContainer = makeRunContainerSuccess(
      fenced('updated persona body'),
    );
    const deps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };
    const result = await defaultInvokeAgentTurn(makeTranscriptInput(), deps);
    expect(result.instructions_update).toBe('updated persona body');

    const call = runContainer.mock.calls[0];
    const prompt = (call[1] as { prompt: string }).prompt;
    expect(prompt).toContain('turn 1');
    expect(prompt).toContain('Hallo');
    expect(prompt).toContain('voice-personas');
    // Read-only-tool guidance literal — REQ-DIR-17 defense layer 1.
    expect(
      prompt.includes('read-only') ||
        prompt.includes('Mutating tools FORBIDDEN') ||
        prompt.includes('NICHT mutierend'),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 8 — transcript null sentinel
  // -------------------------------------------------------------------------
  it('Test 8: NULL_NO_UPDATE sentinel → returns instructions_update:null', async () => {
    const runContainer = makeRunContainerSuccess(fenced(NULL_SENTINEL));
    const deps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };
    const result = await defaultInvokeAgentTurn(makeTranscriptInput(), deps);
    expect(result.instructions_update).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 9 — turn-history forwarded (REQ-DIR-16)
  // -------------------------------------------------------------------------
  it('Test 9: REQ-DIR-16 — full turn-history (5 turns mixed) is in the prompt in order', async () => {
    const runContainer = makeRunContainerSuccess(fenced(NULL_SENTINEL));
    const deps: VoiceAgentInvokerDeps = {
      runContainer,
      loadMainGroup: () => makeMainGroup(),
    };
    const turns: VoiceTriggersTranscriptInput['transcript']['turns'] = [
      { role: 'counterpart', text: 'Hallo dort', started_at: '1' },
      { role: 'assistant', text: 'Guten Tag, hier ist NanoClaw', started_at: '2' },
      { role: 'counterpart', text: 'Trag mir morgen 14 Uhr Zahnarzt ein', started_at: '3' },
      { role: 'assistant', text: 'Verstanden, morgen vierzehn Uhr Zahnarzt', started_at: '4' },
      { role: 'counterpart', text: 'Genau, danke', started_at: '5' },
    ];
    await defaultInvokeAgentTurn(
      makeTranscriptInput({ turn_id: 5, transcript: { turns } }),
      deps,
    );
    const call = runContainer.mock.calls[0];
    const prompt = (call[1] as { prompt: string }).prompt;
    for (const t of turns) {
      expect(prompt).toContain(t.text);
    }
    // Order: position of turn[0] < turn[2] < turn[4] in prompt.
    const idx0 = prompt.indexOf('Hallo dort');
    const idx2 = prompt.indexOf('Trag mir morgen 14 Uhr Zahnarzt ein');
    const idx4 = prompt.indexOf('Genau, danke');
    expect(idx0).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx0);
    expect(idx4).toBeGreaterThan(idx2);
  });
});

// ---------------------------------------------------------------------------
// Prompt-builder direct contract checks (test file regression marker for the
// acceptance grep — INSTRUCTIONS_START literal, Carsten, case_6b, agent_unavailable,
// placeholder, timeout, NULL_NO_UPDATE, turn 1, turn-history).
// ---------------------------------------------------------------------------

describe('prompt builders — contract', () => {
  it('buildPersonaRenderPrompt contains INSTRUCTIONS_START fence + ASCII Du literal + voice-personas', async () => {
    const prompt = buildPersonaRenderPrompt(makeInitInput());
    expect(prompt).toContain('INSTRUCTIONS_START');
    expect(prompt).toContain('voice-personas');
    expect(prompt).toContain('Du');
  });

  it('buildPersonaTurnPrompt mentions NULL_NO_UPDATE sentinel + turn-history header + read-only', async () => {
    const prompt = buildPersonaTurnPrompt(makeTranscriptInput());
    expect(prompt).toContain('NULL_NO_UPDATE');
    // Turn history header (regression marker for REQ-DIR-16) — accept either
    // 'turn history' (current prose) or 'turn-history' (slug form).
    expect(/turn[ -]history/i.test(prompt)).toBe(true);
    expect(prompt).toContain('Mutating tools FORBIDDEN');
  });
});
