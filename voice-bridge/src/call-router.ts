// voice-bridge/src/call-router.ts
// Per-call state registry + lifecycle orchestration.
// /accept -> startCall() ; realtime.call.completed -> endCall()
import type { Logger } from 'pino'
import type { SidebandHandle } from './sideband.js'
import type { SlowBrainWorker } from './slow-brain.js'
import type { TurnLog } from './turn-timing.js'
import { openTurnLog } from './turn-timing.js'
import { openSidebandSession } from './sideband.js'
import { startSlowBrain } from './slow-brain.js'
import { startTeardown } from './teardown.js'
import { runGhostScan } from './ghost-scan.js'
import { clearCall as clearIdempotencyCache } from './idempotency.js'
import { createSilenceMonitor, type SilenceMonitor } from './silence-monitor.js'
import { getHangupCallback } from './tools/dispatch.js'

export interface CallContext {
  callId: string
  startedAt: number
  memBaselineMB: number
  turnLog: TurnLog
  sideband: SidebandHandle
  slowBrain: SlowBrainWorker
  silence: SilenceMonitor | null
}

export interface CallRouter {
  startCall: (callId: string, log: Logger) => CallContext
  endCall: (callId: string, log: Logger) => void
  getCall: (callId: string) => CallContext | undefined
  _size: () => number
}

export interface CallRouterFactories {
  openTurnLog?: (callId: string) => TurnLog
  openSidebandSession?: typeof openSidebandSession
  startSlowBrain?: typeof startSlowBrain
  runGhostScan?: typeof runGhostScan
  clearIdempotencyCache?: (callId: string) => void
}

export function createCallRouter(
  factories: CallRouterFactories = {},
): CallRouter {
  const fTurn = factories.openTurnLog ?? openTurnLog
  const fSide = factories.openSidebandSession ?? openSidebandSession
  const fSlow = factories.startSlowBrain ?? startSlowBrain
  const fScan = factories.runGhostScan ?? runGhostScan
  const fClear = factories.clearIdempotencyCache ?? clearIdempotencyCache
  const map = new Map<string, CallContext>()
  // Tracks per-call log for the sideband onClose callback — WS close fires
  // asynchronously after startCall returns, and we need the original caller's
  // logger for teardown JSONL, not a freshly-built one.
  const logs = new Map<string, Logger>()

  const router: CallRouter = {
    startCall(callId: string, log: Logger): CallContext {
      const existing = map.get(callId)
      if (existing) {
        log.warn({ event: 'call_start_duplicate', call_id: callId })
        return existing
      }
      const memBaselineMB = process.memoryUsage().heapUsed / 1e6
      const turnLog = fTurn(callId)
      // WS-close is the authoritative call-end signal (no OpenAI webhook for
      // this). 02-06 startTeardown's 5s force-close stays as the fallback.
      const sideband = fSide(callId, log, {
        onClose: (id) => {
          const closeLog = logs.get(id) ?? log
          router.endCall(id, closeLog)
        },
        // Plan 02-10: Wire Sideband user-transcript-completed events into the
        // Slow-Brain worker. Lookup via router.getCall so the closure doesn't
        // capture a stale ctx before it's been registered in `map`.
        onTranscriptTurn: (turnId, transcript) => {
          const existing = router.getCall(callId)
          if (!existing) {
            log.warn({
              event: 'transcript_turn_dropped_no_ctx',
              call_id: callId,
              turn_id: turnId,
            })
            return
          }
          existing.slowBrain.push({ turnId, transcript })
        },
        // Plan 03-15: VAD events drive silence-monitor (REQ-VOICE-08/09)
        onSpeechStart: () => {
          router.getCall(callId)?.silence?.onSpeechStart()
        },
        onSpeechStop: () => {
          router.getCall(callId)?.silence?.onSpeechStop()
        },
      })
      logs.set(callId, log)
      const slowBrain = fSlow(log, sideband.state)
      // Plan 03-15: per-call silence monitor. Skipped if no hangup callback is
      // wired (tests, or buildApp variants without OpenAI client).
      const hangupCb = getHangupCallback()
      const silence = hangupCb
        ? createSilenceMonitor({
            callId,
            sideband,
            log,
            hangupCall: hangupCb,
          })
        : null
      const ctx: CallContext = {
        callId,
        startedAt: Date.now(),
        memBaselineMB,
        turnLog,
        sideband,
        slowBrain,
        silence,
      }
      map.set(callId, ctx)
      return ctx
    },
    endCall(callId: string, log: Logger): void {
      const ctx = map.get(callId)
      if (!ctx) {
        log.info({ event: 'call_end_unknown', call_id: callId })
        return
      }
      const teardown = startTeardown({
        callId,
        sideband: ctx.sideband,
        clearCall: fClear,
        ghostScan: (id, l) => fScan(id, l),
        log,
        memBaselineMB: ctx.memBaselineMB,
      })
      teardown.markClosed()
      ctx.silence?.stop()
      ctx.slowBrain.stop().catch((e: Error) => {
        log.warn({
          event: 'slow_brain_stop_failed',
          call_id: callId,
          err: e.message,
        })
      })
      Promise.resolve(ctx.turnLog.close()).catch((e: Error) => {
        log.warn({
          event: 'turn_log_close_failed',
          call_id: callId,
          err: e.message,
        })
      })
      map.delete(callId)
      logs.delete(callId)
    },
    getCall(callId: string): CallContext | undefined {
      return map.get(callId)
    },
    _size(): number {
      return map.size
    },
  }
  return router
}
