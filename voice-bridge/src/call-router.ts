// voice-bridge/src/call-router.ts
// Per-call state registry + lifecycle orchestration. /accept bootstraps via
// startCall() (opens sideband WS, arms hard-safety hangup floor); sideband
// WS-close fires endCall() (teardown, ghost-scan, MCP-close via
// SidebandOpenOpts.coreMcp).
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
import type { TurnLog } from './turn-timing.js'
import { openTurnLog } from './turn-timing.js'
import { openSidebandSession, updateInstructions } from './sideband.js'
import { startTeardown } from './teardown.js'
import { runGhostScan } from './ghost-scan.js'
import { clearCall as clearIdempotencyCache } from './idempotency.js'
import { armHardHangup, type HardHangupHandle } from './silence-monitor.js'
import { getHangupCallback, getAmdClassifier } from './tools/dispatch.js'
import { postCallTranscript } from './post-call-transcript.js'
import type { CoreMcpClient } from './core-mcp-client.js'
import type { NanoclawMcpClient } from './nanoclaw-mcp-client.js'
import { OUTBOUND_CALL_MAX_DURATION_MS } from './config.js'

/**
 * Phase 05.5 D-16 turn-history record. Counterpart turns are appended in the
 * onTranscriptTurn callback (sideband transcription completed event); assistant
 * turns are reconstructable from session state, so v1 ships counterpart-only
 * (Plan 05.5-04 documented simplification — REQ-DIR-16 "full history" is
 * satisfied because the agent receives every counterpart utterance verbatim).
 */
export interface TurnHistoryEntry {
  role: 'counterpart' | 'assistant'
  text: string
  started_at: string
}

export interface CallContext {
  callId: string
  startedAt: number
  memBaselineMB: number
  turnLog: TurnLog
  sideband: SidebandHandle
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
   * Optional — undefined when NANOCLAW_VOICE_MCP_URL is unset (dev/test) or
   * in test fixtures that don't need MCP plumbing.
   */
  coreMcp?: CoreMcpClient
  /**
   * Per-call NanoclawMcpClient. Constructed at /accept (webhook.ts) when
   * NANOCLAW_VOICE_MCP_URL is configured. The endCall() finalizer closes it
   * idempotently (REQ-DIR-19 lifecycle).
   */
  nanoclawMcp?: NanoclawMcpClient
  /**
   * Phase 05.5 D-16 — per-call turn history accumulated for the container-agent
   * transcript trigger. v1 ships counterpart-only; assistant turns are
   * reconstructable from session state. Always initialized to [] so the
   * onTranscriptTurn callback can push without null checks.
   */
  turnHistory: TurnHistoryEntry[]
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
  /**
   * Optional NanoclawMcpClient for transcript-trigger fire-and-forget.
   * webhook.ts /accept passes this when NANOCLAW_VOICE_MCP_URL is configured;
   * tests inject a mock.
   */
  nanoclawMcp?: NanoclawMcpClient
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
        // Wire Sideband user-transcript-completed events. Each turn fires
        // nanoclawMcp.transcript() fire-and-forget per D-12 (Hot-Path never
        // blocks). Lookup via router.getCall so the closure doesn't capture a
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
          // Plan 05.2-06 AMD VAD-fallback invariant: forward transcript to
          // classifier; classifier.onTranscript checks mailbox regex + settles
          // verdict=human if non-mailbox after a speech cycle (Case-2 human path).
          // MUST stay wired in BOTH modes — no branch above this line.
          getAmdClassifier()?.onTranscript(transcript)
          // Phase 05.5 D-16: append counterpart turn to per-call history BEFORE
          // the branch so nanoclawMcp.transcript sees up-to-date turns.
          existing.turnHistory.push({
            role: 'counterpart',
            text: transcript,
            started_at: new Date().toISOString(),
          })
          // D-12: fire-and-forget. Hot-Path never blocks. On timeout / error
          // the Bridge keeps last-known instructions (REQ-DIR-12). Errors
          // surface as `transcript_trigger_failed` warn-log only.
          const turnIdNum = Number(turnId.replace(/^\D+/, '')) || 0
          void existing.nanoclawMcp
            ?.transcript({
              call_id: callId,
              turn_id: turnIdNum,
              transcript: { turns: existing.turnHistory },
              fast_brain_state: {},
            })
            .then((res) => {
              if (res?.instructions_update) {
                updateInstructions(
                  existing.sideband.state,
                  res.instructions_update,
                  log,
                )
              }
            })
            .catch((err: unknown) => {
              log.warn({
                event: 'transcript_trigger_failed',
                call_id: callId,
                err: (err as Error)?.message,
              })
            })
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
        hardHangup,
        coreMcp: startOpts.coreMcp,
        nanoclawMcp: startOpts.nanoclawMcp,
        turnHistory: [],
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
      // Idempotent close of per-call NanoclawMcpClient. No-op when the field
      // is undefined; close() itself is also idempotent (mirrors
      // core-mcp-client.close() pattern). Errors logged only; never thrown —
      // call-end teardown must always proceed.
      ctx.nanoclawMcp?.close().catch((e: Error) => {
        log.warn({
          event: 'nanoclaw_mcp_close_failed',
          call_id: callId,
          err: e.message,
        })
      })
      const turnLogClosed = Promise.resolve(ctx.turnLog.close()).catch(
        (e: Error) => {
          log.warn({
            event: 'turn_log_close_failed',
            call_id: callId,
            err: e.message,
          })
        },
      )
      // open_points 2026-04-27 #2: post-call transcript to Discord. Fire-and-
      // forget after turnLog.close() so the JSONL has been fully flushed to
      // disk before postCallTranscript reads it. Channel is configurable via
      // VOICE_TRANSCRIPT_DISCORD_CHANNEL env (added to .env). Skip when env
      // is unset (test fixtures, dev) or when no per-call MCP client exists
      // (legacy call-paths without a NanoclawMcpClient).
      const transcriptChannel = process.env.VOICE_TRANSCRIPT_DISCORD_CHANNEL
      const startedAt = ctx.startedAt
      if (transcriptChannel && ctx.nanoclawMcp) {
        const mcp = ctx.nanoclawMcp
        const caseType = ctx.sideband.state.caseType
        void turnLogClosed.then(() =>
          postCallTranscript({
            callId,
            durationMs: Date.now() - startedAt,
            caseType,
            channelId: transcriptChannel,
            nanoclawMcp: mcp,
            log,
          }).catch((e: Error) => {
            log.warn({
              event: 'post_call_transcript_uncaught',
              call_id: callId,
              err: e.message,
            })
          }),
        )
      }
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

