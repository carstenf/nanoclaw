/**
 * andy-agent-runner.test.ts
 *
 * Unit tests for runAndyForVoice — mocks runContainerAgent via DI.
 * No real container spawns occur in these tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { runAndyForVoice, type AndyRunnerDeps } from './andy-agent-runner.js';
import type { ContainerOutput } from '../container-runner.js';
import type { RegisteredGroup } from '../types.js';

// Minimal valid RegisteredGroup for main
const FAKE_MAIN: RegisteredGroup & { jid: string } = {
  jid: 'test-jid@g.us',
  name: 'Main',
  folder: 'main',
  trigger: '@Andy',
  added_at: '2025-01-01T00:00:00Z',
  isMain: true,
};

function makeContainerOutput(result: string): ContainerOutput {
  return { status: 'success', result };
}

function makeDeps(overrides: Partial<AndyRunnerDeps> = {}): AndyRunnerDeps {
  return {
    runContainer: vi.fn().mockResolvedValue(
      makeContainerOutput(
        'Some text before.\n{"voice_short": "Neil Armstrong war der erste.", "discord_long": null}',
      ),
    ),
    loadMainGroup: vi.fn().mockReturnValue(FAKE_MAIN),
    loadSkill: vi.fn().mockResolvedValue({
      exists: true,
      body: '# Andy Voice Skill\nAntworte als JSON.',
      path: '/skills/ask-core-andy/SKILL.md',
    }),
    now: vi.fn().mockReturnValueOnce(1000).mockReturnValue(2500),
    timeoutMs: 5000,
    ...overrides,
  };
}

describe('runAndyForVoice', () => {
  it('happy path: parses voice_short and discord_long from container output', async () => {
    const deps = makeDeps();
    const result = await runAndyForVoice('wer war der erste Mensch auf dem Mond', deps);

    expect(result.voice_short).toBe('Neil Armstrong war der erste.');
    expect(result.discord_long).toBeNull();
    expect(result.container_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('passes discord_long when non-null in container output', async () => {
    const deps = makeDeps({
      runContainer: vi.fn().mockResolvedValue(
        makeContainerOutput(
          '{"voice_short": "Kurze Antwort.", "discord_long": "Detaillierte Beschreibung fuer Discord."}',
        ),
      ),
    });
    const result = await runAndyForVoice('erklaere die Photosynthese', deps);

    expect(result.voice_short).toBe('Kurze Antwort.');
    expect(result.discord_long).toBe('Detaillierte Beschreibung fuer Discord.');
  });

  it('skill-missing: returns semantic error voice_short', async () => {
    const deps = makeDeps({
      loadSkill: vi.fn().mockResolvedValue({
        exists: false,
        body: null,
        path: '/skills/ask-core-andy/SKILL.md',
      }),
    });
    const result = await runAndyForVoice('test', deps);

    expect(result.voice_short).toContain('nicht konfiguriert');
    expect(result.discord_long).toBeNull();
  });

  it('group-missing: returns semantic error voice_short', async () => {
    const deps = makeDeps({
      loadMainGroup: vi.fn().mockReturnValue(null),
    });
    const result = await runAndyForVoice('test', deps);

    expect(result.voice_short).toContain('nicht');
    expect(result.discord_long).toBeNull();
  });

  it('container throws: returns spawn-error fallback voice_short', async () => {
    const deps = makeDeps({
      runContainer: vi.fn().mockRejectedValue(new Error('docker not found')),
    });
    const result = await runAndyForVoice('test', deps);

    expect(result.voice_short).toContain('nicht');
    expect(result.discord_long).toBeNull();
  });

  it('timeout fires: returns timeout fallback voice_short', async () => {
    const deps = makeDeps({
      runContainer: vi.fn().mockImplementation(
        () => new Promise<ContainerOutput>((resolve) => setTimeout(() => resolve(makeContainerOutput('{"voice_short":"delayed","discord_long":null}')), 200)),
      ),
      timeoutMs: 10, // Very short timeout
    });
    const result = await runAndyForVoice('test', deps);

    expect(result.voice_short).toMatch(/Discord|nochmal|meldet|dauert/i);
    expect(result.discord_long).toBeNull();
  });

  it('JSON-parse fail: returns first-200-chars fallback', async () => {
    const deps = makeDeps({
      runContainer: vi.fn().mockResolvedValue(
        makeContainerOutput('This is not JSON at all, just plain text output from container.'),
      ),
    });
    const result = await runAndyForVoice('test', deps);

    // Fallback: first 200 chars of output used as voice_short
    expect(result.voice_short).toBeTruthy();
    expect(result.discord_long).toBeNull();
  });

  it('voice_short >3 sentences: truncated to at most 3 sentence-ends', async () => {
    const fiveSentences =
      'Satz eins. Satz zwei. Satz drei. Satz vier. Satz fuenf.';
    const deps = makeDeps({
      runContainer: vi.fn().mockResolvedValue(
        makeContainerOutput(
          `{"voice_short": "${fiveSentences}", "discord_long": null}`,
        ),
      ),
    });
    const result = await runAndyForVoice('test', deps);

    // After truncation, at most 3 sentence-end markers
    const sentenceEnds = (result.voice_short.match(/[.!?]/g) || []).length;
    expect(sentenceEnds).toBeLessThanOrEqual(3);
  });

  it('container returns error status: returns error fallback voice_short', async () => {
    const deps = makeDeps({
      runContainer: vi.fn().mockResolvedValue({
        status: 'error' as const,
        result: null,
        error: 'Container exited with code 1',
      }),
    });
    const result = await runAndyForVoice('test', deps);

    expect(result.voice_short).toContain('nicht');
    expect(result.discord_long).toBeNull();
  });
});
