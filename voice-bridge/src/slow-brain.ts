// voice-bridge/src/slow-brain.ts
// Phase 05.3 — Slow-Brain via NanoClaw-Core-MCP. voice-bridge contains NO
// LLM-Inference — the turn-transcript is forwarded via MCP call to Core, where
// the Claude agent decides whether to push a mid-call session.update.
//
// Cadence-Cap (D-25), back-pressure (D-28), timeout (D-27) and graceful-degrade
// (REQ-DIR-12) are preserved from the pre-retrofit design. Only the inference
// location changed (Core instead of Bridge).
import type { Logger } from 'pino'

import {
  SLOW_BRAIN_CADENCE_CAP,
  SLOW_BRAIN_QUEUE_MAX,
  CORE_MCP_URL,
  CORE_MCP_TIMEOUT_MS,
} from './config.js'
import { callCoreTool } from './core-mcp-client.js'
import type { SidebandState } from './sideband.js'
import { updateInstructions } from './sideband.js'

export interface TranscriptDelta {
  turnId: string
  transcript: string
  toolResults?: unknown
}

export interface CoreTurnResponse {
  ok: boolean
  result?: { ok?: boolean; instructions_update?: string | null }
  instructions_update?: string | null
}

export interface CoreClientLike {
  callTool: (
    name: string,
    args: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<CoreTurnResponse>
}

export interface StartSlowBrainOpts {
  coreClient?: CoreClientLike
  cadenceCap?: number
  timeoutMs?: number
  queueMax?: number
  pollIntervalMs?: number
}

export interface SlowBrainWorker {
  push: (delta: TranscriptDelta) => void
  stop: () => Promise<void>
}

function extractInstructionsUpdate(res: CoreTurnResponse): string | null {
  // Two response shapes supported: raw tool response {ok, instructions_update}
  // or wrapped MCP-server response {ok, result: {ok, instructions_update}}.
  if (res && typeof res === 'object') {
    if ('result' in res && res.result && typeof res.result === 'object') {
      const r = res.result
      if (r.ok !== false && typeof r.instructions_update === 'string') {
        return r.instructions_update
      }
      if (r.instructions_update === null) return null
    }
    if ('instructions_update' in res) {
      if (typeof res.instructions_update === 'string') return res.instructions_update
      if (res.instructions_update === null) return null
    }
  }
  // Unexpected shape — caller logs bad_response.
  throw new Error('bad_response')
}

export function startSlowBrain(
  log: Logger,
  sideband: SidebandState,
  opts: StartSlowBrainOpts = {},
): SlowBrainWorker {
  const cadenceCap = opts.cadenceCap ?? SLOW_BRAIN_CADENCE_CAP
  const timeoutMs = opts.timeoutMs ?? CORE_MCP_TIMEOUT_MS
  const queueMax = opts.queueMax ?? SLOW_BRAIN_QUEUE_MAX
  const pollInterval = opts.pollIntervalMs ?? 10

  const disabled = !opts.coreClient && !CORE_MCP_URL
  if (disabled) {
    log.info({
      event: 'slow_brain_disabled',
      reason: 'core_mcp_url_unset',
      call_id: sideband.callId,
    })
    return {
      push: (_d: TranscriptDelta) => {
        /* no-op */
      },
      stop: async () => {
        /* no-op */
      },
    }
  }

  const coreClient: CoreClientLike =
    opts.coreClient ??
    {
      callTool: async (name, args, o) =>
        (await callCoreTool(name, args, {
          timeoutMs: o?.timeoutMs,
          signal: o?.signal,
        })) as CoreTurnResponse,
    }

  const queue: TranscriptDelta[] = []
  let turnsSinceUpdate = 0
  let running = true
  let currentAbort: AbortController | null = null

  async function runLoop(): Promise<void> {
    while (running) {
      const delta = queue.shift()
      if (!delta) {
        await sleep(pollInterval)
        continue
      }
      turnsSinceUpdate++
      if (cadenceCap > 0 && turnsSinceUpdate < cadenceCap) {
        continue
      }
      try {
        const ctrl = new AbortController()
        currentAbort = ctrl
        const res = await coreClient.callTool(
          'voice_on_transcript_turn',
          {
            call_id: sideband.callId,
            turn_id: delta.turnId,
            transcript: delta.transcript,
            tool_results: delta.toolResults ?? null,
          },
          { timeoutMs, signal: ctrl.signal },
        )
        currentAbort = null
        let instructions: string | null
        try {
          instructions = extractInstructionsUpdate(res)
        } catch {
          log.warn({
            event: 'slow_brain_bad_response',
            call_id: sideband.callId,
          })
          continue
        }
        if (instructions) {
          updateInstructions(sideband, instructions, log)
          turnsSinceUpdate = 0
        }
      } catch (e: unknown) {
        currentAbort = null
        const err = e as Error
        log.warn({
          event: 'slow_brain_degraded',
          call_id: sideband.callId,
          reason: err?.message ?? 'unknown',
        })
        // Hot-path unaffected.
      }
    }
  }

  void runLoop()

  return {
    push(delta: TranscriptDelta): void {
      if (queue.length >= queueMax) {
        const dropped = queue.shift()
        log.warn({
          event: 'slow_brain_backpressure',
          call_id: sideband.callId,
          queue_depth: queue.length + 1,
          dropped_turn_id: dropped?.turnId,
        })
      }
      queue.push(delta)
    },
    async stop(): Promise<void> {
      running = false
      currentAbort?.abort()
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
