// tests/outbound-router.test.ts — RED tests for OutboundRouter
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { OutboundRouter, OutboundTask } from '../src/outbound-router.js'

// Fake deps factory
function makeDeps(overrides: Record<string, unknown> = {}) {
  const openaiClient = {
    realtime: {
      calls: {
        create: vi.fn().mockResolvedValue({ id: 'call-001' }),
        end: vi.fn().mockResolvedValue(undefined),
      },
    },
  }
  const callRouter = {
    _size: vi.fn().mockReturnValue(0),
  }
  const reportBack = vi.fn().mockResolvedValue(undefined)
  const timers = {
    setTimeout: vi.fn().mockReturnValue(123 as unknown as ReturnType<typeof setTimeout>),
    clearTimeout: vi.fn(),
  }
  let t = 1_700_000_000_000
  const now = () => t
  const advanceTime = (ms: number) => { t += ms }
  return { openaiClient, callRouter, reportBack, timers, now, advanceTime, ...overrides }
}

describe('OutboundRouter', () => {
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    vi.useFakeTimers()
    deps = makeDeps()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enqueue-idle: immediately triggers execute when no active call', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Test goal',
      context: '',
      report_to_jid: 'dc:123',
    })
    expect(task.status).toBe('active')
    expect(deps.openaiClient.realtime.calls.create).toHaveBeenCalledOnce()
  })

  it('enqueue-active: queues task when active call in progress', async () => {
    deps.callRouter._size.mockReturnValue(1)
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    // First enqueue — with active call, should be queued
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Queued goal',
      context: '',
      report_to_jid: 'dc:123',
    })
    expect(task.status).toBe('queued')
    expect(deps.openaiClient.realtime.calls.create).not.toHaveBeenCalled()
  })

  it('max-queue-full: throws QueueFullError when queue exceeds OUTBOUND_QUEUE_MAX', async () => {
    deps.callRouter._size.mockReturnValue(1)
    const { createOutboundRouter, QueueFullError } = await import('../src/outbound-router.js')
    // queueMax=2 via DI
    const router = createOutboundRouter({ ...deps, queueMax: 2 })
    router.enqueue({ target_phone: '+491111111111', goal: 'task1', context: '', report_to_jid: 'dc:1' })
    router.enqueue({ target_phone: '+492222222222', goal: 'task2', context: '', report_to_jid: 'dc:2' })
    expect(() =>
      router.enqueue({ target_phone: '+493333333333', goal: 'task3', context: '', report_to_jid: 'dc:3' })
    ).toThrow(QueueFullError)
  })

  it('on-call-end-picks-next: onCallEnd with queued task triggers next execute', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    // Start with no active calls so first enqueue executes immediately
    const router = createOutboundRouter(deps)
    const firstTask = router.enqueue({
      target_phone: '+491234567890',
      goal: 'First goal',
      context: '',
      report_to_jid: 'dc:123',
    })
    // Now simulate another enqueue while first is active
    // First is now active (via triggerExecute), so _size remains 0 in mock
    // We manually queue a second by making _size return 1
    deps.callRouter._size.mockReturnValue(1)
    const secondTask = router.enqueue({
      target_phone: '+499876543210',
      goal: 'Second goal',
      context: '',
      report_to_jid: 'dc:456',
    })
    expect(secondTask.status).toBe('queued')
    // Now simulate call end for first task
    deps.callRouter._size.mockReturnValue(0)
    await router.onCallEnd(firstTask.task_id, 'completed')
    expect(deps.openaiClient.realtime.calls.create).toHaveBeenCalledTimes(2)
    // reportBack called for first task
    expect(deps.reportBack).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: firstTask.task_id, status: 'done' }),
    )
  })

  it('10min-escalation-fires: escalation timer fires for long-queued task', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    deps.callRouter._size.mockReturnValue(1)
    const router = createOutboundRouter(deps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Escalate me',
      context: '',
      report_to_jid: 'dc:999',
    })
    expect(task.status).toBe('queued')
    // The escalation timer should have been set
    expect(deps.timers.setTimeout).toHaveBeenCalled()
    // Simulate escalation timer firing
    const [callback] = deps.timers.setTimeout.mock.calls[0]
    await callback()
    const state = router.getState()
    const escalated = state.find((t: OutboundTask) => t.task_id === task.task_id)
    expect(escalated?.status).toBe('escalated')
    expect(deps.reportBack).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: task.task_id, status: 'escalated' }),
    )
  })

  it('max-duration-end-fires: max-duration timer calls openai.realtime.calls.end', async () => {
    // Use real timers for this test — we flush via explicit Promise microtask queue
    vi.useRealTimers()
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    // Capture setTimeout calls via the DI timers mock (not global fake timers)
    const capturedTimers: Array<{ fn: () => void; ms: number }> = []
    const testDeps = {
      ...deps,
      maxDurationMs: 600000,
      timers: {
        setTimeout: vi.fn((fn: () => void, ms: number) => {
          capturedTimers.push({ fn, ms })
          return 999 as unknown as ReturnType<typeof setTimeout>
        }),
        clearTimeout: vi.fn(),
      },
    }
    const router = createOutboundRouter(testDeps)
    router.enqueue({
      target_phone: '+491234567890',
      goal: 'Max duration test',
      context: '',
      report_to_jid: 'dc:123',
    })
    // Flush microtasks: wait for the void triggerExecute to complete
    await new Promise<void>((r) => setTimeout(r, 10))
    // The max-duration timer should have been set (ms >= 600000)
    const durationTimer = capturedTimers.find(({ ms }) => ms >= 600000)
    expect(durationTimer).toBeDefined()
    // inject a fake call_id so calls.end can be triggered
    const state = router.getState()
    if (state[0]) state[0].call_id = 'call-dur-test'
    await durationTimer!.fn()
    expect(deps.openaiClient.realtime.calls.end).toHaveBeenCalled()
  })

  it('report-back-call-on-end: reportBack is called with summary when onCallEnd fires', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Report this',
      context: 'Some context',
      report_to_jid: 'dc:777',
    })
    await router.onCallEnd(task.task_id, 'completed')
    expect(deps.reportBack).toHaveBeenCalledOnce()
    const arg = deps.reportBack.mock.calls[0][0] as OutboundTask
    expect(arg.task_id).toBe(task.task_id)
    expect(arg.status).toBe('done')
    expect(arg.target_phone).toBe('+491234567890')
  })

  it('getState returns all tasks including active and queued', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    router.enqueue({ target_phone: '+491234567890', goal: 'First', context: '', report_to_jid: 'dc:1' })
    deps.callRouter._size.mockReturnValue(1)
    router.enqueue({ target_phone: '+499876543210', goal: 'Second', context: '', report_to_jid: 'dc:2' })
    const state = router.getState()
    expect(state.length).toBe(2)
    expect(state.some((t: OutboundTask) => t.status === 'active')).toBe(true)
    expect(state.some((t: OutboundTask) => t.status === 'queued')).toBe(true)
  })
})
