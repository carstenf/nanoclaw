// src/webhook.ts — POST /webhook (stub) + POST /accept (Phase 2 full wiring)
// Owns HMAC re-verification (defense-in-depth per D-18 / T-05-01).
// Per T-05-04: only event_type + call_id + size logged at INFO; full payload at DEBUG.
// /accept owns openai.realtime.calls.accept() per REQ-DIR-01, AC-07.
import type { FastifyInstance } from 'fastify'
import OpenAI from 'openai'
import type { Logger } from 'pino'
import { CARSTEN_CLI_NUMBER, SESSION_CONFIG } from './config.js'
import { CASE6B_PERSONA, PHASE2_PERSONA } from './persona.js'
import { getAllowlist, type ToolEntry } from './tools/allowlist.js'
import type { CallRouter } from './call-router.js'
import type { OutboundRouter } from './outbound-router.js'
import { maybeInjectPreGreet } from './pre-greet.js'
import { callCoreTool } from './core-mcp-client.js'
import type { CoreClientLike } from './slow-brain.js'
import { requestResponse } from './sideband.js'
import {
  GREET_TRIGGER_DELAY_MS,
  GREET_TRIGGER_DELAY_OUTBOUND_MS,
} from './config.js'
import {
  checkCostCaps,
  CAP_DAILY_EUR,
  CAP_MONTHLY_EUR,
} from './cost/gate.js'
import { sendDiscordAlert } from './alerts.js'

export function registerWebhookRoute(
  app: FastifyInstance,
  openai: OpenAI,
  log: Logger,
  secret: string,
): void {
  app.post('/webhook', async (request, reply) => {
    const t0 = Date.now()
    const raw = (request as unknown as { rawBody: Buffer }).rawBody
    let eventType = 'unknown'
    let callId: string | undefined
    try {
      const evt = await openai.webhooks.unwrap(
        raw.toString('utf8'),
        request.headers as Record<string, string>,
        secret,
      )
      const evtAny = evt as unknown as Record<string, unknown>
      eventType = (evtAny.type as string) ?? 'unknown'
      const data = evtAny.data as Record<string, unknown> | undefined
      callId = data?.call_id as string | undefined
    } catch (e: unknown) {
      const err = e as Error
      log.warn({ event: 'webhook_signature_invalid', err: err?.message })
      return reply.code(401).send({ error: 'invalid signature' })
    }
    log.info({
      event: 'webhook_received',
      event_type: eventType,
      call_id: callId,
      signature_valid: true,
      payload_size: raw.length,
      latency_ms: Date.now() - t0,
    })
    return reply.code(200).send({ ok: true })
  })
}

/**
 * Extract caller number from realtime.call.incoming event.
 * OpenAI Realtime SIP puts From-header in data.sip_headers.From; fallback data.from.
 */
/**
 * OpenAI Realtime SIP webhook payload: data.sip_headers is an array of
 * {name, value} objects. Prefer Remote-Party-ID over From (more reliable),
 * extract the E.164 number from the SIP URI, normalize national format
 * (+0...) to +49 since Sipgate commonly sends national caller IDs.
 */
function extractCaller(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) return undefined
  const headers =
    (data.sip_headers as Array<{ name: string; value: string }> | undefined) ??
    []
  for (const wantName of ['Remote-Party-ID', 'From']) {
    const h = headers.find(
      (x) => x.name?.toLowerCase() === wantName.toLowerCase(),
    )
    if (!h) continue
    const m = h.value.match(/sip:(\+?\d+)@/)
    if (m && m[1]) {
      let num = m[1].startsWith('+') ? m[1] : `+${m[1]}`
      if (num.startsWith('+0')) num = '+49' + num.slice(2)
      return num
    }
  }
  // Fallback for simpler payload shapes (tests, non-SIP events)
  return (data.from ?? data.caller_number) as string | undefined
}

export function registerAcceptRoute(
  app: FastifyInstance,
  openai: OpenAI,
  log: Logger,
  secret: string,
  whitelist: Set<string>,
  router: CallRouter,
  outboundRouter?: OutboundRouter,
): void {
  app.post('/accept', async (request, reply) => {
    const t0 = Date.now()
    const raw = (request as unknown as { rawBody: Buffer }).rawBody
    let eventType = 'unknown'
    let callId: string | undefined
    let callerNumber: string | undefined
    try {
      const evt = await openai.webhooks.unwrap(
        raw.toString('utf8'),
        request.headers as Record<string, string>,
        secret,
      )
      const evtAny = evt as unknown as Record<string, unknown>
      eventType = (evtAny.type as string) ?? 'unknown'
      const data = evtAny.data as Record<string, unknown> | undefined
      callId = data?.call_id as string | undefined
      callerNumber = extractCaller(data)
    } catch (e: unknown) {
      const err = e as Error
      log.warn({ event: 'accept_signature_invalid', err: err?.message })
      return reply.code(401).send({ error: 'invalid signature' })
    }

    // Only `realtime.call.incoming` exists as an OpenAI webhook event (see
    // openai/resources/webhooks/webhooks.ts RealtimeCallIncomingWebhookEvent).
    // Call-end is signalled by the sideband WS close, wired via call-router's
    // onClose callback to router.endCall. Any non-incoming event is ack-only.
    if (eventType !== 'realtime.call.incoming') {
      log.info({
        event: 'accept_skipped',
        event_type: eventType,
        call_id: callId,
      })
      return reply.code(200).send({ ok: true })
    }

    if (!callId) {
      log.warn({ event: 'accept_missing_call_id' })
      return reply.code(200).send({ ok: true })
    }

    // Plan 04-02 Task 3 (COST-02, COST-03): /accept-time cost gate.
    // Query Core SUM, reject with SIP 503 if daily (€3) / monthly (€25) cap
    // hit or suspension flag set. Pitfall 2-safe: gate fires ONCE per call,
    // before openai.realtime.calls.accept. Fail-open on Core outage (logged).
    const gate = await checkCostCaps(log)
    if (gate.decision !== 'allow') {
      log.warn({
        event: 'cost_gate_reject',
        call_id: callId,
        decision: gate.decision,
        today_eur: gate.today_eur,
        month_eur: gate.month_eur,
        suspended: gate.suspended,
      })
      if (gate.decision === 'reject_monthly') {
        // Suspension flag was already set by Core-side auto-suspend path
        // (variant b, locked per Plan 04-02 WARNING-2 resolution).
        void sendDiscordAlert(
          `🛑 Voice channel SUSPENDED: monthly cap €${CAP_MONTHLY_EUR.toFixed(2)} reached (current €${gate.month_eur.toFixed(2)}). Run voice.reset_monthly_cap to resume.`,
        )
      } else if (gate.decision === 'reject_daily') {
        void sendDiscordAlert(
          `🛑 Daily cap €${CAP_DAILY_EUR.toFixed(2)} reached (€${gate.today_eur.toFixed(2)}). No more calls accepted until midnight.`,
        )
      } else if (gate.decision === 'reject_suspended') {
        void sendDiscordAlert(
          `🛑 Call ${callId} rejected: voice channel is SUSPENDED. Run voice.reset_monthly_cap to resume.`,
        )
      }
      try {
        await openai.realtime.calls.reject(callId, { status_code: 503 })
      } catch (e: unknown) {
        const err = e as Error
        log.warn({
          event: 'reject_failed',
          call_id: callId,
          reason: 'cost_cap',
          err: err?.message,
        })
      }
      return reply.code(200).send({ ok: true })
    }

    // Plan 03-11 rewrite: outbound detection. If outboundRouter has an active
    // task with no openai_call_id yet, this incoming OpenAI webhook is for
    // the call WE initiated via ESL → bypass whitelist, use OUTBOUND_PERSONA,
    // bind the call_id back to the task for end-of-call correlation.
    const activeOutbound =
      outboundRouter?.getActiveTask() ?? null
    const isOutbound =
      !!activeOutbound && !activeOutbound.openai_call_id
    if (isOutbound && activeOutbound) {
      outboundRouter?.bindOpenaiCallId(activeOutbound.task_id, callId)
      const outboundInstructions =
        outboundRouter?.buildPersonaForTask(activeOutbound.task_id) ?? ''
      const allowlistOut = getAllowlist()
      const toolsPayloadOut = allowlistOut.map((e: ToolEntry) => {
        const desc = (e.schema as { description?: unknown }).description
        return {
          type: 'function' as const,
          name: e.name,
          ...(typeof desc === 'string' && desc.length > 0
            ? { description: desc }
            : {}),
          parameters: e.schema,
        }
      })
      try {
        await openai.realtime.calls.accept(callId, {
          type: 'realtime',
          model: SESSION_CONFIG.model,
          instructions: outboundInstructions,
          tools: toolsPayloadOut,
          audio: SESSION_CONFIG.audio,
        } as unknown as Parameters<typeof openai.realtime.calls.accept>[1])
        const ctx = router.startCall(callId, log)
        log.info({
          event: 'call_accepted',
          call_id: callId,
          caller_number: callerNumber ?? null,
          model: SESSION_CONFIG.model,
          latency_ms: Date.now() - t0,
          tools_count: toolsPayloadOut.length,
          schema_compile_ok: true,
          sideband_opened: true,
          persona_selected: 'outbound',
          outbound_task_id: activeOutbound.task_id,
        })
        // Outbound greet: skip pre-greet (no Slow-Brain context yet) but
        // still trigger the proactive response.create. Outbound uses a longer
        // delay (GREET_TRIGGER_DELAY_OUTBOUND_MS, default 2500ms) because
        // Sipgate's two-leg bridge needs ~1.5-2s extra for the caller-side
        // audio path to settle after pickup. Inbound uses GREET_TRIGGER_DELAY_MS.
        setTimeout(() => {
          requestResponse(ctx.sideband.state, log)
          log.info({
            event: 'greet_response_create_sent',
            call_id: callId,
            delay_ms: GREET_TRIGGER_DELAY_OUTBOUND_MS,
            outbound: true,
          })
        }, GREET_TRIGGER_DELAY_OUTBOUND_MS)
      } catch (e: unknown) {
        const err = e as Error
        log.error({
          event: 'accept_failed',
          call_id: callId,
          outbound: true,
          err: err?.message,
        })
      }
      return reply.code(200).send({ ok: true })
    }

    // Whitelist check — reject non-whitelisted with SIP 486.
    if (!callerNumber || !whitelist.has(callerNumber)) {
      log.warn({
        event: 'reject_whitelist',
        call_id: callId,
        caller_number: callerNumber,
        whitelist_size: whitelist.size,
      })
      try {
        await openai.realtime.calls.reject(callId, { status_code: 486 })
      } catch (e: unknown) {
        const err = e as Error
        log.warn({
          event: 'reject_failed',
          call_id: callId,
          err: err?.message,
        })
      }
      return reply.code(200).send({ ok: true })
    }

    // Accept — Phase 2 full session config (D-39..D-43):
    // allowlist tools, persona (case6b or phase2), server_vad + create_response, de-DE.
    // Plan 02-14: select persona based on caller number.
    const personaLabel =
      callerNumber === CARSTEN_CLI_NUMBER ? 'case6b' : 'phase2'
    const instructions =
      callerNumber === CARSTEN_CLI_NUMBER ? CASE6B_PERSONA : PHASE2_PERSONA

    const allowlist = getAllowlist()
    const toolsPayload = allowlist.map((e: ToolEntry) => {
      const desc = (e.schema as { description?: unknown }).description
      return {
        type: 'function' as const,
        name: e.name,
        ...(typeof desc === 'string' && desc.length > 0 ? { description: desc } : {}),
        parameters: e.schema,
      }
    })
    try {
      await openai.realtime.calls.accept(callId, {
        type: 'realtime',
        model: SESSION_CONFIG.model,
        instructions,
        tools: toolsPayload,
        audio: SESSION_CONFIG.audio,
      } as unknown as Parameters<typeof openai.realtime.calls.accept>[1])
      const ctx = router.startCall(callId, log)
      log.info({
        event: 'call_accepted',
        call_id: callId,
        caller_number: callerNumber,
        model: SESSION_CONFIG.model,
        latency_ms: Date.now() - t0,
        tools_count: toolsPayload.length,
        schema_compile_ok: true,
        sideband_opened: true,
        persona_selected: personaLabel,
      })

      // Plan 03-14 / REQ-VOICE-13: fire-and-forget Slow-Brain pre-greet
      // injection. <2000ms budget, fallback to static persona on timeout
      // or no instructions returned. Never blocks accept-handler return.
      const coreClient: CoreClientLike = {
        callTool: async (name, args, o) =>
          (await callCoreTool(name, args, {
            timeoutMs: o?.timeoutMs,
            signal: o?.signal,
          })) as { ok: boolean; instructions_update?: string | null },
      }
      void maybeInjectPreGreet({
        callId,
        sideband: ctx.sideband,
        coreClient,
        log,
      })
        .catch((err: Error) => {
          log.warn({
            event: 'pre_greet_unhandled_error',
            call_id: callId,
            err: err?.message,
          })
        })
        .finally(() => {
          // Plan 03-15: explicit greet-trigger. OpenAI Realtime stays silent
          // until an event drives a response. After pre-greet finishes (with
          // or without injection), push a response.create so the model emits
          // its opening line based on the (possibly updated) instructions.
          // Plan 03-15 fix 22:18 PSTN: Carsten reported greet was audible too
          // soon after pickup → first word clipped. Wait GREET_TRIGGER_DELAY_MS
          // (default 1000ms) so the audio path settles before the model speaks.
          setTimeout(() => {
            requestResponse(ctx.sideband.state, log)
            log.info({
              event: 'greet_response_create_sent',
              call_id: callId,
              delay_ms: GREET_TRIGGER_DELAY_MS,
            })
          }, GREET_TRIGGER_DELAY_MS)
        })
    } catch (e: unknown) {
      const err = e as Error
      log.error({
        event: 'accept_failed',
        call_id: callId,
        caller_number: callerNumber,
        err: err?.message,
      })
    }

    return reply.code(200).send({ ok: true })
  })
}
