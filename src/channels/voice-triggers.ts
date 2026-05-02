// src/channels/voice-triggers.ts
//
// V2.2 — HTTP-channel handlers for voice-mcp's slow-brain triggers + utility
// tools. Replaces the MCP-catchall path on port 3201: Bridge no longer talks
// to NanoClaw via MCP, only voice-mcp does, and voice-mcp uses these plain
// HTTP endpoints instead of the StreamableHTTP transport.
//
// Endpoints (mounted in src/mcp-stream-server.ts):
//   POST /voice/init           → voice_triggers_init
//   POST /voice/transcript     → voice_triggers_transcript
//   POST /voice/discord_post   → voice_send_discord_message
//   POST /voice/ask_core       → existing channels/voice-ask-core.ts
//
// Bearer-auth + IP-allowlist are enforced upstream in mcp-stream-server.ts.
// Each handler thinly wraps the corresponding tool's existing make-function:
// the tool already validates args via zod, so a 400 surfaces validation
// errors with the same messages voice-mcp would have seen via MCP.

import type { Request, Response } from 'express';

import { logger } from '../logger.js';
import type { ToolRegistry } from '../mcp-tools/index.js';

interface ToolHandlerFn {
  (args: unknown): Promise<unknown> | unknown;
}

function makeJsonRouteHandler(
  invokeTool: ToolHandlerFn,
  event: string,
) {
  return async function handler(req: Request, res: Response): Promise<void> {
    try {
      const result = await invokeTool(req.body);
      // Existing tool handlers return discriminated unions:
      //   { ok: true, result: ... } | { ok: false, error: string }
      // We pass through verbatim — voice-mcp parses the same shape.
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        event,
        err: message,
      });
      // BadRequestError thrown by tool handlers → 400 with details.
      const isBadRequest =
        err instanceof Error &&
        (err.name === 'BadRequestError' ||
          message.includes('invalid') ||
          message.includes('required'));
      res.status(isBadRequest ? 400 : 500).json({
        ok: false,
        error: isBadRequest ? 'bad_request' : 'internal',
        message,
      });
    }
  };
}

export function makeVoiceInitHandler(registry: ToolRegistry) {
  return makeJsonRouteHandler(
    (args) => registry.invoke('voice_triggers_init', args),
    'voice_init_handler_threw',
  );
}

export function makeVoiceTranscriptHandler(registry: ToolRegistry) {
  return makeJsonRouteHandler(
    (args) => registry.invoke('voice_triggers_transcript', args),
    'voice_transcript_handler_threw',
  );
}

export function makeVoiceDiscordPostHandler(registry: ToolRegistry) {
  return makeJsonRouteHandler(
    (args) => registry.invoke('voice_send_discord_message', args),
    'voice_discord_post_handler_threw',
  );
}
