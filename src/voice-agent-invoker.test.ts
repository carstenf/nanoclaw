// src/voice-agent-invoker.test.ts
//
// Phase 05.6 Plan 02 (Option E) — vitest unit tests for the pure-template
// render path. Skill-files reader is stubbed via the loadSkillFiles DI
// seam; no LLM, no network, no filesystem reads in tests.

import { describe, expect, it } from 'vitest';

import {
  defaultInvokeAgent,
  defaultInvokeAgentTurn,
  renderPersona,
  extractRenderedString,
  INSTRUCTIONS_FENCE_START,
  INSTRUCTIONS_FENCE_END,
  type VoicePersonaSkillFiles,
} from './voice-agent-invoker.js';
import type { VoiceTriggersInitInput } from './mcp-tools/voice-triggers-init.js';
import type { VoiceTriggersTranscriptInput } from './mcp-tools/voice-triggers-transcript.js';

const FAKE_BASELINE = `### ROLE
Aufgabe: {{goal}}.
Kontext: {{context}}.
Gegenueber: {{counterpart_label}}. Richtung: {{call_direction}}.
Anrede: {{anrede_form}}, Pronomen {{anrede_pronoun}}, Re-Ask {{anrede_capitalized}}, Disclosure {{anrede_disclosure}}.

### CONVERSATION FLOW
<!-- BEGIN SCHWEIGEN_LADDER call_direction=inbound -->
INBOUND-LADDER: bist du da
<!-- END SCHWEIGEN_LADDER -->
<!-- BEGIN SCHWEIGEN_LADDER call_direction=outbound -->
OUTBOUND-LADDER: ist da jemand
<!-- END SCHWEIGEN_LADDER -->
`;

function fakeSkill(caseType: string): VoicePersonaSkillFiles {
  const overlayMap: Record<string, string> = {
    case_6b: '### TASK\nInbound von Carsten.',
    case_2: '### TASK\nOutbound zur Reservierung.',
  };
  return {
    skill: '# SKILL',
    baseline: FAKE_BASELINE,
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
// renderPersona — pure unit
// ---------------------------------------------------------------------------

describe('renderPersona', () => {
  it('case_6b inbound → Du-form, drops outbound ladder, no {{...}} leaks', () => {
    const out = renderPersona(fakeSkill('case_6b'), makeInitInput());
    expect(out).toContain('Anrede: Du');
    expect(out).toContain('Pronomen du');
    expect(out).toContain('Re-Ask dich');
    expect(out).toContain('Disclosure Bist du');
    expect(out).toContain('Gegenueber: Carsten');
    expect(out).toContain('Richtung: inbound');
    expect(out).toContain('INBOUND-LADDER');
    expect(out).not.toContain('OUTBOUND-LADDER');
    expect(out).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(out).toContain('Inbound von Carsten'); // overlay attached
  });

  it('case_2 outbound → Sie-form, drops inbound ladder, attaches case_2 overlay', () => {
    const out = renderPersona(
      fakeSkill('case_2'),
      makeInitInput({
        case_type: 'case_2',
        call_direction: 'outbound',
        counterpart_label: 'Bella Vista',
      }),
    );
    expect(out).toContain('Anrede: Sie');
    expect(out).toContain('Pronomen Sie');
    expect(out).toContain('Re-Ask Sie');
    expect(out).toContain('Disclosure Sind Sie');
    expect(out).toContain('Gegenueber: Bella Vista');
    expect(out).toContain('Richtung: outbound');
    expect(out).toContain('OUTBOUND-LADDER');
    expect(out).not.toContain('INBOUND-LADDER');
    expect(out).toContain('Outbound zur Reservierung'); // overlay attached
  });

  it('drops SCHWEIGEN comment markers entirely (no <!-- BEGIN/END --> remains)', () => {
    const out = renderPersona(fakeSkill('case_6b'), makeInitInput());
    expect(out).not.toContain('BEGIN SCHWEIGEN_LADDER');
    expect(out).not.toContain('END SCHWEIGEN_LADDER');
  });

  it('no overlay → renders baseline only without crash (case_6a is overlay-less)', () => {
    const out = renderPersona(
      fakeSkill('case_6a'),
      makeInitInput({ case_type: 'case_6a' }),
    );
    expect(out).toContain('Anrede: Sie'); // non-6b → Sie default
  });
});

// ---------------------------------------------------------------------------
// extractRenderedString
// ---------------------------------------------------------------------------

describe('extractRenderedString', () => {
  it('extracts body between fence markers', () => {
    const r = extractRenderedString(
      `chatter\n${INSTRUCTIONS_FENCE_START}\nbody\n${INSTRUCTIONS_FENCE_END}\nmore`,
    );
    expect(r.fenced).toBe(true);
    expect(r.instructions).toBe('body');
  });

  it('falls back to trimmed full text without fences', () => {
    const r = extractRenderedString('   plain   ');
    expect(r.fenced).toBe(false);
    expect(r.instructions).toBe('plain');
  });

  it('detects {{...}} leak', () => {
    const r = extractRenderedString(
      `${INSTRUCTIONS_FENCE_START}\nHallo {{counterpart_label}}\n${INSTRUCTIONS_FENCE_END}`,
    );
    expect(r.placeholderLeak).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultInvokeAgent — voice_triggers_init render path
// ---------------------------------------------------------------------------

describe('defaultInvokeAgent', () => {
  it('returns rendered persona with Du-form for case_6b inbound', async () => {
    const r = await defaultInvokeAgent(makeInitInput(), {
      loadSkillFiles: fakeSkill,
    });
    expect(r.instructions).toContain('Du');
    expect(r.instructions).toContain('Carsten');
    expect(r.instructions).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it('returns Sie-form for case_2 outbound', async () => {
    const r = await defaultInvokeAgent(
      makeInitInput({
        case_type: 'case_2',
        call_direction: 'outbound',
        counterpart_label: 'Bella Vista',
      }),
      { loadSkillFiles: fakeSkill },
    );
    expect(r.instructions).toContain('Sie');
    expect(r.instructions).toContain('Bella Vista');
  });

  it('throws agent_unavailable on skill load failure', async () => {
    await expect(
      defaultInvokeAgent(makeInitInput(), {
        loadSkillFiles: () => {
          throw new Error('ENOENT');
        },
      }),
    ).rejects.toMatchObject({ code: 'agent_unavailable' });
  });

  it('returns rendered persona with no AGENT_NOT_WIRED string', async () => {
    const r = await defaultInvokeAgent(makeInitInput(), {
      loadSkillFiles: fakeSkill,
    });
    expect(r.instructions).not.toContain('AGENT_NOT_WIRED');
  });
});

// ---------------------------------------------------------------------------
// defaultInvokeAgentTurn — voice_triggers_transcript render path
// ---------------------------------------------------------------------------

describe('defaultInvokeAgentTurn', () => {
  it('returns null instructions_update by default (no mid-call re-render policy yet)', async () => {
    const r = await defaultInvokeAgentTurn(makeTranscriptInput());
    expect(r.instructions_update).toBeNull();
  });

  it('does not error on multi-turn history (REQ-DIR-16 contract preserved)', async () => {
    const r = await defaultInvokeAgentTurn(
      makeTranscriptInput({
        transcript: {
          turns: [
            { role: 'counterpart', text: 't1', started_at: '1' },
            { role: 'assistant', text: 't2', started_at: '2' },
            { role: 'counterpart', text: 't3', started_at: '3' },
            { role: 'assistant', text: 't4', started_at: '4' },
            { role: 'counterpart', text: 't5', started_at: '5' },
          ],
        },
      }),
    );
    expect(r.instructions_update).toBeNull();
  });
});
