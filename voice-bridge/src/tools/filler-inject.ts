// voice-bridge/src/tools/filler-inject.ts
// Phase 05.3 — Code-side filler-phrase injection for long-latency tools.
// Phase 06.x — language-neutral redesign: emit a single response.create with
// an English instruction-override; the model produces the filler in whatever
// speaking language the call is currently in (driven by session.instructions
// which the persona renders + applyLanguageSwitch updates on every switch).
// No literal text is injected — no per-call lang map, no DE/EN/IT mapping.
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'

/**
 * Language-neutral instruction text per tool name. Written once in English
 * (the model's instruction-language) so a single phrasing serves all
 * speaking languages. The model speaks the filler in the SAME language it
 * is currently speaking (per persona instructions), not in English.
 *
 * Wording rules:
 *  - One short sentence (max ~5 words spoken).
 *  - Never name internal components ("Andy", "Core", "MCP").
 *  - The instruction itself dictates the behavior — no quoted phrase.
 */
const FILLER_INSTRUCTIONS: Map<string, string> = new Map([
  [
    'ask_core',
    'Briefly acknowledge that you are checking — one short sentence, max five words. Speak in the same language you have been using on this call. Do not say anything else.',
  ],
])

/**
 * Per-call filler-emit dedup (Plan 02-15 fix): OpenAI sometimes retries the
 * same function_call_arguments.done event, causing the filler to play twice
 * in quick succession. We skip re-emission within FILLER_COOLDOWN_MS of the
 * last emission for the same call+tool pair.
 */
const FILLER_COOLDOWN_MS = 30_000
const lastEmitAt: Map<string, number> = new Map()

/**
 * Emit a filler-only response.create to the OpenAI Realtime sideband WS.
 *
 * Single message: response.create with audio-only output, tool_choice:'none'
 * (prevents the model from re-emitting the in-flight function_call during
 * the filler response — see Plan 02-15 root-cause analysis below) and an
 * `instructions` field that overrides session.instructions for this one
 * response. The override is language-neutral; the model produces the filler
 * in the active speaking language.
 *
 * Never throws — on ws.send failure: warn-logs and returns false.
 *
 * @param ws       - Open sideband WebSocket
 * @param toolName - Tool name that triggered the filler (must be in FILLER_INSTRUCTIONS)
 * @param callId   - Call ID for log context
 * @param log      - Pino logger (call-scoped)
 * @returns true if filler was emitted, false if skipped or failed
 */
export async function emitFillerPhrase(
  ws: WSType,
  toolName: string,
  callId: string,
  log: Logger,
): Promise<boolean> {
  const instructions = FILLER_INSTRUCTIONS.get(toolName)
  if (!instructions) {
    return false
  }

  const dedupKey = `${callId}:${toolName}`
  const last = lastEmitAt.get(dedupKey)
  const now = Date.now()
  if (last !== undefined && now - last < FILLER_COOLDOWN_MS) {
    log.info({
      event: 'filler_phrase_deduplicated',
      call_id: callId,
      tool_name: toolName,
      since_last_ms: now - last,
    })
    return false
  }
  lastEmitAt.set(dedupKey, now)

  try {
    // tool_choice: 'none' — prevents the model from emitting another
    // function_call during this filler-only response. Without this, while
    // the original ask_core dispatch is still in flight (e.g. 6-19 s for
    // Andy reasoning), the model can re-emit the same function_call inside
    // the filler response. OpenAI then cancels that filler response (it
    // already has an in-flight tool_call without output), the cancellation
    // truncates the streaming function_call_arguments, and the bridge sees
    // a malformed args.done it interprets as `invalid_arguments`. The
    // model then synthesises an "Andy nicht erreichbar" turn even though
    // the original tool call eventually answers fine. Restricting the
    // filler response to `audio + tool_choice: 'none'` removes the race
    // at the source.
    //
    // `instructions` here is a per-response override: the model uses it
    // INSTEAD of session.instructions for this one response. Persona-
    // selected speaking language is preserved by the override's explicit
    // "same language you have been using" clause.
    ws.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          tool_choice: 'none',
          instructions,
        },
      }),
    )
    log.info({
      event: 'filler_phrase_emitted',
      call_id: callId,
      tool_name: toolName,
    })
    return true
  } catch (e: unknown) {
    const err = e as Error
    log.warn({
      event: 'filler_emit_failed',
      call_id: callId,
      tool_name: toolName,
      err: err.message,
    })
    return false
  }
}
