// voice-bridge/src/webhook.ts
// Phase 05.3 — OpenAI Realtime /webhook (HMAC re-verify + ack) and /accept
// (inbound + outbound /accept, persona selection, cost gate, AMD handoff
// bootstrapping, pre-greet fire-and-forget, sideband WS open via call-router).
//
// Owning plans: 05.1-01 (session.type, AMD defect #6), 05.1-03 (Case-2 voicemail
// factory), 05.2-03 D-8 (wait-for-speech armedForFirstSpeech), 05.2-04/05 +
// 05.3-03 D-2 (inbound Carsten baseline+overlay composition), 05.3-05a D-3
// (UX setTimeouts removed; synchronous requestResponse).
//
// Load-bearing invariants (inline-anchored below):
//   - Plan 05.2-05 Q7: session.update is instructions-only (updateInstructions
//     strips `tools`); tools are fixed at /accept and not re-pushed (§201 StGB
//     AMD-gate invariant preserved under Case-2 persona handoff).
//   - Plan 05.1-01 Task 3: synthetic user-directive between updateInstructions
//     and requestResponse on AMD-handoff (breaks classifier conversational
//     context so Case-2 opening greeting is not misread).
//   - Plan 05.3-05a D-3: both UX setTimeouts removed (outbound AMD-handoff +
//     inbound self-greet) — wait-for-speech D-8 is the audio-path-ready signal.
//
// ASCII-umlaut convention enforced project-wide (see persona/baseline.ts header).
import type { FastifyInstance } from 'fastify'
import OpenAI from 'openai'
import type { Logger } from 'pino'
import {
  CARSTEN_CLI_NUMBER,
  SESSION_CONFIG,
  buildTracePath,
  REASONING_MODE,
  FALLBACK_PERSONA,
} from './config.js'
import { PHASE2_PERSONA, buildCase2OutboundPersona } from './persona.js'
import { buildBasePersona } from './persona/baseline.js'
import { buildTaskOverlay } from './persona/overlays/index.js'
import { getAllowlist, type ToolEntry } from './tools/allowlist.js'
import type { CallRouter } from './call-router.js'
import type { OutboundRouter } from './outbound-router.js'
import { maybeInjectPreGreet } from './pre-greet.js'
import { CoreMcpClient } from './core-mcp-client.js'
import { CORE_MCP_URL, CORE_MCP_TOKEN } from './config.js'
import type { NanoclawMcpClient } from './nanoclaw-mcp-client.js'
import type { CoreClientLike } from './slow-brain.js'
import { enableAutoResponseCreate, requestResponse, updateInstructions } from './sideband.js'
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
// Case-2 onVoicemail handler factory.
//
// Constructs voice_case_2_schedule_retry tool-call args matching the zod
// schema at src/mcp-tools/voice-case-2-retry.ts:
//   { call_id, target_phone, calendar_date, prev_outcome, idempotency_key }
//
// All four AMD classifier reasons ('amd_result' | 'cadence_cue' |
// 'silence_mailbox' | 'transcript_cue') are "picked up but mailbox"
// variants and all map to zod enum 'voicemail'. 'no_answer' / 'busy' fire
// from outbound-router error paths, not here.
//
// Fail-fast guard: if casePayload is missing requested_date or
// idempotency_key, log case_2_schedule_retry_missing_fields and skip the
// retry tool call. Sending empty strings would fail zod .length(64).regex
// at Core with -32602 — log-and-skip is the only correct path (the retry
// is orphaned but observable).
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
  nanoclawMcp?: NanoclawMcpClient,
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

    // /accept-time cost gate — query Core SUM, reject with SIP 503 if daily
    // (€3) / monthly (€25) cap hit or suspension flag set. Gate fires ONCE per
    // call, before openai.realtime.calls.accept. Fail-open on Core outage (logged).
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

    // Outbound detection. If outboundRouter has an active task with no
    // openai_call_id yet, this incoming OpenAI webhook is for the call WE
    // initiated via ESL → bypass whitelist, use the outbound persona, bind
    // the call_id back to the task for end-of-call correlation.
    const activeOutbound =
      outboundRouter?.getActiveTask() ?? null
    const isOutbound =
      !!activeOutbound && !activeOutbound.openai_call_id
    if (isOutbound && activeOutbound) {
      outboundRouter?.bindOpenaiCallId(activeOutbound.task_id, callId)

      // Case-2 AMD branch — when case_type='case_2', use CASE2_AMD_CLASSIFIER_PROMPT
      // as initial instructions and add amd_result inline to the tools list
      // (Bridge-internal, NOT in allowlist.ts). Drop 3 Case-6-specific tools
      // that are irrelevant for restaurant reservations (15 - 3 + 1 = 13 tools).
      const isCase2 = activeOutbound.case_type === 'case_2'

      // Honor per-call override envelope (Spike-A / Wave 3):
      //   persona_override — use verbatim as instructions
      //   tools_override   — REPLACE the default allowlist for THIS call only
      // When neither is present and it's not Case-2, the standard outbound
      // path runs unchanged.
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

      // Phase 05.5 Splice A — outbound /accept REASONING_MODE branch.
      // When the flag is 'container-agent', synchronously call nanoclawMcp.init
      // (REQ-DIR-19) and use the returned fully-rendered persona. On
      // timeout/error fall back to FALLBACK_PERSONA per REQ-VOICE-13 fallback
      // exception. The legacy baseline+overlay composition stays in the else
      // branch — Phase-5 default behaviour is byte-identical.
      //
      // Critical guard: if the flag is on but `nanoclawMcp` was not wired
      // (config error — index.ts skipped construction), log fatal and use
      // FALLBACK_PERSONA. Silently regressing to legacy code would mask the
      // misconfiguration.
      //
      // Case-2 AMD-classifier requires CASE2_AMD_CLASSIFIER_PROMPT as the
      // initial /accept instructions so the model stays in detection-mode
      // pre-verdict (§201 StGB AMD-gate, Plan 05-03 T-05-03-01). The
      // container-agent persona is therefore swapped in via the post-AMD-
      // verdict onHuman closure path (existing updateInstructions wiring) —
      // not at /accept time. Hence this Splice A applies to NON-Case-2
      // outbound paths (Case-1 + override envelopes); Case-2 keeps its
      // classifier-prompt instructions and the persona/overlay swap inside
      // onHuman remains the legacy Phase-5 path until Plan 05.6 cleanup.
      const useContainerAgent =
        REASONING_MODE === 'container-agent' && !isCase2
      if (useContainerAgent) {
        if (!nanoclawMcp) {
          log.error({
            event: 'container_agent_mode_but_client_missing',
            call_id: callId,
          })
          outboundInstructions = FALLBACK_PERSONA
        } else {
          try {
            const r = await nanoclawMcp.init({
              call_id: callId,
              case_type: 'case_2',
              call_direction: 'outbound',
              counterpart_label: String(
                activeOutbound.case_payload?.restaurant_name ?? 'Counterpart',
              ),
            })
            outboundInstructions = r.instructions
          } catch (err) {
            log.warn({
              event: 'container_agent_init_failed',
              call_id: callId,
              err: (err as Error)?.message,
            })
            outboundInstructions = FALLBACK_PERSONA
          }
        }
        // Default tools allowlist — container-agent doesn't override tools at
        // /accept (REQ-DIR-11: no tools mid-call; tools fixed at /accept).
        toolsPayloadOut = getAllowlist().map((e: ToolEntry) => {
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
        log.info({
          event: 'container_agent_outbound_active',
          call_id: callId,
          task_id: activeOutbound.task_id,
        })
      } else if (isCase2) {
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
              // Plan 05.2-05 Q7 invariant: instructions-only session.update at
              // AMD-handoff. updateInstructions() strips `tools` (D-26/AC-05);
              // the Case-2 tool list (13 tools incl. amd_result) is fixed at
              // /accept and never re-pushed — so the atomicity question around
              // instructions+tools co-pushes does NOT affect this code path.
              // Re-visit if a future state-graph transition pushes both together
              // (see q7-atomicity-finding.md + session-update-atomicity-probe.ts).
              // `persona` is baseline + Case-2 overlay (post-Plan 05.2-04 migration).
              updateInstructions(ctxRef.sideband.state, persona, log)

              // Plan 05.1-01 Task 3 invariant: synthetic user-directive between
              // updateInstructions and the synchronous requestResponse on
              // AMD-handoff. Breaks the conversational context inherited from
              // CASE2_AMD_CLASSIFIER_PROMPT — without this, the model may
              // mis-read the callee's opening greeting as evidence it should
              // continue in AMD-helper mode instead of CASE2_OUTBOUND_PERSONA.
              // Does NOT itself trigger response.create (VAD only scopes
              // audio-derived items), so the explicit requestResponse below
              // is still required.
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

              // Plan 05.3-05a D-3: setTimeout removed. wait-for-speech
              // (sideband.ts armedForFirstSpeech + onmessage:346-360) is the
              // audio-path-ready signal. Atomic session.update +
              // conversation.item.create is sufficient (Plan 05.2-05 Q7 docs-
              // lean ATOMIC verdict); the response.create fires synchronously
              // here, and native turn_detection.idle_timeout_ms (config.ts
              // SESSION_CONFIG) governs subsequent silence-driven nudges via
              // persona OUTBOUND_SCHWEIGEN ladder (no bridge-side timer).
              //
              // Phase 05.4 Bug-1 fix: after the post-AMD-verdict opening turn,
              // flip turn_detection.create_response to true so turns 2..N are
              // handled natively by server_vad. D-8 first-turn invariant is
              // preserved because this fires only after the verified-human
              // opening has been dispatched (no pre-AMD bot audio possible).
              if (ctxRef) {
                requestResponse(ctxRef.sideband.state, log)
                enableAutoResponseCreate(ctxRef.sideband.state, log)
              }
            } else {
              // startCall hasn't returned yet (extremely rare). Store persona for fallback.
              activeOutbound.persona_override = persona
            }
          },
          // Factory extracted for unit-testability — see
          // buildCase2OnVoicemailHandler + webhook-case-2-voicemail.test.ts.
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

      // Phase 05.4 Block-5: per-call sideband event trace at REQ-INFRA-05 /
      // REQ-VOICE-10 path `~/nanoclaw/voice-container/runs/turns-{call_id}
      // .jsonl`. §201-redaction for audio.delta bytes enforced in
      // sideband.ts maybeWriteTrace (delta_bytes count only, never PCM).
      // Supersedes the interim `/tmp/spike-a-trace-*.jsonl` path (commit
      // d6bf803). See voice-channel-spec/tracing-contract.md for the full
      // redaction + retention contract.
      const traceEventsPath = buildTracePath(callId)
      // Phase 05.4 Block-3: D-8 narrowed to case_type='case_2' only. Case-2
      // still needs `create_response:false` at /accept so the bot stays silent
      // until AMD classifies voicemail vs human. Case-1 / Case-6b outbound use
      // the REQ-VOICE-04 default (`create_response:true`) + speak-first — bot
      // greets on call connect, counterpart responds, native server_vad drives
      // subsequent turns. Eliminates the Q2-silent-pickup hang class.
      const audioForAccept = isCase2
        ? {
            ...SESSION_CONFIG.audio,
            input: {
              ...SESSION_CONFIG.audio.input,
              turn_detection: {
                ...SESSION_CONFIG.audio.input.turn_detection,
                create_response: false,
              },
            },
          }
        : SESSION_CONFIG.audio
      try {
        await openai.realtime.calls.accept(callId, {
          type: 'realtime',
          model: SESSION_CONFIG.model,
          instructions: outboundInstructions,
          tools: toolsPayloadOut,
          audio: audioForAccept,
        } as unknown as Parameters<typeof openai.realtime.calls.accept>[1])
        const ctx = router.startCall(callId, log, {
          traceEventsPath,
          // Phase 05.5: pass per-call NanoclawMcpClient so onTranscriptTurn
          // (call-router.ts) can fire the transcript trigger under
          // REASONING_MODE='container-agent'. Stays undefined under default.
          nanoclawMcp,
        })
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
          // armedForFirstSpeech stays false; the onHuman closure requests
          // response.create + flips create_response:true explicitly post-AMD verdict.
          ctxRef = ctx
        } else {
          // Phase 05.4 Block-3: Case-1 / Case-6b outbound — speak-first per
          // REQ-VOICE-04 (auto_create_response=true). Fire a synchronous
          // response.create so the model opens with its persona-directed
          // greeting ("NanoClaw im Auftrag von Carsten…"). Subsequent turns
          // are handled natively by server_vad + create_response:true.
          // armedForFirstSpeech stays false (the whole arm-then-fire pattern
          // is case-2-specific now).
          requestResponse(ctx.sideband.state, log)
          log.info({
            event: 'outbound_speak_first',
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

    // Accept — full session config: allowlist tools, persona (case6b or phase2),
    // server_vad + create_response:false, de-DE. Inbound Carsten composes
    // baseline + case_6b_inbound_carsten overlay (retires legacy CASE6B_PERSONA)
    // mirroring outbound Case-2 composition. personaLabel literal 'case6b'
    // preserved byte-identical (log-observer contract unchanged).
    const carstenBaseline = buildBasePersona({
      anrede_form: 'Du',
      counterpart_label: 'Carsten',
      goal: 'Inbound-Anruf von Carsten: Kalender pflegen, Reisezeiten, Recherche delegieren',
      context: 'Inbound-Anruf von Carstens CLI',
      call_direction: 'inbound',
    })
    const carstenInstructions = [
      carstenBaseline,
      buildTaskOverlay('case_6b_inbound_carsten', {}),
    ].join('\n\n')

    const personaLabel =
      callerNumber === CARSTEN_CLI_NUMBER ? 'case6b' : 'phase2'

    // Phase 05.5 Splice B — inbound /accept REASONING_MODE branch (REQ-DIR-19).
    // When the flag is 'container-agent', synchronously call nanoclawMcp.init
    // and use the returned fully-rendered Case-6b persona. On timeout/error
    // fall back to FALLBACK_PERSONA (REQ-VOICE-13 inbound best-effort + REQ-
    // DIR-18 fallback exception). The legacy carstenInstructions / PHASE2_PERSONA
    // composition stays in the else branch — Phase-5 default unchanged.
    //
    // Inbound branch only runs the container-agent path for the Carsten case
    // (case_6b). Non-Carsten callers reaching /accept after whitelist would
    // fall back to PHASE2_PERSONA via the legacy path; in v1 of Phase 05.5,
    // case_6a is not in the schema enum yet, so we keep the legacy path for
    // those.
    let instructions: string
    if (
      REASONING_MODE === 'container-agent' &&
      callerNumber === CARSTEN_CLI_NUMBER
    ) {
      if (!nanoclawMcp) {
        log.error({
          event: 'container_agent_mode_but_client_missing',
          call_id: callId,
        })
        instructions = FALLBACK_PERSONA
      } else {
        try {
          const r = await nanoclawMcp.init({
            call_id: callId,
            case_type: 'case_6b',
            call_direction: 'inbound',
            counterpart_label: 'Carsten',
          })
          instructions = r.instructions
        } catch (err) {
          log.warn({
            event: 'container_agent_init_failed',
            call_id: callId,
            err: (err as Error)?.message,
          })
          instructions = FALLBACK_PERSONA
        }
      }
    } else {
      instructions =
        callerNumber === CARSTEN_CLI_NUMBER ? carstenInstructions : PHASE2_PERSONA
    }

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
    // Per-call MCP session: construct the CoreMcpClient BEFORE router.startCall()
    // so it flows through to openSidebandSession's ws.on('close') finalizer,
    // which calls coreMcp.close() on hangup. Without this, the server-side
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
      // Phase 05.4 Block-5: inbound trace at REQ-INFRA-05 / REQ-VOICE-10
      // path. §201-redaction identical to outbound (audio.delta → delta_bytes
      // count only, no PCM). Matches the unconditional tracing decision from
      // commit d6bf803 now that the path is production-grade.
      const ctx = router.startCall(callId, log, {
        coreMcp,
        // Phase 05.5: pass per-call NanoclawMcpClient so onTranscriptTurn
        // (call-router.ts) can fire the transcript trigger under
        // REASONING_MODE='container-agent'. Stays undefined under default.
        nanoclawMcp,
        traceEventsPath: buildTracePath(callId),
      })
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

      // Fire-and-forget Slow-Brain pre-greet injection (<2000ms budget,
      // fallback to static persona on timeout or no instructions returned;
      // never blocks accept-handler return). Adapt the per-call CoreMcpClient
      // into the CoreClientLike shape slow-brain/pre-greet expect. The result
      // cast to { ok, instructions_update? } mirrors v1's return-shape contract.
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
          // Explicit greet-trigger — OpenAI Realtime stays silent until an
          // event drives a response. After pre-greet finishes (with or without
          // injection), push a response.create so the model emits its opening
          // line based on the (possibly updated) instructions.
          // Plan 05.3-05a D-3: setTimeout removed. Inbound self-greet fires
          // response.create synchronously; the legacy 1000ms audio-path-settle
          // compensation is no longer needed (Sipgate single-leg inbound bridge
          // is fast enough per idle-timeout-finding.md §"Impact on sideband.ts
          // event-handler wiring" — and API-min 5000ms for idle_timeout_ms
          // cannot emulate 1000ms semantics anyway). Native idle_timeout_ms
          // governs POST-first-bot-turn silences (config.ts SESSION_CONFIG).
          requestResponse(ctx.sideband.state, log)
          log.info({
            event: 'greet_response_create_sent',
            call_id: callId,
          })
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
