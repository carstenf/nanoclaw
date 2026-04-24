// voice-bridge/src/silence-monitor.ts
// Phase 05.3 — Hard-safety hangup stub. Pure wall-clock ceiling for
// catatonic-call / end_call-failed safety. NO VAD awareness, NO round ladder,
// NO forced response.create pushes. The legacy UX silence/nudge ladder was
// retired in Plan 05.3-05b D-3 PART 2; OpenAI Realtime native
// turn_detection.idle_timeout_ms (see config.ts SESSION_CONFIG) drives
// server-side response.create with persona OUTBOUND_SCHWEIGEN / INBOUND_SCHWEIGEN
// ladders (baseline.ts) in scope.
//
// Outbound has its own OUTBOUND_CALL_MAX_DURATION_MS timer in outbound-router.ts;
// this module provides the inbound hard floor + a belt-and-braces second
// trigger for outbound.
import type { Logger } from 'pino'

export interface HardHangupHandle {
  /** Cancel the pending hangup timer (call normally ended). */
  cancel(): void
}

/**
 * Arm a hard-safety hangup timer for a call. Fires `hangupCb(callId, reason)`
 * after `maxDurationMs` unless `cancel()` is invoked first. No VAD awareness.
 */
export function armHardHangup(
  callId: string,
  maxDurationMs: number,
  hangupCb: (callId: string, reason: string) => Promise<void> | void,
  log?: Logger,
): HardHangupHandle {
  const t = setTimeout(() => {
    log?.warn({
      event: 'hard_safety_hangup_fired',
      call_id: callId,
      max_duration_ms: maxDurationMs,
    })
    Promise.resolve(hangupCb(callId, 'hard_safety_timeout')).catch(
      (e: Error) => {
        log?.warn({
          event: 'hard_safety_hangup_failed',
          call_id: callId,
          err: e?.message,
        })
      },
    )
  }, maxDurationMs)
  return {
    cancel(): void {
      clearTimeout(t)
    },
  }
}
