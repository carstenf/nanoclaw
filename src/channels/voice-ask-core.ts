// src/channels/voice-ask-core.ts
//
// v2.0 — HTTP channel handler for voice-mcp's voice_ask_core tool.
//
// Architecture (parallel to channels/discord.ts):
//   voice-mcp                    NanoClaw (this handler)
//   ─────────                    ──────────────────────
//   bot calls voice_ask_core ─→  POST /voice/ask_core (bearer-auth)
//                                ↓
//                                (warmup=true → wake-up sentinel, return 200)
//                                (warmup=false → register VoiceRespondManager
//                                                 promise, inject IPC envelope
//                                                 into Andy's main container,
//                                                 await voice_respond, return
//                                                 {voice_short, discord_long?})
//
// Bearer-auth + IP-allowlist are enforced upstream in mcp-stream-server.ts —
// this handler trusts that the request reached it through the trust gate.
//
// Drives the EXACT SAME VoiceRespondManager + tryInjectVoiceRequest pair the
// in-tree voice-ask-core MCP tool used in v1.x. The only thing that changes
// is the entry point: HTTP instead of MCP.

import type { Request, Response } from 'express';
import { z } from 'zod';

import { logger } from '../logger.js';
import {
  type VoiceRespondManager,
  VoiceRespondTimeoutError,
} from '../voice-channel/index.js';

const VoiceAskCoreSchema = z.object({
  call_id: z.string().min(1).max(128),
  topic: z.string().min(1).max(64).default('andy'),
  request: z.string().min(1).max(4000),
  warmup: z.boolean().optional().default(false),
  timeout_ms: z.number().int().min(1000).max(300_000).optional(),
});

export interface VoiceAskCoreHandlerDeps {
  voiceRespondManager: VoiceRespondManager;
  /**
   * Inject the request as an IPC envelope into Andy's active main container.
   * Returns false when no main container is active — caller falls back to
   * a graceful `agent_unavailable`-style answer rather than hanging.
   */
  tryInjectVoiceRequest: (callId: string, request: string) => boolean;
  /**
   * Warmup hook — called on warmup=true requests. Should be a fire-and-forget
   * function that ensures Andy's main container is started (no-op if already
   * running). Returns immediately. Wired in src/index.ts to the existing
   * inboundCallWakeUp() helper.
   */
  warmupContainer?: () => void;
  /** Default request timeout in ms when caller omits timeout_ms. */
  defaultTimeoutMs?: number;
}

export function makeVoiceAskCoreHandler(deps: VoiceAskCoreHandlerDeps) {
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? 90_000;

  return async function voiceAskCoreHandler(
    req: Request,
    res: Response,
  ): Promise<void> {
    const parsed = VoiceAskCoreSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({
        ok: false,
        error: 'bad_request',
        field: String(issue?.path?.[0] ?? 'input'),
        message: issue?.message ?? 'invalid',
      });
      return;
    }

    const { call_id, topic, request, warmup, timeout_ms } = parsed.data;

    // Warmup path — fire-and-forget, return immediately. Voice-mcp uses this
    // at /accept-time so Andy's container is up by the time a real ask_core
    // arrives mid-call.
    if (warmup) {
      try {
        deps.warmupContainer?.();
      } catch (err) {
        logger.warn({
          event: 'voice_ask_core_warmup_failed',
          call_id,
          err: err instanceof Error ? err.message : String(err),
        });
        // Still return 200 — warmup is best-effort.
      }
      logger.info({ event: 'voice_ask_core_warmup_ok', call_id });
      res.status(200).json({ ok: true, result: { warmup: true } });
      return;
    }

    // Normal path — register Promise FIRST, then inject so a sub-second Andy
    // reply does not race the registration (same ordering as v1.x in-tree
    // voice-ask-core handler, see comment there for full reasoning).
    const waitTimeoutMs = timeout_ms ?? defaultTimeoutMs;
    const pendingPromise = deps.voiceRespondManager.register(
      call_id,
      waitTimeoutMs,
    );

    const injected = deps.tryInjectVoiceRequest(call_id, request);
    if (!injected) {
      pendingPromise.catch(() => undefined);
      deps.voiceRespondManager.cancel(call_id, 'no_active_container');
      logger.info({
        event: 'voice_ask_core_no_active_container',
        call_id,
        topic,
      });
      res.status(200).json({
        ok: true,
        result: {
          voice_short:
            'Andy ist gerade nicht erreichbar. Bitte ping Andy kurz auf Discord, dann nochmal anrufen.',
          discord_long: null,
          source: 'no_active_container',
        },
      });
      return;
    }

    try {
      const t0 = Date.now();
      const payload = await pendingPromise;
      const elapsed = Date.now() - t0;
      logger.info({
        event: 'voice_ask_core_done',
        call_id,
        topic,
        elapsed_ms: elapsed,
        voice_short_len: payload.voice_short.length,
        has_discord_long: !!payload.discord_long,
      });
      res.status(200).json({
        ok: true,
        result: {
          voice_short: payload.voice_short,
          discord_long: payload.discord_long ?? null,
          source: 'andy',
          elapsed_ms: elapsed,
        },
      });
    } catch (err) {
      if (err instanceof VoiceRespondTimeoutError) {
        logger.warn({
          event: 'voice_ask_core_timeout',
          call_id,
          topic,
          timeout_ms: waitTimeoutMs,
        });
        res.status(200).json({
          ok: true,
          result: {
            voice_short:
              'Andy meldet sich gerade nicht — sag dem Anrufer, ich melde mich später nochmal.',
            discord_long: null,
            source: 'timeout',
          },
        });
        return;
      }
      logger.warn({
        event: 'voice_ask_core_error',
        call_id,
        err: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ ok: false, error: 'internal' });
    }
  };
}
