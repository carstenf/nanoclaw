// voice-bridge/src/outbound-webhook.ts
// Plan 03-11: POST /outbound — peer-allowlisted, optional Bearer auth, zod-validated.
// Enqueues an outbound call request via OutboundRouter.
import type { FastifyInstance } from 'fastify'
import type { Logger } from 'pino'
import { z } from 'zod'
import { QueueFullError, type OutboundRouter } from './outbound-router.js'

// ---- Zod schema (same shape as Core-side schema) ----
//
// Plan 05-00 Task 1 / Wave 3 prep: override envelope.
//   persona_override — verbatim instructions replace buildOutboundPersona(...)
//   tools_override   — per-call tools REPLACE (not extend) the default allowlist.
//
// Tool-name regex `^[a-zA-Z0-9_]{1,64}$` matches the OpenAI/Anthropic API
// constraint. Rejected at zod boundary so Bridge never forwards an illegal
// tool schema to OpenAI Realtime. Both fields optional — when absent the
// pre-existing outbound persona + allowlist path runs unchanged.

const ToolOverrideSpecSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-zA-Z0-9_]{1,64}$/,
      'tool name must match ^[a-zA-Z0-9_]{1,64}$ (OpenAI/Anthropic API constraint)',
    ),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()),
})

export const OutboundRequestSchema = z.object({
  call_id: z.string().optional(),
  target_phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'target_phone must be E.164'),
  goal: z.string().min(1).max(500),
  context: z.string().max(2000).default(''),
  report_to_jid: z.string().min(1),
  persona_override: z.string().min(1).max(10_000).optional(),
  tools_override: z.array(ToolOverrideSpecSchema).max(32).optional(),
  // Plan 05-02 Wave 2: case type routing + per-case payload.
  // Both optional — existing Case-6b callers that omit them see no behavior change.
  case_type: z.enum(['case_2', 'case_6b']).optional(),
  case_payload: z.record(z.string(), z.unknown()).optional(),
})

// ---- Peer-IP check ----

/**
 * Extract the first-hop IP from the request.
 * Checks X-Forwarded-For header first (for test injection), then request.ip.
 */
function getPeerIp(request: {
  headers: Record<string, string | string[] | undefined>
  ip: string
}): string {
  const xff = request.headers['x-forwarded-for']
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim()
    if (first) return first
  }
  return request.ip
}

// 10.0.0.2 = bridge's own WireGuard address (Core lives on same host, connects via local bind)
const DEFAULT_PEER_ALLOWLIST = new Set(['10.0.0.1', '10.0.0.2', '10.0.0.4', '10.0.0.5'])

// ---- Route registration ----

export interface RegisterOutboundRouteOpts {
  peerAllowlist?: Set<string>
  authToken?: string
  /** Override the peer IP for tests (bypasses x-forwarded-for extraction). */
  peerIpOverride?: string
}

export function registerOutboundRoute(
  app: FastifyInstance,
  log: Logger,
  router: OutboundRouter,
  opts: RegisterOutboundRouteOpts = {},
): void {
  const allowlist = opts.peerAllowlist ?? DEFAULT_PEER_ALLOWLIST
  const authToken = opts.authToken

  app.post('/outbound', async (request, reply) => {
    // 1. Peer-allowlist check
    const peerIp =
      opts.peerIpOverride ??
      getPeerIp(request as unknown as {
        headers: Record<string, string | string[] | undefined>
        ip: string
      })

    if (!allowlist.has(peerIp)) {
      log.warn({ event: 'outbound_peer_rejected', peer_ip: peerIp })
      return reply.code(403).send({ error: 'forbidden' })
    }

    // 2. Optional Bearer auth
    if (authToken) {
      const authHeader = (request.headers as Record<string, string | undefined>)[
        'authorization'
      ]
      const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
      if (provided !== authToken) {
        log.warn({ event: 'outbound_unauthorized', peer_ip: peerIp })
        return reply.code(401).send({ error: 'unauthorized' })
      }
    }

    // 3. Zod body validation
    const parse = OutboundRequestSchema.safeParse(request.body)
    if (!parse.success) {
      const issue = parse.error.issues[0]
      const field = String(issue?.path?.[0] ?? 'input')
      const message = issue?.message ?? 'invalid'
      log.warn({ event: 'outbound_bad_request', field, message })
      return reply.code(400).send({ error: 'bad_request', field, message })
    }

    const {
      call_id,
      target_phone,
      goal,
      context,
      report_to_jid,
      persona_override,
      tools_override,
      case_type,
      case_payload,
    } = parse.data

    // 4. Enqueue
    let task
    try {
      task = router.enqueue({
        call_id,
        target_phone,
        goal,
        context,
        report_to_jid,
        persona_override,
        tools_override,
        case_type,
        case_payload,
      })
    } catch (err) {
      if (err instanceof QueueFullError) {
        log.warn({ event: 'outbound_queue_full' })
        return reply.code(429).send({ error: 'queue_full' })
      }
      log.error({ event: 'outbound_enqueue_error', err: (err as Error).message })
      return reply.code(500).send({ error: 'internal' })
    }

    // 5. Compute estimated_start_ts + queue_position
    const state = router.getState()
    const activeCount = state.filter((t) => t.status === 'active').length
    const queuedCount = state.filter(
      (t) => t.status === 'queued' && t.task_id !== task.task_id,
    ).length
    const queuePosition = queuedCount + (task.status === 'queued' ? 1 : 0)

    // estimated_start_ts: now if idle, else now + 60s per queued position
    const estimatedMs =
      activeCount === 0 && queuePosition === 0
        ? Date.now()
        : Date.now() + queuePosition * 60_000

    log.info({
      event: 'outbound_enqueued',
      task_id: task.task_id,
      status: task.status,
      queue_position: queuePosition,
    })

    return reply.code(200).send({
      outbound_task_id: task.task_id,
      estimated_start_ts: new Date(estimatedMs).toISOString(),
      queue_position: queuePosition,
      status: task.status,
    })
  })
}
