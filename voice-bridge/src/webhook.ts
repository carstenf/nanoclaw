// src/webhook.ts — POST /webhook (stub) + POST /accept (Phase 1 accept handler)
// Owns HMAC re-verification (defense-in-depth per D-18 / T-05-01).
// Per T-05-04: only event_type + call_id + size logged at INFO; full payload at DEBUG.
// /accept owns openai.realtime.calls.accept() per REQ-DIR-01, AC-07.
import type { FastifyInstance } from 'fastify'
import OpenAI from 'openai'
import type pino from 'pino'
import { PHASE1_PERSONA } from './config.js'

export function registerWebhookRoute(
  app: FastifyInstance,
  openai: OpenAI,
  log: pino.Logger,
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
function extractCaller(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) return undefined
  const sipHeaders = data.sip_headers as Record<string, unknown> | undefined
  const fromHeader = (sipHeaders?.From ?? sipHeaders?.from) as
    | string
    | undefined
  if (fromHeader) {
    const m = fromHeader.match(/sip:([+\d]+)/)
    if (m) return m[1]
  }
  const direct = (data.from ?? data.caller_number) as string | undefined
  return direct
}

export function registerAcceptRoute(
  app: FastifyInstance,
  openai: OpenAI,
  log: pino.Logger,
  secret: string,
  whitelist: Set<string>,
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

    // Only handle realtime.call.incoming; other event types ack-only.
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

    // Accept — minimal session config for Phase 1 (empty tools per AC-04).
    try {
      await openai.realtime.calls.accept(callId, {
        type: 'realtime',
        model: 'gpt-realtime',
        instructions: PHASE1_PERSONA,
        audio: {
          output: { voice: 'cedar' },
        },
      } as unknown as Parameters<
        typeof openai.realtime.calls.accept
      >[1])
      log.info({
        event: 'call_accepted',
        call_id: callId,
        caller_number: callerNumber,
        latency_ms: Date.now() - t0,
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
