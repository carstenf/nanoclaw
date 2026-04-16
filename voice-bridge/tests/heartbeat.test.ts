import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Per RESEARCH.md §Heartbeat: HTTP canary chosen over ICMP.
// Tests use vi.useFakeTimers() + mocked fetch + mocked sendDiscordAlert.

describe('heartbeat canary + throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Ensure WG_PEER_URL points to something; the actual fetch is mocked.
    process.env.WG_PEER_URL = 'http://10.0.0.1:9876/__wg_canary'
    process.env.DISCORD_ALERT_WEBHOOK_URL = 'https://discord.example/webhook'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete process.env.WG_PEER_URL
    delete process.env.DISCORD_ALERT_WEBHOOK_URL
  })

  it('canary returns 204 → no Discord ALERT sent (healthy path)', async () => {
    const alertsMod = await import('../src/alerts.js')
    const alertSpy = vi.spyOn(alertsMod, 'sendDiscordAlert').mockResolvedValue(undefined)

    // Healthy fetch: returns 204
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }) as Response,
    )

    const { runHeartbeatOnce } = await import('../src/heartbeat.js')
    const pinoMock = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    await runHeartbeatOnce(pinoMock as never, { lastAlertAt: 0, consecutiveFailures: 0 })

    expect(alertSpy).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(pinoMock.warn).not.toHaveBeenCalled()
  })

  it('3 consecutive failures → exactly 1 Discord ALERT sent (throttle works)', async () => {
    const alertsMod = await import('../src/alerts.js')
    const alertSpy = vi.spyOn(alertsMod, 'sendDiscordAlert').mockResolvedValue(undefined)

    // All fetches fail with network error
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const { runHeartbeatOnce } = await import('../src/heartbeat.js')
    const pinoMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const state = { lastAlertAt: 0, consecutiveFailures: 0 }

    // Run 3 failures
    await runHeartbeatOnce(pinoMock as never, state)
    await runHeartbeatOnce(pinoMock as never, state)
    await runHeartbeatOnce(pinoMock as never, state)

    // Alert should fire once (on first failure, throttle blocks the rest within 5min)
    expect(alertSpy).toHaveBeenCalledOnce()
    expect(pinoMock.warn).toHaveBeenCalledTimes(3)
  })

  it('second ALERT within throttle window is suppressed', async () => {
    const alertsMod = await import('../src/alerts.js')
    const alertSpy = vi.spyOn(alertsMod, 'sendDiscordAlert').mockResolvedValue(undefined)

    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const { runHeartbeatOnce } = await import('../src/heartbeat.js')
    const pinoMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    // Simulate: lastAlertAt was 2 minutes ago — still within 5min window
    const state = { lastAlertAt: Date.now() - 2 * 60 * 1000, consecutiveFailures: 5 }

    await runHeartbeatOnce(pinoMock as never, state)

    // Must NOT fire a second alert (still within throttle window)
    expect(alertSpy).not.toHaveBeenCalled()
  })
})
