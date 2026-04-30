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
  buildAudioConfig,
  buildTracePath,
  FALLBACK_PERSONA,
  NANOCLAW_VOICE_MCP_URL,
  NANOCLAW_VOICE_MCP_TOKEN,
  type CallLang,
} from './config.js'
import { getAllowlist, type ToolEntry } from './tools/allowlist.js'
import type { CallRouter } from './call-router.js'
import type { OutboundRouter } from './outbound-router.js'
import { maybeInjectPreGreet } from './pre-greet.js'
import { NanoclawMcpClient } from './nanoclaw-mcp-client.js'
import type { CoreClientLike } from './pre-greet.js'
import { enableAutoResponseCreate, requestResponse, updateInstructions } from './sideband.js'
import {
  checkCostCaps,
  CAP_DAILY_EUR,
  CAP_MONTHLY_EUR,
} from './cost/gate.js'
import { sendDiscordAlert } from './alerts.js'
import {
  OUTBOUND_AMD_CLASSIFIER_PROMPT,
  createAmdClassifier,
  type AmdEventSnapshot,
  type AmdVoicemailReason,
} from './amd-classifier.js'
import { setAmdClassifier } from './tools/dispatch.js'

// ---------------------------------------------------------------------------
// onVoicemail handler factory.
//
// Constructs voice_outbound_schedule_retry tool-call args after AMD verdict
// 'voicemail'. All four AMD classifier reasons ('amd_result' | 'cadence_cue' |
// 'silence_mailbox' | 'transcript_cue') are "picked up but mailbox" variants
// and all map to zod enum 'voicemail'. 'no_answer' / 'busy' fire from outbound-
// router error paths, not here.
// ---------------------------------------------------------------------------

type OutboundOnVoicemailActiveOutbound = {
  task_id: string
  target_phone: string
  /**
   * Step 2D: counterpart_label threaded into voicemail handler so the
   * notify_user message names the right entity ("Voicemail erkannt bei
   * Tante Anke" rather than the case_2-specific "...bei Restaurant ...").
   */
  counterpart_label?: string
  /**
   * open_points 2026-04-29 smart-retry: language of the call so
   * voice_analyze_voicemail can extract opening times with the right system
   * prompt. Defaults to 'de' when undefined.
   */
  lang?: 'de' | 'en' | 'it'
}

type OutboundOnVoicemailCoreClient = {
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>
}

type OutboundOnVoicemailOpenAI = {
  realtime: { calls: { hangup: (callId: string) => Promise<unknown> } }
}

/**
 * Step 2D: renamed from BuildCase2OnVoicemailHandlerParams. The handler now
 * runs for every outbound (Step 2A — AMD always-on), not just case_2.
 */
export interface BuildOutboundOnVoicemailHandlerParams {
  callId: string
  activeOutbound: OutboundOnVoicemailActiveOutbound
  casePayload: Record<string, unknown>
  coreMcpForAmd: OutboundOnVoicemailCoreClient | null
  openai: OutboundOnVoicemailOpenAI
  log: Logger
  setAmdClassifier: (c: null) => void
}

/**
 * Build the AMD onVoicemail callback for any outbound call. Step 2D rename
 * from buildCase2OnVoicemailHandler — Step 2A made AMD universal, so the
 * voicemail path runs for case_2 + generic outbound alike.
 *
 * open_points 2026-04-29 (smart-retry): the AMD classifier now passes the
 * captured eventLog snapshot. We extract the voicemail greeting transcript,
 * call voice_analyze_voicemail to mine opening times, and either:
 *   - smart-retry at the next opening time (closed_until_iso) + 15 min
 *   - skip the retry if the greeting says "closed for the rest of today"
 *   - fall back to the 5/15/45/120 ladder when no actionable info found
 */
export function buildOutboundOnVoicemailHandler(
  params: BuildOutboundOnVoicemailHandlerParams,
): (reason: AmdVoicemailReason, snapshot: AmdEventSnapshot) => Promise<void> {
  const { callId, activeOutbound, casePayload, coreMcpForAmd, openai, log } =
    params

  // All AMD reasons collapse to zod enum 'voicemail'. The _r argument is
  // intentionally unused: the 4-way map is a constant. Future AMD reason
  // codes must be added to AmdVoicemailReason to compile (TS strict
  // enforces review of any expansion).
  const amdReasonToPrevOutcome = (_r: AmdVoicemailReason): 'voicemail' =>
    'voicemail'

  // Step 2D: resolve a non-restaurant-biased label for the notify_user text.
  // counterpart_label (Andy's voice_request_outbound_call arg) wins, then
  // case_2's restaurant_name (legacy compat), finally the masked phone.
  const resolvedLabel = (() => {
    if (
      typeof activeOutbound.counterpart_label === 'string' &&
      activeOutbound.counterpart_label.length > 0
    ) {
      return activeOutbound.counterpart_label
    }
    const restaurantName = casePayload.restaurant_name
    if (typeof restaurantName === 'string' && restaurantName.length > 0) {
      return restaurantName
    }
    return activeOutbound.target_phone
  })()

  return async function onVoicemail(
    reason: AmdVoicemailReason,
    snapshot: AmdEventSnapshot,
  ): Promise<void> {
    const voicemailText = extractVoicemailTranscript(snapshot)
    log.info({
      event: 'case_2_amd_voicemail_verdict',
      call_id: callId,
      reason,
      task_id: activeOutbound.task_id,
      transcript_len: voicemailText.length,
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

    // open_points 2026-04-29 smart-retry: ask Core to mine opening info from
    // the captured greeting. ANALYZE_MIN_LEN guards against IVR beep-only
    // captures or whisper-noise that wouldn't add signal over the ladder.
    let analyzer: {
      closed_until_iso: string | null
      closed_today: boolean
      raw: string
    } = { closed_until_iso: null, closed_today: false, raw: '' }
    if (
      coreMcpForAmd &&
      voicemailText.length >= ANALYZE_MIN_TRANSCRIPT_LEN
    ) {
      try {
        const analyzeRaw = await coreMcpForAmd.callTool(
          'voice_analyze_voicemail',
          {
            call_id: callId,
            transcript: voicemailText,
            lang: activeOutbound.lang ?? 'de',
          },
        )
        const parsed = parseAnalyzerEnvelope(analyzeRaw)
        if (parsed) {
          analyzer = parsed
          log.info({
            event: 'voicemail_analyzer_done',
            call_id: callId,
            closed_until_iso: analyzer.closed_until_iso,
            closed_today: analyzer.closed_today,
            raw_len: analyzer.raw.length,
          })
        }
      } catch (e: unknown) {
        log.warn({
          event: 'voicemail_analyzer_failed',
          call_id: callId,
          err: (e as Error)?.message,
        })
      }
    }

    if (!coreMcpForAmd) {
      params.setAmdClassifier(null)
      return
    }

    const smartRetryAt = analyzer.closed_until_iso
      ? addMinutesIso(analyzer.closed_until_iso, 15)
      : null
    const skipRetry = analyzer.closed_today && !smartRetryAt

    if (skipRetry) {
      // "Closed for the rest of today" without a specific re-open time: drop
      // the ladder and tell Carsten so he can decide whether to re-trigger
      // tomorrow manually.
      try {
        await coreMcpForAmd.callTool('voice_notify_user', {
          urgency: 'info',
          text: `❌ ${resolvedLabel} hat heute geschlossen (Mailbox: "${analyzer.raw || 'no quote'}"). Kein automatischer Retry.`,
          call_id: callId,
        })
      } catch (e: unknown) {
        log.warn({
          event: 'case_2_notify_failed',
          call_id: callId,
          err: (e as Error)?.message,
        })
      }
      params.setAmdClassifier(null)
      return
    }

    try {
      await coreMcpForAmd.callTool('voice_outbound_schedule_retry', {
        call_id: callId,
        target_phone: activeOutbound.target_phone,
        prev_outcome: amdReasonToPrevOutcome(reason),
        ...(smartRetryAt ? { retry_at: smartRetryAt } : {}),
      })
    } catch (e: unknown) {
      log.warn({
        event: 'outbound_schedule_retry_failed',
        call_id: callId,
        err: (e as Error)?.message,
      })
    }

    try {
      const notifyText = smartRetryAt
        ? `🕐 Mailbox bei ${resolvedLabel} sagt: "${analyzer.raw || 'opening info'}". Smart-Retry geplant fuer ${smartRetryAt}.`
        : `Voicemail erkannt bei ${resolvedLabel} (${reason}). Naechster Versuch in Kuerze.`
      await coreMcpForAmd.callTool('voice_notify_user', {
        urgency: 'info',
        text: notifyText,
        call_id: callId,
      })
    } catch (e: unknown) {
      log.warn({
        event: 'case_2_notify_failed',
        call_id: callId,
        err: (e as Error)?.message,
      })
    }

    params.setAmdClassifier(null)
  }
}

/** Min transcript chars before we bother asking the analyzer. */
const ANALYZE_MIN_TRANSCRIPT_LEN = 30

/**
 * Concatenate transcript chunks from the AMD eventLog into one greeting
 * string, dropping the synthetic 'amd_result:<verdict>' marker entries the
 * classifier emits when the model replies via function_call instead of audio.
 */
export function extractVoicemailTranscript(snapshot: AmdEventSnapshot): string {
  const parts: string[] = []
  for (const evt of snapshot.eventLog) {
    if (evt.type !== 'transcript') continue
    if (evt.text.startsWith('amd_result:')) continue
    parts.push(evt.text.trim())
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * voice_analyze_voicemail returns either:
 *   - the bare result object (NanoclawMcpClient._extractResult unwraps the
 *     {ok, result} envelope on success), OR
 *   - the {ok:false, error} envelope on Sonnet failure.
 * Walk both shapes defensively; on anything unexpected return null so the
 * caller falls back to the ladder.
 */
function parseAnalyzerEnvelope(
  raw: unknown,
): { closed_until_iso: string | null; closed_today: boolean; raw: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  // Direct shape (post-extractResult unwrap).
  if ('closed_until_iso' in obj || 'closed_today' in obj || 'raw' in obj) {
    return {
      closed_until_iso:
        typeof obj.closed_until_iso === 'string' && obj.closed_until_iso.length > 0
          ? obj.closed_until_iso
          : null,
      closed_today: obj.closed_today === true,
      raw: typeof obj.raw === 'string' ? obj.raw : '',
    }
  }
  // Fallback: legacy {ok:true, result:{...}} envelope.
  if (obj.ok === true && obj.result && typeof obj.result === 'object') {
    return parseAnalyzerEnvelope(obj.result)
  }
  return null
}

function addMinutesIso(iso: string, minutes: number): string | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return new Date(t + minutes * 60_000).toISOString()
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

      // §201-StGB invariant (open_points 2026-04-28 Step 2A — AMD always-on):
      // EVERY outbound call routes through the AMD classifier prompt at
      // /accept. Pre-Step-2A this gate fired only for case_type='case_2',
      // which left voice_request_outbound_call (Andy's unified outbound
      // entry that ships no case_type) unprotected — the model entered
      // speak-first mode and could narrate into a voicemail box. Step 2A
      // closes that hole by treating every outbound as needing AMD before
      // any bot-audio is allowed; the persona swap fires after onHuman.

      // Honor per-call override envelope (Spike-A / Wave 3):
      //   persona_override — use verbatim as the post-AMD persona
      //   tools_override   — REPLACE the default allowlist for THIS call only
      // amd_result is appended unconditionally (non-negotiable AMD invariant).
      const hasPersonaOverride =
        typeof activeOutbound.persona_override === 'string' &&
        activeOutbound.persona_override.length > 0
      const hasToolsOverride =
        Array.isArray(activeOutbound.tools_override) &&
        activeOutbound.tools_override.length > 0

      // ctxRef is populated after router.startCall() and read by the onHuman
      // closure to push the post-AMD persona via session.update.
      let ctxRef: { sideband: { state: Parameters<typeof updateInstructions>[0] } } | null = null

      // Initial /accept instructions = AMD classifier prompt for ALL outbound.
      const outboundInstructions: string = OUTBOUND_AMD_CLASSIFIER_PROMPT

      // Pre-render the post-AMD persona. Step 2B unified path: every outbound
      // renders a baseline-only persona via the voice-personas skill (the
      // case-2 restaurant overlay was deleted; the generic outbound persona
      // is the baseline addressing `counterpart_label` with the goal text
      // Andy supplied). Source priority:
      //   1. nanoclawMcp.init render → baseline-only outbound persona.
      //   2. persona_override (legacy Spike-A / Wave 3) → wins over render
      //      when explicitly supplied; preserved for tests + backward compat.
      //   3. render failure or no MCP client → FALLBACK_PERSONA (REQ-DIR-18).
      // counterpart_label resolution: top-level activeOutbound.counterpart_label
      // first (Andy's voice_request_outbound_call arg), then case_2 legacy
      // restaurant_name in case_payload, finally 'Counterpart'.
      const resolvedCounterpartLabel = String(
        activeOutbound.counterpart_label ??
          (activeOutbound.case_payload?.restaurant_name as string | undefined) ??
          'Counterpart',
      )
      // Step 2B+ (post-Test-4 retry): no FALLBACK_PERSONA on outbound. If the
      // skill renderer can't produce a persona, the call is rejected with a
      // notify-user error — Carsten said "wenn die persona nicht durchkommt:
      // kein Call und Fehlermeldung". Better explicit failure than a half-
      // baked generic bot that hallucinates "wie kann ich Ihnen bei Ihrer
      // Reservierung helfen".
      let postAmdPersona: string | null = null
      let personaFailureReason: string | null = null
      if (hasPersonaOverride) {
        postAmdPersona = activeOutbound.persona_override as string
      } else if (!nanoclawMcp) {
        // Config-time fallback: NANOCLAW_VOICE_MCP_URL not set at startup.
        // Treated as deploy misconfiguration rather than runtime failure;
        // accept the call with FALLBACK_PERSONA so the operator sees a
        // bot-greeting + can debug. Tests rely on this branch (acceptIncoming
        // doesn't inject nanoclawMcp). Runtime init failures (next branch)
        // still hard-reject.
        log.error({
          event: 'container_agent_mode_but_client_missing',
          call_id: callId,
        })
        postAmdPersona = FALLBACK_PERSONA
      } else {
        // case_type passed as 'case_2' for any outbound (the only outbound
        // case in v1; the overlay file is gone so render is baseline-only
        // regardless of case_type). Step 3 will rename the enum value to
        // 'case_outbound' once the migration cycle is past the live PASS gate.
        const initCaseType: 'case_2' = 'case_2'
        try {
          const r = await nanoclawMcp.init({
            call_id: callId,
            case_type: initCaseType,
            call_direction: 'outbound',
            counterpart_label: resolvedCounterpartLabel,
            ...(activeOutbound.lang ? { lang: activeOutbound.lang } : {}),
            ...(activeOutbound.goal && activeOutbound.goal.length > 0
              ? { goal: activeOutbound.goal }
              : {}),
            ...(activeOutbound.lang_whitelist && activeOutbound.lang_whitelist.length > 0
              ? { lang_whitelist: activeOutbound.lang_whitelist }
              : {}),
          })
          postAmdPersona = r.instructions
        } catch (err) {
          log.warn({
            event: 'container_agent_init_failed',
            call_id: callId,
            case_type: initCaseType,
            err: (err as Error)?.message,
          })
          personaFailureReason = (err as Error)?.message ?? 'render_failed'
        }
      }

      // No persona → reject the OpenAI Realtime call + notify Andy via a
      // fresh per-call NanoclawMcpClient. Belt-and-suspenders: the
      // outbound-webhook persona pre-check should have already caught the
      // failure before originate, so this branch only fires for race-window
      // failures (MCP died between pre-check and /accept).
      if (postAmdPersona === null) {
        log.error({
          event: 'outbound_rejected_no_persona',
          call_id: callId,
          task_id: activeOutbound.task_id,
          reason: personaFailureReason,
        })
        try {
          await openai.realtime.calls.reject(callId, { type: 'realtime' } as never)
        } catch (e: unknown) {
          log.warn({
            event: 'outbound_reject_failed',
            call_id: callId,
            err: (e as Error)?.message,
          })
        }
        const notifyClient = NANOCLAW_VOICE_MCP_URL
          ? new NanoclawMcpClient({
              url: new URL(NANOCLAW_VOICE_MCP_URL),
              bearer: NANOCLAW_VOICE_MCP_TOKEN,
            })
          : null
        if (notifyClient) {
          try {
            await notifyClient.callTool('voice_notify_user', {
              urgency: 'alert',
              text: `Outbound an ${resolvedCounterpartLabel} (${activeOutbound.target_phone}) abgebrochen — Persona-Render fehlgeschlagen (${personaFailureReason ?? 'unknown'}). Bitte NanoClaw-Service pruefen + manuell wiederholen.`,
              call_id: callId,
            })
          } catch (e: unknown) {
            log.warn({
              event: 'outbound_no_persona_notify_failed',
              call_id: callId,
              err: (e as Error)?.message,
            })
          } finally {
            await notifyClient.close().catch(() => {})
          }
        }
        // Mark task done so the queue advances. Reuse onCallEnd with a
        // synthetic 'persona_render_failed' reason — router preserves
        // task.error for reportBack.
        await outboundRouter?.onCallEnd?.(activeOutbound.task_id, 'persona_render_failed').catch(
          () => {},
        )
        return reply.code(200).send({ ok: false, reason: 'persona_render_failed' })
      }

      // Outbound tool list: base allowlist minus 3 Case-6-specific tools that
      // make no sense for an outbound bot, plus amd_result. tools_override (if
      // supplied) replaces the allowlist; amd_result is still appended.
      const OUTBOUND_EXCLUDED = new Set(['voice_search_competitors', 'voice_get_practice_profile', 'voice_get_contract', 'search_competitors', 'get_practice_profile', 'get_contract'])
      const baseTools = hasToolsOverride
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
        : getAllowlist()
            .filter((e: ToolEntry) => !OUTBOUND_EXCLUDED.has(e.name))
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
      const toolsPayloadOut: Array<{ type: 'function'; name: string; description?: string; parameters: Record<string, unknown> }> = [...baseTools, amdResultTool]

      // Register AMD classifier for this call so dispatch.ts can route amd_result.
      const casePayload = (activeOutbound.case_payload ?? {}) as Record<string, unknown>
      const coreMcpForAmd = NANOCLAW_VOICE_MCP_URL
        ? new NanoclawMcpClient({
            url: new URL(NANOCLAW_VOICE_MCP_URL),
            bearer: NANOCLAW_VOICE_MCP_TOKEN,
          })
        : null

      const classifier = createAmdClassifier({
        callId,
        log,
        onHuman: () => {
          // Verdict: human — swap to the persona pre-rendered at /accept.
          // postAmdPersona is sourced per the priority list above and
          // guaranteed to be a valid persona string (FALLBACK_PERSONA worst-
          // case per REQ-DIR-18).
          const persona = postAmdPersona
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
              // `persona` is the pre-rendered case_2 outbound persona from
              // voice-personas skill (REQ-DIR-13: single SoT in nanoclaw).
              updateInstructions(ctxRef.sideband.state, persona, log)

              // Plan 05.1-01 Task 3 invariant: synthetic user-directive between
              // updateInstructions and the synchronous requestResponse on
              // AMD-handoff. Breaks the conversational context inherited from
              // OUTBOUND_AMD_CLASSIFIER_PROMPT — without this, the model may
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
          // buildOutboundOnVoicemailHandler + webhook-case-2-voicemail.test.ts.
          onVoicemail: buildOutboundOnVoicemailHandler({
            callId,
            activeOutbound: {
              task_id: activeOutbound.task_id,
              target_phone: activeOutbound.target_phone,
              counterpart_label: activeOutbound.counterpart_label,
              lang: activeOutbound.lang,
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
        case_type: activeOutbound.case_type ?? null,
        // persona_source reflects which branch produced postAmdPersona.
        // post-Test-4-retry: 'fallback' branch removed — render failure now
        // rejects the call entirely instead of serving FALLBACK_PERSONA.
        persona_source: hasPersonaOverride ? 'persona_override' : 'skill_render',
        counterpart_label: resolvedCounterpartLabel,
        // Step 2B+ multilingual diagnostics: surface what Andy supplied at
        // the boundary so missed lang/goal plumbing is visible in logs.
        lang: activeOutbound.lang ?? null,
        goal_present: Boolean(activeOutbound.goal && activeOutbound.goal.length > 0),
        goal_len: activeOutbound.goal?.length ?? 0,
        tools_count: toolsPayloadOut.length,
        tools_override: hasToolsOverride,
      })

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
      const callLang: CallLang = (activeOutbound.lang ?? 'de') as CallLang
      // §201 invariant (Step 2A): every outbound is AMD-gated. Param name
      // still reads `outboundAmdGate` until the Step 3 cleanup rename pass.
      const audioForAccept = buildAudioConfig(callLang, { outboundAmdGate: true })
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
          // Per-call NanoclawMcpClient so onTranscriptTurn (call-router.ts)
          // can fire the transcript trigger to the voice-personas skill.
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
          persona_selected: 'outbound_amd',
          outbound_task_id: activeOutbound.task_id,
        })
        // Step 2A — AMD always-on: NO proactive requestResponse for any
        // outbound. The AMD classifier prompt is in scope; the onHuman
        // closure fires response.create + flips create_response:true post
        // verdict. Wire ctxRef so the closure reaches sideband. The legacy
        // speak-first else-branch (Case-6b outbound) is dead since /accept
        // now always pushes OUTBOUND_AMD_CLASSIFIER_PROMPT — proactive
        // requestResponse would either be silenced by the detection-mode
        // prompt or break it.
        ctxRef = ctx
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

    // Inbound /accept — render persona via nanoclawMcp.init (REQ-DIR-13:
    // voice-personas skill in nanoclaw is the single SoT). Carsten → case_6b.
    // Non-Carsten callers reaching /accept after whitelist (case_6a not yet
    // wired) fall through to FALLBACK_PERSONA (REQ-DIR-18). On nanoclaw
    // render failure → FALLBACK_PERSONA (REQ-VOICE-13 inbound best-effort).
    const personaLabel =
      callerNumber === CARSTEN_CLI_NUMBER ? 'case6b' : 'fallback'

    let instructions: string
    if (callerNumber === CARSTEN_CLI_NUMBER) {
      if (!nanoclawMcp) {
        log.error({
          event: 'container_agent_mode_but_client_missing',
          call_id: callId,
        })
        instructions = FALLBACK_PERSONA
      } else {
        // open_points 2026-04-27 #1: fire-and-forget pre-warm. Runs in
        // parallel to nanoclawMcp.init() so the persona render's 3 ms is
        // not delayed by the wake-up's MCP round-trip. By the time the
        // bot finishes greeting Carsten and his first ask_core fires
        // (~5-10 s later), the main container is up + idle-waiting.
        // Failure is non-fatal — voice path still works, the next
        // ask_core just pays cold-spawn latency if needed.
        nanoclawMcp
          .wakeUp({ call_id: callId, reason: 'inbound' })
          .then((r) => {
            log.info({
              event: 'voice_wake_up_dispatched',
              call_id: callId,
              status: r.status,
            })
          })
          .catch((err) => {
            log.warn({
              event: 'voice_wake_up_failed',
              call_id: callId,
              err: (err as Error)?.message,
            })
          })
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
            case_type: 'case_6b',
            err: (err as Error)?.message,
          })
          instructions = FALLBACK_PERSONA
        }
      }
    } else {
      instructions = FALLBACK_PERSONA
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
    // Per-call MCP session: construct the NanoclawMcpClient BEFORE router.startCall()
    // so it flows through to openSidebandSession's ws.on('close') finalizer,
    // which calls coreMcp.close() on hangup. Without this, the server-side
    // sessions Map leaks one session per call. Transport points at the
    // nanoclaw-voice MCP server (port 3201) — see core-mcp-client.ts header.
    const coreMcp = NANOCLAW_VOICE_MCP_URL
      ? new NanoclawMcpClient({
          url: new URL(NANOCLAW_VOICE_MCP_URL),
          bearer: NANOCLAW_VOICE_MCP_TOKEN,
        })
      : undefined
    try {
      // Inbound is currently Carsten-only (case_6b) → DE always. Routed
      // through buildAudioConfig for symmetry; future case_6a (non-Carsten
      // inbound) can pass a different lang here once detected.
      await openai.realtime.calls.accept(callId, {
        type: 'realtime',
        model: SESSION_CONFIG.model,
        instructions,
        tools: toolsPayload,
        audio: buildAudioConfig('de'),
      } as unknown as Parameters<typeof openai.realtime.calls.accept>[1])
      // Phase 05.4 Block-5: inbound trace at REQ-INFRA-05 / REQ-VOICE-10
      // path. §201-redaction identical to outbound (audio.delta → delta_bytes
      // count only, no PCM). Matches the unconditional tracing decision from
      // commit d6bf803 now that the path is production-grade.
      const ctx = router.startCall(callId, log, {
        coreMcp,
        // Per-call NanoclawMcpClient so onTranscriptTurn (call-router.ts)
        // can fire the transcript trigger to the voice-personas skill.
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

      // Fire-and-forget pre-greet injection (<2000ms budget, fallback to
      // FALLBACK_PERSONA on timeout or no instructions returned; never blocks
      // accept-handler return). Adapt the per-call NanoclawMcpClient into the
      // CoreClientLike shape pre-greet expects.
      const coreClient: CoreClientLike = coreMcp
        ? {
            callTool: async (name, args, o) =>
              (await coreMcp.callTool(name, args, {
                timeoutMs: o?.timeoutMs,
                signal: o?.signal,
              })) as { ok: boolean; instructions_update?: string | null },
          }
        : {
            // If NANOCLAW_VOICE_MCP_URL is unset (dev/test), pre-greet becomes
            // a no-op — callTool throws, maybeInjectPreGreet catches and logs
            // `core_call_failed`.
            callTool: async () => {
              throw new Error('core-mcp: NANOCLAW_VOICE_MCP_URL not configured')
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
