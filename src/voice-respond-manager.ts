// src/voice-respond-manager.ts
//
// Pattern-B host-side: correlates voice_response container output with the
// awaiting voice-mcp-client request promise. The flow:
//
//   voice-mcp-client.askMain()
//     → register(call_id) returns Promise
//     → injects voice_request envelope into main-container's IPC dir
//     → main container processes turn, emits voice_response marker
//     → runAgent's onOutput sees voice_response → calls resolve(call_id, ...)
//     → askMain Promise resolves with { voice_short, discord_long }
//     → client posts answer back to voice-mcp via voice_post_answer MCP tool
//
// Timeouts owned by caller (askMain Promise.race with timeoutMs). On timeout
// the entry is dropped so a late voice_response just logs unmatched-call_id.

import { logger } from './logger.js';

export interface VoiceAnswer {
  voice_short: string;
  discord_long: string | null;
}

interface PendingEntry {
  resolve: (answer: VoiceAnswer) => void;
  reject: (error: string) => void;
  registeredAt: number;
}

export class VoiceRespondManager {
  private pending = new Map<string, PendingEntry>();

  register(call_id: string, timeoutMs: number): Promise<VoiceAnswer> {
    return new Promise<VoiceAnswer>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve,
        reject,
        registeredAt: Date.now(),
      };
      this.pending.set(call_id, entry);
      setTimeout(() => {
        if (this.pending.get(call_id) === entry) {
          this.pending.delete(call_id);
          reject('timeout');
        }
      }, timeoutMs).unref?.();
    });
  }

  resolve(call_id: string, answer: VoiceAnswer): boolean {
    const entry = this.pending.get(call_id);
    if (!entry) {
      logger.warn({
        event: 'voice_respond_unmatched',
        call_id,
      });
      return false;
    }
    this.pending.delete(call_id);
    entry.resolve(answer);
    return true;
  }

  size(): number {
    return this.pending.size;
  }
}

let _instance: VoiceRespondManager | null = null;

export function getVoiceRespondManager(): VoiceRespondManager {
  if (!_instance) _instance = new VoiceRespondManager();
  return _instance;
}
