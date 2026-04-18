// voice-bridge/src/tools/dispatch.ts
// Plan 02-11: async MCP-forward gate (replaces 02-07 stub).
// Validates tool-name + args via allowlist, maps to Core MCP tool name
// (prefix voice.), calls Core, emits function_call_output + response.create.
// All error paths (timeout, unavailable, invalid, not_implemented) emit a
// synthetic error payload so the bot can respond gracefully (AC-06).
import type { Logger } from 'pino'
import type { WebSocket as WSType } from 'ws'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getEntry } from './allowlist.js'
import {
  callCoreTool as _callCoreTool,
  CoreMcpTimeoutError,
  CoreMcpError,
} from '../core-mcp-client.js'
import {
  emitFunctionCallOutput as _emitFunctionCallOutput,
  emitResponseCreate as _emitResponseCreate,
} from './tool-output-emitter.js'
import { emitFillerPhrase as _emitFillerPhrase } from './filler-inject.js'
import {
  DISPATCH_TOOL_TIMEOUT_MS,
  FILLER_PHRASE_TOOLS,
  TOOL_DISPATCH_JSONL_PATH,
} from '../config.js'

// Tool-name mapping: bridge tool name → Core MCP tool name.
// null  = not implemented (03-08 skipped or bridge-internal, stub path).
// undefined = unknown → invalid_tool_call (caught by allowlist check before we get here).
const TOOL_TO_CORE_MCP: Record<string, string | null> = {
  check_calendar: 'voice.check_calendar',
  create_calendar_entry: 'voice.create_calendar_entry',
  send_discord_message: 'voice.send_discord_message',
  get_contract: 'voice.get_contract',
  get_practice_profile: 'voice.get_practice_profile',
  schedule_retry: 'voice.schedule_retry',
  search_competitors: null, // 03-08 skipped
  search_hotels: null, // 03-08 skipped
  transfer_call: null, // bridge-internal, 02-12+
  confirm_action: null, // bridge-internal, 02-04 readback
  ask_core: 'voice.ask_core',
  get_travel_time: 'voice.get_travel_time',
}

export interface DispatchOpts {
  /** DI: override callCoreTool for tests */
  callCoreTool?: (
    name: string,
    args: unknown,
    opts: { timeoutMs: number },
  ) => Promise<unknown>
  /** DI: override emitFunctionCallOutput for tests */
  emitFunctionCallOutput?: (
    ws: WSType,
    functionCallId: string,
    payload: unknown,
    log: Logger,
  ) => boolean
  /** DI: override emitResponseCreate for tests */
  emitResponseCreate?: (ws: WSType, log: Logger) => boolean
  /** DI: override emitFillerPhrase for tests (fire-and-forget filler injection) */
  emitFiller?: (
    ws: WSType,
    toolName: string,
    callId: string,
    log: Logger,
  ) => Promise<boolean>
  /** timeout override (default DISPATCH_TOOL_TIMEOUT_MS from config) */
  dispatchTimeoutMs?: number
  /** JSONL path override (default from config) */
  jsonlPath?: string
}

function appendJsonl(path: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    /* JSONL write failure is never fatal */
  }
}

/**
 * Async MCP-forward dispatch. Validates tool + args, maps to Core tool name,
 * calls Core, emits function_call_output + response.create.
 * Fire-and-forget safe: all errors are caught internally and emitted as error
 * payloads to the bot. Never throws.
 */
export async function dispatchTool(
  ws: WSType,
  callId: string,
  turnId: string,
  functionCallId: string,
  toolName: string,
  args: unknown,
  log: Logger,
  opts: DispatchOpts = {},
): Promise<void> {
  const callCore = opts.callCoreTool ?? _callCoreTool
  const emitOutput = opts.emitFunctionCallOutput ?? _emitFunctionCallOutput
  const emitCreate = opts.emitResponseCreate ?? _emitResponseCreate
  const emitFiller = opts.emitFiller ?? _emitFillerPhrase
  const timeoutMs = opts.dispatchTimeoutMs ?? DISPATCH_TOOL_TIMEOUT_MS
  const jsonlPath = opts.jsonlPath ?? TOOL_DISPATCH_JSONL_PATH

  // 1. Validate tool name against allowlist
  const entry = getEntry(toolName)
  if (!entry) {
    log.warn({
      event: 'invalid_tool_call',
      call_id: callId,
      turn_id: turnId,
      tool_name: toolName,
      reason: 'unknown_name',
    })
    emitOutput(ws, functionCallId, { error: 'invalid_tool_call' }, log)
    emitCreate(ws, log)
    return
  }

  // 2. Validate args against JSON schema
  if (!entry.validate(args)) {
    log.warn({
      event: 'invalid_tool_call',
      call_id: callId,
      turn_id: turnId,
      tool_name: toolName,
      reason: 'schema_fail',
      ajv_errors: entry.validate.errors,
    })
    emitOutput(ws, functionCallId, { error: 'invalid_tool_call' }, log)
    emitCreate(ws, log)
    return
  }

  // 3. Map to Core MCP name
  const coreName = TOOL_TO_CORE_MCP[toolName]
  if (coreName === null) {
    // Known but not implemented (03-08 skip or bridge-internal stub)
    log.info({
      event: 'tool_not_implemented',
      call_id: callId,
      turn_id: turnId,
      tool_name: toolName,
    })
    emitOutput(ws, functionCallId, { error: 'not_implemented' }, log)
    emitCreate(ws, log)
    appendJsonl(jsonlPath, {
      ts: Date.now(),
      event: 'tool_dispatch_done',
      call_id: callId,
      function_call_id: functionCallId,
      tool_name: toolName,
      latency_ms: 0,
      mcp_status: 'not_implemented',
      bytes_out: 0,
    })
    return
  }

  // 3b. Filler-phrase injection for long-latency tools (Plan 02-14, REQ-C6B-02).
  // Fire-and-forget from caller's perspective but awaited here so filler is sent
  // before the slow MCP call begins. Never blocks dispatch on failure.
  if (FILLER_PHRASE_TOOLS.includes(toolName)) {
    await emitFiller(ws, toolName, callId, log).catch((err: Error) =>
      log.warn({
        event: 'filler_emit_failed',
        tool_name: toolName,
        err: err.message,
      }),
    )
  }

  // 4. Call Core MCP with timeout
  const t0 = Date.now()
  let mcpStatus: 'ok' | 'err' | 'timeout' | 'not_implemented' = 'ok'
  let resultPayload: unknown

  try {
    const result = await callCore(coreName, args, { timeoutMs })
    const latency = Date.now() - t0
    mcpStatus = 'ok'
    resultPayload = result

    log.info({
      event: 'tool_dispatch_ok',
      call_id: callId,
      turn_id: turnId,
      tool_name: toolName,
      core_name: coreName,
      latency_ms: latency,
    })
    emitOutput(ws, functionCallId, result, log)
    emitCreate(ws, log)

    appendJsonl(jsonlPath, {
      ts: Date.now(),
      event: 'tool_dispatch_done',
      call_id: callId,
      function_call_id: functionCallId,
      tool_name: toolName,
      latency_ms: latency,
      mcp_status: mcpStatus,
      bytes_out: JSON.stringify(resultPayload).length,
    })
  } catch (e: unknown) {
    const latency = Date.now() - t0

    if (e instanceof CoreMcpTimeoutError) {
      mcpStatus = 'timeout'
      log.warn({
        event: 'tool_dispatch_timeout',
        call_id: callId,
        turn_id: turnId,
        tool_name: toolName,
        latency_ms: latency,
      })
      emitOutput(ws, functionCallId, { error: 'tool_timeout' }, log)
    } else if (e instanceof CoreMcpError) {
      mcpStatus = 'err'
      log.warn({
        event: 'tool_dispatch_mcp_error',
        call_id: callId,
        turn_id: turnId,
        tool_name: toolName,
        status: e.status,
        latency_ms: latency,
      })
      emitOutput(ws, functionCallId, { error: 'tool_unavailable' }, log)
    } else {
      mcpStatus = 'err'
      const err = e as Error
      log.warn({
        event: 'tool_dispatch_error',
        call_id: callId,
        turn_id: turnId,
        tool_name: toolName,
        err: err.message,
        latency_ms: latency,
      })
      emitOutput(ws, functionCallId, { error: 'tool_unavailable' }, log)
    }
    emitCreate(ws, log)

    appendJsonl(jsonlPath, {
      ts: Date.now(),
      event: 'tool_dispatch_done',
      call_id: callId,
      function_call_id: functionCallId,
      tool_name: toolName,
      latency_ms: latency,
      mcp_status: mcpStatus,
      bytes_out: 0,
    })
  }
}
