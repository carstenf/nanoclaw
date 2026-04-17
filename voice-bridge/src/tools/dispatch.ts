// voice-bridge/src/tools/dispatch.ts
// Thin MCP-proxy gate (D-36). Validates tool-name + args, returns synthetic
// tool_error on fail, placeholder on success (MCP forward in later plan).
import type { Logger } from 'pino'
import { getEntry, INVALID_TOOL_RESPONSE } from './allowlist.js'

export interface DispatchOk {
  type: 'tool_call_accepted'
  tool_name: string
}

export interface DispatchErr {
  type: 'tool_error'
  message: string
  code: 'invalid_tool_call'
}

export type DispatchResult = DispatchOk | DispatchErr

export function dispatchTool(
  callId: string,
  turnId: string,
  toolName: string,
  args: unknown,
  log: Logger,
): DispatchResult {
  const entry = getEntry(toolName)
  if (!entry) {
    log.warn({
      event: 'invalid_tool_call',
      call_id: callId,
      turn_id: turnId,
      tool_name: toolName,
      reason: 'unknown_name',
    })
    return INVALID_TOOL_RESPONSE
  }
  if (!entry.validate(args)) {
    log.warn({
      event: 'invalid_tool_call',
      call_id: callId,
      turn_id: turnId,
      tool_name: toolName,
      reason: 'schema_fail',
      ajv_errors: entry.validate.errors,
    })
    return INVALID_TOOL_RESPONSE
  }
  // D-36: Phase 2 scope ends at the gate. Actual MCP forwarding arrives with
  // the Case-6 tool wiring in Phase 3/4. Return accepted-stub so upstream
  // idempotency wrapper (02-02) has something to cache.
  return { type: 'tool_call_accepted', tool_name: toolName }
}
