/**
 * claude-client.ts
 *
 * Thin fetch-based client for the Anthropic Messages API routed via OneCLI proxy.
 * OneCLI intercepts the TLS handshake and injects OAuth credentials in-flight.
 * No @anthropic-ai/sdk dependency — keeps Nanoclaw dep footprint small.
 */
import { ProxyAgent } from 'undici';

import {
  ONECLI_URL,
  SLOW_BRAIN_MODEL,
  SLOW_BRAIN_MAX_TOKENS_PER_TURN,
  SLOW_BRAIN_CLAUDE_TIMEOUT_MS,
} from '../config.js';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CallClaudeOpts {
  /** Override the fetch implementation (for testing). Default: globalThis.fetch */
  fetch?: typeof globalThis.fetch;
  /** Override the undici ProxyAgent dispatcher (for testing). Default: new ProxyAgent(ONECLI_URL) */
  dispatcher?: unknown;
  /** Timeout in milliseconds. Default: SLOW_BRAIN_CLAUDE_TIMEOUT_MS (5000) */
  timeoutMs?: number;
  /** Model ID override. Default: SLOW_BRAIN_MODEL */
  model?: string;
  /** max_tokens override. Default: SLOW_BRAIN_MAX_TOKENS_PER_TURN */
  maxTokens?: number;
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Call Claude Sonnet via the OneCLI proxy (MITM HTTPS gateway).
 *
 * @param systemPrompt  System prompt sent with every request.
 * @param messages      Conversation history (user/assistant turns).
 * @param opts          Optional overrides for DI / configuration.
 * @returns             The raw text from content[0].text.
 * @throws              On non-2xx, timeout, or missing content.
 */
export async function callClaudeViaOneCli(
  systemPrompt: string,
  messages: ClaudeMessage[],
  opts: CallClaudeOpts = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? SLOW_BRAIN_CLAUDE_TIMEOUT_MS;
  const model = opts.model ?? SLOW_BRAIN_MODEL;
  const maxTokens = opts.maxTokens ?? SLOW_BRAIN_MAX_TOKENS_PER_TURN;

  const abortCtrl = new AbortController();
  const timer = setTimeout(() => abortCtrl.abort(), timeoutMs);

  // Use injected dispatcher for tests, or create a ProxyAgent to route via OneCLI.
  // ProxyAgent is typed as `object` in undici but used as RequestInit dispatcher.
  const dispatcher =
    opts.dispatcher !== undefined
      ? opts.dispatcher
      : new ProxyAgent(ONECLI_URL);

  const fetchFn = opts.fetch ?? globalThis.fetch;

  try {
    const res = await fetchFn(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
      }),
      // dispatcher is a Node/undici extension not in standard RequestInit.
      // Cast to avoid TypeScript complaints when using the global fetch signature.
      ...(dispatcher ? { dispatcher } : {}),
      signal: abortCtrl.signal,
    } as RequestInit);

    if (!res.ok) {
      throw new Error(
        `Claude API error: HTTP ${res.status} from ${ANTHROPIC_API_URL}`,
      );
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content?.find((c) => c.type === 'text' && c.text);
    if (!textBlock || !textBlock.text) {
      throw new Error(
        'Claude API error: no text content in response',
      );
    }

    return textBlock.text;
  } finally {
    clearTimeout(timer);
  }
}
