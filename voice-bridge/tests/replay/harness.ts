// voice-bridge/tests/replay/harness.ts
// Replay harness: iterates Spike-E fixture turns, measures Bridge-side
// dispatch latency, checks tool-call args vs fixture, compares text via
// cosineOrDice. No real network or OpenAI round-trip — dispatch is invoked
// directly so the harness measures BRIDGE-side work only.
//
// Percentile-bucket semantics (Warning 2 fix):
//   - Every turn contributes to per-turn band compliance using the fixture's
//     platform-reported t_first_audio_ms as the golden reference.
//   - ONLY tool-call turns contribute to the p50/p95 percentile bucket —
//     non-tool turns log near-zero Bridge-side elapsed and would trivially
//     pass the percentile gate, making it hollow. Restricting the bucket to
//     tool-call turns keeps REQ-VOICE-02 / REQ-VOICE-03 honest.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'
import { dispatchTool } from '../../src/tools/dispatch.js'
import { invokeIdempotent, clearCall } from '../../src/idempotency.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const FIXTURES_DIR = join(__dirname, '..', 'fixtures', 'spike-e')
const GOLDEN_PATH = join(__dirname, '..', 'fixtures', 'golden', 'latency-bands.json')

export interface FixtureTurn {
  turn_idx: number
  text_pushed: string
  tool_call_triggered: boolean
  tool_name: string | null
  tool_args_str: string | null
  transcription: string
  t0_ms: number
  t_first_audio_ms: number
}

export interface FixtureGoldenTurn {
  turn_idx: number
  t_first_audio_ms: number
  tool_name: string | null
  tool_args_str: string | null
  transcription: string
}

export interface FixtureGolden {
  turns: FixtureGoldenTurn[]
  tolerance_ms: number
}

export function loadFixture(name: string): {
  turns: FixtureTurn[]
  golden: FixtureGolden
} {
  const turns = readFileSync(join(FIXTURES_DIR, name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as FixtureTurn)
  const allGolden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<
    string,
    FixtureGolden
  >
  const golden = allGolden[name]
  if (!golden) throw new Error(`no golden for fixture ${name}`)
  return { turns, golden }
}

export function mockLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: 'info',
  } as unknown as Logger
}

export interface TurnMeasurement {
  turn_idx: number
  /** Wall-clock Bridge-side work for tool turns; fixture-reported for non-tool turns. */
  elapsed_ms: number
  /** True if this turn invoked a tool (counted for p50/p95 bucket). */
  counted_for_percentile: boolean
  golden_ms: number
  in_band: boolean
}

export async function runReplayAgainstBridge(
  fixtureName: string,
): Promise<TurnMeasurement[]> {
  const { turns, golden } = loadFixture(fixtureName)
  // Reset idempotency cache so duplicate fixture turns don't short-circuit.
  clearCall('replay')
  const out: TurnMeasurement[] = []
  const log = mockLog()
  for (const turn of turns) {
    const goldenTurn = golden.turns[turn.turn_idx]
    const golden_ms = goldenTurn?.t_first_audio_ms ?? turn.t_first_audio_ms

    let elapsed: number
    let counted: boolean

    if (turn.tool_call_triggered && turn.tool_name) {
      const t0 = performance.now()
      let args: unknown = {}
      try {
        args = turn.tool_args_str ? JSON.parse(turn.tool_args_str) : {}
      } catch {
        args = {}
      }
      // Unique turn id per call (turn_idx repeats across fixtures) so the
      // idempotency wrapper does not collapse distinct fixture turns.
      // 02-11: dispatchTool is now async (ws, callId, turnId, functionCallId,
      // toolName, args, log, opts). Harness uses a null-sink mock WS and
      // a no-op callCoreTool so no real MCP calls happen.
      const mockWS = { send: vi.fn() } as unknown as WSType
      const mockOpts = {
        callCoreTool: vi.fn().mockResolvedValue({ ok: true }),
        emitFunctionCallOutput: vi.fn().mockReturnValue(true),
        emitResponseCreate: vi.fn().mockReturnValue(true),
        jsonlPath: '/dev/null',
      }
      await invokeIdempotent(
        'replay',
        `${fixtureName}:${turn.turn_idx}`,
        turn.tool_name,
        args,
        async () =>
          dispatchTool(
            mockWS,
            'replay',
            `${fixtureName}:${turn.turn_idx}`,
            `fc_${turn.turn_idx}`,
            turn.tool_name as string,
            args,
            log,
            mockOpts,
          ),
        log,
      )
      elapsed = performance.now() - t0
      counted = true
    } else {
      // Non-tool turn: platform-reported latency stands in for the golden
      // band contract but is excluded from the percentile bucket.
      elapsed = golden_ms
      counted = false
    }

    // Bridge-side dispatch is orders of magnitude faster than the OpenAI
    // round-trip fixture t_first_audio_ms. For tool turns we accept any
    // elapsed that stays at or below (golden + tolerance); this validates
    // the Bridge does not inject latency above the platform baseline.
    const in_band =
      Math.abs(elapsed - golden_ms) <= golden.tolerance_ms ||
      elapsed <= golden_ms + golden.tolerance_ms

    out.push({
      turn_idx: turn.turn_idx,
      elapsed_ms: elapsed,
      counted_for_percentile: counted,
      golden_ms,
      in_band,
    })
  }
  return out
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}
