import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { callClaudeViaOneCli } from './claude-client.js';

// Helper: create a minimal fetch mock that returns a given response
function makeMockFetch(
  status: number,
  body: unknown,
  delay?: number,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    if (delay) {
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const t = setTimeout(() => resolve(), delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  };
}

const SYSTEM = 'Du bist ein Test-Koordinator.';
const MESSAGES: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: 'Hallo, wie geht es dir?' },
];

describe('callClaudeViaOneCli', () => {
  it('posts to api.anthropic.com/v1/messages and returns text', async () => {
    const capturedRequests: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      capturedRequests.push({ url, init: init ?? {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'Gut, danke!' }],
        }),
      } as unknown as Response;
    };

    const result = await callClaudeViaOneCli(SYSTEM, MESSAGES, {
      fetch: mockFetch as unknown as typeof fetch,
    });

    expect(result).toBe('Gut, danke!');
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toContain('api.anthropic.com/v1/messages');

    // Check request body
    const body = JSON.parse(capturedRequests[0].init.body as string);
    expect(body.system).toBe(SYSTEM);
    expect(body.messages).toEqual(MESSAGES);
    expect(body.max_tokens).toBeDefined();
    expect(body.model).toBeDefined();
  });

  it('sends correct anthropic-version header', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      } as unknown as Response;
    };

    await callClaudeViaOneCli(SYSTEM, MESSAGES, { fetch: mockFetch as unknown as typeof fetch });

    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(capturedHeaders['content-type']).toBe('application/json');
  });

  it('throws on 5xx response', async () => {
    const mockFetch = makeMockFetch(500, { error: 'internal server error' });

    await expect(
      callClaudeViaOneCli(SYSTEM, MESSAGES, { fetch: mockFetch as unknown as typeof fetch }),
    ).rejects.toThrow(/500/);
  });

  it('throws on timeout (AbortController)', async () => {
    // delay > timeoutMs → AbortError or timeout-derived error
    const mockFetch = makeMockFetch(200, { content: [{ type: 'text', text: 'late' }] }, 500);

    await expect(
      callClaudeViaOneCli(SYSTEM, MESSAGES, {
        fetch: mockFetch as unknown as typeof fetch,
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
  }, 3000);

  it('throws when content array is missing or empty', async () => {
    const mockFetch = makeMockFetch(200, { content: [] });

    await expect(
      callClaudeViaOneCli(SYSTEM, MESSAGES, { fetch: mockFetch as unknown as typeof fetch }),
    ).rejects.toThrow();
  });

  it('respects opts.model override', async () => {
    let capturedBody: Record<string, unknown> = {};
    const mockFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      } as unknown as Response;
    };

    await callClaudeViaOneCli(SYSTEM, MESSAGES, {
      fetch: mockFetch as unknown as typeof fetch,
      model: 'claude-test-model',
    });

    expect(capturedBody.model).toBe('claude-test-model');
  });
});
