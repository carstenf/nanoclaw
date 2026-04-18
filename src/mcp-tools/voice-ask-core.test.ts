import { describe, it, expect, vi } from 'vitest';
import { makeVoiceAskCore } from './voice-ask-core.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import type { AndyVoiceResult } from './andy-agent-runner.js';

// Helper: build deps with sensible defaults
function makeDeps(
  overrides: Partial<{
    loadSkill: (
      topic: string,
    ) => Promise<{ exists: boolean; body: string | null; path: string }>;
    callClaude: (
      sys: string,
      msgs: Array<{ role: 'user'; content: string }>,
      opts?: { timeoutMs?: number; maxTokens?: number },
    ) => Promise<string>;
    runAndy: (req: string) => Promise<AndyVoiceResult>;
    sendDiscord: (
      channelId: string,
      content: string,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    andyDiscordChannel: string;
    jsonlPath: string;
    timeoutMs: number;
    maxTokens: number;
    now: () => number;
  }> = {},
) {
  return {
    loadSkill:
      overrides.loadSkill ??
      (async () => ({
        exists: true,
        body: 'skill content',
        path: '/skills/ask-core-test/SKILL.md',
      })),
    callClaude: overrides.callClaude ?? (async () => 'answer text'),
    runAndy:
      overrides.runAndy ??
      (async () => ({
        voice_short: 'Andy Antwort.',
        discord_long: null,
        container_latency_ms: 100,
      })),
    sendDiscord: overrides.sendDiscord ?? vi.fn().mockResolvedValue({ ok: true }),
    andyDiscordChannel: overrides.andyDiscordChannel ?? '1234567890',
    jsonlPath: overrides.jsonlPath ?? '/tmp/test-voice-ask-core.jsonl',
    timeoutMs: overrides.timeoutMs ?? 1000,
    maxTokens: overrides.maxTokens ?? 100,
    now: overrides.now ?? (() => 1000),
  };
}

describe('voice.ask_core', () => {
  // --- Existing echo-path tests (regression) ---

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
      loadSkill: async () => ({
        exists: false,
        body: null,
        path: '/skills/ask-core-nope/SKILL.md',
      }),
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
    await expect(handler({ topic: '', request: 'test' })).rejects.toThrow(
      BadRequestError,
    );
  });

  it('zod-fail: topic fails regex (e.g. "../evil") → BadRequestError', async () => {
    const handler = makeVoiceAskCore(makeDeps());
    await expect(
      handler({ topic: '../evil', request: 'test' }),
    ).rejects.toThrow(BadRequestError);
  });

  it('zod-fail: empty request → BadRequestError', async () => {
    const handler = makeVoiceAskCore(makeDeps());
    await expect(handler({ topic: 'test', request: '' })).rejects.toThrow(
      BadRequestError,
    );
  });

  it('zod-fail: request > 2000 chars → BadRequestError', async () => {
    const handler = makeVoiceAskCore(makeDeps());
    const longRequest = 'a'.repeat(2001);
    await expect(
      handler({ topic: 'test', request: longRequest }),
    ).rejects.toThrow(BadRequestError);
  });

  it('claude timeout: callClaude aborts → returns ok:false, error:claude_timeout', async () => {
    const deps = makeDeps({
      loadSkill: async () => ({
        exists: true,
        body: 'skill',
        path: '/skills/ask-core-test/SKILL.md',
      }),
      callClaude: async () => {
        const err = Object.assign(new DOMException('aborted', 'AbortError'));
        throw err;
      },
    });
    const handler = makeVoiceAskCore(deps);
    const result = (await handler({ topic: 'test', request: 'test' })) as {
      ok: false;
      error: string;
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('claude_timeout');
  });

  // --- New: topic='andy' path tests ---

  it('topic=andy: routes to runAndy, returns voice_short as answer', async () => {
    const runAndy = vi.fn().mockResolvedValue({
      voice_short: 'Neil Armstrong war der erste.',
      discord_long: null,
      container_latency_ms: 1500,
    });
    const deps = makeDeps({ runAndy });
    const handler = makeVoiceAskCore(deps);
    const result = (await handler({
      topic: 'andy',
      request: 'wer war der erste Mensch auf dem Mond',
    })) as { ok: true; result: { answer: string; topic: string } };

    expect(result.ok).toBe(true);
    expect(result.result.answer).toBe('Neil Armstrong war der erste.');
    expect(result.result.topic).toBe('andy');
    expect(runAndy).toHaveBeenCalledWith(
      'wer war der erste Mensch auf dem Mond',
    );
  });

  it('topic=andy + discord_long: fires sendDiscord (fire-and-forget)', async () => {
    const sendDiscord = vi.fn().mockResolvedValue({ ok: true });
    const runAndy = vi.fn().mockResolvedValue({
      voice_short: 'Kurze Antwort.',
      discord_long: 'Detaillierte Erklaerung fuer Discord.',
      container_latency_ms: 2000,
    });
    const deps = makeDeps({ runAndy, sendDiscord, andyDiscordChannel: 'ch-999' });
    const handler = makeVoiceAskCore(deps);
    const result = (await handler({ topic: 'andy', request: 'erklaere mir X' })) as {
      ok: true;
      result: { answer: string };
    };

    expect(result.ok).toBe(true);
    expect(result.result.answer).toBe('Kurze Antwort.');
    // Allow one tick for fire-and-forget
    await new Promise((r) => setTimeout(r, 10));
    expect(sendDiscord).toHaveBeenCalledWith(
      'ch-999',
      'Detaillierte Erklaerung fuer Discord.',
    );
  });

  it('topic=andy + null discord_long: does NOT call sendDiscord', async () => {
    const sendDiscord = vi.fn().mockResolvedValue({ ok: true });
    const runAndy = vi.fn().mockResolvedValue({
      voice_short: 'Kurze Antwort.',
      discord_long: null,
      container_latency_ms: 800,
    });
    const deps = makeDeps({ runAndy, sendDiscord });
    const handler = makeVoiceAskCore(deps);
    await handler({ topic: 'andy', request: 'test' });

    await new Promise((r) => setTimeout(r, 10));
    expect(sendDiscord).not.toHaveBeenCalled();
  });

  it('topic=andy runAndy throws: returns graceful fallback, no crash', async () => {
    const runAndy = vi.fn().mockRejectedValue(new Error('container failed'));
    const deps = makeDeps({ runAndy });
    const handler = makeVoiceAskCore(deps);
    const result = (await handler({ topic: 'andy', request: 'test' })) as {
      ok: boolean;
      result?: { answer: string };
      error?: string;
    };

    // Must not throw — either ok:true with fallback or ok:false
    expect(result).toBeDefined();
  });

  it('topic=andy: JSONL event contains ask_core_andy_done', async () => {
    const fs = await import('fs');
    const jsonlPath = '/tmp/test-andy-jsonl-' + Date.now() + '.jsonl';
    const deps = makeDeps({ jsonlPath });
    const handler = makeVoiceAskCore(deps);
    await handler({ topic: 'andy', request: 'test frage' });

    const lines = fs.default.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l));
    expect(events.some((e: { event: string }) => e.event === 'ask_core_andy_done')).toBe(true);
  });

  it('topic=test (echo-path regression): does NOT call runAndy', async () => {
    const runAndy = vi.fn().mockResolvedValue({
      voice_short: 'Should not be called.',
      discord_long: null,
      container_latency_ms: 0,
    });
    const deps = makeDeps({ runAndy });
    const handler = makeVoiceAskCore(deps);
    const result = (await handler({ topic: 'test', request: 'sag Hallo' })) as {
      ok: true;
      result: { answer: string };
    };

    expect(runAndy).not.toHaveBeenCalled();
    expect(result.result.answer).toBe('answer text'); // callClaude default mock
  });
});
