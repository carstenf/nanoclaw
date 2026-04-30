import { describe, it, expect, vi } from 'vitest';
import { makeVoiceAskCore } from './voice-ask-core.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import {
  VoiceRespondManager,
  VoiceRespondTimeoutError,
} from '../voice-channel/index.js';

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
    sendDiscord:
      overrides.sendDiscord ?? vi.fn().mockResolvedValue({ ok: true }),
    andyDiscordChannel: overrides.andyDiscordChannel ?? '1234567890',
    jsonlPath: overrides.jsonlPath ?? '/tmp/test-voice-ask-core.jsonl',
    timeoutMs: overrides.timeoutMs ?? 1000,
    maxTokens: overrides.maxTokens ?? 100,
    now: overrides.now ?? (() => 1000),
  };
}

describe('voice_ask_core', () => {
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
        return 'Hallo Operator von NanoClaw.';
      },
    });
    const handler = makeVoiceAskCore(deps);
    const result = (await handler({ topic: 'test', request: 'sag Hallo' })) as {
      ok: true;
      result: { answer: string; topic: string; citations: string[] };
    };

    expect(result.ok).toBe(true);
    expect(result.result.answer).toBe('Hallo Operator von NanoClaw.');
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

  // --- topic='andy' integration tests (Phase 05.6-04 wiring) ---
  // The handler routes via tryInjectVoiceRequest (IPC into existing main
  // container) + VoiceRespondManager (correlate voice_respond callback).
  // No --rm fallback exists — every failure path returns a graceful message.

  it('topic=andy happy path: register → inject → resolve → returns voice_short', async () => {
    const manager = new VoiceRespondManager();
    const tryInjectVoiceRequest = vi.fn(
      (callId: string, _prompt: string): boolean => {
        // Simulate Andy answering nearly immediately after inject.
        setTimeout(
          () =>
            manager.resolve(callId, {
              voice_short: 'Mailand 18 Grad und sonnig.',
              discord_long: null,
            }),
          0,
        );
        return true;
      },
    );

    const handler = makeVoiceAskCore({
      ...makeDeps(),
      voiceRespondManager: manager,
      tryInjectVoiceRequest,
      voiceRequestTimeoutMs: 5000,
    });

    const result = (await handler({
      call_id: 'rtc_test_happy',
      topic: 'andy',
      request: 'Wetter Mailand',
    })) as { ok: true; result: { answer: string; topic: string } };

    expect(result.ok).toBe(true);
    expect(result.result.answer).toBe('Mailand 18 Grad und sonnig.');
    expect(result.result.topic).toBe('andy');
    expect(tryInjectVoiceRequest).toHaveBeenCalledWith(
      'rtc_test_happy',
      'Wetter Mailand',
    );
  });

  it('topic=andy register-before-inject: prevents race when Andy resolves sub-millisecond', async () => {
    const manager = new VoiceRespondManager();
    const order: string[] = [];

    // Wrap manager.register to record call order.
    const realRegister = manager.register.bind(manager);
    manager.register = (callId: string, timeoutMs: number) => {
      order.push('register');
      return realRegister(callId, timeoutMs);
    };

    // Inject simulates a synchronous resolve (worst-case race).
    const tryInjectVoiceRequest = vi.fn(
      (callId: string, _prompt: string): boolean => {
        order.push('inject');
        manager.resolve(callId, { voice_short: 'sub-ms', discord_long: null });
        return true;
      },
    );

    const handler = makeVoiceAskCore({
      ...makeDeps(),
      voiceRespondManager: manager,
      tryInjectVoiceRequest,
      voiceRequestTimeoutMs: 5000,
    });

    await handler({
      call_id: 'rtc_test_race',
      topic: 'andy',
      request: 'race?',
    });

    expect(order).toEqual(['register', 'inject']);
  });

  it('topic=andy missing call_id: returns "nicht erreichbar" graceful', async () => {
    const manager = new VoiceRespondManager();
    const tryInjectVoiceRequest = vi.fn(() => true);
    const handler = makeVoiceAskCore({
      ...makeDeps(),
      voiceRespondManager: manager,
      tryInjectVoiceRequest,
    });

    const result = (await handler({ topic: 'andy', request: 'no call_id' })) as {
      ok: true;
      result: { answer: string };
    };

    expect(result.result.answer).toContain('nicht erreichbar');
    expect(tryInjectVoiceRequest).not.toHaveBeenCalled();
  });

  it('topic=andy not wired (no manager/injector): returns "nicht erreichbar"', async () => {
    const handler = makeVoiceAskCore(makeDeps());
    const result = (await handler({
      call_id: 'rtc_test_unwired',
      topic: 'andy',
      request: 'test',
    })) as { ok: true; result: { answer: string } };
    expect(result.result.answer).toContain('nicht erreichbar');
  });

  it('topic=andy inject returns false (no active container): graceful skip, no leaked pending', async () => {
    const manager = new VoiceRespondManager();
    const tryInjectVoiceRequest = vi.fn(() => false);
    const handler = makeVoiceAskCore({
      ...makeDeps(),
      voiceRespondManager: manager,
      tryInjectVoiceRequest,
      voiceRequestTimeoutMs: 100,
    });

    const result = (await handler({
      call_id: 'rtc_test_no_container',
      topic: 'andy',
      request: 'test',
    })) as { ok: true; result: { answer: string } };

    expect(result.result.answer).toContain('nicht erreichbar');
    expect(tryInjectVoiceRequest).toHaveBeenCalled();
    // Manager.cancel() in the no-active-container branch frees the just-
    // registered pending entry IMMEDIATELY — no need to wait for the natural
    // timeout. size() must be 0 the moment the handler returns.
    expect(manager.size()).toBe(0);
  });

  it('topic=andy manager timeout: returns "braucht laenger" graceful', async () => {
    const manager = new VoiceRespondManager();
    // Inject succeeds but no one calls resolve → timeout fires.
    const tryInjectVoiceRequest = vi.fn(() => true);
    const handler = makeVoiceAskCore({
      ...makeDeps(),
      voiceRespondManager: manager,
      tryInjectVoiceRequest,
      voiceRequestTimeoutMs: 50,
    });

    const result = (await handler({
      call_id: 'rtc_test_timeout',
      topic: 'andy',
      request: 'test',
    })) as { ok: true; result: { answer: string } };

    expect(result.result.answer).toContain('braucht laenger');
    expect(manager.size()).toBe(0);
  });

  it('topic=andy: VoiceRespondTimeoutError class is the rejection type', async () => {
    // Defensive smoke check: ensure handler imports the same error type as
    // the manager rejects with — guards against duplicate-symbol drift.
    const manager = new VoiceRespondManager();
    const promise = manager.register('rtc_smoke', 10);
    await expect(promise).rejects.toBeInstanceOf(VoiceRespondTimeoutError);
  });
});
