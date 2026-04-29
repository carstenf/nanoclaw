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

  it('lang=en → "you" form, no T-V distinction, EN goal text', () => {
    const out = renderPersona(
      fakeSkill('case_6b'),
      makeInitInput({ lang: 'en' }),
    );
    expect(out).toContain('Anrede: you');
    expect(out).toContain('Pronomen you');
    expect(out).toContain('Disclosure Are you');
    expect(out).toContain('Help Carsten directly via CLI');
    expect(out).not.toContain('ueber CLI');
  });

  it('lang=it case_6b → tu-form, IT goal text', () => {
    const out = renderPersona(
      fakeSkill('case_6b'),
      makeInitInput({ lang: 'it' }),
    );
    expect(out).toContain('Anrede: tu');
    expect(out).toContain('Pronomen tu');
    expect(out).toContain('Re-Ask te');
    expect(out).toContain('Aiutare Carsten');
  });

  it('lang=it case_2 → Lei-form, IT goal text', () => {
    const out = renderPersona(
      fakeSkill('case_2'),
      makeInitInput({
        case_type: 'case_2',
        call_direction: 'outbound',
        counterpart_label: 'Bella Vista',
        lang: 'it',
      }),
    );
    expect(out).toContain('Anrede: Lei');
    expect(out).toContain("Disclosure Lei e'");
    // post-Test-4-retry: case_2+outbound goal-default is now neutral
    // (kein "Prenotare un tavolo" mehr — Andy's goal arg drives the call).
    expect(out).toContain('Risolvere la questione con Bella Vista');
  });

  it('lang omitted → defaults to de (back-compat)', () => {
    const out = renderPersona(fakeSkill('case_6b'), makeInitInput());
    expect(out).toContain('Anrede: Du');
    expect(out).toContain('CLI direkt helfen'); // DE goal
  });
});

// ---------------------------------------------------------------------------
// lang_switch_block (Phase 06.x mid-call language switch instructions)
// ---------------------------------------------------------------------------

const FAKE_BASELINE_WITH_SWITCH = `### ROLE
Aufgabe: {{goal}}.
Sprache: {{lang_switch_block}}
Anrede: {{anrede_form}}
<!-- BEGIN SCHWEIGEN_LADDER call_direction=inbound -->
INBOUND-LADDER
<!-- END SCHWEIGEN_LADDER -->
<!-- BEGIN SCHWEIGEN_LADDER call_direction=outbound -->
OUTBOUND-LADDER
<!-- END SCHWEIGEN_LADDER -->`;

function fakeSkillWithSwitch(caseType: string): VoicePersonaSkillFiles {
  return {
    skill: '# SKILL',
    baseline: FAKE_BASELINE_WITH_SWITCH,
    overlay: '',
    overlayPath: caseType === 'case_2' ? 'overlays/case_2.md' : null,
  };
}

describe('renderPersona — lang_switch_block (language-neutral, Phase 06.x)', () => {
  it('no whitelist → DE active: instructs to speak German, no switch tool, second-attempt-English rule', () => {
    const out = renderPersona(
      fakeSkillWithSwitch('case_2'),
      makeInitInput({ case_type: 'case_2', call_direction: 'outbound', lang: 'de' }),
    );
    expect(out).toContain('Speak German throughout');
    // Second-attempt-English fallback rule must be present.
    expect(out).toMatch(/second time|second attempt|insists/i);
    expect(out).toContain('English');
    expect(out).not.toContain('voice_set_language');
    // No quoted refusal phrase — wording must be language-neutral.
    expect(out).not.toMatch(/"[^"]*Entschuldigung[^"]*"/);
    expect(out).not.toMatch(/"[^"]*Sorry[^"]*"/);
  });

  it('no whitelist → EN active: instructs to speak English, no switch tool', () => {
    const out = renderPersona(
      fakeSkillWithSwitch('case_2'),
      makeInitInput({ case_type: 'case_2', call_direction: 'outbound', lang: 'en' }),
    );
    expect(out).toContain('Speak English throughout');
    expect(out).not.toContain('voice_set_language');
  });

  it('whitelist [de,en,it] starting in de → switch instruction listing English / Italian + switchable codes', () => {
    const out = renderPersona(
      fakeSkillWithSwitch('case_2'),
      makeInitInput({
        case_type: 'case_2',
        call_direction: 'outbound',
        lang: 'de',
        lang_whitelist: ['de', 'en', 'it'],
      }),
    );
    expect(out).toContain('Start this call in German');
    // Allowed-list now uses English language names + slash separator.
    expect(out).toContain('German / English / Italian');
    // Switchable-only codes group passed to set_language.
    expect(out).toContain('en/it');
    expect(out).toContain('voice_set_language');
    // Second-attempt-English rule.
    expect(out).toMatch(/second time|insists/i);
  });

  it('whitelist [de,en] starting in en → switch instruction lists German', () => {
    const out = renderPersona(
      fakeSkillWithSwitch('case_2'),
      makeInitInput({
        case_type: 'case_2',
        call_direction: 'outbound',
        lang: 'en',
        lang_whitelist: ['de', 'en'],
      }),
    );
    expect(out).toContain('Start this call in English');
    expect(out).toContain('German');
    expect(out).toContain('voice_set_language');
  });

  it('whitelist contains only the active lang → behaves like no whitelist (no switchables)', () => {
    const out = renderPersona(
      fakeSkillWithSwitch('case_2'),
      makeInitInput({
        case_type: 'case_2',
        call_direction: 'outbound',
        lang: 'de',
        lang_whitelist: ['de'],
      }),
    );
    expect(out).toContain('Speak German throughout');
    expect(out).not.toContain('voice_set_language');
  });

  it('IT whitelist → starts in Italian, names allowed langs in English form', () => {
    const out = renderPersona(
      fakeSkillWithSwitch('case_2'),
      makeInitInput({
        case_type: 'case_2',
        call_direction: 'outbound',
        lang: 'it',
        lang_whitelist: ['de', 'en', 'it'],
      }),
    );
    expect(out).toContain('Start this call in Italian');
    expect(out).toContain('voice_set_language');
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

  it('passes lang to the skill-files loader (DI seam contract)', async () => {
    let capturedLang: string | undefined;
    await defaultInvokeAgent(makeInitInput({ lang: 'it' }), {
      loadSkillFiles: (caseType, lang) => {
        capturedLang = lang;
        return fakeSkill(caseType);
      },
    });
    expect(capturedLang).toBe('it');
  });

  it('defaults loader lang to de when input lang is omitted', async () => {
    let capturedLang: string | undefined;
    await defaultInvokeAgent(makeInitInput(), {
      loadSkillFiles: (caseType, lang) => {
        capturedLang = lang;
        return fakeSkill(caseType);
      },
    });
    expect(capturedLang).toBe('de');
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
