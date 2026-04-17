// voice-bridge/src/slow-brain.ts
// D-24..D-28 + DIR-06, DIR-11:
// Event-driven Claude Sonnet worker. Consumes transcript deltas, coalesces
// per cadence cap, pushes instructions-only session.update via sideband.
// Graceful degrade — hot-path NEVER blocks or throws because of this module.
import { createRequire } from 'node:module'
import type { Logger } from 'pino'
import {
  SLOW_BRAIN_CADENCE_CAP,
  SLOW_BRAIN_TIMEOUT_MS,
  SLOW_BRAIN_QUEUE_MAX,
  SLOW_BRAIN_MODEL,
  getAnthropicKey,
} from './config.js'
import type { SidebandState } from './sideband.js'
import { updateInstructions } from './sideband.js'

export interface TranscriptDelta {
  turnId: string
  transcript: string
  toolResults?: unknown
}

export interface SlowBrainWorker {
  push: (delta: TranscriptDelta) => void
  stop: () => Promise<void>
}

// Minimal shape of Anthropic Messages response we care about.
export interface AnthropicClient {
  messages: {
    create: (
      params: {
        model: string
        max_tokens: number
        messages: Array<{ role: 'user'; content: string }>
      },
      opts?: { signal?: AbortSignal },
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>
  }
}

export interface StartSlowBrainOpts {
  anthropicClient?: AnthropicClient
  cadenceCap?: number
  timeoutMs?: number
  queueMax?: number
  pollIntervalMs?: number
}

export function startSlowBrain(
  log: Logger,
  sideband: SidebandState,
  opts: StartSlowBrainOpts = {},
): SlowBrainWorker {
  const cadenceCap = opts.cadenceCap ?? SLOW_BRAIN_CADENCE_CAP
  const timeoutMs = opts.timeoutMs ?? SLOW_BRAIN_TIMEOUT_MS
  const queueMax = opts.queueMax ?? SLOW_BRAIN_QUEUE_MAX
  const pollInterval = opts.pollIntervalMs ?? 10
  const anthropic = opts.anthropicClient ?? createDefaultClient()

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
        // Coalesce this turn — skip Claude call, wait for the next one.
        continue
      }
      try {
        const ctrl = new AbortController()
        currentAbort = ctrl
        const timer = setTimeout(() => ctrl.abort(), timeoutMs)
        const res = await anthropic.messages.create(
          {
            model: SLOW_BRAIN_MODEL,
            max_tokens: 500,
            messages: [
              {
                role: 'user',
                content: `Transcript delta:\n${delta.transcript}\n\nTool results: ${JSON.stringify(
                  delta.toolResults ?? null,
                )}`,
              },
            ],
          },
          { signal: ctrl.signal },
        )
        clearTimeout(timer)
        currentAbort = null
        const text = res.content.find((c) => c.type === 'text')?.text ?? ''
        if (text) {
          updateInstructions(sideband, text, log)
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
        // Continue loop — hot-path unaffected.
      }
    }
  }

  // Fire-and-forget.
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

// Lazy import via createRequire so @anthropic-ai/sdk is only loaded when the
// default client path is used. Tests inject opts.anthropicClient and never hit
// this branch.
function createDefaultClient(): AnthropicClient {
  const req = createRequire(import.meta.url)
  const mod = req('@anthropic-ai/sdk') as {
    default?: new (args: { apiKey: string }) => AnthropicClient
    Anthropic?: new (args: { apiKey: string }) => AnthropicClient
  }
  const Ctor = mod.default ?? mod.Anthropic
  if (!Ctor) {
    throw new Error('slow-brain: @anthropic-ai/sdk missing default / Anthropic export')
  }
  return new Ctor({ apiKey: getAnthropicKey() })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
