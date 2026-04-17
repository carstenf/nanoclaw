import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

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

  return async function voiceOnTranscriptTurn(
    args: unknown,
  ): Promise<VoiceTurnResponse> {
    const v = validateVoiceTurnArgs(args);

    // Log length only — transcript text is PII and stays out of the JSONL.
    const entry = {
      ts: now(),
      event: 'transcript_turn_received',
      call_id: v.call_id,
      turn_id: v.turn_id,
      transcript_len: v.transcript.length,
    };
    try {
      fs.mkdirSync(deps.dataDir, { recursive: true });
      fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      log.warn({ event: 'voice_turn_log_failed', err, path: jsonlPath });
    }

    // Stub v0 — actual Claude-Slow-Brain inference lands in Plan 03-02.
    return { ok: true, instructions_update: null };
  };
}
