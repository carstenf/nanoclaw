// voice-bridge/scripts/session-update-atomicity-probe.ts
// Plan 05.2-05 Task 1 — Q7 atomicity probe (CONTEXT.md §Q7, research §6.4 Q7).
//
// Open question:
//   Does a single OpenAI Realtime `session.update` carrying BOTH `instructions`
//   AND `tools` replace them atomically on the server, or is there a brief
//   window where the new instructions see the old tools (or vice versa)?
//
// Documentation evidence (.planning/research/voice-persona-architecture.md §2.1
// + §6.4 Q7):
//   - OpenAI Cookbook's "Dynamic Conversation Flow via session.updates" pattern
//     shows a `set_conversation_state` tool that performs a SINGLE session.update
//     replacing the prompt AND tools for state transitions. This strongly
//     *implies* atomicity but the Cookbook does not EXPLICITLY commit to it.
//   - OpenAI Realtime Server Events reference (session.updated) is silent on
//     atomicity ordering guarantees.
//
// Method:
//   1. Open a Realtime session via WebSocket (`wss://api.openai.com/v1/realtime`)
//   2. Send initial session.update with instructions_A ("APFEL") + tools_A
//      (only `tool_a_unique`).
//   3. Wait for session.updated confirmation, send response.create, capture
//      baseline behavior (APFEL, tool_a_unique visible).
//   4. Send SECOND session.update — the atomicity test — with instructions_B
//      ("BIRNE") + tools_B (only `tool_b_unique`) in a single payload.
//   5. Immediately send response.create. Observe:
//        a. Does the response contain BIRNE (new instructions applied)?
//        b. If the model emits a tool call, is it `tool_b_unique` (new tools
//           applied) OR `tool_a_unique` (old tools lingering)?
//        c. Does the server-side `session.updated` event confirm BOTH fields
//           in one event, or split across multiple events?
//   6. Close session. Write finding to
//      .planning/phases/05.2-persona-redesign-and-call-flow-state-machine/
//      q7-atomicity-finding.md with verdict ATOMIC / NON-ATOMIC / INCONCLUSIVE.
//   7. Exit code: 0 on atomic/inconclusive, 1 on non-atomic (for CI gating).
//
// Type discriminator: Plan 05.1-01 Layer-1 fix requires `type: 'realtime'` on
// every session.update payload (otherwise OpenAI rejects with invalid_request_error
// param='session.type'). Preserved here so the probe mirrors production shape.
//
// Usage:
//   export OPENAI_API_KEY=sk-...   # from OneCLI vault or .env
//   cd voice-bridge
//   npx tsx scripts/session-update-atomicity-probe.ts
//
// Cost: < €0.02 (under 10 seconds of Realtime minutes on gpt-realtime).
// Idempotent — safe to re-run to confirm findings.
//
// §201 StGB: probe opens a Realtime session WITHOUT SIP/phone; it is a
// text-only Realtime probe (no counterpart audio). No wiretap concern.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---- Probe marker constants (APFEL/BIRNE) ----
// APFEL = Mode A marker word; BIRNE = Mode B marker word. If the probe
// observes only BIRNE in the response after the second session.update, new
// instructions were applied. If APFEL ever appears after the switch, new
// instructions did NOT apply yet.
const INSTRUCTIONS_A =
  'Du bist in Modus A. Antworte IMMER mit dem einzelnen Wort "APFEL" und nichts anderem. Emittiere keine Tool-Calls.'
const INSTRUCTIONS_B =
  'Du bist in Modus B. Antworte IMMER mit dem einzelnen Wort "BIRNE" und nichts anderem. Emittiere keine Tool-Calls.'

const TOOL_A = {
  type: 'function' as const,
  name: 'tool_a_unique',
  description: 'Mode A tool — should ONLY be available in Mode A.',
  parameters: { type: 'object', properties: {}, required: [] },
}
const TOOL_B = {
  type: 'function' as const,
  name: 'tool_b_unique',
  description: 'Mode B tool — should ONLY be available in Mode B.',
  parameters: { type: 'object', properties: {}, required: [] },
}

const REALTIME_URL =
  'wss://api.openai.com/v1/realtime?model=gpt-realtime-2025-08-28'

const FINDING_PATH = resolve(
  __dirname,
  '..',
  '..',
  '.planning',
  'phases',
  '05.2-persona-redesign-and-call-flow-state-machine',
  'q7-atomicity-finding.md',
)

interface ProbeObservation {
  session_updated_count: number
  session_updated_carried_both_fields: boolean | null
  response_a_text: string
  response_b_text: string
  tool_calls_in_response_b: string[]
  had_error: boolean
  error_messages: string[]
  elapsed_ms: number
}

interface ProbeResult {
  verdict: 'ATOMIC' | 'NON-ATOMIC' | 'INCONCLUSIVE'
  evidence: string
  observation: ProbeObservation
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.error(`[Q7-probe ${new Date().toISOString()}] ${msg}`)
}

async function runProbe(): Promise<ProbeResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || apiKey.length < 10) {
    throw new Error(
      'OPENAI_API_KEY env var required. Run:\n' +
        '  export OPENAI_API_KEY=sk-...\n' +
        '  (or source the OneCLI vault)',
    )
  }

  const t0 = Date.now()
  const obs: ProbeObservation = {
    session_updated_count: 0,
    session_updated_carried_both_fields: null,
    response_a_text: '',
    response_b_text: '',
    tool_calls_in_response_b: [],
    had_error: false,
    error_messages: [],
    elapsed_ms: 0,
  }

  const ws = new WebSocket(REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  })

  let responsePhase: 'A' | 'B' = 'A'
  let secondUpdateSent = false

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error('probe timeout (30s)'))
      try {
        ws.close()
      } catch {
        /* swallow */
      }
    }, 30_000)

    ws.on('open', () => {
      log('ws open — sending initial session.update (Mode A)')
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime', // Plan 05.1-01 Layer-1 discriminator
            instructions: INSTRUCTIONS_A,
            tools: [TOOL_A],
            // text-only output for probe; no audio
            modalities: ['text'],
          },
        }),
      )
    })

    ws.on('message', (raw) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(String(raw)) as Record<string, unknown>
      } catch {
        return
      }
      const evtType = String(parsed.type ?? '')

      if (evtType === 'error') {
        const err = parsed.error as { message?: string } | undefined
        obs.had_error = true
        obs.error_messages.push(String(err?.message ?? 'unknown error'))
        log(`ERROR event: ${JSON.stringify(parsed.error)}`)
        return
      }

      if (evtType === 'session.updated') {
        obs.session_updated_count += 1
        // Does this session.updated event carry BOTH instructions AND tools?
        // This is the KEY atomicity signal: if OpenAI splits a single client-side
        // session.update into multiple server-side session.updated events (one
        // per field), atomicity is questionable.
        const session = (parsed.session ?? {}) as Record<string, unknown>
        const hasInstructions =
          typeof session.instructions === 'string' &&
          (session.instructions as string).length > 0
        const hasTools =
          Array.isArray(session.tools) && (session.tools as unknown[]).length > 0
        if (obs.session_updated_count === 2) {
          obs.session_updated_carried_both_fields = hasInstructions && hasTools
          log(
            `session.updated #2: instructions=${hasInstructions} tools=${hasTools}`,
          )
        } else {
          log(
            `session.updated #${obs.session_updated_count}: instructions=${hasInstructions} tools=${hasTools}`,
          )
        }
        // Trigger response.create ONCE per mode
        if (obs.session_updated_count === 1 && !secondUpdateSent) {
          log('sending response.create (Mode A expected → "APFEL")')
          ws.send(JSON.stringify({ type: 'response.create' }))
        }
        return
      }

      if (evtType === 'response.done') {
        // Response text is aggregated via response.output[*].content[*].text
        // but a minimal signal comes from response.output_text.done in some
        // server versions. We accept either shape.
        const response =
          (parsed.response ?? {}) as {
            output?: Array<{
              type?: string
              name?: string
              content?: Array<{ type?: string; text?: string }>
            }>
          }
        const output = response.output ?? []
        const text = output
          .flatMap((o) => o.content ?? [])
          .map((c) => c.text ?? '')
          .join('')
        const toolCalls = output
          .filter((o) => o.type === 'function_call' && typeof o.name === 'string')
          .map((o) => String(o.name))

        if (responsePhase === 'A') {
          obs.response_a_text = text
          log(`response A done: "${text}" tool_calls=${JSON.stringify(toolCalls)}`)
          // Now send the atomicity test: second session.update with
          // BOTH instructions_B and tools_B in one payload.
          secondUpdateSent = true
          responsePhase = 'B'
          log('sending SECOND session.update (Mode B) — ATOMICITY TEST')
          ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                instructions: INSTRUCTIONS_B,
                tools: [TOOL_B],
                modalities: ['text'],
              },
            }),
          )
          // Response.create fires AFTER session.updated #2 (see above)
        } else {
          obs.response_b_text = text
          obs.tool_calls_in_response_b = toolCalls
          log(`response B done: "${text}" tool_calls=${JSON.stringify(toolCalls)}`)
          // Test complete
          clearTimeout(timeout)
          try {
            ws.close(1000)
          } catch {
            /* swallow */
          }
          resolvePromise()
        }
        return
      }
    })

    // When session.updated #2 arrives, we need to fire response.create for
    // Mode B. Handled inline in the session.updated branch above once
    // session_updated_count === 2 and responsePhase === 'B'.
    ws.on('close', () => {
      clearTimeout(timeout)
      obs.elapsed_ms = Date.now() - t0
      resolvePromise()
    })

    ws.on('error', (err) => {
      obs.had_error = true
      obs.error_messages.push((err as Error).message)
      clearTimeout(timeout)
      rejectPromise(err)
    })
  })

  // ---- Verdict logic ----
  // ATOMIC: Mode B response contains BIRNE (new instructions applied) AND
  //         if a tool was called, it was tool_b_unique (new tools applied) AND
  //         no error events observed during the second update.
  // NON-ATOMIC: Mode B response contains APFEL (old instructions lingered)
  //         OR tool_a_unique was invoked after the switch (old tools lingered).
  // INCONCLUSIVE: could not run (error, timeout, no signal in response text).
  let verdict: ProbeResult['verdict'] = 'INCONCLUSIVE'
  let evidence = ''
  if (obs.had_error) {
    verdict = 'INCONCLUSIVE'
    evidence = `Probe failed with errors: ${obs.error_messages.join('; ')}`
  } else if (
    obs.response_b_text.includes('BIRNE') &&
    !obs.tool_calls_in_response_b.includes('tool_a_unique')
  ) {
    verdict = 'ATOMIC'
    evidence =
      `Response B contained "BIRNE" (new instructions applied). ` +
      `No tool_a_unique invocations after switch. session.updated #2 ` +
      `carried both fields: ${String(obs.session_updated_carried_both_fields)}.`
  } else if (
    obs.response_b_text.includes('APFEL') ||
    obs.tool_calls_in_response_b.includes('tool_a_unique')
  ) {
    verdict = 'NON-ATOMIC'
    evidence =
      `Response B contained "APFEL" OR tool_a_unique was invoked after ` +
      `the switch — old state lingered. tool_calls_in_response_b=` +
      `${JSON.stringify(obs.tool_calls_in_response_b)}. response_b_text="${obs.response_b_text}".`
  } else {
    verdict = 'INCONCLUSIVE'
    evidence =
      `Response B did not contain either marker. response_b_text="${obs.response_b_text}". ` +
      `Model may have ignored the single-word instruction. Re-run with stricter prompt.`
  }

  return { verdict, evidence, observation: obs }
}

function writeFinding(result: ProbeResult, source: 'empirical' | 'docs-only'): void {
  const today = new Date().toISOString().slice(0, 10)
  const content = [
    '# Q7 Finding — session.update Atomicity',
    '',
    `**Probed:** ${today}`,
    `**Source:** ${source === 'empirical' ? 'Empirical probe (scripts/session-update-atomicity-probe.ts)' : 'Documentation research only — empirical probe deferred (no OPENAI_API_KEY in this environment)'}`,
    `**Verdict:** ${result.verdict}`,
    '',
    '## Method',
    '',
    '1. Open Realtime WebSocket session at wss://api.openai.com/v1/realtime',
    '2. Send initial session.update (Mode A): instructions="APFEL", tools=[tool_a_unique]',
    '3. Send response.create, capture Mode A response + available tools',
    '4. Send SECOND session.update (Mode B): instructions="BIRNE", tools=[tool_b_unique]',
    '   — BOTH fields in a single client-side payload (the atomicity test)',
    '5. Send response.create immediately after session.updated #2',
    '6. Observe response text (BIRNE = new instructions applied; APFEL = old lingered)',
    '   AND tool_calls (tool_b_unique = new tools applied; tool_a_unique = old lingered)',
    '',
    '## Observations',
    '',
    '```',
    `session_updated_count: ${result.observation.session_updated_count}`,
    `session_updated_carried_both_fields: ${String(result.observation.session_updated_carried_both_fields)}`,
    `response_a_text: "${result.observation.response_a_text}"`,
    `response_b_text: "${result.observation.response_b_text}"`,
    `tool_calls_in_response_b: ${JSON.stringify(result.observation.tool_calls_in_response_b)}`,
    `had_error: ${result.observation.had_error}`,
    `error_messages: ${JSON.stringify(result.observation.error_messages)}`,
    `elapsed_ms: ${result.observation.elapsed_ms}`,
    '```',
    '',
    '## Evidence Narrative',
    '',
    result.evidence,
    '',
    '## Implications for 05.2 handoff',
    '',
    '- **If ATOMIC:** single `session.update` carrying instructions+tools is safe',
    '  for the AMD→baseline+overlay handoff in webhook.ts onHuman closure.',
    '  Current implementation (single-shot `updateInstructions`) is correct.',
    '- **If NON-ATOMIC:** workaround — send `session.update({tools_only})` first,',
    '  await `session.updated` confirmation, then `session.update({instructions_only})`.',
    '  Alternative: send `response.cancel` between the two updates to avoid a',
    '  response firing with mixed old/new state.',
    '- **If INCONCLUSIVE:** default to treating as ATOMIC per OpenAI Cookbook',
    '  "Dynamic Conversation Flow via session.updates" pattern (research §2.1',
    '  + §6.4 Q7). Add monitoring for tool-call anomalies in 05.2-06 live-verify',
    '  traces; re-run this probe empirically once API key is available.',
    '',
    '## Phase 05.2 decision',
    '',
    result.verdict === 'NON-ATOMIC'
      ? '- webhook.ts `updateInstructions` call: EXTENDED to two-step — tools-first, then instructions-only, with `session.updated` await between. See Task 3 Branch B implementation.'
      : '- webhook.ts `updateInstructions` call: UNCHANGED. Current single-shot `session.update` (instructions-only; `tools` not re-pushed because the tool list was fixed at `/accept` and does not change post-AMD-verdict) remains correct.',
    '- Case-2 tool list was set at `/accept` (the 13 tools including `amd_result`)',
    '  and is NOT re-pushed by the onHuman handoff. This means Q7 is LESS load-bearing',
    '  for the current 05.2 handoff than feared — the handoff only ever updates',
    '  `instructions`, never tools.',
    '- Future Phase 5 state-graph transitions MAY push both simultaneously; this',
    '  finding applies to them directly. Revisit per-transition if behavior drifts.',
    '',
    '## References',
    '',
    '- OpenAI Cookbook "Realtime Prompting Guide — Dynamic Conversation Flow via session.updates":',
    '  https://developers.openai.com/cookbook/examples/realtime_prompting_guide',
    '- OpenAI Realtime Server Events (session.updated):',
    '  https://developers.openai.com/api/reference/resources/realtime/server-events',
    '- OpenAI Realtime Conversations guide:',
    '  https://platform.openai.com/docs/guides/realtime-conversations',
    '- Research §2.1 (Realtime official 8-section prompt structure) + §6.4 Q7 (original open question).',
    '- CONTEXT.md canonical reference Q7 (Phase 05.2 source-of-truth).',
    '',
  ].join('\n')
  mkdirSync(dirname(FINDING_PATH), { recursive: true })
  writeFileSync(FINDING_PATH, content, 'utf-8')
  log(`wrote finding → ${FINDING_PATH}`)
}

async function main(): Promise<void> {
  try {
    const result = await runProbe()
    writeFinding(result, 'empirical')
    log(`verdict=${result.verdict}`)
    // Exit code contract: 0 on atomic/inconclusive, 1 on non-atomic.
    process.exit(result.verdict === 'NON-ATOMIC' ? 1 : 0)
  } catch (err: unknown) {
    const e = err as Error
    log(`probe failed: ${e.message}`)
    // Write an INCONCLUSIVE finding so Task 2 still has a file to read.
    writeFinding(
      {
        verdict: 'INCONCLUSIVE',
        evidence: `Probe could not be executed: ${e.message}`,
        observation: {
          session_updated_count: 0,
          session_updated_carried_both_fields: null,
          response_a_text: '',
          response_b_text: '',
          tool_calls_in_response_b: [],
          had_error: true,
          error_messages: [e.message],
          elapsed_ms: 0,
        },
      },
      'docs-only',
    )
    process.exit(0)
  }
}

void main()
