// voice-bridge/src/call-router.ts
// Phase 05.3 — Per-call state registry + lifecycle orchestration. /accept
// bootstraps via startCall() (opens sideband WS, starts slow-brain, arms
// hard-safety hangup floor); sideband WS-close fires endCall() (teardown,
// ghost-scan, MCP-close via SidebandOpenOpts.coreMcp).
//
// Owning plans: 04.5-03 (per-call MCP session, Pitfall 5), 05.2 VAD wiring
// (AMD-classifier forward, Case-2 VAD-fallback human path), 05.3-05b D-3 PART 2
// (silence-monitor retired; hardHangup stub replaces VAD state machine).
//
// Load-bearing invariants:
//   - AMD-classifier VAD-fallback human path: onSpeechStart/Stop/Transcript
//     forwards to getAmdClassifier() (see closures below).
//   - Hard-safety hangup floor: pure wall-clock ceiling, no VAD awareness.
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
import { armHardHangup, type HardHangupHandle } from './silence-monitor.js'
import { getHangupCallback, getAmdClassifier } from './tools/dispatch.js'
import type { CoreMcpClient } from './core-mcp-client.js'
import { OUTBOUND_CALL_MAX_DURATION_MS } from './config.js'

export interface CallContext {
  callId: string
  startedAt: number
  memBaselineMB: number
  turnLog: TurnLog
  sideband: SidebandHandle
  slowBrain: SlowBrainWorker
  /**
   * Hard-safety hangup floor (pure wall-clock timer, no VAD awareness).
   * Replaces the legacy silence-monitor VAD state machine + 3-round nudge
   * ladder — native idle_timeout_ms + persona OUTBOUND_SCHWEIGEN /
   * INBOUND_SCHWEIGEN drive the UX layer (Plan 05.3-05a/b).
   */
  hardHangup: HardHangupHandle | null
  /**
   * Per-call MCP session. Set by webhook.ts /accept via startCall({ coreMcp }).
   * The sideband ws.on('close') handler receives this via SidebandOpenOpts.coreMcp
   * and closes the MCP session — prevents server-side sessions Map leak.
   * Optional — undefined when CORE_MCP_URL is unset (dev/test) or in test
   * fixtures that don't need MCP plumbing.
   */
  coreMcp?: CoreMcpClient
}

/**
 * Opts passed through startCall() into openSidebandSession for the MCP-close
 * finalizer. Kept as its own interface so tests can construct a router without
 * worrying about MCP plumbing. `traceEventsPath` also flows through here so
 * webhook.ts /accept can enable per-call Spike-A event tracing when an
 * outbound task carries an override envelope. Production callers (non-spike)
 * leave this unset — null passthrough = no instrumentation.
 */
export interface StartCallOpts {
  coreMcp?: CoreMcpClient
  traceEventsPath?: string
}

export interface CallRouter {
  /**
   * `opts.coreMcp` — per-call MCP client. When provided, flows through to
   * openSidebandSession so the WS-close finalizer can close the MCP session.
   * Production caller: webhook.ts /accept; tests typically omit.
   */
  startCall: (callId: string, log: Logger, opts?: StartCallOpts) => CallContext
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
  /** Notify outbound-router when an outbound call ends (task mark-done + next-queued). */
  onCallEndExtra?: (callId: string, reason: string) => void | Promise<void>
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
    startCall(
      callId: string,
      log: Logger,
      startOpts: StartCallOpts = {},
    ): CallContext {
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
        // Wire Sideband user-transcript-completed events into the Slow-Brain
        // worker. Lookup via router.getCall so the closure doesn't capture a
        // stale ctx before it's been registered in `map`.
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
          // Plan 05.2-06 AMD VAD-fallback invariant: forward transcript to
          // classifier; classifier.onTranscript checks mailbox regex + settles
          // verdict=human if non-mailbox after a speech cycle (Case-2 human path).
          getAmdClassifier()?.onTranscript(transcript)
        },
        // VAD events drive the AMD classifier only (Case-2 VAD-fallback human
        // path). Legacy silence-monitor forwards were retired with the UX
        // state machine (see silence-monitor.ts header). onBotStart/onBotStop
        // handlers are gone entirely (hard-safety stub has no VAD awareness).
        onSpeechStart: () => {
          getAmdClassifier()?.onSpeechStarted()
        },
        onSpeechStop: () => {
          getAmdClassifier()?.onSpeechStopped()
        },
        // Pass per-call MCP client to sideband so the WS-close finalizer can
        // close it (prevents server-side sessions Map leak).
        coreMcp: startOpts.coreMcp,
        // Optional per-call Spike-A event trace. Undefined in production =
        // no tracing; spike path sets this via the outbound override envelope
        // in webhook.ts.
        traceEventsPath: startOpts.traceEventsPath,
      })
      logs.set(callId, log)
      const slowBrain = fSlow(log, sideband.state)
      // Plan 05.3-05b D-3 invariant: per-call hard-safety hangup floor (pure
      // wall-clock ceiling). Fires hangup after OUTBOUND_CALL_MAX_DURATION_MS
      // regardless of VAD state. Outbound has its own durationTimer in
      // outbound-router.ts; this is belt-and-braces for outbound and the sole
      // ceiling for inbound. Skipped if no hangup callback is wired (tests).
      const hangupCb = getHangupCallback()
      const hardHangup = hangupCb
        ? armHardHangup(callId, OUTBOUND_CALL_MAX_DURATION_MS, hangupCb, log)
        : null
      const ctx: CallContext = {
        callId,
        startedAt: Date.now(),
        memBaselineMB,
        turnLog,
        sideband,
        slowBrain,
        hardHangup,
        coreMcp: startOpts.coreMcp,
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
      ctx.hardHangup?.cancel()
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
      // Notify outbound-router when its call ends so it can mark task done
      // and trigger the next queued task.
      if (factories.onCallEndExtra) {
        try {
          void Promise.resolve(factories.onCallEndExtra(callId, 'normal')).catch(
            (e: Error) => {
              log.warn({
                event: 'on_call_end_extra_failed',
                call_id: callId,
                err: e.message,
              })
            },
          )
        } catch (e: unknown) {
          log.warn({
            event: 'on_call_end_extra_failed',
            call_id: callId,
            err: (e as Error).message,
          })
        }
      }
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
