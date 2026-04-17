// voice-bridge/src/teardown.ts
// D-16 / D-17 / D-19: 2s-kill / 5s-force-close teardown + heap-delta observability.
// Target of force-close is the sideband WS. FS legs terminate independently.
// REQ-VOICE-11: assert session.closed from OpenAI within 2000ms of BYE;
// if not received, force-close the sideband WebSocket within 5000ms.
import type { Logger } from 'pino'
import type { SidebandHandle } from './sideband.js'

export interface StartTeardownOpts {
  callId: string
  sideband: SidebandHandle
  clearCall: (callId: string) => void
  ghostScan: (
    callId: string,
    log: Logger,
  ) => Promise<string[]> | string[]
  log: Logger
  memBaselineMB: number
  killMs?: number
  forceMs?: number
  heapDelayMs?: number
}

export interface TeardownHandle {
  markClosed: () => void
  abort: () => void
}

export function startTeardown(opts: StartTeardownOpts): TeardownHandle {
  const killMs = opts.killMs ?? 2000
  const forceMs = opts.forceMs ?? 5000
  const heapDelayMs = opts.heapDelayMs ?? 5000
  const { callId, sideband, clearCall, ghostScan, log, memBaselineMB } = opts
  const t0 = Date.now()
  let closed = false
  let aborted = false

  log.info({ event: 'teardown_started', call_id: callId, trigger: 'BYE' })

  const killTimer = setTimeout(() => {
    if (closed || aborted) return
    log.warn({
      event: 'teardown_kill_pending',
      call_id: callId,
      elapsed_ms: Date.now() - t0,
    })
  }, killMs)

  const forceTimer = setTimeout(async () => {
    if (closed || aborted) return
    log.warn({
      event: 'teardown_force_closed',
      call_id: callId,
      elapsed_ms: Date.now() - t0,
    })
    try {
      sideband.close()
    } catch {
      /* swallow */
    }
    clearCall(callId)
    try {
      await ghostScan(callId, log)
    } catch (e: unknown) {
      const err = e as Error
      log.warn({
        event: 'ghost_scan_failed',
        call_id: callId,
        err: err.message,
      })
    }
    scheduleHeapDelta()
  }, forceMs)

  function scheduleHeapDelta(): void {
    setTimeout(() => {
      const now = process.memoryUsage().heapUsed / 1e6
      log.info({
        event: 'mem_delta_mb',
        call_id: callId,
        delta_mb: +(now - memBaselineMB).toFixed(2),
      })
    }, heapDelayMs)
  }

  return {
    markClosed(): void {
      if (closed || aborted) return
      closed = true
      clearTimeout(killTimer)
      clearTimeout(forceTimer)
      log.info({
        event: 'teardown_closed_normally',
        call_id: callId,
        elapsed_ms: Date.now() - t0,
      })
      try {
        sideband.close()
      } catch {
        /* swallow */
      }
      clearCall(callId)
      Promise.resolve(ghostScan(callId, log)).catch((e: Error) => {
        log.warn({
          event: 'ghost_scan_failed',
          call_id: callId,
          err: e.message,
        })
      })
      scheduleHeapDelta()
    },
    abort(): void {
      aborted = true
      clearTimeout(killTimer)
      clearTimeout(forceTimer)
    },
  }
}
