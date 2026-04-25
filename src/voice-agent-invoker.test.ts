// src/voice-agent-invoker.test.ts
//
// Phase 05.6 Plan 02 — vitest unit tests for the direct-API render path.
//
// All Anthropic API calls are stubbed via the renderApi DI seam; no real
// network, no real skill-files reads (loadSkillFiles is also stubbed).

import { describe, expect, it, vi } from 'vitest';

import {
  defaultInvokeAgent,
  defaultInvokeAgentTurn,
  buildPersonaRenderPrompt,
  buildPersonaTurnPrompt,
  buildSystemPrompt,
  extractRenderedString,
  INSTRUCTIONS_FENCE_START,
  INSTRUCTIONS_FENCE_END,
  NULL_SENTINEL,
  type VoicePersonaSkillFiles,
} from './voice-agent-invoker.js';
import type { VoiceTriggersInitInput } from './mcp-tools/voice-triggers-init.js';
import type { VoiceTriggersTranscriptInput } from './mcp-tools/voice-triggers-transcript.js';

function fenced(body: string): string {
  return `ignored chatter\n${INSTRUCTIONS_FENCE_START}\n${body}\n${INSTRUCTIONS_FENCE_END}\nmore`;
}

function fakeSkill(caseType: string): VoicePersonaSkillFiles {
  const overlayMap: Record<string, string> = {
    case_6b: '## TASK\nInbound von Carsten — Du-Form.',
    case_2: '## TASK\nOutbound zur Restaurant-Reservierung — Sie-Form.',
  };
  return {
    skill: '# SKILL\nRender persona between fences.',
    baseline:
      '# BASELINE\nGoal: {{goal}}\nCounterpart: {{counterpart_label}}\nAnrede: {{anrede_form}}',
    overlay: overlayMap[caseType] ?? '',
    overlayPath: overlayMap[caseType] ? `overlays/${caseType}.md` : null,
  };
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
// extractRenderedString
// ---------------------------------------------------------------------------

describe('extractRenderedString', () => {
  it('extracts body between fence markers', () => {
    const r = extractRenderedString(fenced('Hallo Carsten, Du-Form.'));
    expect(r.fenced).toBe(true);
    expect(r.instructions).toBe('Hallo Carsten, Du-Form.');
    expect(r.placeholderLeak).toBe(false);
  });

  it('falls back to trimmed full text without fences', () => {
    const r = extractRenderedString('   plain output without markers   ');
    expect(r.fenced).toBe(false);
    expect(r.instructions).toBe('plain output without markers');
  });

  it('detects unsubstituted placeholder leak', () => {
    const r = extractRenderedString(fenced('Hallo {{counterpart_label}}'));
    expect(r.placeholderLeak).toBe(true);
  });

  it('returns empty body on null input', () => {
    expect(extractRenderedString(null).instructions).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildPersonaRenderPrompt / buildPersonaTurnPrompt
// ---------------------------------------------------------------------------

describe('buildPersonaRenderPrompt', () => {
  it('includes call_id, case_type, call_direction, counterpart_label', () => {
    const p = buildPersonaRenderPrompt(makeInitInput());
    expect(p).toContain('rtc_unit_init');
    expect(p).toContain('case_6b');
    expect(p).toContain('inbound');
    expect(p).toContain('Carsten');
  });

  it('declares Du-form derivation guidance for case_6b', () => {
    const p = buildPersonaRenderPrompt(makeInitInput({ case_type: 'case_6b' }));
    expect(p).toContain('Du');
  });

  it('declares Sie-form derivation guidance for case_2', () => {
    const p = buildPersonaRenderPrompt(makeInitInput({ case_type: 'case_2' }));
    expect(p).toContain('Sie');
  });
});

describe('buildPersonaTurnPrompt', () => {
  it('forwards full turn-history (REQ-DIR-16)', () => {
    const p = buildPersonaTurnPrompt(
      makeTranscriptInput({
        transcript: {
          turns: [
            { role: 'counterpart', text: 'turn-1', started_at: '2026-04-25T10:00:00Z' },
            { role: 'assistant', text: 'turn-2', started_at: '2026-04-25T10:00:05Z' },
            { role: 'counterpart', text: 'turn-3', started_at: '2026-04-25T10:00:10Z' },
          ],
        },
      }),
    );
    expect(p).toContain('turn-1');
    expect(p).toContain('turn-2');
    expect(p).toContain('turn-3');
  });

  it('mentions NULL_NO_UPDATE sentinel for no-op decision', () => {
    const p = buildPersonaTurnPrompt(makeTranscriptInput());
    expect(p).toContain(NULL_SENTINEL);
  });
});

describe('buildSystemPrompt', () => {
  it('inlines SKILL.md, baseline.md, and overlay', () => {
    const p = buildSystemPrompt(fakeSkill('case_6b'));
    expect(p).toContain('Render persona between fences');
    expect(p).toContain('Goal: {{goal}}');
    expect(p).toContain('Inbound von Carsten');
  });

  it('emits a no-overlay note when case_type has no mapped overlay', () => {
    const p = buildSystemPrompt(fakeSkill('unknown_case'));
    expect(p).toContain('No overlay mapped');
  });

  it('mandates fence markers in OUTPUT FORMAT section', () => {
    const p = buildSystemPrompt(fakeSkill('case_6b'));
    expect(p).toContain(INSTRUCTIONS_FENCE_START);
    expect(p).toContain(INSTRUCTIONS_FENCE_END);
  });
});

// ---------------------------------------------------------------------------
// defaultInvokeAgent — voice_triggers_init render path
// ---------------------------------------------------------------------------

describe('defaultInvokeAgent', () => {
  it('returns rendered persona on happy path (case_6b Du-form)', async () => {
    const renderApi = vi
      .fn()
      .mockResolvedValue(fenced('Hallo Carsten, schoen dass Du anrufst.'));
    const r = await defaultInvokeAgent(makeInitInput(), {
      renderApi,
      loadSkillFiles: fakeSkill,
    });
    expect(r.instructions).toContain('Du anrufst');
    expect(renderApi).toHaveBeenCalledTimes(1);
    const [systemPrompt, userMessage] = renderApi.mock.calls[0];
    expect(systemPrompt).toContain('Render persona between fences');
    expect(userMessage).toContain('case_6b');
    expect(userMessage).toContain('inbound');
  });

  it('passes the case_2 overlay through buildSystemPrompt for case_2 input', async () => {
    const renderApi = vi.fn().mockResolvedValue(fenced('Guten Tag, hier ist Andy.'));
    await defaultInvokeAgent(makeInitInput({ case_type: 'case_2' }), {
      renderApi,
      loadSkillFiles: fakeSkill,
    });
    const [systemPrompt] = renderApi.mock.calls[0];
    expect(systemPrompt).toContain('Outbound zur Restaurant-Reservierung');
  });

  it('throws agent_unavailable on render API error', async () => {
    const renderApi = vi.fn().mockRejectedValue(new Error('Claude API error: HTTP 500'));
    await expect(
      defaultInvokeAgent(makeInitInput(), { renderApi, loadSkillFiles: fakeSkill }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('agent_unavailable'),
      code: 'agent_unavailable',
    });
  });

  it('throws timeout-coded error on AbortError from API', async () => {
    const renderApi = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(
      defaultInvokeAgent(makeInitInput(), { renderApi, loadSkillFiles: fakeSkill }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('throws agent_unavailable on skill load failure', async () => {
    const loadSkillFiles = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT: skill missing');
    });
    const renderApi = vi.fn();
    await expect(
      defaultInvokeAgent(makeInitInput(), { renderApi, loadSkillFiles }),
    ).rejects.toMatchObject({ code: 'agent_unavailable' });
    expect(renderApi).not.toHaveBeenCalled();
  });

  it('extracts fenceless output and flags it (no exception)', async () => {
    const renderApi = vi.fn().mockResolvedValue('plain output without markers');
    const r = await defaultInvokeAgent(makeInitInput(), {
      renderApi,
      loadSkillFiles: fakeSkill,
    });
    expect(r.instructions).toBe('plain output without markers');
  });

  it('passes timeoutMs/maxTokens/model deps through to renderApi', async () => {
    const renderApi = vi.fn().mockResolvedValue(fenced('ok'));
    await defaultInvokeAgent(makeInitInput(), {
      renderApi,
      loadSkillFiles: fakeSkill,
      timeoutMs: 1234,
      maxTokens: 2222,
      model: 'claude-haiku-4-5',
    });
    const [, , opts] = renderApi.mock.calls[0];
    expect(opts).toMatchObject({ timeoutMs: 1234, maxTokens: 2222, model: 'claude-haiku-4-5' });
  });
});

// ---------------------------------------------------------------------------
// defaultInvokeAgentTurn — voice_triggers_transcript render path
// ---------------------------------------------------------------------------

describe('defaultInvokeAgentTurn', () => {
  it('returns null instructions_update when LLM emits NULL_NO_UPDATE', async () => {
    const renderApi = vi.fn().mockResolvedValue(fenced(NULL_SENTINEL));
    const r = await defaultInvokeAgentTurn(makeTranscriptInput(), {
      renderApi,
      loadSkillFiles: fakeSkill,
    });
    expect(r.instructions_update).toBeNull();
  });

  it('returns the rendered string when LLM emits a fresh persona', async () => {
    const renderApi = vi
      .fn()
      .mockResolvedValue(fenced('Updated persona — re-affirm Reservierungs-Confirmation.'));
    const r = await defaultInvokeAgentTurn(makeTranscriptInput(), {
      renderApi,
      loadSkillFiles: fakeSkill,
    });
    expect(r.instructions_update).toContain('Reservierungs-Confirmation');
  });

  it('forwards full turn-history into the user message (REQ-DIR-16)', async () => {
    const renderApi = vi.fn().mockResolvedValue(fenced(NULL_SENTINEL));
    await defaultInvokeAgentTurn(
      makeTranscriptInput({
        transcript: {
          turns: [
            { role: 'counterpart', text: 't1', started_at: '2026-04-25T10:00:00Z' },
            { role: 'assistant', text: 't2', started_at: '2026-04-25T10:00:05Z' },
            { role: 'counterpart', text: 't3', started_at: '2026-04-25T10:00:10Z' },
            { role: 'assistant', text: 't4', started_at: '2026-04-25T10:00:15Z' },
            { role: 'counterpart', text: 't5', started_at: '2026-04-25T10:00:20Z' },
          ],
        },
      }),
      { renderApi, loadSkillFiles: fakeSkill },
    );
    const [, userMessage] = renderApi.mock.calls[0];
    expect(userMessage).toContain('t1');
    expect(userMessage).toContain('t5');
  });

  it('throws agent_unavailable on render API error', async () => {
    const renderApi = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(
      defaultInvokeAgentTurn(makeTranscriptInput(), {
        renderApi,
        loadSkillFiles: fakeSkill,
      }),
    ).rejects.toMatchObject({ code: 'agent_unavailable' });
  });
});
