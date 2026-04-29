// voice-bridge/src/outbound-router.ts
// Phase 05.3 — Outbound execution queue + originate-via-Sipgate-REST router.
// OpenAI SDK has no outbound call API (only accept/reject/refer/hangup); this
// module originates via Sipgate REST, then waits for OpenAI to send the
// realtime.call.incoming webhook to /accept which correlates via getActiveTask().
//
// Flow per outbound task:
//   1. enqueue() puts task in queue, fires triggerExecute if no active call.
//   2. triggerExecute() picks next queued task and calls deps.outboundOriginator
//      .originate() (production = SipgateRestClient, tests = mock).
//   3. OpenAI receives the bridged INVITE, sends realtime.call.incoming webhook
//      to /accept. /accept consults outboundRouter.getActiveTask(), sees an
//      active outbound task with no openai_call_id yet → applies persona and
//      calls bindOpenaiCallId(taskId, openaiCallId).
//   4. Call proceeds. Sideband close → endCall → outboundRouter.onCallEnd(
//      taskId,'normal') → reportBack → triggerExecute next queued task.
//
// Single-active-outbound concurrency (queue-serialised) is enforced — keeps
// webhook correlation trivial: "the active outbound task IS the one the
// incoming OpenAI webhook is for."
//
// Owning plans: 03-11 (queue + originate), 05-00/-02/-03 (override envelope,
// case_type routing, Case-2 per-outcome reportBack), 05.1-03 (AMD voicemail).
//
// Load-bearing invariants:
//   - Idempotency-key contract: case_payload.idempotency_key flows from Core
//     through enqueue → webhook → AMD voicemail retry handler. Missing key
//     → log-and-skip (never synthesize).
//   - DI-opts pattern: deps.outboundOriginator + deps.coreClient + deps.timers
//     are test-injectable; production wiring is in index.ts buildApp.
import crypto from 'node:crypto'
import {
  OUTBOUND_QUEUE_MAX,
  OUTBOUND_CALL_MAX_DURATION_MS,
  OUTBOUND_ESCALATION_TIMEOUT_MS,
} from './config.js'

// ---- Types ----

/**
 * Per-call override envelope.
 *
 * When `persona_override` is set, /accept uses it verbatim as session
 * instructions. When `tools_override` is set, /accept emits these tools
 * instead of the default allowlist for THIS call only. Tool names must match
 * Anthropic/OpenAI regex `^[a-zA-Z0-9_]{1,64}$` (validated at zod boundary in
 * outbound-webhook.ts).
 *
 * These fields are in-memory only — not persisted. The Bridge no longer
 * renders personas itself (REQ-DIR-13: voice-personas skill in nanoclaw is
 * the single SoT); for `case_type='case_2'` the Bridge calls
 * nanoclawMcp.init({case_type:'case_2',call_direction:'outbound',...}) at
 * /accept and uses the returned instructions. For non-Case-2 outbound, the
 * caller must supply `persona_override` or the call falls back to
 * FALLBACK_PERSONA (REQ-DIR-18).
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
  /** Plan 05-03 Task 4: semantic outcome set by persona/model at end-of-call. Distinct from status.
   *  Used for Case-2 reportBack routing (success/out_of_tolerance skip retry; others trigger retry). */
  outcome?: 'success' | 'out_of_tolerance' | 'voicemail_detected' | 'line_busy' | 'no_answer' | 'escalated'
  /** Plan 05-03 Task 4: counter offer text set by model when outcome=out_of_tolerance. */
  counter_offer?: string
  /** Plan 05-00 Task 1 / Wave 3 prep: override default persona at /accept. */
  persona_override?: string
  /** Plan 05-00 Task 1 / Wave 3 prep: override default allowlist at /accept. */
  tools_override?: ToolOverrideSpec[]
  /** Plan 05-02 Wave 2: case type for routing at /accept. undefined = legacy / unspecified (Case-6b). */
  case_type?: 'case_2' | 'case_6b'
  /** Plan 05-02 Wave 2: extra per-case-type payload carried through to /accept handler (Wave 3 reads this). */
  case_payload?: Record<string, unknown>
  /**
   * Phase 06.x multilingual: persona/voice language Andy picks per outbound
   * call. Threaded into voice_triggers_init at /accept so the per-language
   * baseline + overlay are rendered. Undefined = NanoClaw-side default 'de'.
   */
  lang?: 'de' | 'en' | 'it'
  /**
   * Step 2B: noun phrase identifying the called party ("Restaurant Bella
   * Vista", "Praxis Dr. Mueller", "Tante Anke"). Threaded into the
   * voice_triggers_init counterpart_label arg for natural greeting +
   * addressing in the post-AMD persona. Falls back to
   * case_payload.restaurant_name (case_2 legacy) and finally 'Counterpart'.
   */
  counterpart_label?: string
  /**
   * Mid-call language switch whitelist (Phase 06.x). Andy supplies a 1-5
   * element subset of supported langs (de/en/it) — bot may switch only
   * within this set via voice_set_language(lang) tool. Empty/undefined =
   * no mid-call switching.
   */
  lang_whitelist?: ('de' | 'en' | 'it')[]
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
  /** Phase 06.x multilingual: persona language for the outbound call. */
  lang?: 'de' | 'en' | 'it'
  /** Step 2B: counterpart noun phrase, used by /accept persona render. */
  counterpart_label?: string
  /** Mid-call language switch whitelist (Phase 06.x). */
  lang_whitelist?: ('de' | 'en' | 'it')[]
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
  /**
   * Plan 05-03 Task 4: Core MCP client for Case-2 outcome routing.
   * Optional — if absent, Case-2 routing is skipped (backward compat for
   * callers that don't inject it, e.g. legacy Phase-3 tests).
   */
  coreClient?: {
    callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
  }
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
}

// ---- Error ----

export class QueueFullError extends Error {
  readonly code = 'queue_full' as const
  constructor() {
    super('outbound queue is full')
    this.name = 'QueueFullError'
  }
}

// ---- Case-2 outcome routing ----

/**
 * Plan 05-03 Task 4: After a Case-2 call ends, emit the appropriate
 * voice_notify_user urgency tier and, for retry-eligible outcomes,
 * voice_case_2_schedule_retry.
 *
 * Outcome priority: task.outcome takes precedence over task.error (the model
 * sets task.outcome via onCallEnd metadata; task.error is set by originate
 * failures or AMD/VAD detection paths).
 */
async function reportBackCase2(
  task: OutboundTask,
  coreClient: NonNullable<OutboundRouterDeps['coreClient']>,
  log?: OutboundRouterDeps['log'],
): Promise<void> {
  const casePayload = (task.case_payload ?? {}) as Record<string, unknown>
  const restaurantName = String(casePayload.restaurant_name ?? 'Restaurant')
  const idempotencyKey = String(casePayload.idempotency_key ?? task.task_id)
  const calendarDate = String(casePayload.requested_date ?? '')

  const verdict = task.outcome ?? (task.error as string | undefined)

  log?.info({
    event: 'case_2_reportback',
    task_id: task.task_id,
    verdict,
    outcome: task.outcome,
    error: task.error,
  })

  switch (verdict) {
    case 'success': {
      const requestedTime = String(casePayload.requested_time ?? '')
      const partySize = Number(casePayload.party_size ?? 1)
      await coreClient.callTool('voice_notify_user', {
        urgency: 'info',
        text: `Reservierung bestätigt: ${restaurantName} am ${calendarDate} um ${requestedTime} für ${partySize} Person${partySize !== 1 ? 'en' : ''}.`,
        call_id: task.openai_call_id,
        task_id: task.task_id,
      })
      break
    }

    case 'out_of_tolerance': {
      const counterOffer = task.counter_offer ?? ''
      await coreClient.callTool('voice_notify_user', {
        urgency: 'decision',
        text: `Restaurant ${restaurantName} hat ein Gegenangebot: ${counterOffer}. Bitte entscheiden.`,
        call_id: task.openai_call_id,
        task_id: task.task_id,
        counter_offer: counterOffer,
      })
      break
    }

    case 'voicemail_detected':
    case 'line_busy':
    case 'no_answer': {
      let retryResult: unknown
      try {
        retryResult = await coreClient.callTool('voice_case_2_schedule_retry', {
          task_id: task.task_id,
          target_phone: task.target_phone,
          case_payload: casePayload,
          prev_outcome: verdict,
          idempotency_key: idempotencyKey,
          calendar_date: calendarDate,
        })
      } catch {
        retryResult = null
      }
      const retryRes = retryResult as { error?: string } | null
      if (retryRes?.error === 'daily_cap_reached') {
        await coreClient.callTool('voice_notify_user', {
          urgency: 'alert',
          text: `Tägliches Anruflimit für ${restaurantName} erreicht. Bitte manuell buchen: ${task.target_phone}.`,
          call_id: task.openai_call_id,
          task_id: task.task_id,
        })
      } else {
        await coreClient.callTool('voice_notify_user', {
          urgency: 'info',
          text: `Anruf bei ${restaurantName} war nicht erfolgreich (${verdict}). Nächster Versuch geplant.`,
          call_id: task.openai_call_id,
          task_id: task.task_id,
          prev_outcome: verdict,
        })
      }
      break
    }

    default:
      // Unknown outcome — no routing action
      break
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

    // Submit originate via Sipgate REST-API.
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
      // Surface Sipgate error details. SipgateRestError.details.lineBusy →
      // task.error='line_busy' (reserved; Sipgate does not distinguish busy
      // from no-answer synchronously). details.retryable → generic message.
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
    // For 'timeout': override error with 'max_duration_exceeded'.
    // For all other reasons: preserve any task.error already set
    // (e.g. AMD voicemail detection sets task.error='voicemail_detected'
    // before calling onCallEnd('normal')). Do NOT clear it here.
    if (reason === 'timeout') {
      task.error = 'max_duration_exceeded'
    }
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

    // Case-2 per-outcome routing via Core MCP. Runs after deps.reportBack so
    // the generic path always fires first. Skipped when coreClient is absent.
    if (task.case_type === 'case_2' && deps.coreClient) {
      try {
        await reportBackCase2(task, deps.coreClient, deps.log)
      } catch {
        /* best-effort — outcome routing must not block queue advancement */
      }
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
      // Spike-A override envelope (persona + tools).
      persona_override: req.persona_override,
      tools_override: req.tools_override,
      // Case-type routing envelope — idempotency_key flows via case_payload
      // per Plan 05-02 idempotency-key invariant. undefined = legacy path.
      case_type: req.case_type,
      case_payload: req.case_payload,
      lang: req.lang,
      counterpart_label: req.counterpart_label,
      lang_whitelist: req.lang_whitelist,
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

  return {
    enqueue,
    onCallEnd,
    getState,
    getActiveTask,
    bindOpenaiCallId,
    taskIdForOpenaiCallId,
  }
}
