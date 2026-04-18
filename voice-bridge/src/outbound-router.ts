// voice-bridge/src/outbound-router.ts
// Plan 03-11 (rewrite 22:18): outbound execution via FreeSWITCH ESL.
//
// Old implementation called openai.realtime.calls.create() which does NOT
// exist in the OpenAI SDK (only accept/reject/refer/hangup for inbound).
// REQ-SIP-02 specifies outbound via FreeSWITCH originate; ESL is the standard
// FS control surface (verified working from Lenovo1 → Hetzner over WireGuard
// per briefing 22:18, REQ-INFRA-13/14 fulfilled).
//
// Flow per outbound task:
//   1. enqueue() puts task in queue, fires triggerExecute if no active call.
//   2. triggerExecute() picks next queued task, calls eslOriginate() which
//      issues `originate sofia/gateway/sipgate/<phone> &bridge(sofia/openai/...)`.
//      FS originates A-leg to sipgate; on answer, bridges to OpenAI SIP.
//   3. OpenAI receives the bridged INVITE, sends realtime.call.incoming
//      webhook to /accept. /accept consults outboundRouter.getActiveTask(),
//      sees an active outbound task with no openai_call_id yet → applies
//      OUTBOUND_PERSONA(goal,context) and calls bindOpenaiCallId(taskId,
//      openaiCallId).
//   4. Call proceeds. Sideband close → endCall → outboundRouter.onCallEnd(
//      taskId,'normal') → reportBack → triggerExecute next queued task.
//
// Single-active-outbound concurrency (queue-serialised) is enforced as before
// — keeps webhook correlation trivial: "the active outbound task IS the one
// the incoming OpenAI webhook is for."
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
  /** FreeSWITCH-side channel UUID returned by originate +OK. */
  fs_uuid?: string
  /** OpenAI-side call_id, set by webhook /accept once the bridged INVITE arrives. */
  openai_call_id?: string
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

export interface EslClientLike {
  /** Issue a FreeSWITCH originate, return the FS-side UUID on success. */
  originate: (opts: {
    targetPhone: string
    taskId: string
  }) => Promise<{ fsUuid: string }>
}

// DI surface for tests
export interface OutboundRouterDeps {
  /** Plan 03-11 rewrite: ESL client replaces the old openaiClient.realtime.calls.create attempt. */
  eslClient: EslClientLike
  callRouter: {
    _size: () => number
  }
  /** Called after each task completes (done/failed/escalated) with final task state. */
  reportBack: (task: OutboundTask) => Promise<void>
  /** Optional hard hangup (used at max-duration cap). */
  hangupCall?: (openaiCallId: string) => Promise<void>
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
  /** Plan 03-11 rewrite: webhook /accept reads this to see if an unmapped
   *  outbound is in flight, then calls bindOpenaiCallId. */
  getActiveTask: () => OutboundTask | null
  bindOpenaiCallId: (taskId: string, openaiCallId: string) => void
  /** Reverse lookup so endCall handlers can convert openai_call_id back to taskId. */
  taskIdForOpenaiCallId: (openaiCallId: string) => string | null
  /** For 03-11: persona built fresh per call, exposed for /accept handler. */
  buildPersonaForTask: (taskId: string) => string | null
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
  // openai_call_id → task_id reverse index
  const openaiToTask = new Map<string, string>()

  function queued(): OutboundTask[] {
    return [...tasks.values()].filter((t) => t.status === 'queued')
  }

  async function triggerExecute(): Promise<void> {
    if (activeTaskId !== null) return
    const next = queued()[0]
    if (!next) return

    next.status = 'active'
    next.started_at = now()
    activeTaskId = next.task_id

    const escTimer = escalationTimers.get(next.task_id)
    if (escTimer !== undefined) {
      deps.timers.clearTimeout(escTimer)
      escalationTimers.delete(next.task_id)
    }

    // Start max-duration cap timer. Fires hangup if call runs too long.
    const durTimer = deps.timers.setTimeout(async () => {
      const t = tasks.get(next.task_id)
      if (!t || t.status !== 'active') return
      if (t.openai_call_id && deps.hangupCall) {
        try {
          await deps.hangupCall(t.openai_call_id)
        } catch {
          /* best-effort */
        }
      }
      // If the OpenAI call never wired up (no openai_call_id) we can't hangup
      // it directly — onCallEnd-fallback marks the task failed.
      if (tasks.get(next.task_id)?.status === 'active') {
        await onCallEndInternal(next.task_id, 'timeout')
      }
    }, maxDurationMs)
    durationTimers.set(next.task_id, durTimer)

    // Issue FreeSWITCH originate via ESL.
    try {
      const result = await deps.eslClient.originate({
        targetPhone: next.target_phone,
        taskId: next.task_id,
      })
      next.fs_uuid = result.fsUuid
    } catch (err) {
      next.status = 'failed'
      next.error = err instanceof Error ? err.message : String(err)
      next.ended_at = now()
      activeTaskId = null
      const dt = durationTimers.get(next.task_id)
      if (dt !== undefined) {
        deps.timers.clearTimeout(dt)
        durationTimers.delete(next.task_id)
      }
      try {
        await deps.reportBack(next)
      } catch {
        /* best-effort */
      }
      await triggerExecute()
    }
  }

  async function onCallEndInternal(
    taskId: string,
    reason: string,
  ): Promise<void> {
    const task = tasks.get(taskId)
    if (!task) return

    const dt = durationTimers.get(taskId)
    if (dt !== undefined) {
      deps.timers.clearTimeout(dt)
      durationTimers.delete(taskId)
    }

    task.status = reason === 'timeout' ? 'failed' : 'done'
    task.error = reason === 'timeout' ? 'max_duration_exceeded' : undefined
    task.ended_at = now()

    if (task.openai_call_id) {
      openaiToTask.delete(task.openai_call_id)
    }
    if (activeTaskId === taskId) {
      activeTaskId = null
    }

    try {
      await deps.reportBack(task)
    } catch {
      /* best-effort */
    }

    await triggerExecute()
  }

  function enqueue(req: EnqueueRequest): OutboundTask {
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
      status: 'queued',
    }
    tasks.set(task.task_id, task)

    const escTimer = deps.timers.setTimeout(async () => {
      const t = tasks.get(task.task_id)
      if (!t || t.status !== 'queued') return
      t.status = 'escalated'
      escalationTimers.delete(task.task_id)
      try {
        await deps.reportBack(t)
      } catch {
        /* best-effort */
      }
    }, escalationMs)
    escalationTimers.set(task.task_id, escTimer)

    if (activeTaskId === null && deps.callRouter._size() === 0) {
      void triggerExecute().catch(() => {
        /* errors handled inside triggerExecute */
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

  function getActiveTask(): OutboundTask | null {
    if (!activeTaskId) return null
    return tasks.get(activeTaskId) ?? null
  }

  function bindOpenaiCallId(taskId: string, openaiCallId: string): void {
    const t = tasks.get(taskId)
    if (!t) return
    t.openai_call_id = openaiCallId
    openaiToTask.set(openaiCallId, taskId)
  }

  function taskIdForOpenaiCallId(openaiCallId: string): string | null {
    return openaiToTask.get(openaiCallId) ?? null
  }

  function buildPersonaForTask(taskId: string): string | null {
    const t = tasks.get(taskId)
    if (!t) return null
    return buildOutboundPersona(t.goal, t.context)
  }

  return {
    enqueue,
    onCallEnd,
    getState,
    getActiveTask,
    bindOpenaiCallId,
    taskIdForOpenaiCallId,
    buildPersonaForTask,
  }
}
