import { z } from 'zod';

import { logger } from '../logger.js';
import type { ToolHandler } from './index.js';

/**
 * voice_wake_up — pre-warm path discussed in open_points 2026-04-27 #1.
 *
 * voice-bridge calls this fire-and-forget at /accept time so the existing
 * whatsapp_main container is up-and-idle by the time the first ask_core
 * arrives ~5-10 s later. The call is unconditional (no warm/cold check) —
 * if the container is already up, the wake-up message arrives, Andy's
 * persona instruction tells him to silently no-op, and the existing turn
 * pipeline absorbs the round-trip without producing a Discord/WhatsApp
 * post (output suppression in `runAgent` callback when prompt was a
 * wake-up sentinel). If the container is down, `enqueueMessageCheck`
 * spawns it.
 *
 * After wake-up, the container sits idle waiting for IPC (existing 30 min
 * IDLE_TIMEOUT). If nothing else happens during that window, it shuts down
 * normally — wake_up REFRESHES via natural spawn lifecycle, never EXTENDS.
 */
export const VoiceWakeUpSchema = z.object({
  call_id: z.string().min(1),
  reason: z.enum(['inbound', 'outbound']).optional(),
});

export interface VoiceWakeUpDeps {
  /**
   * Inserts a wake-up sentinel message into the main group's DB and triggers
   * `enqueueMessageCheck`. Returns true if scheduled, false if no main group
   * is registered. Wired in NanoClaw index.ts.
   */
  triggerWakeUp: (callId: string, reason: string) => boolean;
}

export const WAKE_UP_SENTINEL = '<voice_wake_up';

export function makeVoiceWakeUp(deps: VoiceWakeUpDeps): ToolHandler {
  return async (rawArgs) => {
    const parsed = VoiceWakeUpSchema.safeParse(rawArgs);
    if (!parsed.success) {
      logger.warn(
        {
          event: 'voice_wake_up_bad_args',
          err: parsed.error.message,
        },
        'voice_wake_up: invalid args',
      );
      return { status: 'invalid_args', error: parsed.error.message };
    }
    const { call_id, reason } = parsed.data;
    const reasonStr = reason ?? 'inbound';
    const scheduled = deps.triggerWakeUp(call_id, reasonStr);
    if (!scheduled) {
      logger.warn(
        {
          event: 'voice_wake_up_no_main_group',
          call_id,
        },
        'voice_wake_up: main group not registered — skipped',
      );
      return { status: 'no_main_group' };
    }
    logger.info(
      {
        event: 'voice_wake_up_scheduled',
        call_id,
        reason: reasonStr,
      },
      'voice_wake_up: sentinel queued, container will spawn or refresh',
    );
    return { status: 'ok' };
  };
}
