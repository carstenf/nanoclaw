// voice-bridge/src/tools/filler-inject.ts
// Phase 05.3 — Code-side filler-phrase injection for long-latency tools.
// Sends a synthetic assistant message + response.create so OpenAI TTS speaks
// the filler while the slow tool (e.g. ask_core) is executing. The filler
// must be emitted within 1000 ms of the delegation-trigger (REQ-C6B-02).
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'

/**
 * Hard-coded filler messages per tool name (v1).
 * Extensible: add entries here to cover more long-latency tools.
 */
const FILLER_MESSAGES: Map<string, string> = new Map([
  ['ask_core', 'Moment, ich frage Andy...'],
])

/**
 * Per-call filler-emit dedup (Plan 02-15 fix): OpenAI sometimes retries the
 * same function_call_arguments.done event, causing the filler to play twice
 * in quick succession ("Moment... Moment..."). We skip re-emission within
 * FILLER_COOLDOWN_MS of the last emission for the same call+tool pair.
 */
const FILLER_COOLDOWN_MS = 30_000
const lastEmitAt: Map<string, number> = new Map()

/**
 * Emit a synthetic assistant filler phrase to the OpenAI Realtime sideband WS.
 *
 * Sends two messages in sequence:
 *  1. conversation.item.create  (assistant text message)
 *  2. response.create           (triggers TTS synthesis of the text)
 *
 * Never throws — on ws.send failure: warn-logs and returns false.
 *
 * @param ws       - Open sideband WebSocket
 * @param toolName - Tool name that triggered the filler (must be in FILLER_MESSAGES)
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
  const msg = FILLER_MESSAGES.get(toolName)
  if (!msg) {
    return false
  }

  // Dedup: skip if same call+tool fired filler within cooldown window.
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
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: msg }],
        },
      }),
    )
    ws.send(
      JSON.stringify({
        type: 'response.create',
        response: { modalities: ['audio', 'text'] },
      }),
    )
    log.info({
      event: 'filler_phrase_emitted',
      call_id: callId,
      tool_name: toolName,
      msg,
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
