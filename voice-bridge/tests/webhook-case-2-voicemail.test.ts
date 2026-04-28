// voice-bridge/tests/webhook-case-2-voicemail.test.ts
// Plan 05.1-03 Task 1 (RED): integration tests for onVoicemail arg construction.
//
// Validates that webhook.ts's Case-2 onVoicemail handler constructs the correct
// voice_case_2_schedule_retry tool-call arg shape — the one that matches the zod
// schema at src/mcp-tools/voice-case-2-retry.ts:36-44. Defect #4 (Plan 05.1
// RESEARCH §4): current code sends {task_id, target_phone, case_payload,
// prev_outcome} where prev_outcome is the AMD reason enum — zod rejects with
// -32602 every time.
//
// All four AMD classifier reasons (amd_result | cadence_cue | silence_mailbox |
// transcript_cue) map to prev_outcome='voicemail' (RESEARCH §4.3).
//
// Approach: Task 2 GREEN extracts the onVoicemail closure into an exported
// factory function `buildOutboundOnVoicemailHandler` from webhook.ts so it is
// unit-testable. This test file imports that factory; before GREEN lands it
// does not exist, so the import failure is the RED gate.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { AmdVoicemailReason } from '../src/amd-classifier.js'
import { buildOutboundOnVoicemailHandler } from '../src/webhook.js'

// ---- zod schema replica ----------------------------------------------------
// Keep in sync with src/mcp-tools/voice-case-2-retry.ts:36-44.
// Replicated here because voice-bridge does not cross-import from the Core tree
// (that tree depends on better-sqlite3 and would pull unrelated infra into the
// bridge test graph). The purpose of this replica is the client↔server contract
// check in Test 2 (safeParse). If the Core schema changes, this replica must
// move with it.
const VoiceCase2ScheduleRetrySchema = z.object({
  call_id: z.string().optional(),
  target_phone: z.string().regex(/^\+[1-9]\d{1,14}$/, 'target_phone must be E.164'),
  calendar_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'calendar_date must be YYYY-MM-DD'),
  prev_outcome: z.enum(['no_answer', 'busy', 'voicemail', 'out_of_tolerance']).optional(),
  idempotency_key: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/, 'idempotency_key must be 64 lowercase hex chars'),
})

// ---- harness ---------------------------------------------------------------
function makeLog(): { log: Logger; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  const info = vi.fn()
  const warn = vi.fn()
  const log = {
    info,
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: 'info',
  } as unknown as Logger
  return { log, info, warn }
}

type CallToolMock = ReturnType<typeof vi.fn>

interface HandlerFixture {
  callId: string
  callToolMock: CallToolMock
  hangupMock: ReturnType<typeof vi.fn>
  setAmdClassifierMock: ReturnType<typeof vi.fn>
  log: Logger
  logInfo: ReturnType<typeof vi.fn>
  logWarn: ReturnType<typeof vi.fn>
  handler: (reason: AmdVoicemailReason) => Promise<void>
}

function buildHandler(opts: {
  callToolOverride?: CallToolMock
  casePayloadOverride?: Record<string, unknown>
}): HandlerFixture {
  const callId = 'test_call'
  const { log, info: logInfo, warn: logWarn } = makeLog()
  const callToolMock: CallToolMock =
    opts.callToolOverride ?? vi.fn().mockResolvedValue({ ok: true })
  const hangupMock = vi.fn().mockResolvedValue(undefined)
  const setAmdClassifierMock = vi.fn()

  const defaultPayload: Record<string, unknown> = {
    requested_date: '2026-04-21',
    idempotency_key: 'a'.repeat(64),
    restaurant_name: 'Test Restaurant',
    requested_time: '19:00',
    party_size: 2,
  }
  const casePayload = opts.casePayloadOverride ?? defaultPayload

  const activeOutbound = {
    task_id: 'task_001',
    target_phone: '+491708036426',
  }

  const coreMcpForAmd = {
    callTool: callToolMock as unknown as (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
  }

  const openai = {
    realtime: { calls: { hangup: hangupMock } },
  } as unknown as Parameters<typeof buildOutboundOnVoicemailHandler>[0]['openai']

  const handler = buildOutboundOnVoicemailHandler({
    callId,
    activeOutbound,
    casePayload,
    coreMcpForAmd: coreMcpForAmd as unknown as Parameters<
      typeof buildOutboundOnVoicemailHandler
    >[0]['coreMcpForAmd'],
    openai,
    log,
    setAmdClassifier: setAmdClassifierMock,
  })

  return {
    callId,
    callToolMock,
    hangupMock,
    setAmdClassifierMock,
    log,
    logInfo,
    logWarn,
    handler,
  }
}

// ---- tests -----------------------------------------------------------------

const AMD_REASONS: readonly AmdVoicemailReason[] = [
  'amd_result',
  'cadence_cue',
  'silence_mailbox',
  'transcript_cue',
] as const

describe('webhook onVoicemail — voice_case_2_schedule_retry arg construction (Defect #4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Test 1 — parameterized across the 4 AMD reason codes
  for (const reason of AMD_REASONS) {
    it(`test 1 [${reason}]: calls voice_case_2_schedule_retry with {call_id, target_phone, calendar_date, prev_outcome='voicemail', idempotency_key}`, async () => {
      const fx = buildHandler({})
      await fx.handler(reason)

      expect(fx.callToolMock).toHaveBeenCalledWith(
        'voice_case_2_schedule_retry',
        expect.objectContaining({
          call_id: 'test_call',
          target_phone: '+491708036426',
          calendar_date: '2026-04-21',
          prev_outcome: 'voicemail',
          idempotency_key: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      )
      // buggy shape MUST NOT appear
      const retryCall = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_case_2_schedule_retry',
      )
      expect(retryCall?.[1]).not.toHaveProperty('task_id')
      expect(retryCall?.[1]).not.toHaveProperty('case_payload')
      expect(retryCall?.[1]?.prev_outcome).not.toBe(reason)
    })
  }

  // Test 2 — zod contract: constructed args parse successfully against the
  // authoritative schema from src/mcp-tools/voice-case-2-retry.ts.
  for (const reason of AMD_REASONS) {
    it(`test 2 [${reason}]: constructed args pass VoiceCase2ScheduleRetrySchema.safeParse`, async () => {
      const fx = buildHandler({})
      await fx.handler(reason)

      const retryCall = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_case_2_schedule_retry',
      )
      expect(retryCall).toBeDefined()
      const args = retryCall![1]
      const parseResult = VoiceCase2ScheduleRetrySchema.safeParse(args)
      if (!parseResult.success) {
        // Surface exact zod issues for debugging
        throw new Error(
          `zod rejected args for reason=${reason}: ${JSON.stringify(parseResult.error.issues)}`,
        )
      }
      expect(parseResult.success).toBe(true)
    })
  }

  // Test 3 — regression: voice_notify_user still fires after retry
  it('test 3: voice_notify_user is invoked after voice_case_2_schedule_retry (regression guard)', async () => {
    const fx = buildHandler({})
    await fx.handler('amd_result')

    expect(fx.callToolMock).toHaveBeenCalledWith(
      'voice_notify_user',
      expect.objectContaining({ urgency: 'info', call_id: 'test_call' }),
    )
  })

  // Test 4 — error resilience: retry rejection is caught and logged; notify
  // still fires. This mirrors the current webhook.ts behavior (try/catch per
  // call, sequential dispatch).
  it('test 4: voice_case_2_schedule_retry rejection is caught + logged; voice_notify_user still fires', async () => {
    const callTool = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'voice_case_2_schedule_retry') throw new Error('network')
      return { ok: true }
    })
    const fx = buildHandler({ callToolOverride: callTool })
    await fx.handler('amd_result')

    // retry failure was logged
    expect(fx.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'case_2_schedule_retry_failed',
        call_id: 'test_call',
      }),
    )
    // notify STILL fired despite retry failure
    expect(fx.callToolMock).toHaveBeenCalledWith(
      'voice_notify_user',
      expect.objectContaining({ urgency: 'info' }),
    )
  })

  // Test 5 — fail-fast: missing required zod fields in casePayload.
  // Sending an empty idempotency_key would fail zod .length(64).regex(/^[0-9a-f]{64}$/)
  // at Core with the exact -32602 symptom this plan fixes. Fail-fast at Bridge
  // is the only correct behavior; the retry is orphaned but observable via log.
  it('test 5a: missing casePayload.idempotency_key → skip retry; log case_2_schedule_retry_missing_fields', async () => {
    const fx = buildHandler({
      casePayloadOverride: {
        requested_date: '2026-04-21',
        // idempotency_key intentionally absent
        restaurant_name: 'Test Restaurant',
      },
    })
    await fx.handler('amd_result')

    // Step 2C: case_2 retry NOT called (missing idempotency_key) — instead
    // voice_outbound_schedule_retry kicks in for the generic path.
    const case2RetryCalls = fx.callToolMock.mock.calls.filter(
      (c) => c[0] === 'voice_case_2_schedule_retry',
    )
    expect(case2RetryCalls).toHaveLength(0)
    const outboundRetryCalls = fx.callToolMock.mock.calls.filter(
      (c) => c[0] === 'voice_outbound_schedule_retry',
    )
    expect(outboundRetryCalls).toHaveLength(1)
    const args = outboundRetryCalls[0][1] as Record<string, unknown>
    expect(args.target_phone).toBe('+491708036426')
    expect(args.prev_outcome).toBe('voicemail')
  })

  it('test 5b: missing casePayload.requested_date → falls back to voice_outbound_schedule_retry (Step 2C)', async () => {
    const fx = buildHandler({
      casePayloadOverride: {
        // requested_date intentionally absent
        idempotency_key: 'a'.repeat(64),
        restaurant_name: 'Test Restaurant',
      },
    })
    await fx.handler('cadence_cue')

    const case2RetryCalls = fx.callToolMock.mock.calls.filter(
      (c) => c[0] === 'voice_case_2_schedule_retry',
    )
    expect(case2RetryCalls).toHaveLength(0)
    const outboundRetryCalls = fx.callToolMock.mock.calls.filter(
      (c) => c[0] === 'voice_outbound_schedule_retry',
    )
    expect(outboundRetryCalls).toHaveLength(1)
  })

  it('test 5c: empty-string idempotency_key is treated as missing → voice_outbound_schedule_retry (Step 2C)', async () => {
    const fx = buildHandler({
      casePayloadOverride: {
        requested_date: '2026-04-21',
        idempotency_key: '',
        restaurant_name: 'Test Restaurant',
      },
    })
    await fx.handler('silence_mailbox')

    const case2RetryCalls = fx.callToolMock.mock.calls.filter(
      (c) => c[0] === 'voice_case_2_schedule_retry',
    )
    expect(case2RetryCalls).toHaveLength(0)
    const outboundRetryCalls = fx.callToolMock.mock.calls.filter(
      (c) => c[0] === 'voice_outbound_schedule_retry',
    )
    expect(outboundRetryCalls).toHaveLength(1)
  })
})
