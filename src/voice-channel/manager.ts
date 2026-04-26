/**
 * voice-channel/manager.ts
 *
 * VoiceRespondManager — Promise-correlation between an in-flight ask_core
 * voice request and Andy's reply via the voice_respond MCP-Tool.
 *
 * Flow:
 *   1. voice-ask-core handler (topic='andy', existing-container path) calls
 *      `register(call_id, timeoutMs)` which drops a VoiceRequestEnvelope IPC
 *      file into the whatsapp_main container input/. It then awaits the
 *      returned Promise.
 *   2. Andy (running in whatsapp_main container) processes the request and
 *      calls the voice_respond MCP-Tool with `{call_id, voice_short,
 *      discord_long?}`. The MCP-Tool handler calls `resolve(call_id, ...)`.
 *   3. The Promise registered in step 1 resolves with Andy's payload, which
 *      voice-ask-core returns as the ask_core tool result.
 *
 * Timeouts: each register() arms a setTimeout that rejects the Promise if
 * Andy does not call voice_respond within `timeoutMs`. The handler in
 * voice-ask-core catches this and falls back to a graceful timeout message.
 */
import { logger } from '../logger.js';

export interface AndyVoicePayload {
  voice_short: string;
  discord_long?: string | null;
}

interface PendingRequest {
  resolve: (payload: AndyVoicePayload) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  startedAt: number;
}

export class VoiceRespondTimeoutError extends Error {
  constructor(
    public readonly callId: string,
    public readonly timeoutMs: number,
  ) {
    super(`voice_respond timeout: ${callId} (${timeoutMs}ms)`);
    this.name = 'VoiceRespondTimeoutError';
  }
}

export class VoiceRespondNotFoundError extends Error {
  constructor(public readonly callId: string) {
    super(`voice_respond: no pending request for call_id=${callId}`);
    this.name = 'VoiceRespondNotFoundError';
  }
}

export class VoiceRespondManager {
  private pending = new Map<string, PendingRequest>();

  /**
   * Register a pending request. Returns a Promise that resolves when
   * voice_respond fires for this call_id, or rejects with
   * VoiceRespondTimeoutError after timeoutMs.
   *
   * If a prior request with the same call_id is still pending, it is
   * rejected with a duplicate-key error before the new one registers
   * (defensive — ask_core should normally never re-issue with the same
   * call_id, but a buggy bridge could).
   */
  register(callId: string, timeoutMs: number): Promise<AndyVoicePayload> {
    const existing = this.pending.get(callId);
    if (existing) {
      logger.warn(
        { event: 'voice_respond_duplicate_register', call_id: callId },
        'voice_respond: rejecting prior pending and re-registering',
      );
      clearTimeout(existing.timeoutHandle);
      existing.reject(new Error(`duplicate register for call_id=${callId}`));
      this.pending.delete(callId);
    }

    return new Promise<AndyVoicePayload>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pending.delete(callId)) {
          logger.warn(
            { event: 'voice_respond_timeout', call_id: callId, timeoutMs },
            'voice_respond timed out — Andy did not call voice_respond',
          );
          reject(new VoiceRespondTimeoutError(callId, timeoutMs));
        }
      }, timeoutMs);
      // Allow Node to exit even if the timer is still active.
      if (timeoutHandle.unref) timeoutHandle.unref();

      this.pending.set(callId, {
        resolve,
        reject,
        timeoutHandle,
        startedAt: Date.now(),
      });
    });
  }

  /**
   * Resolve a pending request with Andy's payload. Returns true if the
   * call_id matched a pending request, false if no such request exists
   * (caller may have already timed out).
   */
  resolve(callId: string, payload: AndyVoicePayload): boolean {
    const entry = this.pending.get(callId);
    if (!entry) {
      logger.warn(
        { event: 'voice_respond_no_pending', call_id: callId },
        'voice_respond called for unknown call_id (timeout or never registered)',
      );
      return false;
    }
    clearTimeout(entry.timeoutHandle);
    this.pending.delete(callId);
    const elapsed = Date.now() - entry.startedAt;
    logger.info(
      {
        event: 'voice_respond_resolved',
        call_id: callId,
        elapsed_ms: elapsed,
        voice_short_len: payload.voice_short.length,
        has_discord_long: !!payload.discord_long,
      },
      'voice_respond resolved pending ask_core request',
    );
    entry.resolve(payload);
    return true;
  }

  /** Number of currently-pending requests (for telemetry/tests). */
  size(): number {
    return this.pending.size;
  }

  /** Test/shutdown helper: clear all pending and reject them. */
  clear(reason = 'shutdown'): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeoutHandle);
      entry.reject(new Error(`voice_respond cleared: ${reason}`));
    }
    this.pending.clear();
  }
}
