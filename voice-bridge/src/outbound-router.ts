// voice-bridge/src/outbound-router.ts
// Plan 03-11: In-memory outbound-call queue + lifecycle manager.
// Handles: enqueue, triggerExecute, onCallEnd, escalation, max-duration-cap.
import crypto from 'node:crypto'
import {
  OUTBOUND_QUEUE_MAX,
  OUTBOUND_CALL_MAX_DURATION_MS,
  OUTBOUND_ESCALATION_TIMEOUT_MS,
} from './config.js'
import { buildOutboundPersona } from './persona.js'

// ---- Types ----

export interface OutboundTask {
  task_id: string
  target_phone: string
  goal: string
  context: string
  report_to_jid: string
  created_at: number
  started_at?: number
  ended_at?: number
  /** OpenAI-side call ID (set after calls.create resolves) */
  call_id?: string
  status: 'queued' | 'active' | 'done' | 'failed' | 'escalated'
  error?: string
}

export interface EnqueueRequest {
  target_phone: string
  goal: string
  context: string
  report_to_jid: string
  call_id?: string
}

// DI surface for tests
export interface OutboundRouterDeps {
  openaiClient: {
    realtime: {
      calls: {
        create: (params: Record<string, unknown>) => Promise<{ id: string }>
        end: (callId: string) => Promise<void>
      }
    }
  }
  callRouter: {
    _size: () => number
  }
  /** Called after each task completes (done/failed/escalated) with final task state. */
  reportBack: (task: OutboundTask) => Promise<void>
  timers: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
    clearTimeout: (id: ReturnType<typeof setTimeout>) => void
  }
  now?: () => number
  queueMax?: number
  maxDurationMs?: number
  escalationMs?: number
}

export interface OutboundRouter {
  enqueue: (req: EnqueueRequest) => OutboundTask
  onCallEnd: (taskId: string, reason: string) => Promise<void>
  getState: () => OutboundTask[]
}

// ---- Error ----

export class QueueFullError extends Error {
  readonly code = 'queue_full' as const
  constructor() {
    super('outbound queue is full')
    this.name = 'QueueFullError'
  }
}

// ---- Implementation ----

export function createOutboundRouter(deps: OutboundRouterDeps): OutboundRouter {
  const now = deps.now ?? (() => Date.now())
  const queueMax = deps.queueMax ?? OUTBOUND_QUEUE_MAX
  const maxDurationMs = deps.maxDurationMs ?? OUTBOUND_CALL_MAX_DURATION_MS
  const escalationMs = deps.escalationMs ?? OUTBOUND_ESCALATION_TIMEOUT_MS

  // task_id → task (FIFO via insertion order)
  const tasks = new Map<string, OutboundTask>()
  // task_id → escalation timer handle
  const escalationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // task_id → max-duration timer handle
  const durationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // task_id that is currently "active" (executing call)
  let activeTaskId: string | null = null

  function queued(): OutboundTask[] {
    return [...tasks.values()].filter((t) => t.status === 'queued')
  }

  async function triggerExecute(): Promise<void> {
    // Already executing or no tasks
    if (activeTaskId !== null) return
    const next = queued()[0]
    if (!next) return

    // Mark active
    next.status = 'active'
    next.started_at = now()
    activeTaskId = next.task_id

    // Clear escalation timer if still running
    const escTimer = escalationTimers.get(next.task_id)
    if (escTimer !== undefined) {
      deps.timers.clearTimeout(escTimer)
      escalationTimers.delete(next.task_id)
    }

    // Build persona from goal+context
    const instructions = buildOutboundPersona(next.goal, next.context)

    // Start max-duration cap timer
    const durTimer = deps.timers.setTimeout(async () => {
      // Call has exceeded max-duration — end it
      if (next.call_id) {
        try {
          await deps.openaiClient.realtime.calls.end(next.call_id)
        } catch {
          // best-effort
        }
      }
      // onCallEnd will be triggered by sideband close; but as fallback, fire here
      if (tasks.get(next.task_id)?.status === 'active') {
        await onCallEndInternal(next.task_id, 'timeout')
      }
    }, maxDurationMs)
    durationTimers.set(next.task_id, durTimer)

    // Launch call
    try {
      const result = await deps.openaiClient.realtime.calls.create({
        type: 'sip',
        to: next.target_phone,
        instructions,
      })
      next.call_id = result.id
    } catch (err) {
      // calls.create failed — mark failed
      next.status = 'failed'
      next.error = err instanceof Error ? err.message : String(err)
      next.ended_at = now()
      activeTaskId = null
      // Clear duration timer
      const dt = durationTimers.get(next.task_id)
      if (dt !== undefined) {
        deps.timers.clearTimeout(dt)
        durationTimers.delete(next.task_id)
      }
      // Report back
      try {
        await deps.reportBack(next)
      } catch {
        // best-effort
      }
      // Try next queued task
      await triggerExecute()
    }
  }

  async function onCallEndInternal(taskId: string, reason: string): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) return

    // Clear duration timer
    const dt = durationTimers.get(taskId)
    if (dt !== undefined) {
      deps.timers.clearTimeout(dt)
      durationTimers.delete(taskId)
    }

    // Update status
    task.status = reason === 'timeout' ? 'failed' : 'done'
    task.error = reason === 'timeout' ? 'max_duration_exceeded' : undefined
    task.ended_at = now()

    if (activeTaskId === taskId) {
      activeTaskId = null
    }

    // Report back
    try {
      await deps.reportBack(task)
    } catch {
      // best-effort
    }

    // Pick next queued task
    await triggerExecute()
  }

  function enqueue(req: EnqueueRequest): OutboundTask {
    // Check capacity (queued + active count)
    const currentCount = [...tasks.values()].filter(
      (t) => t.status === 'queued' || t.status === 'active',
    ).length
    if (currentCount >= queueMax) {
      throw new QueueFullError()
    }

    const task: OutboundTask = {
      task_id: crypto.randomUUID(),
      target_phone: req.target_phone,
      goal: req.goal,
      context: req.context,
      report_to_jid: req.report_to_jid,
      created_at: now(),
      call_id: req.call_id,
      status: 'queued',
    }
    tasks.set(task.task_id, task)

    // Start escalation timer (will be cleared if task starts executing)
    const escTimer = deps.timers.setTimeout(async () => {
      const t = tasks.get(task.task_id)
      if (!t || t.status !== 'queued') return
      t.status = 'escalated'
      escalationTimers.delete(task.task_id)
      try {
        await deps.reportBack(t)
      } catch {
        // best-effort
      }
    }, escalationMs)
    escalationTimers.set(task.task_id, escTimer)

    // If no active call → execute immediately (async, fire-and-forget with error guard)
    if (activeTaskId === null && deps.callRouter._size() === 0) {
      void triggerExecute().catch(() => {
        // errors handled inside triggerExecute
      })
    }

    return task
  }

  async function onCallEnd(taskId: string, reason: string): Promise<void> {
    return onCallEndInternal(taskId, reason)
  }

  function getState(): OutboundTask[] {
    return [...tasks.values()]
  }

  return { enqueue, onCallEnd, getState }
}
