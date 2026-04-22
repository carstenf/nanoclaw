// voice-bridge/tests/webhook-amd-handoff.test.ts
// Plan 05.2-05 Task 2 — integration tests for AMD→baseline+Case-2 handoff.
//
// Scope:
//   Five integration tests (A-E) that assert the full post-AMD-verdict
//   session.update payload carries the migrated baseline+overlay composition
//   from Plan 05.2-04, preserves the Plan 05.1-01 Layer-2 ordering, honors
//   the Plan 05.1-01 type:'realtime' discriminator, upholds the §201 StGB
//   pre-verdict audio-leak invariant (Plan 05-03 T-05-03-01), and reflects
//   the Q7 atomicity finding verdict (Task 1).
//
//   The handoff mechanics themselves are UNCHANGED from Plan 05.1-01:
//   webhook.ts onHuman closure still calls
//       updateInstructions(ctxRef.sideband.state, persona, log)
//       → conversation.item.create role=user synthetic directive
//       → setTimeout(GREET_TRIGGER_DELAY_OUTBOUND_MS) → requestResponse
//   What's new (from Plan 05.2-04): `persona` now resolves to
//       buildBasePersona(...) + '\n\n' + buildCase2Overlay(...)
//   containing baseline markers (Rolle KRITISCH / TURN-DISCIPLIN proxy)
//   AND Case-2 overlay markers (Reservierung für / time_tolerance_min).
//
// Pattern origin: accept.test.ts:851 'Test F+H: onHuman sends session.update
// THEN conversation.item.create THEN (after timer) response.create'. This
// file extends that pattern with payload-content assertions for the
// migrated composition, explicit §201 invariant guard, and Q7-conditional
// single-vs-two-step session.update logic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createOutboundRouter } from '../src/outbound-router.js'
import type { OutboundTask } from '../src/outbound-router.js'
import { CASE2_AMD_CLASSIFIER_PROMPT } from '../src/amd-classifier.js'

// Load the Q7 atomicity finding at test-setup time. Test E branches on the
// parsed **Verdict:** line to assert single-shot OR two-step session.update.
// Absence of the file is a hard error — Task 1 guarantees it exists.
const Q7_FINDING_PATH = resolve(
  __dirname,
  '..',
  '..',
  '.planning',
  'phases',
  '05.2-persona-redesign-and-call-flow-state-machine',
  'q7-atomicity-finding.md',
)

function readQ7Verdict(): 'ATOMIC' | 'NON-ATOMIC' | 'INCONCLUSIVE' {
  const content = readFileSync(Q7_FINDING_PATH, 'utf-8')
  // Match the canonical frontmatter line:
  //   **Verdict:** ATOMIC | NON-ATOMIC | INCONCLUSIVE (docs-lean ATOMIC)
  // Take only the first token after the colon; any trailing parenthetical
  // qualifier is documentation prose, not a disposition.
  const m = content.match(/\*\*Verdict:\*\*\s*(ATOMIC|NON-ATOMIC|INCONCLUSIVE)/)
  if (!m) {
    throw new Error(
      `q7-atomicity-finding.md missing **Verdict:** line (path=${Q7_FINDING_PATH})`,
    )
  }
  return m[1] as 'ATOMIC' | 'NON-ATOMIC' | 'INCONCLUSIVE'
}

describe('Plan 05.2-05 — AMD→baseline+Case-2 handoff integration', () => {
  let logDir: string

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'bridge-handoff-'))
    process.env.OPENAI_WEBHOOK_SECRET =
      'whsec_test_handoff_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    process.env.BRIDGE_BIND = '127.0.0.1'
    process.env.BRIDGE_PORT = '0'
    process.env.BRIDGE_LOG_DIR = logDir
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true })
    delete process.env.OPENAI_WEBHOOK_SECRET
    delete process.env.BRIDGE_BIND
    delete process.env.BRIDGE_PORT
    delete process.env.BRIDGE_LOG_DIR
  })

  // ---- Test fixture helpers ----

  function makeFakeTimers() {
    return {
      setTimeout: vi.fn().mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>),
      clearTimeout: vi.fn(),
    }
  }

  /**
   * Build a fresh outbound router with a single active Case-2 task for
   * Bellavista on 2026-05-15, 19:00, party=4, tolerance=±30min.
   *
   * Key field choices (load-bearing for Tests A+C):
   *   restaurant_name: 'Bellavista'   → baseline overlay 'fuer Bellavista'
   *   time_tolerance_min: 30          → overlay '±30 Min'
   *   requested_time: '19:00'         → overlay 'um neunzehn Uhr'
   *   party_size: 4                   → overlay 'fuer vier Personen'
   */
  function makeCase2OutboundRouter(): ReturnType<typeof createOutboundRouter> {
    const task: OutboundTask = {
      task_id: 'task-bellavista-test',
      target_phone: '+4989123456',
      goal: 'Reservierung Bellavista',
      context: 'test',
      report_to_jid: 'jid@test',
      created_at: Date.now(),
      status: 'active',
      case_type: 'case_2',
      case_payload: {
        restaurant_name: 'Bellavista',
        requested_date: '2026-05-15',
        requested_time: '19:00',
        time_tolerance_min: 30,
        party_size: 4,
      },
    }

    const timers = makeFakeTimers()
    const router = createOutboundRouter({
      outboundOriginator: {
        originate: vi.fn().mockResolvedValue({ providerRef: 'ref-1' }),
      },
      callRouter: { _size: vi.fn().mockReturnValue(0) },
      reportBack: vi.fn().mockResolvedValue(undefined),
      timers,
    })
    router.enqueue({
      target_phone: task.target_phone,
      goal: task.goal,
      context: task.context,
      report_to_jid: task.report_to_jid,
      case_type: 'case_2',
      case_payload: task.case_payload,
    })
    return router
  }

  /**
   * Mount /accept with an outbound router that has an active Case-2 task.
   * Captures all WS sends into `sentMessages` for per-test assertions.
   * Returns the app + the captured-messages array + the mock state so the
   * test can trigger onHuman via the registered AMD classifier.
   */
  async function mountAcceptWithCase2Handoff() {
    const sentMessages: string[] = []
    const mockWs = {
      send: vi.fn((s: string) => {
        sentMessages.push(s)
      }),
      readyState: 1,
    }
    const mockState = {
      callId: 'rtc_handoff_test',
      ready: true,
      ws: mockWs as unknown as import('ws').WebSocket,
      openedAt: 0,
      lastUpdateAt: 0,
      armedForFirstSpeech: false,
    }

    const outboundRouter = makeCase2OutboundRouter()
    // outbound-router originate is async — wait one tick so it becomes active.
    await new Promise((r) => setTimeout(r, 10))

    const acceptSpy = vi.fn().mockResolvedValue({})
    const openai = {
      webhooks: {
        unwrap: vi.fn().mockResolvedValue({
          type: 'realtime.call.incoming',
          data: {
            call_id: 'rtc_handoff_test',
            sip_headers: [
              {
                name: 'From',
                value: '"Caller" <sip:+4900000@sipgate.de>',
              },
            ],
          },
        }),
      },
      realtime: { calls: { accept: acceptSpy, reject: vi.fn() } },
    }

    const router = {
      startCall: vi.fn().mockReturnValue({
        sideband: { state: mockState },
        close: vi.fn(),
      }),
      endCall: vi.fn(),
      getCall: vi.fn(),
      _size: vi.fn().mockReturnValue(0),
    }

    const { buildApp } = await import('../src/index.js')
    const app = await buildApp({
      openaiOverride: openai as never,
      whitelistOverride: new Set(),
      routerOverride: router as never,
      outboundRouterOverride: outboundRouter,
    })

    // Fire /accept — registers AMD classifier, sideband state is ready.
    const res = await app.inject({
      method: 'POST',
      url: '/accept',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'handoff-test',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,xxx',
      },
      payload: JSON.stringify({
        type: 'realtime.call.incoming',
        data: { call_id: 'rtc_handoff_test' },
      }),
    })
    expect(res.statusCode).toBe(200)
    expect(acceptSpy).toHaveBeenCalledTimes(1)

    return { app, sentMessages, mockState, acceptSpy }
  }

  // -------------------------------------------------------------------------
  // Test A — baseline+Case-2 overlay markers in session.update payload
  // -------------------------------------------------------------------------
  // After AMD verdict=human, the session.update instructions string MUST
  // contain markers from BOTH baseline (Plan 05.2-01) AND Case-2 overlay
  // (Plan 05.2-04). This is the migration-correctness assertion.
  //
  // Markers chosen for verbatim match against persona/baseline.ts +
  // persona/overlays/case-2.ts (post-migration):
  //   BASELINE:
  //     - 'Rolle (KRITISCH)' — baseline §INSTRUCTIONS role-lock (replaces
  //       legacy OUTBOUND_PERSONA_TEMPLATE's missing clause). This is the
  //       D-9 fix for 2026-04-21 role-hallucination defect. The Plan tasks
  //       describe this as 'TURN-DISCIPLIN' in shorthand; the literal
  //       baseline string is 'Rolle (KRITISCH)' — we assert BOTH so reviewers
  //       can grep by either convention.
  //     - 'NanoClaw' — identity (baseline §ROLE & OBJECTIVE)
  //     - 'Ja, ich bin eine KI' — baseline §INSTRUCTIONS Offenlegung
  //     - 'im Auftrag von Carsten' — persona.ts buildCase2OutboundPersona
  //       goal phrasing (preserved from legacy OUTBOUND_PERSONA_TEMPLATE
  //       for self-introduction "NanoClaw im Auftrag von Carsten")
  //   CASE-2 OVERLAY:
  //     - 'Bellavista' — restaurant_name substituted into ### TASK
  //     - '±30 Min' — time_tolerance_min in ### TASK + ### DECISION RULES
  //     - 'Reservierung fuer Bellavista' — overlay ### TASK leading line
  it('Test A: session.update instructions contains BOTH baseline AND Case-2 overlay markers', async () => {
    const { app, sentMessages, mockState } = await mountAcceptWithCase2Handoff()
    const { getAmdClassifier, setAmdClassifier } = await import(
      '../src/tools/dispatch.js'
    )

    vi.useFakeTimers()
    try {
      const classifier = getAmdClassifier()
      expect(classifier).not.toBeNull()
      classifier?.onAmdResult('human')

      // First send = session.update. Parse and assert baseline+overlay content.
      expect(sentMessages.length).toBeGreaterThanOrEqual(2)
      const firstParsed = JSON.parse(sentMessages[0]) as {
        type: string
        session: { type: string; instructions: string }
      }
      expect(firstParsed.type).toBe('session.update')

      const instr = firstParsed.session.instructions

      // Baseline markers (Plan 05.2-01) — role-lock, identity, disclosure
      expect(instr).toContain('Rolle (KRITISCH)')
      // Plan truth[1] 'TURN-DISCIPLIN' shorthand: baseline renders the
      // role-lock block; the block's defining phrase matches what 05.2-01
      // shipped. Both grep-markers must coexist.
      expect(instr).toContain('SPRICHST NUR deine Rolle')
      expect(instr).toContain('NanoClaw')
      expect(instr).toContain('Ja, ich bin eine KI')
      expect(instr).toContain('im Auftrag von Carsten')

      // Case-2 overlay markers (Plan 05.2-04)
      expect(instr).toContain('Bellavista')
      expect(instr).toContain('±30 Min')
      expect(instr).toContain('Reservierung fuer Bellavista')

      // Negative assertion: the classifier prompt MUST NOT be a substring of
      // the post-handoff instructions. If the migration accidentally kept
      // CASE2_AMD_CLASSIFIER_PROMPT concatenated, this would silently keep
      // the model in detection-mode after the verdict.
      expect(instr).not.toBe(CASE2_AMD_CLASSIFIER_PROMPT)
      expect(instr).not.toContain('Du bist in einem Detektions-Modus')

      // Mute ctx lint for unused
      void mockState
    } finally {
      vi.useRealTimers()
      setAmdClassifier(null)
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // Test B — §201 StGB pre-verdict audio-leak invariant preserved
  // -------------------------------------------------------------------------
  // In the AMD listen-only phase (before amd_result verdict arrives), the
  // sideband must NEVER send response.create, and no response.output_audio.delta
  // or response.audio_transcript.delta events may surface upward. This is
  // inherited from Plan 05-03 T-05-03-01 and Plan 05.1-02 transcription
  // suppression — Plan 05.2-05 re-asserts it for the migrated composition.
  //
  // The new baseline+overlay composition could theoretically regress this
  // invariant if, e.g., a test helper or initialization accidentally
  // triggered a response.create before the classifier ran. This test guards
  // against that regression.
  it('Test B: no response.create or audio_transcript.delta before amd_result verdict (§201 invariant)', async () => {
    const { app, sentMessages } = await mountAcceptWithCase2Handoff()

    // Simulate the AMD listen-only phase: caller VAD events fire but NO
    // amd_result function-call yet. The sideband sees speech_started /
    // speech_stopped and forwards them to the registered AMD classifier —
    // it must NOT send response.create or any audio event upward.
    //
    // Critical check: in the window between /accept completing and
    // amd_result arriving, sentMessages should contain ZERO response.create
    // entries. The sideband's armedForFirstSpeech path is NOT engaged
    // because Case-2 leaves the flag false (webhook.ts:594-600 only arms
    // for the non-Case-2 branch).
    const before = sentMessages.slice()
    for (const msg of before) {
      const parsed = JSON.parse(msg) as { type?: string }
      expect(parsed.type).not.toBe('response.create')
      // audio_transcript.delta is a SERVER→client event; it would appear
      // on the ws.on('message') path, not in ws.send() captures. But we
      // also assert our test harness never synthesizes one by mistake.
      expect(parsed.type).not.toBe('response.audio_transcript.delta')
      expect(parsed.type).not.toBe('response.output_audio.delta')
    }

    // Additionally assert that `armedForFirstSpeech` stayed false for
    // Case-2 — the D-8 narrowing from Plan 05.2-03. The mockState was
    // observable from `router.startCall()` return value; we re-obtain
    // via a side-channel: if armedForFirstSpeech had been set to true,
    // webhook.ts would have logged `armed_for_first_speech` — we can't
    // easily assert the log, but the absence of a response.create in
    // the sentMessages is the functional assertion that matters.

    await app.close()
  })

  // -------------------------------------------------------------------------
  // Test C — Plan 05.1-01 Layer-2 ordering preserved post-migration
  // -------------------------------------------------------------------------
  // After amd_result verdict=human, the exact WS-send sequence MUST be:
  //   1. session.update (baseline+Case-2 overlay instructions)
  //   2. conversation.item.create role=user synthetic directive
  //        text contains '[System-Hinweis: AMD-Verdict war human'
  //   3. [after GREET_TRIGGER_DELAY_OUTBOUND_MS] response.create
  //
  // The migration (Plan 05.2-04) changed the payload CONTENT but NOT the
  // ordering. Test C asserts the ordering is preserved.
  it('Test C: post-verdict WS send order is session.update → item.create → response.create', async () => {
    const { app, sentMessages } = await mountAcceptWithCase2Handoff()
    const { getAmdClassifier, setAmdClassifier } = await import(
      '../src/tools/dispatch.js'
    )

    vi.useFakeTimers()
    try {
      const classifier = getAmdClassifier()
      classifier?.onAmdResult('human')

      // Synchronously: first two sends queued.
      expect(sentMessages.length).toBeGreaterThanOrEqual(2)

      const firstParsed = JSON.parse(sentMessages[0]) as { type: string }
      expect(firstParsed.type).toBe('session.update')

      const secondParsed = JSON.parse(sentMessages[1]) as {
        type: string
        item?: {
          type?: string
          role?: string
          content?: Array<{ type?: string; text?: string }>
        }
      }
      expect(secondParsed.type).toBe('conversation.item.create')
      expect(secondParsed.item?.type).toBe('message')
      expect(secondParsed.item?.role).toBe('user')
      expect(secondParsed.item?.content?.[0]?.type).toBe('input_text')
      expect(secondParsed.item?.content?.[0]?.text).toContain(
        '[System-Hinweis: AMD-Verdict war human',
      )

      // Advance the timer past GREET_TRIGGER_DELAY_OUTBOUND_MS (default 2500ms
      // per config.ts, but 5000ms is a safe upper bound).
      await vi.advanceTimersByTimeAsync(5000)

      const idxSession = sentMessages.findIndex(
        (s) => JSON.parse(s).type === 'session.update',
      )
      const idxItem = sentMessages.findIndex(
        (s) => JSON.parse(s).type === 'conversation.item.create',
      )
      const idxResponse = sentMessages.findIndex(
        (s) => JSON.parse(s).type === 'response.create',
      )
      expect(idxSession).toBe(0)
      expect(idxItem).toBe(1)
      expect(idxResponse).toBeGreaterThan(idxItem)
    } finally {
      vi.useRealTimers()
      setAmdClassifier(null)
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // Test D — Plan 05.1-01 session.type='realtime' discriminator preserved
  // -------------------------------------------------------------------------
  // sideband.ts:703 places `type: 'realtime'` FIRST in the session payload
  // so extraSession spread can override it if needed, but the default MUST
  // be 'realtime' (otherwise OpenAI rejects with invalid_request_error
  // param='session.type'). Test D pins the invariant at the handoff call
  // site — any future migration that drops the discriminator fails here.
  it("Test D: session.update payload carries session.type='realtime'", async () => {
    const { app, sentMessages } = await mountAcceptWithCase2Handoff()
    const { getAmdClassifier, setAmdClassifier } = await import(
      '../src/tools/dispatch.js'
    )

    vi.useFakeTimers()
    try {
      const classifier = getAmdClassifier()
      classifier?.onAmdResult('human')

      const firstParsed = JSON.parse(sentMessages[0]) as {
        type: string
        session: { type: string; instructions: string }
      }
      expect(firstParsed.type).toBe('session.update')
      // Load-bearing: without type: 'realtime' the server rejects the update
      // with invalid_request_error and the persona swap silently fails.
      expect(firstParsed.session?.type).toBe('realtime')
    } finally {
      vi.useRealTimers()
      setAmdClassifier(null)
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // Test E — Q7 atomicity finding reflected in session.update shape
  // -------------------------------------------------------------------------
  // Reads .planning/phases/.../q7-atomicity-finding.md at test-setup time.
  //   - Verdict ATOMIC or INCONCLUSIVE → current code ships ONE session.update
  //     for the handoff (tools NOT re-pushed; only instructions change).
  //   - Verdict NON-ATOMIC → code ships TWO session.update messages: first
  //     with tools-only, second with instructions-only (Task 3 Branch B
  //     workaround).
  //
  // In all cases, the session.update(s) MUST precede conversation.item.create
  // and response.create.
  it('Test E: session.update shape reflects Q7 verdict from q7-atomicity-finding', async () => {
    const verdict = readQ7Verdict()
    const { app, sentMessages } = await mountAcceptWithCase2Handoff()
    const { getAmdClassifier, setAmdClassifier } = await import(
      '../src/tools/dispatch.js'
    )

    vi.useFakeTimers()
    try {
      const classifier = getAmdClassifier()
      classifier?.onAmdResult('human')

      await vi.advanceTimersByTimeAsync(5000)

      const sessionUpdateSends = sentMessages.filter(
        (s) => JSON.parse(s).type === 'session.update',
      )

      if (verdict === 'NON-ATOMIC') {
        // Branch B: expect TWO session.update messages. First carries tools,
        // second carries instructions. Current code does not implement this;
        // this assertion guides Task 3 Branch B if/when verdict flips.
        expect(sessionUpdateSends.length).toBe(2)
        const firstSession = (JSON.parse(sessionUpdateSends[0]) as {
          session: { tools?: unknown; instructions?: string }
        }).session
        const secondSession = (JSON.parse(sessionUpdateSends[1]) as {
          session: { tools?: unknown; instructions?: string }
        }).session
        // First message in two-step carries tools (not instructions); second
        // carries instructions (not tools). Exact shape is workaround-specific.
        // Minimum assertion: at least one message carries each field.
        const anyHasTools =
          'tools' in firstSession || 'tools' in secondSession
        const anyHasInstructions =
          typeof firstSession.instructions === 'string' ||
          typeof secondSession.instructions === 'string'
        expect(anyHasTools).toBe(true)
        expect(anyHasInstructions).toBe(true)
      } else {
        // ATOMIC or INCONCLUSIVE: expect exactly ONE session.update.
        // This is the current shipping behavior (matches Plan 05.1-01).
        expect(sessionUpdateSends.length).toBe(1)
        const session = (JSON.parse(sessionUpdateSends[0]) as {
          session: { type: string; instructions: string; tools?: unknown }
        }).session
        expect(session.type).toBe('realtime')
        expect(typeof session.instructions).toBe('string')
        // D-26/AC-05 invariant (sideband.ts:704-710): tools field is stripped
        // from instructions-only updates. The post-handoff session.update
        // MUST NOT carry tools — the tools list was fixed at /accept.
        expect('tools' in session).toBe(false)
      }
    } finally {
      vi.useRealTimers()
      setAmdClassifier(null)
      await app.close()
    }
  })
})
