// voice-bridge/tests/silence-monitor.test.ts
// Plan 05.3-05b D-3 PART 2 — hard-safety-stub contract only. Legacy 3-round
// VAD ladder + bot-awareness state-machine tests retired with the UX layer
// (see silence-monitor.ts header: UX moved to persona + idle_timeout_ms).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { armHardHangup } from '../src/silence-monitor.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('armHardHangup (Plan 05.3-05b hard-safety-stub)', () => {
  it('fires hangupCb with reason=hard_safety_timeout after maxDurationMs', () => {
    const hangupCb = vi.fn().mockResolvedValue(undefined)
    armHardHangup('rtc_test', 10000, hangupCb)
    vi.advanceTimersByTime(9999)
    expect(hangupCb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hangupCb).toHaveBeenCalledWith('rtc_test', 'hard_safety_timeout')
  })

  it('cancel() prevents the hangup from firing', () => {
    const hangupCb = vi.fn()
    const h = armHardHangup('rtc_test', 10000, hangupCb)
    vi.advanceTimersByTime(5000)
    h.cancel()
    vi.advanceTimersByTime(60000)
    expect(hangupCb).not.toHaveBeenCalled()
  })
})
