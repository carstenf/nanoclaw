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

/**
 * Plan 05-00 Task 1 (Spike-A) + Wave-3 prep: per-call override envelope.
 *
 * When `persona_override` is set, /accept uses it verbatim as session
 * instructions instead of buildOutboundPersona(goal, context). When
 * `tools_override` is set, /accept emits these tools instead of the default
 * allowlist for THIS call only. Tool names must match Anthropic/OpenAI
 * regex `^[a-zA-Z0-9_]{1,64}$` (validated at zod boundary in
 * outbound-webhook.ts).
 *
 * These fields are in-memory only — not persisted, not mirrored to Core.
 * Their purpose is two-fold:
 *   (1) Spike-A AMD-classifier dry-run (05-00 Task 1), which injects the
 *       CASE2_AMD_CLASSIFIER_PROMPT + a throwaway `amd_result` tool without
 *       modifying allowlist.ts or persona.ts.
 *   (2) Wave 3 Case-2 outbound, where Core will compute the per-call
 *       persona + tools by case_type and push them through this same
 *       envelope — Bridge stays generic.
 *
 * Defaults: both undefined → existing buildOutboundPersona + getAllowlist
 * path runs unchanged. Production callers that don't set either field see
 * no behavior change.
 */
export interface ToolOverrideSpec {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export interface OutboundTask {
  task_id: string
  target_phone: string
  goal: string
  context: string
  report_to_jid: string
  created_at: number
  started_at?: number
  ended_at?: number
  /** Provider-side reference (Sipgate sessionId or FS-channel-uuid for ESL fallback). */
  provider_ref?: string
  /** OpenAI-side call_id, set by webhook /accept once the bridged INVITE arrives. */
  openai_call_id?: string
  status: 'queued' | 'active' | 'done' | 'failed' | 'escalated'
  error?: string
  /** Plan 05-00 Task 1 / Wave 3 prep: override default persona at /accept. */
  persona_override?: string
  /** Plan 05-00 Task 1 / Wave 3 prep: override default allowlist at /accept. */
  tools_override?: ToolOverrideSpec[]
  /** Plan 05-02 Wave 2: case type for routing at /accept. undefined = legacy / unspecified (Case-6b). */
  case_type?: 'case_2' | 'case_6b'
  /** Plan 05-02 Wave 2: extra per-case-type payload carried through to /accept handler (Wave 3 reads this). */
  case_payload?: Record<string, unknown>
}

export interface EnqueueRequest {
  target_phone: string
  goal: string
  context: string
  report_to_jid: string
  call_id?: string
  /** Plan 05-00 Task 1 / Wave 3 prep: per-call persona override. */
  persona_override?: string
  /** Plan 05-00 Task 1 / Wave 3 prep: per-call tools override. */
  tools_override?: ToolOverrideSpec[]
  /** Plan 05-02 Wave 2: case type for routing. undefined = legacy (Case-6b unchanged). */
  case_type?: 'case_2' | 'case_6b'
  /** Plan 05-02 Wave 2: extra per-case-type payload. Wave 3 reads this at /accept. */
  case_payload?: Record<string, unknown>
}

/**
 * Provider-agnostic outbound originate. Plan 03-11 pivot 2026-04-19: prod
 * implementation uses Sipgate REST-API (sipgate-rest-client.ts). The ESL/
 * FreeSWITCH-trunk implementation (freeswitch-esl-client.ts) is retained as
 * v2 fallback if the Sipgate account is upgraded from Basic to Trunking.
 */
export interface OutboundOriginatorLike {
  /** Issue an outbound call to `targetPhone`. Return an opaque provider-side
   *  reference (Sipgate sessionId or FS-channel-uuid) for traceability. */
  originate: (opts: {
    targetPhone: string
    taskId: string
  }) => Promise<{ providerRef: string }>
}

// DI surface for tests
export interface OutboundRouterDeps {
  /** Plan 03-11 pivot 2026-04-19: provider-agnostic outbound originator (was eslClient). */
  outboundOriginator: OutboundOriginatorLike
  callRouter: {
    _size: () => number
  }
  /** Called after each task completes (done/failed/escalated) with final task state. */
  reportBack: (task: OutboundTask) => Promise<void>
  /** Optional hard hangup (used at max-duration cap). */
  hangupCall?: (openaiCallId: string) => Promise<void>
  /** Optional pino-style logger for execute-path observability. */
  log?: {
    info: (o: Record<string, unknown>, msg?: string) => void
    warn: (o: Record<string, unknown>, msg?: string) => void
  }
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

    // Plan 03-11 pivot 2026-04-19: outbound via Sipgate REST-API (was ESL).
    deps.log?.info(
      {
        event: 'outbound_originate_start',
        task_id: next.task_id,
        target_phone: next.target_phone,
      },
      'submitting outbound originate',
    )
    try {
      const result = await deps.outboundOriginator.originate({
        targetPhone: next.target_phone,
        taskId: next.task_id,
      })
      next.provider_ref = result.providerRef
      deps.log?.info(
        {
          event: 'outbound_originate_ok',
          task_id: next.task_id,
          provider_ref: result.providerRef,
        },
        'outbound originate accepted',
      )
    } catch (err) {
      next.status = 'failed'
      // Plan 05-02 Task 4: surface Sipgate error details from Spike-B parser.
      // SipgateRestError.details.lineBusy → task.error='line_busy' (reserved for future use;
      // Spike-B verdict: Sipgate does not distinguish busy from no-answer synchronously).
      // SipgateRestError.details.retryable → generic retryable_failure (Research §4.4).
      const errDetails = (err as { details?: { lineBusy?: boolean; retryable?: boolean } })?.details
      if (errDetails?.lineBusy === true) {
        next.error = 'line_busy'
      } else {
        next.error = err instanceof Error ? err.message : String(err)
      }
      next.ended_at = now()
      activeTaskId = null
      deps.log?.warn(
        {
          event: 'outbound_originate_failed',
          task_id: next.task_id,
          err: next.error,
        },
        'outbound originate failed — task marked failed',
      )
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
      // Plan 05-00 Task 1 / Wave 3 prep: carry override envelope through.
      persona_override: req.persona_override,
      tools_override: req.tools_override,
      // Plan 05-02 Wave 2: carry case_type + case_payload through (undefined = legacy path).
      case_type: req.case_type,
      case_payload: req.case_payload,
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
