import { describe, it, expect, vi } from 'vitest';
import { makeVoiceAskCore } from './voice-ask-core.js';
import { BadRequestError } from './voice-on-transcript-turn.js';

// Helper: build deps with sensible defaults
function makeDeps(
  overrides: Partial<{
    loadSkill: (topic: string) => Promise<{ exists: boolean; body: string | null; path: string }>;
    callClaude: (sys: string, msgs: Array<{ role: 'user'; content: string }>, opts?: { timeoutMs?: number; maxTokens?: number }) => Promise<string>;
    jsonlPath: string;
    timeoutMs: number;
    maxTokens: number;
    now: () => number;
  }> = {},
) {
  return {
    loadSkill: overrides.loadSkill ?? (async () => ({ exists: true, body: 'skill content', path: '/skills/ask-core-test/SKILL.md' })),
    callClaude: overrides.callClaude ?? (async () => 'answer text'),
    jsonlPath: overrides.jsonlPath ?? '/tmp/test-voice-ask-core.jsonl',
    timeoutMs: overrides.timeoutMs ?? 1000,
    maxTokens: overrides.maxTokens ?? 100,
    now: overrides.now ?? (() => 1000),
  };
}

describe('voice.ask_core', () => {
  it('happy path: skill found, claude returns text', async () => {
    const deps = makeDeps({
      loadSkill: async () => ({
        exists: true,
        body: '# Test Skill\nSay hello.',
        path: '/skills/ask-core-test/SKILL.md',
      }),
      callClaude: async (sys, msgs) => {
        expect(sys).toContain('# Test Skill');
        expect(msgs[0].content).toBe('sag Hallo');
        return 'Hallo Carsten von NanoClaw.';
      },
    });
    const handler = makeVoiceAskCore(deps);
    const result = (await handler({ topic: 'test', request: 'sag Hallo' })) as {
      ok: true;
      result: { answer: string; topic: string; citations: string[] };
    };

    expect(result.ok).toBe(true);
    expect(result.result.answer).toBe('Hallo Carsten von NanoClaw.');
    expect(result.result.topic).toBe('test');
    expect(result.result.citations).toEqual([]);
  });

  it('skill-missing: returns skill_not_configured gracefully', async () => {
    const deps = makeDeps({
      loadSkill: async () => ({ exists: false, body: null, path: '/skills/ask-core-nope/SKILL.md' }),
    });
    const handler = makeVoiceAskCore(deps);
    const result = (await handler({ topic: 'nope', request: 'test' })) as {
      ok: true;
      result: { answer: string; topic: string; citations: string[] };
    };

    expect(result.ok).toBe(true);
    expect(result.result.answer).toBe('skill_not_configured');
    expect(result.result.topic).toBe('nope');
  });

  it('zod-fail: empty topic → BadRequestError', async () => {
    const handler = makeVoiceAskCore(makeDeps());
    await expect(handler({ topic: '', request: 'test' })).rejects.toThrow(BadRequestError);
  });

  it('zod-fail: topic fails regex (e.g. "../evil") → BadRequestError', async () => {
    const handler = makeVoiceAskCore(makeDeps());
    await expect(handler({ topic: '../evil', request: 'test' })).rejects.toThrow(BadRequestError);
  });

  it('zod-fail: empty request → BadRequestError', async () => {
    const handler = makeVoiceAskCore(makeDeps());
    await expect(handler({ topic: 'test', request: '' })).rejects.toThrow(BadRequestError);
  });

  it('zod-fail: request > 2000 chars → BadRequestError', async () => {
    const handler = makeVoiceAskCore(makeDeps());
    const longRequest = 'a'.repeat(2001);
    await expect(handler({ topic: 'test', request: longRequest })).rejects.toThrow(BadRequestError);
  });

  it('claude timeout: callClaude aborts → returns ok:false, error:claude_timeout', async () => {
    const deps = makeDeps({
      loadSkill: async () => ({ exists: true, body: 'skill', path: '/skills/ask-core-test/SKILL.md' }),
      callClaude: async () => {
        const err = Object.assign(new DOMException('aborted', 'AbortError'));
        throw err;
      },
    });
    const handler = makeVoiceAskCore(deps);
    const result = (await handler({ topic: 'test', request: 'test' })) as { ok: false; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('claude_timeout');
  });
});
