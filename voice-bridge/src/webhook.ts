// src/webhook.ts — POST /webhook handler
// Owns HMAC re-verification (defense-in-depth per D-18 / T-05-01) and JSONL write.
// Per T-05-04: only event_type + call_id + size logged at INFO; full payload at DEBUG only.
import type { FastifyInstance } from 'fastify'
import OpenAI from 'openai'
import type pino from 'pino'
export function registerWebhookRoute(
  app: FastifyInstance,
  openai: OpenAI,
  log: pino.Logger,
  secret: string,
): void {
  app.post('/webhook', async (request, reply) => {
    const t0 = Date.now()
    // rawBody is attached by the addContentTypeParser in index.ts
    const raw = (request as unknown as { rawBody: Buffer }).rawBody
    let eventType = 'unknown'
    let callId: string | undefined
    try {
      // webhooks.unwrap() returns a Promise — must await to catch async rejections
      const evt = await openai.webhooks.unwrap(
        raw.toString('utf8'),
        request.headers as Record<string, string>,
        secret,
      )
      // Cast through unknown to access dynamic fields on the returned event object
      const evtAny = evt as unknown as Record<string, unknown>
      eventType = evtAny.type as string ?? 'unknown'
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
