// voice-bridge/src/pre-greet.ts
// Phase 05.3 — Slow-Brain pre-greet injection. Inject Slow-Brain-tailored
// persona via session.update BEFORE the model emits its first utterance, with
// a strict 2000ms budget (REQ-VOICE-13). If Slow-Brain does not deliver in
// time (or returns no instructions), the static persona passed at /accept
// governs.
//
// Fire-and-forget from the /accept handler — must NOT block accept-handler
// return. Hot-path is unaffected on any failure path.
//
// Load-bearing invariant:
//   - Case-2 AMD branch pre-greet skip (see maybeInjectPreGreet below). Firing
//     Slow-Brain pre-greet while the classifier prompt is in scope would race
//     and break AMD.
import type { Logger } from 'pino'

import type { SidebandHandle } from './sideband.js'
import { updateInstructions } from './sideband.js'
import type { OutboundRouter } from './outbound-router.js'

// Phase 05.6 cleanup: legacy slow-brain.ts deleted. CoreClientLike was the
// duck-typed NanoclawMcpClient shape used here for the pre-greet RPC. Inlined to
// avoid a dependency on the deleted file. Both NanoclawMcpClient and any future
// per-call MCP client satisfy this shape via structural typing.
export interface CoreClientLike {
  callTool: (
    name: string,
    args: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<unknown>
}

export interface MaybeInjectPreGreetOpts {
  callId: string
  sideband: SidebandHandle
  coreClient: CoreClientLike
  log: Logger
  /** Total budget from invocation to session.update emit. Default 2000ms (REQ-VOICE-13). */
  budgetMs?: number
  /** Sub-budget for waiting until sideband WS is ready. Default 800ms. */
  readyWaitMs?: number
  /** Polling interval while waiting for sideband ready. Default 50ms. */
  pollMs?: number
  /**
   * Optional outbound router to check case_type. If the active task has
   * case_type='case_2', pre-greet is skipped entirely (the AMD classifier
   * branch in /accept handles first-utterance gating). No Slow-Brain RPC
   * racing with classifier prompt.
   */
  outboundRouter?: OutboundRouter
}

export async function maybeInjectPreGreet(
  opts: MaybeInjectPreGreetOpts,
): Promise<void> {
  const budgetMs = opts.budgetMs ?? 2000
  const readyWaitMs = opts.readyWaitMs ?? 800
  const pollMs = opts.pollMs ?? 50
  const t0 = Date.now()

  // Plan 05-03 AMD-handoff invariant: Case-2 branch skips pre-greet entirely.
  // /accept already set CASE2_AMD_CLASSIFIER_PROMPT as instructions; firing
  // Slow-Brain pre-greet would race with it and break AMD.
  const activeTask = opts.outboundRouter?.getActiveTask?.() ?? null
  if (activeTask?.case_type === 'case_2') {
    opts.log.info({
      event: 'pre_greet_skipped',
      call_id: opts.callId,
      reason: 'case_2_amd_branch',
    })
    return
  }

  // 1. Wait for sideband WS to be ready (small budget within total)
  const readyDeadline = t0 + readyWaitMs
  while (!opts.sideband.state.ready && Date.now() < readyDeadline) {
    await sleep(pollMs)
  }
  if (!opts.sideband.state.ready) {
    opts.log.info({
      event: 'pre_greet_skipped',
      call_id: opts.callId,
      reason: 'sideband_not_ready',
      elapsed_ms: Date.now() - t0,
    })
    return
  }

  // 2. Compute remaining RPC budget
  const remaining = budgetMs - (Date.now() - t0)
  if (remaining <= 100) {
    opts.log.info({
      event: 'pre_greet_skipped',
      call_id: opts.callId,
      reason: 'budget_exhausted',
      elapsed_ms: Date.now() - t0,
    })
    return
  }

  // 3. Call Core Slow-Brain with phase=pre_greet (turn_id signal +
  //    transcript=''). Core handler can branch on turn_id='pre-greet' to
  //    fetch a fast pre-greet instruction (e.g. cached) instead of running
  //    the full Andy/Claude inference pipeline.
  let resp: unknown
  try {
    resp = await opts.coreClient.callTool(
      'voice_on_transcript_turn',
      {
        call_id: opts.callId,
        turn_id: 'pre-greet',
        transcript: '',
      },
      { timeoutMs: remaining },
    )
  } catch (e: unknown) {
    opts.log.info({
      event: 'pre_greet_skipped',
      call_id: opts.callId,
      reason: 'core_call_failed',
      err: (e as Error)?.message ?? 'unknown',
      elapsed_ms: Date.now() - t0,
    })
    return
  }

  // 4. Extract instructions_update from response (raw or wrapped MCP shape)
  const instructions = extractInstructions(resp)
  if (!instructions) {
    opts.log.info({
      event: 'pre_greet_skipped',
      call_id: opts.callId,
      reason: 'no_instructions',
      elapsed_ms: Date.now() - t0,
    })
    return
  }

  // 5. Final budget check before emit
  const totalElapsed = Date.now() - t0
  if (totalElapsed > budgetMs) {
    opts.log.info({
      event: 'pre_greet_skipped',
      call_id: opts.callId,
      reason: 'budget_exhausted_after_rpc',
      elapsed_ms: totalElapsed,
    })
    return
  }

  // 6. Emit session.update with Slow-Brain-tailored persona
  const ok = updateInstructions(opts.sideband.state, instructions, opts.log)
  opts.log.info({
    event: 'pre_greet_injected',
    call_id: opts.callId,
    instructions_len: instructions.length,
    elapsed_ms: Date.now() - t0,
    sent: ok,
  })
}

function extractInstructions(res: unknown): string | null {
  if (!res || typeof res !== 'object') return null
  const r = res as Record<string, unknown>
  if (
    'result' in r &&
    r.result &&
    typeof r.result === 'object'
  ) {
    const inner = r.result as Record<string, unknown>
    if (typeof inner.instructions_update === 'string' && inner.instructions_update.length > 0) {
      return inner.instructions_update
    }
  }
  if (typeof r.instructions_update === 'string' && r.instructions_update.length > 0) {
    return r.instructions_update
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
