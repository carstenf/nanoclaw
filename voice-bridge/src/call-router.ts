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
import type { CoreMcpClient } from './core-mcp-client.js'

export interface CallContext {
  callId: string
  startedAt: number
  memBaselineMB: number
  turnLog: TurnLog
  sideband: SidebandHandle
  slowBrain: SlowBrainWorker
  silence: SilenceMonitor | null
  /**
   * Plan 04.5-03 / D-6 / Pitfall 5 (T-4.5-E): per-call MCP session.
   * Set by webhook.ts /accept via startCall({ coreMcp }). The sideband
   * ws.on('close') handler receives this via SidebandOpenOpts.coreMcp and
   * closes the MCP session — prevents server-side sessions Map leak.
   * Optional — undefined when CORE_MCP_URL is unset (dev/test) or in
   * test fixtures that don't need MCP plumbing.
   */
  coreMcp?: CoreMcpClient
}

/**
 * Plan 04.5-03: opts passed through startCall() into openSidebandSession
 * for the Pitfall-5 finalizer. Kept as its own interface so tests can
 * construct a router without worrying about MCP plumbing.
 *
 * Plan 05-00 Task 1 (Spike-A): traceEventsPath also flows through here so
 * that webhook.ts /accept can enable per-call event tracing when an
 * outbound task carries an override envelope. Production callers (non-
 * spike) leave this unset — null passthrough = no instrumentation.
 */
export interface StartCallOpts {
  coreMcp?: CoreMcpClient
  traceEventsPath?: string
}

export interface CallRouter {
  /**
   * Plan 04.5-03: `opts.coreMcp` — per-call MCP client (D-6). When
   * provided, flows through to openSidebandSession so the WS-close
   * finalizer can close the MCP session (Pitfall 5 / T-4.5-E).
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
  /** Plan 03-11 rewrite: notify outbound-router when an outbound call ends. */
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
        // Plan 05.2-02 D-7 / research §4.3: bot-audio events drive the
        // bot-awareness half of the silence-monitor state machine.
        // output_audio_buffer.started → cancel armed timer (bot is speaking);
        // output_audio_buffer.stopped → arm timer iff caller also silent.
        onBotStart: () => {
          router.getCall(callId)?.silence?.onBotStart()
        },
        onBotStop: () => {
          router.getCall(callId)?.silence?.onBotStop()
        },
        // Plan 04.5-03 / Pitfall 5 / T-4.5-E: pass per-call MCP client to
        // sideband so the WS-close finalizer can close it (prevents
        // server-side sessions Map leak).
        coreMcp: startOpts.coreMcp,
        // Plan 05-00 Task 1 (Spike-A): optional per-call event trace.
        // Undefined in production = no tracing; spike path sets this via
        // the outbound override envelope in webhook.ts.
        traceEventsPath: startOpts.traceEventsPath,
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
      // Plan 03-11 rewrite: outbound-router needs notification when its call
      // ends so it can mark task done and trigger next queued.
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
