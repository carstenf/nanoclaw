// voice-bridge/tests/webhook-outbound-voicemail.test.ts
//
// Replaces webhook-case-2-voicemail.test.ts (deleted 2026-04-30 in Step 3
// Phase A2). After voice_start_case_2_call retired (Phase A1) and the
// bridge isCase2Retry-branch removed (Phase A2), every outbound voicemail
// flow goes through voice_outbound_schedule_retry. This file pins that
// invariant.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import type { AmdVoicemailReason } from '../src/amd-classifier.js'
import { buildOutboundOnVoicemailHandler } from '../src/webhook.js'

function makeLog(): {
  log: Logger
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
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
  logWarn: ReturnType<typeof vi.fn>
  handler: (reason: AmdVoicemailReason) => Promise<void>
}

function buildHandler(opts: {
  callToolOverride?: CallToolMock
  casePayloadOverride?: Record<string, unknown>
}): HandlerFixture {
  const callId = 'test_call'
  const { log, warn: logWarn } = makeLog()
  const callToolMock: CallToolMock =
    opts.callToolOverride ?? vi.fn().mockResolvedValue({ ok: true })
  const hangupMock = vi.fn().mockResolvedValue(undefined)
  const setAmdClassifierMock = vi.fn()

  const casePayload = opts.casePayloadOverride ?? {}

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
    logWarn,
    handler,
  }
}

const AMD_REASONS: readonly AmdVoicemailReason[] = [
  'amd_result',
  'cadence_cue',
  'silence_mailbox',
  'transcript_cue',
] as const

describe('webhook onVoicemail — voice_outbound_schedule_retry generic path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  for (const reason of AMD_REASONS) {
    it(`AMD reason '${reason}' → calls voice_outbound_schedule_retry with {call_id, target_phone, prev_outcome='voicemail'}`, async () => {
      const fx = buildHandler({})
      await fx.handler(reason)

      expect(fx.callToolMock).toHaveBeenCalledWith(
        'voice_outbound_schedule_retry',
        expect.objectContaining({
          call_id: 'test_call',
          target_phone: '+491708036426',
          prev_outcome: 'voicemail',
        }),
      )
      // Phase A1/A2 invariant: bridge MUST NOT call the retired case_2 tool.
      const case2Call = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_case_2_schedule_retry',
      )
      expect(case2Call).toBeUndefined()
    })
  }

  it('Hangup is called regardless of retry-tool outcome', async () => {
    const fx = buildHandler({})
    await fx.handler('amd_result')
    expect(fx.hangupMock).toHaveBeenCalledWith('test_call')
  })

  it('Retry-tool rejection is caught + logged; voice_notify_user still fires', async () => {
    const callTool: CallToolMock = vi.fn().mockImplementation((name) => {
      if (name === 'voice_outbound_schedule_retry') {
        return Promise.reject(new Error('mcp boom'))
      }
      return Promise.resolve({ ok: true })
    })
    const fx = buildHandler({ callToolOverride: callTool })
    await fx.handler('amd_result')

    // Warn-log captures the failure
    expect(fx.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'outbound_schedule_retry_failed',
        call_id: 'test_call',
      }),
    )
    // notify_user still fires despite the retry-tool failure
    const notifyCall = fx.callToolMock.mock.calls.find(
      (c) => c[0] === 'voice_notify_user',
    )
    expect(notifyCall).toBeDefined()
  })
})
