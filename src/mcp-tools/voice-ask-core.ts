/**
 * voice-ask-core.ts
 *
 * MCP tool: voice_ask_core
 * Two-path handler:
 *   - topic='andy' → runAndyForVoice (real container-agent call against groups/main)
 *   - other topics  → Claude-Sonnet inference via OneCLI (echo-skill path)
 *
 * Skill-resolution: data/skills/ask-core-<topic>/SKILL.md
 *
 * - If skill not found → graceful answer 'skill_not_configured'
 * - JSONL log: only lengths + event type, no request/answer text (PII-clean)
 */

import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { logger } from '../logger.js';
import {
  ASK_CORE_CLAUDE_TIMEOUT_MS,
  ASK_CORE_MAX_TOKENS_PER_CALL,
  DATA_DIR,
  SKILLS_DIR,
} from '../config.js';
import { BadRequestError } from './voice-on-transcript-turn.js';
import type { SkillLoadResult } from './skill-loader.js';
import type { AndyVoiceResult } from './andy-agent-runner.js';

// Input schema: topic must be slug-format to prevent path-traversal
export const AskCoreSchema = z.object({
  call_id: z.string().optional(),
  topic: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'topic must be a slug (a-z, 0-9, _, -)'),
  request: z.string().min(1).max(2000),
});

export interface VoiceAskCoreDeps {
  /** Load skill SKILL.md. Must be injected from skill-loader.loadSkill. */
  loadSkill: (topic: string) => Promise<SkillLoadResult>;
  /** Call Claude via OneCLI proxy. Must be injected from claude-client.callClaudeViaOneCli. */
  callClaude: (
    systemPrompt: string,
    messages: Array<{ role: 'user'; content: string }>,
    opts?: { timeoutMs?: number; maxTokens?: number },
  ) => Promise<string>;
  /**
   * Run Andy via real container-agent (topic='andy' path).
   * Injected from andy-agent-runner.runAndyForVoice in index.ts.
   */
  runAndy?: (request: string) => Promise<AndyVoiceResult>;
  /**
   * Send Discord message (fire-and-forget for andy discord_long).
   * Injected from index.ts sendDiscordMessage callback.
   */
  sendDiscord?: (
    channelId: string,
    content: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Discord channel ID for Andy's long-form posts.
   * Injected from config ANDY_VOICE_DISCORD_CHANNEL.
   */
  andyDiscordChannel?: string;
  /** Path to JSONL log file. Default: DATA_DIR/voice-ask-core.jsonl */
  jsonlPath?: string;
  /** Inference timeout in ms. Default: ASK_CORE_CLAUDE_TIMEOUT_MS */
  timeoutMs?: number;
  /** Max tokens per call. Default: ASK_CORE_MAX_TOKENS_PER_CALL */
  maxTokens?: number;
  /** Now function for latency calculation (injectable for tests). */
  now?: () => number;
}

/**
 * Create the voice_ask_core tool handler.
 * Injects deps so the handler can be unit-tested without real fs/Claude calls.
 */
export function makeVoiceAskCore(deps: VoiceAskCoreDeps) {
  const jsonlPath =
    deps.jsonlPath ?? path.join(DATA_DIR, 'voice-ask-core.jsonl');
  const timeoutMs = deps.timeoutMs ?? ASK_CORE_CLAUDE_TIMEOUT_MS;
  const maxTokens = deps.maxTokens ?? ASK_CORE_MAX_TOKENS_PER_CALL;
  const now = deps.now ?? (() => Date.now());

  return async function voiceAskCore(args: unknown): Promise<unknown> {
    const start = now();

    // Validate input with Zod
    const parseResult = AskCoreSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      throw new BadRequestError(
        String(firstError?.path?.[0] ?? 'input'),
        firstError?.message ?? 'invalid',
      );
    }

    const { call_id, topic, request } = parseResult.data;

    // -----------------------------------------------------------------------
    // PATH A: topic='andy' → real container-agent call
    // -----------------------------------------------------------------------
    if (topic === 'andy') {
      if (!deps.runAndy) {
        // Graceful degradation when runAndy not wired (shouldn't happen in prod)
        logger.warn(
          { event: 'ask_core_andy_not_wired' },
          'runAndy not injected — falling through to echo path',
        );
      } else {
        try {
          const result = await deps.runAndy(request);

          // Fire-and-forget Discord long-form if present
          if (
            result.discord_long &&
            deps.sendDiscord &&
            deps.andyDiscordChannel
          ) {
            void deps
              .sendDiscord(deps.andyDiscordChannel, result.discord_long)
              .catch((err: unknown) =>
                logger.warn({ event: 'discord_longform_failed', err }),
              );
          }

          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'ask_core_andy_done',
            tool: 'voice_ask_core',
            call_id: call_id ?? null,
            topic,
            request_len: request.length,
            container_latency_ms: result.container_latency_ms,
            voice_short_len: result.voice_short.length,
            discord_long_sent: !!(
              result.discord_long &&
              deps.sendDiscord &&
              deps.andyDiscordChannel
            ),
            discord_long_len: result.discord_long?.length ?? null,
          });

          return {
            ok: true,
            result: {
              answer: result.voice_short,
              topic: 'andy',
              citations: [],
            },
          };
        } catch (err) {
          logger.warn({ event: 'ask_core_andy_error', err });
          appendJsonl(jsonlPath, {
            ts: new Date().toISOString(),
            event: 'ask_core_andy_failed',
            tool: 'voice_ask_core',
            call_id: call_id ?? null,
            topic,
            request_len: request.length,
            container_latency_ms: null,
            voice_short_len: 0,
            discord_long_sent: false,
            discord_long_len: null,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ok: false, error: 'andy_error' };
        }
      }
    }

    // -----------------------------------------------------------------------
    // PATH B: all other topics → echo-skill / Claude inference path (unchanged)
    // -----------------------------------------------------------------------

    // Load skill file
    const skill = await deps.loadSkill(topic);

    if (!skill.exists || !skill.body) {
      // Graceful: skill not configured — bot can react without crashing
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'ask_core_skill_not_configured',
        tool: 'voice_ask_core',
        call_id: call_id ?? null,
        topic,
        request_len: request.length,
        answer_len: 0,
        latency_ms: now() - start,
      });
      return {
        ok: true,
        result: {
          answer: 'skill_not_configured',
          topic,
          citations: [],
        },
      };
    }

    // Call Claude with skill as system-prompt
    try {
      const rawAnswer = await deps.callClaude(
        skill.body,
        [{ role: 'user', content: request }],
        { timeoutMs, maxTokens },
      );

      // Trim and truncate to 2000 chars
      const answer = rawAnswer.trim().slice(0, 2000);

      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'ask_core_done',
        tool: 'voice_ask_core',
        call_id: call_id ?? null,
        topic,
        request_len: request.length,
        answer_len: answer.length,
        latency_ms: now() - start,
      });

      return {
        ok: true,
        result: {
          answer,
          topic,
          citations: [],
        },
      };
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' ||
          err.message.includes('aborted') ||
          err.message.includes('abort'));

      if (isAbort) {
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'ask_core_failed',
          tool: 'voice_ask_core',
          call_id: call_id ?? null,
          topic,
          request_len: request.length,
          answer_len: 0,
          latency_ms: now() - start,
          error: 'claude_timeout',
        });
        return { ok: false, error: 'claude_timeout' };
      }

      // Network/5xx errors
      logger.warn({ event: 'voice_ask_core_error', topic, err });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'ask_core_failed',
        tool: 'voice_ask_core',
        call_id: call_id ?? null,
        topic,
        request_len: request.length,
        answer_len: 0,
        latency_ms: now() - start,
        error: 'claude_error',
      });
      return { ok: false, error: 'claude_error' };
    }
  };
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}
