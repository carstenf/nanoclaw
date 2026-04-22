// src/webhook.ts — POST /webhook (stub) + POST /accept (Phase 2 full wiring)
// Owns HMAC re-verification (defense-in-depth per D-18 / T-05-01).
// Per T-05-04: only event_type + call_id + size logged at INFO; full payload at DEBUG.
// /accept owns openai.realtime.calls.accept() per REQ-DIR-01, AC-07.
import type { FastifyInstance } from 'fastify'
import OpenAI from 'openai'
import type { Logger } from 'pino'
import { CARSTEN_CLI_NUMBER, SESSION_CONFIG } from './config.js'
import { CASE6B_PERSONA, PHASE2_PERSONA, buildCase2OutboundPersona } from './persona.js'
import { getAllowlist, type ToolEntry, INVALID_TOOL_RESPONSE } from './tools/allowlist.js'
import type { CallRouter } from './call-router.js'
import type { OutboundRouter } from './outbound-router.js'
import { maybeInjectPreGreet } from './pre-greet.js'
import { CoreMcpClient } from './core-mcp-client.js'
import { CORE_MCP_URL, CORE_MCP_TOKEN } from './config.js'
import type { CoreClientLike } from './slow-brain.js'
import { requestResponse, updateInstructions } from './sideband.js'
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
import {
  CASE2_AMD_CLASSIFIER_PROMPT,
  createAmdClassifier,
  type AmdVoicemailReason,
} from './amd-classifier.js'
import { setAmdClassifier } from './tools/dispatch.js'

// ---------------------------------------------------------------------------
// Plan 05.1-03 (Defect #4): Case-2 onVoicemail handler factory.
//
// Constructs voice_case_2_schedule_retry tool-call args matching the zod
// schema at src/mcp-tools/voice-case-2-retry.ts:36-44:
//   { call_id, target_phone, calendar_date, prev_outcome, idempotency_key }
// The previous inline closure sent {task_id, target_phone, case_payload,
// prev_outcome: reason} — zod rejected every time with -32602, silently
// dropping every voicemail retry.
//
// All four AMD classifier reasons ('amd_result' | 'cadence_cue' |
// 'silence_mailbox' | 'transcript_cue') are "picked up but mailbox"
// variants; per RESEARCH §4.3 they all map to zod enum 'voicemail'.
// 'no_answer' / 'busy' fire from outbound-router error paths, not here.
//
// Fail-fast guard: if casePayload is missing requested_date or
// idempotency_key, log case_2_schedule_retry_missing_fields and skip the
// retry tool call. Sending empty strings would fail zod .length(64).regex
// at Core with the exact -32602 symptom this plan fixes — log-and-skip is
// the only correct path (the retry is orphaned but observable).
// ---------------------------------------------------------------------------

type Case2OnVoicemailActiveOutbound = {
  task_id: string
  target_phone: string
}

type Case2OnVoicemailCoreClient = {
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>
}

type Case2OnVoicemailOpenAI = {
  realtime: { calls: { hangup: (callId: string) => Promise<unknown> } }
}

export interface BuildCase2OnVoicemailHandlerParams {
  callId: string
  activeOutbound: Case2OnVoicemailActiveOutbound
  casePayload: Record<string, unknown>
  coreMcpForAmd: Case2OnVoicemailCoreClient | null
  openai: Case2OnVoicemailOpenAI
  log: Logger
  setAmdClassifier: (c: null) => void
}

export function buildCase2OnVoicemailHandler(
  params: BuildCase2OnVoicemailHandlerParams,
): (reason: AmdVoicemailReason) => Promise<void> {
  const { callId, activeOutbound, casePayload, coreMcpForAmd, openai, log } =
    params

  // All AMD reasons collapse to zod enum 'voicemail'. The _r argument is
  // intentionally unused: the 4-way map is a constant. Future AMD reason
  // codes must be added to AmdVoicemailReason to compile (TS strict
  // enforces review of any expansion).
  const amdReasonToPrevOutcome = (_r: AmdVoicemailReason): 'voicemail' =>
    'voicemail'

  return async function onVoicemail(reason: AmdVoicemailReason): Promise<void> {
    log.info({
      event: 'case_2_amd_voicemail_verdict',
      call_id: callId,
      reason,
      task_id: activeOutbound.task_id,
    })
    try {
      await openai.realtime.calls.hangup(callId)
    } catch (e: unknown) {
      log.warn({
        event: 'case_2_voicemail_hangup_failed',
        call_id: callId,
        err: (e as Error)?.message,
      })
    }
    // voice_case_2_schedule_retry + voice_notify_user via Core MCP
    if (coreMcpForAmd) {
      // Fail-fast if required zod-schema fields are missing from casePayload.
      // casePayload.requested_date + idempotency_key are MANDATORY per Phase 5 D-7.
      // Empty-string fallback would fail zod .length(64).regex(/^[0-9a-f]{64}$/)
      // at Core with -32602 — the exact symptom this plan fixes.
      const calendarDateRaw = casePayload.requested_date
      const idempotencyKeyRaw = casePayload.idempotency_key
      const calendarDate =
        typeof calendarDateRaw === 'string' && calendarDateRaw.length > 0
          ? calendarDateRaw
          : ''
      const idempotencyKey =
        typeof idempotencyKeyRaw === 'string' && idempotencyKeyRaw.length > 0
          ? idempotencyKeyRaw
          : ''
      if (!calendarDate || !idempotencyKey) {
        log.warn({
          event: 'case_2_schedule_retry_missing_fields',
          call_id: callId,
          has_calendar_date: Boolean(calendarDate),
          has_idempotency_key: Boolean(idempotencyKey),
        })
      } else {
        try {
          await coreMcpForAmd.callTool('voice_case_2_schedule_retry', {
            call_id: callId,
            target_phone: activeOutbound.target_phone,
            calendar_date: calendarDate,
            prev_outcome: amdReasonToPrevOutcome(reason),
            idempotency_key: idempotencyKey,
          })
        } catch (e: unknown) {
          log.warn({
            event: 'case_2_schedule_retry_failed',
            call_id: callId,
            err: (e as Error)?.message,
          })
        }
      }
      try {
        await coreMcpForAmd.callTool('voice_notify_user', {
          urgency: 'info',
          text: `Voicemail erkannt bei ${String(casePayload.restaurant_name ?? 'Restaurant')} (${reason}). Nächster Versuch in Kürze.`,
          call_id: callId,
        })
      } catch (e: unknown) {
        log.warn({
          event: 'case_2_notify_failed',
          call_id: callId,
          err: (e as Error)?.message,
        })
      }
    }
    params.setAmdClassifier(null)
  }
}

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
          `🛑 Voice channel SUSPENDED: monthly cap €${CAP_MONTHLY_EUR.toFixed(2)} reached (current €${gate.month_eur.toFixed(2)}). Run voice_reset_monthly_cap to resume.`,
        )
      } else if (gate.decision === 'reject_daily') {
        void sendDiscordAlert(
          `🛑 Daily cap €${CAP_DAILY_EUR.toFixed(2)} reached (€${gate.today_eur.toFixed(2)}). No more calls accepted until midnight.`,
        )
      } else if (gate.decision === 'reject_suspended') {
        void sendDiscordAlert(
          `🛑 Call ${callId} rejected: voice channel is SUSPENDED. Run voice_reset_monthly_cap to resume.`,
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

      // Plan 05-03 Task 3: Case-2 AMD branch.
      // When case_type='case_2', use CASE2_AMD_CLASSIFIER_PROMPT as instructions
      // and add amd_result inline to the tools list (Bridge-internal, NOT in
      // allowlist.ts — T-05-03-07). Drop 3 Case-6-specific tools that are
      // irrelevant for restaurant reservations (REQ-TOOLS-09: 15 - 3 + 1 = 13).
      // CAUTION: amd_result NOT added to allowlist.ts — compile-time cap stays 15.
      const isCase2 = activeOutbound.case_type === 'case_2'

      // Plan 05-00 Task 1 / Wave 3 prep: honor per-call override envelope.
      //   persona_override — use verbatim as instructions (skips buildOutboundPersona)
      //   tools_override   — REPLACE the default allowlist for THIS call only
      // When neither is present and it's not Case-2, the pre-existing outbound path runs unchanged.
      const hasPersonaOverride =
        typeof activeOutbound.persona_override === 'string' &&
        activeOutbound.persona_override.length > 0
      const hasToolsOverride =
        Array.isArray(activeOutbound.tools_override) &&
        activeOutbound.tools_override.length > 0

      let outboundInstructions: string
      let toolsPayloadOut: Array<{ type: 'function'; name: string; description?: string; parameters: Record<string, unknown> }>
      // ctxRef is populated after router.startCall() inside the Case-2 branch.
      // Declared at outbound-block scope so the onHuman closure can capture it.
      let ctxRef: { sideband: { state: Parameters<typeof updateInstructions>[0] } } | null = null

      if (isCase2) {
        // Case-2: AMD classifier prompt as initial instructions.
        // The classifier fires amd_result which swaps to CASE2_OUTBOUND_PERSONA.
        outboundInstructions = CASE2_AMD_CLASSIFIER_PROMPT

        // Case-2 tool list: base allowlist minus 3 Case-6-specific tools + amd_result.
        // Net count: 15 - 3 + 1 = 13 (under REQ-TOOLS-09 cap of 15).
        const CASE2_EXCLUDED = new Set(['voice_search_competitors', 'voice_get_practice_profile', 'voice_get_contract', 'search_competitors', 'get_practice_profile', 'get_contract'])
        const baseTools = getAllowlist()
          .filter((e: ToolEntry) => !CASE2_EXCLUDED.has(e.name))
          .map((e: ToolEntry) => {
            const desc = (e.schema as { description?: unknown }).description
            return {
              type: 'function' as const,
              name: e.name,
              ...(typeof desc === 'string' && desc.length > 0 ? { description: desc } : {}),
              parameters: e.schema,
            }
          })
        // amd_result: Bridge-internal only, declared inline here.
        // T-05-03-07: NOT added to allowlist.ts; compile-time REQ-TOOLS-09 guard still passes.
        const amdResultTool = {
          type: 'function' as const,
          name: 'amd_result',
          description: 'Bridge-internal AMD verdict tool. Emit when you determine human or voicemail.',
          parameters: {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['human', 'voicemail', 'silence'] },
            },
            required: ['verdict'],
            additionalProperties: false,
          },
        }
        toolsPayloadOut = [...baseTools, amdResultTool]

        // Register AMD classifier for this call so dispatch.ts can route amd_result.
        const casePayload = (activeOutbound.case_payload ?? {}) as Record<string, unknown>
        const coreMcpForAmd = CORE_MCP_URL
          ? new CoreMcpClient(new URL(CORE_MCP_URL), CORE_MCP_TOKEN)
          : null

        const classifier = createAmdClassifier({
          callId,
          log,
          onHuman: () => {
            // Verdict: human — swap to Case-2 outbound persona + trigger first response
            const persona = buildCase2OutboundPersona({
              restaurant_name: String(casePayload.restaurant_name ?? 'Restaurant'),
              requested_date: String(casePayload.requested_date ?? ''),
              requested_time: String(casePayload.requested_time ?? ''),
              time_tolerance_min: Number(casePayload.time_tolerance_min ?? 30),
              party_size: Number(casePayload.party_size ?? 1),
              notes: casePayload.notes != null ? String(casePayload.notes) : undefined,
            })
            log.info({
              event: 'case_2_amd_human_verdict',
              call_id: callId,
              task_id: activeOutbound.task_id,
            })
            if (ctxRef) {
              // Plan 05.2-05 Q7 finding (.planning/phases/05.2-persona-redesign-and-call-flow-state-machine/q7-atomicity-finding.md):
              // Does a single session.update with BOTH instructions AND tools
              // replace them atomically on the OpenAI server? Verdict is
              // INCONCLUSIVE with a docs-lean toward ATOMIC per OpenAI
              // Cookbook "Dynamic Conversation Flow via session.updates".
              // Key narrowing: this handoff pushes instructions-ONLY —
              // updateInstructions() at sideband.ts:704-710 actively strips
              // the tools field (D-26/AC-05 invariant). The Case-2 tool list
              // (13 tools including amd_result) was fixed at /accept and is
              // not re-pushed here. Q7 therefore does NOT affect this code
              // path under the current architecture. If Phase 5 state-graph
              // transitions push instructions+tools together, re-visit this
              // call site and run voice-bridge/scripts/session-update-atomicity-probe.ts.
              //
              // Also: Plan 05.2-04 migrated buildCase2OutboundPersona to
              // compose baseline (persona/baseline.ts) + Case-2 overlay
              // (persona/overlays/case-2.ts). Callsite signature unchanged;
              // the `persona` string now contains baseline role-lock + overlay
              // task details. See tests/webhook-amd-handoff.test.ts Test A.
              //
              // Push Case-2 persona to model via session.update, then trigger greeting.
              updateInstructions(ctxRef.sideband.state, persona, log)

              // Plan 05.1-01 Task 3 (defect #6 Layer 2, RESEARCH §2.5):
              // synthetic user-directive injection between updateInstructions
              // and the setTimeout→requestResponse. Breaks the conversational
              // context inherited from CASE2_AMD_CLASSIFIER_PROMPT — without
              // this, the model may still mis-read the callee's opening
              // greeting ("Restaurant Bellavista") as evidence it should
              // continue in AMD-helper mode instead of CASE2_OUTBOUND_PERSONA.
              // Text uses ASCII umlauts per Phase 2 CASE6B_PERSONA convention.
              // Pitfall 5: this item.create does NOT itself trigger a
              // response.create (VAD only scopes audio-derived items), so
              // the explicit requestResponse below is still required.
              try {
                ctxRef.sideband.state.ws?.send(
                  JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                      type: 'message',
                      role: 'user',
                      content: [
                        {
                          type: 'input_text',
                          text: '[System-Hinweis: AMD-Verdict war human. Der Anruf laeuft jetzt im Reservierungs-Modus. Beginne bitte mit der Begruessung gemaess deiner neuen Anweisungen.]',
                        },
                      ],
                    },
                  }),
                )
                log.info({
                  event: 'case_2_amd_synthetic_user_directive_sent',
                  call_id: callId,
                })
              } catch (e: unknown) {
                log.warn({
                  event: 'case_2_amd_synthetic_user_directive_send_failed',
                  call_id: callId,
                  err: (e as Error)?.message,
                })
              }

              setTimeout(() => {
                if (ctxRef) requestResponse(ctxRef.sideband.state, log)
              }, GREET_TRIGGER_DELAY_OUTBOUND_MS)
            } else {
              // startCall hasn't returned yet (extremely rare). Store persona for fallback.
              activeOutbound.persona_override = persona
            }
          },
          // Plan 05.1-03 defect #4: factory extracted for unit-testability.
          // See buildCase2OnVoicemailHandler + webhook-case-2-voicemail.test.ts.
          onVoicemail: buildCase2OnVoicemailHandler({
            callId,
            activeOutbound: {
              task_id: activeOutbound.task_id,
              target_phone: activeOutbound.target_phone,
            },
            casePayload,
            coreMcpForAmd,
            openai,
            log,
            setAmdClassifier,
          }),
        })
        setAmdClassifier(classifier)

        log.info({
          event: 'case_2_amd_branch_active',
          call_id: callId,
          task_id: activeOutbound.task_id,
          tools_count: toolsPayloadOut.length,
        })
      } else if (hasPersonaOverride || hasToolsOverride) {
        outboundInstructions = hasPersonaOverride
          ? (activeOutbound.persona_override as string)
          : (outboundRouter?.buildPersonaForTask(activeOutbound.task_id) ?? '')
        toolsPayloadOut = hasToolsOverride
          ? (activeOutbound.tools_override as Array<{
              name: string
              description?: string
              parameters: Record<string, unknown>
            }>).map((t) => ({
              type: 'function' as const,
              name: t.name,
              ...(typeof t.description === 'string' && t.description.length > 0
                ? { description: t.description }
                : {}),
              parameters: t.parameters,
            }))
          : getAllowlist().map((e: ToolEntry) => {
              const desc = (e.schema as { description?: unknown }).description
              return {
                type: 'function' as const,
                name: e.name,
                ...(typeof desc === 'string' && desc.length > 0 ? { description: desc } : {}),
                parameters: e.schema,
              }
            })
        log.info({
          event: 'outbound_override_active',
          call_id: callId,
          task_id: activeOutbound.task_id,
          persona_override: hasPersonaOverride,
          tools_override_count: hasToolsOverride
            ? (activeOutbound.tools_override as unknown[]).length
            : 0,
        })
      } else {
        outboundInstructions = outboundRouter?.buildPersonaForTask(activeOutbound.task_id) ?? ''
        toolsPayloadOut = getAllowlist().map((e: ToolEntry) => {
          const desc = (e.schema as { description?: unknown }).description
          return {
            type: 'function' as const,
            name: e.name,
            ...(typeof desc === 'string' && desc.length > 0 ? { description: desc } : {}),
            parameters: e.schema,
          }
        })
      }

      // Plan 05-00 Task 1 (Spike-A): when override is active, enable per-call
      // sideband event trace to a deterministic path. Spike script tails it.
      const traceEventsPath =
        (hasPersonaOverride || hasToolsOverride || isCase2)
          ? `/tmp/spike-a-trace-${callId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`
          : undefined
      try {
        await openai.realtime.calls.accept(callId, {
          type: 'realtime',
          model: SESSION_CONFIG.model,
          instructions: outboundInstructions,
          tools: toolsPayloadOut,
          audio: SESSION_CONFIG.audio,
        } as unknown as Parameters<typeof openai.realtime.calls.accept>[1])
        const ctx = router.startCall(callId, log, { traceEventsPath })
        log.info({
          event: 'call_accepted',
          call_id: callId,
          caller_number: callerNumber ?? null,
          model: SESSION_CONFIG.model,
          latency_ms: Date.now() - t0,
          tools_count: toolsPayloadOut.length,
          schema_compile_ok: true,
          sideband_opened: true,
          persona_selected: isCase2 ? 'case_2_amd' : 'outbound',
          outbound_task_id: activeOutbound.task_id,
        })
        if (isCase2) {
          // Case-2: NO proactive requestResponse — AMD classifier must fire first.
          // Wire ctxRef so the onHuman callback (closure above) can reach sideband.
          // armedForFirstSpeech stays false; the onHuman closure requests response.create
          // explicitly post-AMD verdict.
          ctxRef = ctx
        } else {
          // Plan 05.2-03 D-8: Case-1 (non-Case-2) outbound arms
          // armedForFirstSpeech=true so sideband waits for counterpart's first
          // speech_stopped before firing response.create. Replaces the previous
          // proactive setTimeout+requestResponse (which caused the bot to speak
          // before the counterpart said hello — user complaint 2026-04-21).
          // Silence + nudge ladder is persona-driven via baseline OUTBOUND_SCHWEIGEN
          // block (D-1 3 attempts, D-2 Sie-form apologetic farewell) — no server
          // timer per feedback_no_timer_based_silence memory.
          ctx.sideband.state.armedForFirstSpeech = true
          log.info({
            event: 'armed_for_first_speech',
            call_id: callId,
            outbound: true,
          })
        }
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
    // Plan 04.5-03 / D-6 / Pitfall 5 (T-4.5-E): per-call MCP session.
    // Construct the CoreMcpClient BEFORE router.startCall() so it flows
    // through to openSidebandSession's ws.on('close') finalizer, which
    // calls coreMcp.close() on hangup. Without this, the server-side
    // sessions Map leaks one session per call.
    const coreMcp = CORE_MCP_URL
      ? new CoreMcpClient(new URL(CORE_MCP_URL), CORE_MCP_TOKEN)
      : undefined
    try {
      await openai.realtime.calls.accept(callId, {
        type: 'realtime',
        model: SESSION_CONFIG.model,
        instructions,
        tools: toolsPayload,
        audio: SESSION_CONFIG.audio,
      } as unknown as Parameters<typeof openai.realtime.calls.accept>[1])
      const ctx = router.startCall(callId, log, { coreMcp })
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
      //
      // Plan 04.5-03: adapt the per-call CoreMcpClient into the
      // CoreClientLike shape slow-brain/pre-greet expect. The result cast
      // to { ok, instructions_update? } mirrors v1's return-shape contract.
      const coreClient: CoreClientLike = coreMcp
        ? {
            callTool: async (name, args, o) =>
              (await coreMcp.callTool(name, args, {
                timeoutMs: o?.timeoutMs,
                signal: o?.signal,
              })) as { ok: boolean; instructions_update?: string | null },
          }
        : {
            // If CORE_MCP_URL is unset (dev/test without Core), pre-greet
            // becomes a no-op — the callTool adapter throws, and
            // maybeInjectPreGreet catches and logs `core_call_failed`.
            callTool: async () => {
              throw new Error('core-mcp: CORE_MCP_URL not configured')
            },
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
