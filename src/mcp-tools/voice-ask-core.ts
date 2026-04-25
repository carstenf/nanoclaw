/**
 * voice-ask-core.ts
 *
 * MCP tool: voice_ask_core
 * Two-path handler:
 *   - topic='andy' → IPC injection into the existing whatsapp_main container
 *     (Andy answers via the voice_respond MCP tool). NO --rm fallback.
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
import {
  type VoiceRespondManager,
  VoiceRespondTimeoutError,
} from '../voice-respond-manager.js';

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
  /**
   * Phase 05.6-04 follow-up: shared VoiceRespondManager. When provided
   * together with `tryInjectVoiceRequest`, topic='andy' first tries to inject
   * the request into the existing whatsapp_main container (no docker spawn).
   */
  voiceRespondManager?: VoiceRespondManager;
  /**
   * Phase 05.6-04 follow-up: timeout (ms) for waiting on voice_respond when
   * the existing-container path is taken. Defaults to ASK_CORE_ANDY_TIMEOUT_MS.
   */
  voiceRequestTimeoutMs?: number;
  /**
   * Phase 05.6-04 follow-up: drop a voice_request IPC envelope into the
   * active main container. Returns true if the container was active and the
   * file was written; false if no active container — in which case ask_core
   * returns a graceful "Andy not reachable" message (NO --rm fallback to
   * avoid orphan-container leaks across NanoClaw restarts). Wired in
   * NanoClaw index.ts as `(callId, prompt) => queue.sendVoiceRequest(...)`.
   */
  tryInjectVoiceRequest?: (
    callId: string,
    prompt: string,
  ) => boolean;
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
    // PATH A: topic='andy' → Andy in the existing whatsapp_main container.
    // Single source. NO --rm fallback — running parallel containers would
    // race with the persistent whatsapp_main container's IPC + leak orphans
    // on each NanoClaw restart. If no main container is active, we return a
    // graceful "Andy not reachable" so the voice-bot can ask the user to try
    // again after pinging Andy on Discord/WhatsApp first.
    // -----------------------------------------------------------------------
    if (topic === 'andy') {
      if (
        !call_id ||
        !deps.voiceRespondManager ||
        !deps.tryInjectVoiceRequest
      ) {
        logger.warn(
          {
            event: 'ask_core_andy_not_wired',
            has_call_id: !!call_id,
            has_manager: !!deps.voiceRespondManager,
            has_injector: !!deps.tryInjectVoiceRequest,
          },
          'ask_core andy: missing wiring (call_id / voiceRespondManager / tryInjectVoiceRequest)',
        );
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'ask_core_andy_not_wired',
          tool: 'voice_ask_core',
          call_id: call_id ?? null,
          topic,
          request_len: request.length,
        });
        return {
          ok: true,
          result: {
            answer:
              'Andy ist gerade nicht erreichbar. Bitte ping Andy kurz auf Discord, dann nochmal anrufen.',
            topic: 'andy',
            citations: [],
          },
        };
      }

      // Register the pending Promise FIRST, then inject. If we injected
      // first and Andy was super-fast (sub-second), voice_respond could
      // resolve before register() ran → matched=false → Discord fallback
      // even on perfectly-timed answers (race condition).
      const waitTimeoutMs =
        deps.voiceRequestTimeoutMs ?? 90_000;
      const pendingPromise = deps.voiceRespondManager.register(
        call_id,
        waitTimeoutMs,
      );

      const injected = deps.tryInjectVoiceRequest(call_id, request);
      if (!injected) {
        // Cancel the just-registered pending entry — nothing will resolve it.
        // .clear() rejects all pending; we can't surgically remove one entry,
        // so let the Promise time out naturally (not awaited here).
        pendingPromise.catch(() => undefined);
        logger.info(
          {
            event: 'ask_core_andy_no_active_container',
            call_id,
          },
          'No active main container — graceful skip (no --rm fallback)',
        );
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'ask_core_andy_no_active_container',
          tool: 'voice_ask_core',
          call_id,
          topic,
          request_len: request.length,
        });
        return {
          ok: true,
          result: {
            answer:
              'Andy ist gerade nicht erreichbar. Bitte ping Andy kurz auf Discord, dann nochmal anrufen.',
            topic: 'andy',
            citations: [],
          },
        };
      }

      try {
        const t0 = now();
        const payload = await pendingPromise;
        const elapsed = now() - t0;
        logger.info(
          {
            event: 'ask_core_andy_done_existing_container',
            call_id,
            elapsed_ms: elapsed,
            voice_short_len: payload.voice_short.length,
            has_discord_long: !!payload.discord_long,
          },
          'ask_core via existing whatsapp_main container',
        );
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'ask_core_andy_done_existing_container',
          tool: 'voice_ask_core',
          call_id,
          topic,
          request_len: request.length,
          container_latency_ms: elapsed,
          voice_short_len: payload.voice_short.length,
          discord_long_sent: !!(
            payload.discord_long &&
            deps.sendDiscord &&
            deps.andyDiscordChannel
          ),
          discord_long_len: payload.discord_long?.length ?? null,
        });
        return {
          ok: true,
          result: {
            answer: payload.voice_short,
            topic: 'andy',
            citations: [],
          },
        };
      } catch (err) {
        const isTimeout = err instanceof VoiceRespondTimeoutError;
        logger.warn(
          {
            event: 'ask_core_andy_existing_container_failed',
            call_id,
            is_timeout: isTimeout,
            err: err instanceof Error ? err.message : String(err),
          },
          'ask_core existing-container path failed — graceful skip (no --rm fallback)',
        );
        appendJsonl(jsonlPath, {
          ts: new Date().toISOString(),
          event: 'ask_core_andy_existing_container_failed',
          tool: 'voice_ask_core',
          call_id,
          topic,
          request_len: request.length,
          is_timeout: isTimeout,
        });
        return {
          ok: true,
          result: {
            answer: isTimeout
              ? 'Andy braucht laenger als erwartet. Ich melde mich gleich auf Discord.'
              : 'Andy ist gerade nicht erreichbar. Bitte ping Andy kurz auf Discord, dann nochmal anrufen.',
            topic: 'andy',
            citations: [],
          },
        };
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
