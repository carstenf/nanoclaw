// voice-bridge/src/tools/tool-output-emitter.ts
// Plan 02-11: WS-send helpers for emitting function_call_output and
// response.create back to the OpenAI Realtime sideband WebSocket.
// Both functions are fire-safe: any WS error is caught, logged at WARN,
// and the function returns false — the sideband message-loop never crashes
// (REQ-DIR-02 hot-path-continuity).
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'

/**
 * Emit `conversation.item.create` with `type: 'function_call_output'` back to
 * OpenAI Realtime sideband WS. This tells the model what the tool returned.
 *
 * @param ws           - Open sideband WebSocket
 * @param functionCallId - `call_id` from the `response.function_call_arguments.done` event
 * @param payload      - Tool result object (will be JSON.stringify-ed)
 * @param log          - Pino logger (call-scoped)
 * @returns true if ws.send succeeded, false otherwise
 */
export function emitFunctionCallOutput(
  ws: WSType,
  functionCallId: string,
  payload: unknown,
  log: Logger,
): boolean {
  try {
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: functionCallId,
          output: JSON.stringify(payload),
        },
      }),
    )
    return true
  } catch (e: unknown) {
    const err = e as Error
    log.warn({
      event: 'tool_output_emit_failed',
      function_call_id: functionCallId,
      err: err.message,
    })
    return false
  }
}

/**
 * Emit `response.create` to OpenAI Realtime sideband WS so the model
 * synthesises an audio response after receiving the function_call_output.
 * In v0 this is always fired after every function_call_output.
 *
 * @param ws  - Open sideband WebSocket
 * @param log - Pino logger (call-scoped)
 * @returns true if ws.send succeeded, false otherwise
 */
export function emitResponseCreate(ws: WSType, log: Logger): boolean {
  try {
    ws.send(JSON.stringify({ type: 'response.create' }))
    return true
  } catch (e: unknown) {
    const err = e as Error
    log.warn({
      event: 'response_create_emit_failed',
      err: err.message,
    })
    return false
  }
}
