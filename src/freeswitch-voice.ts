// Phase 1 cleanup (2026-04-16): this module previously owned the legacy
// sidecar call-accept path (Port 4500 external service). That architecture
// was superseded by voice-bridge (Plan 01-05b) per REQ-DIR-01/AC-07.
//
// Remaining exports are minimal stubs kept so Core (src/index.ts) and
// any lingering callers compile without the legacy dependency. Inbound
// calls are accepted by voice-bridge on port 4402 directly. Outbound
// FreeSWITCH-originated calls are out of scope for Phase 1 — any caller
// that lands here will get a deprecation error.
import { logger } from './logger.js';

export interface FreeswitchVoiceDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  getMainJid: () => string | undefined;
}

export function initFreeswitchVoice(_deps: FreeswitchVoiceDeps): void {
  logger.info(
    'FS: freeswitch-voice module is a stub post Plan 01-05b — voice-bridge owns the call path.',
  );
}

export async function makeFreeswitchCall(
  _to: string,
  _goal: string,
  _chatJid: string,
  _voice?: string,
): Promise<never> {
  throw new Error(
    'makeFreeswitchCall is deprecated after Plan 01-05b. FreeSWITCH-originated outbound calls require a rebuild against voice-bridge (Phase 2).',
  );
}
