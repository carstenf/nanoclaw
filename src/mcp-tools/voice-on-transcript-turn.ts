import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { logger } from '../logger.js';

import { SlowBrainSessionManager } from './slow-brain-session.js';

// Phase 4.5 Wave-0: zod schema added for TOOL_META inputSchema consumption by
// the session-based MCP transport (port 3201). The existing handwritten
// `validateVoiceTurnArgs` below stays untouched — it continues to validate the
// port-3200 REST path per D-8. Both validators describe the same shape.
export const OnTranscriptTurnSchema = z.object({
  call_id: z.string().min(1),
  turn_id: z.string().min(1),
  transcript: z.string(),
});

export interface VoiceTurnArgs {
  call_id: string;
  turn_id: string;
  transcript: string;
}

export interface VoiceTurnResponse {
  ok: true;
  instructions_update: string | null;
}

export class BadRequestError extends Error {
  constructor(
    public readonly field: string,
    public readonly expected: string,
  ) {
    super(`bad_request: ${field} expected ${expected}`);
    this.name = 'BadRequestError';
  }
}

export interface VoiceOnTranscriptTurnDeps {
  dataDir: string;
  now?: () => number;
  log?: Pick<typeof logger, 'info' | 'warn'>;
  /** Optional session manager — if omitted, falls back to stub (instructions_update: null). */
  sessionManager?: SlowBrainSessionManager;
}

export function validateVoiceTurnArgs(args: unknown): VoiceTurnArgs {
  if (!args || typeof args !== 'object') {
    throw new BadRequestError('arguments', 'object');
  }
  const a = args as Record<string, unknown>;
  if (typeof a.call_id !== 'string' || a.call_id.length === 0) {
    throw new BadRequestError('call_id', 'non-empty string');
  }
  if (typeof a.turn_id !== 'string' || a.turn_id.length === 0) {
    throw new BadRequestError('turn_id', 'non-empty string');
  }
  if (typeof a.transcript !== 'string') {
    throw new BadRequestError('transcript', 'string');
  }
  return {
    call_id: a.call_id,
    turn_id: a.turn_id,
    transcript: a.transcript,
  };
}

export function makeVoiceOnTranscriptTurn(deps: VoiceOnTranscriptTurnDeps) {
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => Date.now());
  const jsonlPath = path.join(deps.dataDir, 'voice-slow-brain.jsonl');
  const sessionManager = deps.sessionManager;

  return async function voiceOnTranscriptTurn(
    args: unknown,
  ): Promise<VoiceTurnResponse> {
    const v = validateVoiceTurnArgs(args);

    // Log length only — transcript text is PII and stays out of the JSONL.
    const receiveEntry = {
      ts: now(),
      event: 'transcript_turn_received',
      call_id: v.call_id,
      turn_id: v.turn_id,
      transcript_len: v.transcript.length,
    };
    try {
      fs.mkdirSync(deps.dataDir, { recursive: true });
      fs.appendFileSync(jsonlPath, JSON.stringify(receiveEntry) + '\n');
    } catch (err) {
      log.warn({ event: 'voice_turn_log_failed', err, path: jsonlPath });
    }

    // If no session manager wired, fall back to stub behavior (null).
    if (!sessionManager) {
      return { ok: true, instructions_update: null };
    }

    // Slow-Brain inference via SessionManager + Claude.
    let instructionsUpdate: string | null = null;
    const inferenceStart = now();
    try {
      const session = sessionManager.getOrCreate(v.call_id);
      instructionsUpdate = await sessionManager.recordTurn(
        session,
        v.turn_id,
        v.transcript,
      );

      // Log inference metrics — no PII (no transcript, no instructions text).
      const session2 = sessionManager.getOrCreate(v.call_id);
      const inferenceEntry = {
        ts: now(),
        event: 'slow_brain_inference_done',
        call_id: v.call_id,
        turn_id: v.turn_id,
        claude_latency_ms: now() - inferenceStart,
        instructions_update_len:
          instructionsUpdate !== null ? instructionsUpdate.length : null,
        message_count: session2.messages.length,
      };
      try {
        fs.appendFileSync(jsonlPath, JSON.stringify(inferenceEntry) + '\n');
      } catch (err) {
        log.warn({ event: 'voice_inference_log_failed', err, path: jsonlPath });
      }
    } catch (err) {
      log.warn({
        event: 'slow_brain_inference_failed',
        call_id: v.call_id,
        turn_id: v.turn_id,
        err,
      });
      instructionsUpdate = null;
    }

    return { ok: true, instructions_update: instructionsUpdate };
  };
}
