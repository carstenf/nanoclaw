// tests/outbound-router.test.ts — OutboundRouter tests
// Plan 03-11 rewrite: openaiClient.realtime.calls.create replaced by outboundOriginator.originate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { OutboundTask } from '../src/outbound-router.js'

function makeDeps(overrides: Record<string, unknown> = {}) {
  const outboundOriginator = {
    originate: vi.fn().mockResolvedValue({ providerRef: 'fs-uuid-001' }),
  }
  const callRouter = {
    _size: vi.fn().mockReturnValue(0),
  }
  const reportBack = vi.fn().mockResolvedValue(undefined)
  const hangupCall = vi.fn().mockResolvedValue(undefined)
  const timers = {
    setTimeout: vi
      .fn()
      .mockReturnValue(123 as unknown as ReturnType<typeof setTimeout>),
    clearTimeout: vi.fn(),
  }
  let t = 1_700_000_000_000
  const now = () => t
  const advanceTime = (ms: number) => {
    t += ms
  }
  return {
    outboundOriginator,
    callRouter,
    reportBack,
    hangupCall,
    timers,
    now,
    advanceTime,
    ...overrides,
  }
}

describe('OutboundRouter (03-11 pivot — Sipgate REST)', () => {
  let deps: ReturnType<typeof makeDeps>

  beforeEach(() => {
    vi.useFakeTimers()
    deps = makeDeps()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('enqueue-idle: immediately triggers outbound originate when no active call', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Test goal',
      context: '',
      report_to_jid: 'dc:123',
    })
    expect(task.status).toBe('active')
    // Drain microtasks (triggerExecute runs as void async). Use a small
    // advance instead of runAllTimersAsync so duration/escalation timers
    // (10+ minutes) do NOT fire here.
    await vi.advanceTimersByTimeAsync(1)
    expect(deps.outboundOriginator.originate).toHaveBeenCalledOnce()
    expect(deps.outboundOriginator.originate).toHaveBeenCalledWith({
      targetPhone: '+491234567890',
      taskId: task.task_id,
    })
  })

  it('enqueue-active: queues task when active call in progress', async () => {
    deps.callRouter._size.mockReturnValue(1)
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Queued goal',
      context: '',
      report_to_jid: 'dc:123',
    })
    expect(task.status).toBe('queued')
    expect(deps.outboundOriginator.originate).not.toHaveBeenCalled()
  })

  it('max-queue-full: throws QueueFullError when queue exceeds OUTBOUND_QUEUE_MAX', async () => {
    deps.callRouter._size.mockReturnValue(1)
    const { createOutboundRouter, QueueFullError } = await import(
      '../src/outbound-router.js'
    )
    const router = createOutboundRouter({ ...deps, queueMax: 2 })
    router.enqueue({
      target_phone: '+491111111111',
      goal: 'task1',
      context: '',
      report_to_jid: 'dc:1',
    })
    router.enqueue({
      target_phone: '+492222222222',
      goal: 'task2',
      context: '',
      report_to_jid: 'dc:2',
    })
    expect(() =>
      router.enqueue({
        target_phone: '+493333333333',
        goal: 'task3',
        context: '',
        report_to_jid: 'dc:3',
      }),
    ).toThrow(QueueFullError)
  })

  it('on-call-end-picks-next: onCallEnd with queued task triggers next outbound originate', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const firstTask = router.enqueue({
      target_phone: '+491234567890',
      goal: 'First goal',
      context: '',
      report_to_jid: 'dc:123',
    })
    deps.callRouter._size.mockReturnValue(1)
    const secondTask = router.enqueue({
      target_phone: '+499876543210',
      goal: 'Second goal',
      context: '',
      report_to_jid: 'dc:456',
    })
    expect(secondTask.status).toBe('queued')
    deps.callRouter._size.mockReturnValue(0)
    await router.onCallEnd(firstTask.task_id, 'completed')
    expect(deps.outboundOriginator.originate).toHaveBeenCalledTimes(2)
    expect(deps.reportBack).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: firstTask.task_id,
        status: 'done',
      }),
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
    expect(deps.timers.setTimeout).toHaveBeenCalled()
    const [callback] = deps.timers.setTimeout.mock.calls[0]
    await callback()
    const state = router.getState()
    const escalated = state.find((t: OutboundTask) => t.task_id === task.task_id)
    expect(escalated?.status).toBe('escalated')
    expect(deps.reportBack).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: task.task_id,
        status: 'escalated',
      }),
    )
  })

  it('max-duration-end-fires: max-duration timer calls hangupCall when openai_call_id bound', async () => {
    vi.useRealTimers()
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const hangupSpy = vi.fn().mockResolvedValue(undefined)
    const originateSpy = vi.fn().mockResolvedValue({ providerRef: 'fs-dur' })
    const capturedTimers: Array<{ fn: () => void; ms: number }> = []
    const freshDeps = {
      outboundOriginator: { originate: originateSpy },
      callRouter: { _size: vi.fn().mockReturnValue(0) },
      reportBack: vi.fn().mockResolvedValue(undefined),
      hangupCall: hangupSpy,
      now: () => Date.now(),
      maxDurationMs: 600000,
      escalationMs: 660000,
      timers: {
        setTimeout: vi.fn((fn: () => void, ms: number) => {
          capturedTimers.push({ fn, ms })
          return 999 as unknown as ReturnType<typeof setTimeout>
        }),
        clearTimeout: vi.fn(),
      },
    }
    const router = createOutboundRouter(freshDeps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Max duration test',
      context: '',
      report_to_jid: 'dc:123',
    })
    await new Promise<void>((r) => setTimeout(r, 10))
    // bind openai call_id (simulates webhook /accept)
    router.bindOpenaiCallId(task.task_id, 'rtc_max_dur')
    const durationTimer = capturedTimers.find(({ ms }) => ms === 600000)
    expect(durationTimer).toBeDefined()
    await durationTimer!.fn()
    expect(hangupSpy).toHaveBeenCalledWith('rtc_max_dur')
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
    router.enqueue({
      target_phone: '+491234567890',
      goal: 'First',
      context: '',
      report_to_jid: 'dc:1',
    })
    deps.callRouter._size.mockReturnValue(1)
    router.enqueue({
      target_phone: '+499876543210',
      goal: 'Second',
      context: '',
      report_to_jid: 'dc:2',
    })
    const state = router.getState()
    expect(state.length).toBe(2)
    expect(state.some((t: OutboundTask) => t.status === 'active')).toBe(true)
    expect(state.some((t: OutboundTask) => t.status === 'queued')).toBe(true)
  })

  // ---- 03-11 rewrite-specific tests ----

  it('getActiveTask returns currently active task or null', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    expect(router.getActiveTask()).toBeNull()
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Active',
      context: '',
      report_to_jid: 'dc:1',
    })
    expect(router.getActiveTask()?.task_id).toBe(task.task_id)
  })

  it('bindOpenaiCallId + taskIdForOpenaiCallId reverse-lookup works', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'X',
      context: '',
      report_to_jid: 'dc:1',
    })
    router.bindOpenaiCallId(task.task_id, 'rtc_xyz_123')
    expect(router.taskIdForOpenaiCallId('rtc_xyz_123')).toBe(task.task_id)
    expect(router.taskIdForOpenaiCallId('not-a-real-id')).toBeNull()
  })

  // Persona rendering moved out of the Bridge in Phase 05.6 (REQ-DIR-13:
  // voice-personas skill in nanoclaw is the single SoT). The router no longer
  // exposes buildPersonaForTask; non-Case-2 outbound either uses the
  // persona_override envelope or falls back to FALLBACK_PERSONA at /accept.

  // ---- Plan 05-00 Task 1 (Spike-A) / Wave 3 prep: override envelope ----

  it('persona_override is carried through enqueue onto the OutboundTask', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const overrideText = 'SPIKE-A CLASSIFIER PROMPT verbatim text'
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'ignored under override',
      context: '',
      report_to_jid: 'dc:1',
      persona_override: overrideText,
    })
    const active = router.getActiveTask()
    expect(active?.task_id).toBe(task.task_id)
    expect(active?.persona_override).toBe(overrideText)
  })

  it('tools_override is carried through enqueue onto the OutboundTask', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const toolsOverride = [
      {
        name: 'amd_result',
        description: 'Emit AMD verdict — spike-only',
        parameters: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['human', 'voicemail', 'silence'] },
          },
          required: ['verdict'],
        },
      },
    ]
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'SPIKE-A',
      context: '',
      report_to_jid: 'dc:1',
      tools_override: toolsOverride,
    })
    const active = router.getActiveTask()
    expect(active?.task_id).toBe(task.task_id)
    expect(active?.tools_override).toEqual(toolsOverride)
  })

  it('no override: OutboundTask.persona_override and tools_override are undefined (backward compat)', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'normal outbound',
      context: '',
      report_to_jid: 'dc:1',
    })
    const active = router.getActiveTask()
    expect(active?.task_id).toBe(task.task_id)
    expect(active?.persona_override).toBeUndefined()
    expect(active?.tools_override).toBeUndefined()
  })

  it('outbound originate failure marks task failed + reportBack + advances queue', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const eslFail = {
      originate: vi.fn().mockRejectedValueOnce(new Error('connect_failed: ECONNREFUSED')),
    }
    const failDeps = { ...deps, outboundOriginator: eslFail }
    const router = createOutboundRouter(failDeps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'X',
      context: '',
      report_to_jid: 'dc:1',
    })
    // Flush async
    // Drain microtasks (triggerExecute runs as void async). Use a small
    // advance instead of runAllTimersAsync so duration/escalation timers
    // (10+ minutes) do NOT fire here.
    await vi.advanceTimersByTimeAsync(1)
    const state = router.getState()
    const got = state.find((t) => t.task_id === task.task_id)
    expect(got?.status).toBe('failed')
    expect(got?.error).toContain('connect_failed')
    expect(deps.reportBack).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: task.task_id, status: 'failed' }),
    )
  })

  // ---- Plan 05-02 Task 4: line_busy surfacing ----

  it('line_busy: originate error with details.lineBusy=true → task.error="line_busy"', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const lineBusyErr = Object.assign(new Error('sipgate busy'), {
      details: { lineBusy: true, retryable: false },
    })
    const busyOriginator = {
      originate: vi.fn().mockRejectedValueOnce(lineBusyErr),
    }
    const busyDeps = { ...deps, outboundOriginator: busyOriginator }
    const router = createOutboundRouter(busyDeps)
    router.enqueue({
      target_phone: '+491234567890',
      goal: 'Test line_busy',
      context: '',
      report_to_jid: 'dc:1',
    })
    await vi.advanceTimersByTimeAsync(1)
    const state = router.getState()
    const task = state[0]
    expect(task?.status).toBe('failed')
    expect(task?.error).toBe('line_busy')
  })

  // ---- Plan 05-02 Wave 2: case_type field ----

  it('case_type="case_2" and case_payload are carried through enqueue onto OutboundTask', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Tischreservierung',
      context: '',
      report_to_jid: 'dc:1',
      case_type: 'case_2',
      case_payload: { foo: 1, restaurant_name: 'La Piazza' },
    })
    const active = router.getActiveTask()
    expect(active?.task_id).toBe(task.task_id)
    expect(active?.case_type).toBe('case_2')
    expect((active?.case_payload as Record<string, unknown>)?.foo).toBe(1)
  })

  it('case_type undefined when not provided (backward compat with Case-6b callers)', async () => {
    const { createOutboundRouter } = await import('../src/outbound-router.js')
    const router = createOutboundRouter(deps)
    const task = router.enqueue({
      target_phone: '+491234567890',
      goal: 'Legacy call',
      context: '',
      report_to_jid: 'dc:1',
    })
    const active = router.getActiveTask()
    expect(active?.task_id).toBe(task.task_id)
    expect(active?.case_type).toBeUndefined()
    expect(active?.case_payload).toBeUndefined()
  })
})

