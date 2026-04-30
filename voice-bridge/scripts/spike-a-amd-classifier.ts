// voice-bridge/scripts/spike-a-amd-classifier.ts
// Plan 05-00 Task 1 — Spike-A AMD classifier first-turn verification.
//
// THROWAWAY: deleted after 05-00 Task 1 closes. Do NOT import from
// production code. Do NOT ship in any release.
//
// Purpose (closes OQ-1): does gpt-realtime-mini emit a `function_call`
// as its first output within 2000 ms of the outbound pickup with ZERO
// preceding `response.audio.delta` frames?
//
// Flow:
//   1. POST /outbound with persona_override=OUTBOUND_AMD_CLASSIFIER_PROMPT
//      + tools_override=[amd_result({verdict})]. Bridge routes through
//      the existing outbound-router → Sipgate REST → OpenAI SIP path.
//   2. Bridge /accept applies the override (see
//      voice-bridge/src/webhook.ts isOutbound branch) AND enables the
//      per-call sideband event trace at /tmp/spike-a-trace-<callId>.jsonl
//      (see voice-bridge/src/sideband.ts traceEventsPath opt).
//   3. This script polls the trace file for events, redacts any
//      response.audio.delta payload (§201 StGB — no audio persisted,
//      only frame byte-count), and prints the verdict + elapsed_ms +
//      AUDIO_LEAKED flag when `response.function_call_arguments.done`
//      with name="amd_result" arrives. 8000 ms timeout otherwise.
//
// Constraints:
//   - Pure standalone tsx — no new env vars, no OneCLI changes, no
//     systemd service.
//   - MUST NOT write any .wav/.mp3/.opus/.flac file. Only the (already-
//     redacted) JSONL from the Bridge-side trace path.
//
// Usage (coordinated with Operator's second phone):
//   cd /home/carsten_bot/nanoclaw/voice-bridge
//   npx tsx scripts/spike-a-amd-classifier.ts +491708036426
import { readFileSync, existsSync } from 'node:fs'
import { readdirSync } from 'node:fs'

// ---- Constants ----

// Verbatim from .planning/phases/05-case-2-restaurant-reservation-outbound/
//   05-RESEARCH.md §2.4. Must NOT be reworded during the spike — the
//   whole point of Spike-A is to test THIS prompt shape verbatim.
const OUTBOUND_AMD_CLASSIFIER_PROMPT = [
  'Du bist in einem Detektions-Modus. Der Anruf wurde GERADE angenommen.',
  'Deine EINZIGE Aufgabe ist: bestimme, ob ein Mensch oder eine Mailbox/Anrufbeantworter angenommen hat.',
  '',
  'KRITISCH: Du sprichst JETZT NICHT. Generiere KEIN Audio. Du hörst nur zu.',
  '',
  'Höre die ersten 3 Sekunden:',
  '- Wenn ein Mensch knapp grüßt → emit function_call "amd_result" with arg {"verdict": "human"}',
  '- Wenn eine Ansage läuft → emit function_call "amd_result" with arg {"verdict": "voicemail"}',
  '- Wenn 4 Sekunden lang NICHTS gesprochen wird → emit function_call "amd_result" with arg {"verdict": "silence"}',
  '',
  'Sprich NIEMALS bis die Bridge dir neue Anweisungen gibt.',
].join('\n')

const AMD_RESULT_TOOL = {
  name: 'amd_result',
  description: 'Emit AMD verdict (human/voicemail/silence) — spike-only',
  parameters: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['human', 'voicemail', 'silence'] },
    },
    required: ['verdict'],
  },
}

const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://10.0.0.2:4402'
const TIMEOUT_MS = 8000
const POLL_INTERVAL_MS = 50

// ---- Helpers ----

function parseJsonlFile(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf-8')
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  const out: Array<Record<string, unknown>> = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      /* ignore malformed — partial write mid-append */
    }
  }
  return out
}

function findTraceFileFor(callIdSanitized: string): string {
  // Bridge sanitizes callId to `[a-zA-Z0-9_-]` when naming the file —
  // we receive the raw callId from /outbound response, sanitize the
  // same way.
  return `/tmp/spike-a-trace-${callIdSanitized}.jsonl`
}

// ---- Main ----

async function main(): Promise<void> {
  const targetPhone = process.argv[2]
  if (!targetPhone) {
    console.error('Usage: tsx scripts/spike-a-amd-classifier.ts +491708036426')
    process.exit(1)
  }
  if (!/^\+[1-9]\d{1,14}$/.test(targetPhone)) {
    console.error(`Invalid E.164 phone: ${targetPhone}`)
    process.exit(1)
  }

  console.error(`spike-a: targeting ${targetPhone} via ${BRIDGE_URL}`)
  console.error('spike-a: POST /outbound with persona_override + tools_override')

  const t0 = Date.now()
  const body = {
    target_phone: targetPhone,
    goal: 'SPIKE-A AMD classifier test',
    context: '',
    report_to_jid: 'spike-a@local',
    persona_override: OUTBOUND_AMD_CLASSIFIER_PROMPT,
    tools_override: [AMD_RESULT_TOOL],
  }

  const res = await fetch(`${BRIDGE_URL}/outbound`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.2',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errBody = await res.text()
    console.error(`spike-a: POST /outbound failed ${res.status}: ${errBody}`)
    process.exit(1)
  }

  const enqueueResp = (await res.json()) as {
    outbound_task_id: string
    estimated_start_ts: string
    queue_position: number
    status: string
  }
  console.error(
    `spike-a: enqueued task_id=${enqueueResp.outbound_task_id} status=${enqueueResp.status}`,
  )

  // Bridge binds the OpenAI call_id to the task inside /accept. We don't
  // know it yet — so we poll /tmp for ANY spike-a-trace file that appears
  // after t0 and was freshly created. Once we've got it, we stick with it.
  let tracePath: string | null = null
  let acceptAt = 0
  let lastOffset = 0
  let audioLeaked = false
  let firstVerdict: { verdict: string; elapsed_ms: number } | null = null
  const deadline = Date.now() + TIMEOUT_MS + 30_000 // allow 30s for ring+pickup

  while (Date.now() < deadline) {
    if (!tracePath) {
      // Find the freshest trace file created after t0
      try {
        const files = readdirSync('/tmp')
          .filter(
            (f) => f.startsWith('spike-a-trace-') && f.endsWith('.jsonl'),
          )
          .map((f) => `/tmp/${f}`)
        for (const f of files) {
          const events = parseJsonlFile(f)
          if (events.length > 0) {
            tracePath = f
            acceptAt = Date.now()
            console.error(`spike-a: trace file opened: ${tracePath}`)
            break
          }
        }
      } catch {
        /* /tmp read failure — retry */
      }
      if (!tracePath) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        continue
      }
    }

    // Poll the file for new events
    const events = parseJsonlFile(tracePath)
    for (const evt of events.slice(lastOffset)) {
      const type = evt.type as string | undefined
      if (type === 'response.audio.delta' && !firstVerdict) {
        audioLeaked = true
      }
      if (
        type === 'response.function_call_arguments.done' &&
        (evt.name as string) === 'amd_result'
      ) {
        try {
          const args = JSON.parse(evt.arguments as string) as {
            verdict?: string
          }
          if (args.verdict) {
            firstVerdict = {
              verdict: args.verdict,
              elapsed_ms: (evt.t_ms_since_open as number) ?? Date.now() - acceptAt,
            }
          }
        } catch {
          /* arguments malformed — treat as no verdict */
        }
      }
    }
    lastOffset = events.length

    if (firstVerdict) break

    // Timeout check — 8000 ms from first trace event
    if (Date.now() - acceptAt > TIMEOUT_MS) break

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  if (!firstVerdict) {
    console.log(
      `VERDICT=TIMEOUT  ELAPSED_MS=${Date.now() - t0}  AUDIO_LEAKED=${audioLeaked}  TRACE=${tracePath ?? '(none)'}`,
    )
    process.exit(2)
  }

  console.log(
    `VERDICT=${firstVerdict.verdict}  ELAPSED_MS=${firstVerdict.elapsed_ms}  AUDIO_LEAKED=${audioLeaked}  TRACE=${tracePath}`,
  )
  process.exit(0)
}

// Clean SIGINT — flush and exit with trace path hint if any.
process.on('SIGINT', () => {
  console.error('\nspike-a: interrupted — trace (if any) left intact in /tmp')
  process.exit(130)
})

main().catch((err: Error) => {
  console.error(`spike-a: unhandled error: ${err.message}`)
  process.exit(1)
})
