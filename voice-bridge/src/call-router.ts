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

export interface CallContext {
  callId: string
  startedAt: number
  memBaselineMB: number
  turnLog: TurnLog
  sideband: SidebandHandle
  slowBrain: SlowBrainWorker
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
      })
      logs.set(callId, log)
      const slowBrain = fSlow(log, sideband.state)
      const ctx: CallContext = {
        callId,
        startedAt: Date.now(),
        memBaselineMB,
        turnLog,
        sideband,
        slowBrain,
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
