// voice-bridge/tests/webhook-outbound-voicemail.test.ts
//
// Replaces webhook-case-2-voicemail.test.ts (deleted 2026-04-30 in Step 3
// Phase A2). After voice_start_case_2_call retired (Phase A1) and the
// bridge isCase2Retry-branch removed (Phase A2), every outbound voicemail
// flow goes through voice_outbound_schedule_retry. This file pins that
// invariant.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from 'pino'
import type {
  AmdEventSnapshot,
  AmdVoicemailReason,
} from '../src/amd-classifier.js'
import {
  buildOutboundOnVoicemailHandler,
  extractVoicemailTranscript,
} from '../src/webhook.js'

const EMPTY_SNAPSHOT: AmdEventSnapshot = { eventLog: [] }
const VM_OPEN_AT_15 = 'Hallo, hier ist die Mailbox von Bella Vista. Wir sind heute ab fuenfzehn Uhr wieder erreichbar. Bitte rufen Sie spaeter an.'
const VM_OPEN_AT_15_SNAPSHOT: AmdEventSnapshot = {
  eventLog: [{ type: 'transcript', text: VM_OPEN_AT_15, at: 1 }],
}

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
  handler: (
    reason: AmdVoicemailReason,
    snapshot?: AmdEventSnapshot,
  ) => Promise<void>
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

  const builtHandler = buildOutboundOnVoicemailHandler({
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
  // Wrap so existing tests can pass just a reason; smart-retry tests pass a
  // populated snapshot to drive the analyze branch.
  const handler = (reason: AmdVoicemailReason, snapshot?: AmdEventSnapshot) =>
    builtHandler(reason, snapshot ?? EMPTY_SNAPSHOT)

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

  // open_points 2026-04-29: smart-retry — voice_analyze_voicemail mines the
  // captured greeting for opening info and overrides the ladder when found.
  describe('smart-retry (voice_analyze_voicemail)', () => {
    it('empty snapshot → no analyze call, ladder retry only', async () => {
      const fx = buildHandler({})
      await fx.handler('amd_result', EMPTY_SNAPSHOT)
      const analyzeCall = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_analyze_voicemail',
      )
      expect(analyzeCall).toBeUndefined()
      const retryCall = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_outbound_schedule_retry',
      )
      expect(retryCall).toBeDefined()
      expect(retryCall?.[1]).not.toHaveProperty('retry_at')
    })

    it('analyzer returns closed_until_iso → schedule_retry called with retry_at = +15min', async () => {
      const callTool: CallToolMock = vi.fn().mockImplementation((name) => {
        if (name === 'voice_analyze_voicemail') {
          return Promise.resolve({
            closed_until_iso: '2026-04-30T15:00:00+02:00',
            closed_today: false,
            raw: 'ab fuenfzehn Uhr wieder erreichbar',
          })
        }
        return Promise.resolve({ ok: true })
      })
      const fx = buildHandler({ callToolOverride: callTool })
      await fx.handler('transcript_cue', VM_OPEN_AT_15_SNAPSHOT)

      const retryCall = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_outbound_schedule_retry',
      )
      expect(retryCall).toBeDefined()
      const retryArgs = retryCall?.[1] as { retry_at?: string }
      expect(retryArgs.retry_at).toBe('2026-04-30T13:15:00.000Z')

      const notifyCall = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_notify_user',
      )
      expect(notifyCall?.[1]).toMatchObject({
        text: expect.stringContaining('Smart-Retry'),
      })
    })

    it('analyzer returns closed_today=true without re-open time → no retry, notify_user "geschlossen"', async () => {
      const callTool: CallToolMock = vi.fn().mockImplementation((name) => {
        if (name === 'voice_analyze_voicemail') {
          return Promise.resolve({
            closed_until_iso: null,
            closed_today: true,
            raw: 'heute geschlossen',
          })
        }
        return Promise.resolve({ ok: true })
      })
      const fx = buildHandler({ callToolOverride: callTool })
      await fx.handler('transcript_cue', VM_OPEN_AT_15_SNAPSHOT)

      const retryCall = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_outbound_schedule_retry',
      )
      expect(retryCall).toBeUndefined()

      const notifyCall = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_notify_user',
      )
      expect(notifyCall?.[1]).toMatchObject({
        text: expect.stringContaining('hat heute geschlossen'),
      })
    })

    it('analyzer rejection → ladder fallback (no retry_at)', async () => {
      const callTool: CallToolMock = vi.fn().mockImplementation((name) => {
        if (name === 'voice_analyze_voicemail') {
          return Promise.reject(new Error('claude_timeout'))
        }
        return Promise.resolve({ ok: true })
      })
      const fx = buildHandler({ callToolOverride: callTool })
      await fx.handler('transcript_cue', VM_OPEN_AT_15_SNAPSHOT)

      // Analyzer was attempted (transcript long enough) and warn-logged
      expect(fx.logWarn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'voicemail_analyzer_failed' }),
      )

      const retryCall = fx.callToolMock.mock.calls.find(
        (c) => c[0] === 'voice_outbound_schedule_retry',
      )
      expect(retryCall).toBeDefined()
      expect(retryCall?.[1]).not.toHaveProperty('retry_at')
    })

    it('extractVoicemailTranscript drops amd_result markers and joins transcript chunks', () => {
      const text = extractVoicemailTranscript({
        eventLog: [
          { type: 'speech_started', at: 1 },
          { type: 'transcript', text: 'Hallo, hier ist die Mailbox', at: 2 },
          { type: 'transcript', text: 'amd_result:voicemail', at: 3 },
          { type: 'transcript', text: 'ab 15 Uhr wieder erreichbar', at: 4 },
          { type: 'audio_delta', bytes: 100, at: 5 },
        ],
      })
      expect(text).toBe(
        'Hallo, hier ist die Mailbox ab 15 Uhr wieder erreichbar',
      )
    })
  })
})
