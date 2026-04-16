// Per RESEARCH.md §Heartbeat (HTTP canary chosen over ICMP — five
// documented reasons: subprocess overhead, granularity, container
// isolation, code unification, dependency surface). Implementing
// GET to forwarder /__wg_canary on port 9876 every 1s.
// Discord ALERT throttled to 1/5min (CONTEXT specifics).
// Implements D-16 as amended in CONTEXT.md (BLOCKER #1 closure).
import { setTimeout as sleep } from 'node:timers/promises'
import type pino from 'pino'
import { sendDiscordAlert } from './alerts.js'

export const POLL_INTERVAL_MS = 1000
export const FAIL_THRESHOLD_MS = 2000
export const ALERT_THROTTLE_MS = 5 * 60 * 1000 // max 1 alert per 5 min (CONTEXT specifics)

export interface HeartbeatState {
  lastAlertAt: number
  consecutiveFailures: number
}

/**
 * Run a single heartbeat probe and mutate the provided state object.
 * Exported for unit testing (avoids the infinite loop of startHeartbeat).
 */
export async function runHeartbeatOnce(
  log: pino.Logger,
  state: HeartbeatState,
): Promise<void> {
  const t0 = Date.now()
  let ok = false
  let detail = ''
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FAIL_THRESHOLD_MS)
    // Read WG_PEER_URL at call time so tests can override via env in beforeEach.
    const wgPeerUrl = process.env.WG_PEER_URL ?? 'http://10.0.0.1:9876/__wg_canary'
    const r = await fetch(wgPeerUrl, { signal: ctrl.signal })
    clearTimeout(timer)
    ok = r.status === 204 || r.status === 200
    detail = `status=${r.status}`
  } catch (e: unknown) {
    const err = e as Error
    detail = `err=${err.name}:${err.message}`
  }
  const elapsed = Date.now() - t0

  if (ok) {
    if (state.consecutiveFailures > 0) {
      log.info({
        event: 'wg_recovered',
        after_ms: elapsed,
        prior_failures: state.consecutiveFailures,
      })
    }
    state.consecutiveFailures = 0
  } else {
    state.consecutiveFailures++
    log.warn({
      event: 'wg_canary_fail',
      detail,
      elapsed_ms: elapsed,
      consecutive: state.consecutiveFailures,
    })
    const now = Date.now()
    if (now - state.lastAlertAt > ALERT_THROTTLE_MS) {
      await sendDiscordAlert(`voice-bridge: WG peer unreachable (${detail})`)
      state.lastAlertAt = now
    }
  }
}

/**
 * Infinite polling loop — starts as a fire-and-forget coroutine inside Fastify.
 */
export async function startHeartbeat(log: pino.Logger): Promise<void> {
  const state: HeartbeatState = { lastAlertAt: 0, consecutiveFailures: 0 }
  while (true) {
    await runHeartbeatOnce(log, state)
    await sleep(POLL_INTERVAL_MS)
  }
}
