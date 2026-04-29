// voice-bridge/src/tools/allowlist.ts
// Static tool registry derived from REQ-TOOLS-01..08 + confirm_action (D-07).
// Bridge NEVER re-implements handler bodies (AC-09, D-35, D-36).
import { Ajv } from 'ajv'
import addFormatsModule from 'ajv-formats'
import type { ValidateFunction } from 'ajv'

// ajv-formats ships as CJS with `exports.default = ...`. Under NodeNext the
// default import resolves to the module namespace, so we have to unwrap
// `.default` at runtime. Cast to a call signature so the call stays typed.
type AddFormats = (ajv: Ajv, opts?: unknown) => Ajv
const addFormats = (
  ((addFormatsModule as unknown) as { default?: AddFormats }).default ??
  ((addFormatsModule as unknown) as AddFormats)
) as AddFormats

import checkCalendarSchema from './schemas/check_calendar.json' with { type: 'json' }
import createCalendarEntrySchema from './schemas/create_calendar_entry.json' with { type: 'json' }
import sendDiscordMessageSchema from './schemas/send_discord_message.json' with { type: 'json' }
import getContractSchema from './schemas/get_contract.json' with { type: 'json' }
import searchCompetitorsSchema from './schemas/search_competitors.json' with { type: 'json' }
import getPracticeProfileSchema from './schemas/get_practice_profile.json' with { type: 'json' }
import scheduleRetrySchema from './schemas/schedule_retry.json' with { type: 'json' }
import transferCallSchema from './schemas/transfer_call.json' with { type: 'json' }
import confirmActionSchema from './schemas/confirm_action.json' with { type: 'json' }
import askCoreSchema from './schemas/ask_core.json' with { type: 'json' }
import getTravelTimeSchema from './schemas/get_travel_time.json' with { type: 'json' }
import requestOutboundCallSchema from './schemas/request_outbound_call.json' with { type: 'json' }
import deleteCalendarEntrySchema from './schemas/delete_calendar_entry.json' with { type: 'json' }
import updateCalendarEntrySchema from './schemas/update_calendar_entry.json' with { type: 'json' }
import endCallSchema from './schemas/end_call.json' with { type: 'json' }
import setLanguageSchema from './schemas/set_language.json' with { type: 'json' }

export interface ToolEntry {
  name: string
  mutating: boolean
  schema: Record<string, unknown>
  validate: ValidateFunction
  /**
   * If true, dispatch.ts injects the live `rtc_*` call_id into the tool args
   * before forwarding to Core. Required for tools whose Core handler must
   * correlate back to this voice call (e.g. ask_core → voice_respond
   * Promise-match). The bot's function_call args don't carry call_id by
   * default — only the tool's declared schema fields.
   */
  injectCallId?: boolean
}

const ajv = new Ajv({ strict: true })
addFormats(ajv)

const ENTRIES: ToolEntry[] = [
  { name: 'check_calendar',        mutating: false, schema: checkCalendarSchema as Record<string, unknown>,        validate: ajv.compile(checkCalendarSchema) },
  { name: 'create_calendar_entry', mutating: true,  schema: createCalendarEntrySchema as Record<string, unknown>, validate: ajv.compile(createCalendarEntrySchema) },
  { name: 'send_discord_message',  mutating: true,  schema: sendDiscordMessageSchema as Record<string, unknown>,  validate: ajv.compile(sendDiscordMessageSchema) },
  { name: 'get_contract',          mutating: false, schema: getContractSchema as Record<string, unknown>,          validate: ajv.compile(getContractSchema) },
  { name: 'search_competitors',    mutating: false, schema: searchCompetitorsSchema as Record<string, unknown>,    validate: ajv.compile(searchCompetitorsSchema) },
  { name: 'get_practice_profile',  mutating: false, schema: getPracticeProfileSchema as Record<string, unknown>,  validate: ajv.compile(getPracticeProfileSchema) },
  { name: 'schedule_retry',        mutating: true,  schema: scheduleRetrySchema as Record<string, unknown>,        validate: ajv.compile(scheduleRetrySchema) },
  { name: 'transfer_call',         mutating: true,  schema: transferCallSchema as Record<string, unknown>,         validate: ajv.compile(transferCallSchema) },
  { name: 'confirm_action',        mutating: true,  schema: confirmActionSchema as Record<string, unknown>,        validate: ajv.compile(confirmActionSchema) },
  { name: 'ask_core',              mutating: false, schema: askCoreSchema as Record<string, unknown>,              validate: ajv.compile(askCoreSchema),              injectCallId: true },
  { name: 'get_travel_time',       mutating: false, schema: getTravelTimeSchema as Record<string, unknown>,       validate: ajv.compile(getTravelTimeSchema) },
  { name: 'request_outbound_call', mutating: true,  schema: requestOutboundCallSchema as Record<string, unknown>, validate: ajv.compile(requestOutboundCallSchema) },
  { name: 'delete_calendar_entry', mutating: true,  schema: deleteCalendarEntrySchema as Record<string, unknown>, validate: ajv.compile(deleteCalendarEntrySchema) },
  { name: 'update_calendar_entry', mutating: true,  schema: updateCalendarEntrySchema as Record<string, unknown>, validate: ajv.compile(updateCalendarEntrySchema) },
  { name: 'end_call',              mutating: true,  schema: endCallSchema as Record<string, unknown>,              validate: ajv.compile(endCallSchema) },
  // Phase 06.x mid-call language switch. mutating:false because the tool
  // mutates only voice-channel internal state (per-call lang) — not external
  // systems. injectCallId so the NanoClaw handler reads the per-call active
  // whitelist via the gateway.
  { name: 'set_language',          mutating: false, schema: setLanguageSchema as Record<string, unknown>,          validate: ajv.compile(setLanguageSchema), injectCallId: true },
]

// REQ-TOOLS-09 ceiling guard — fires at module load.
// Cap was 15 in Phase 5 (REQ-TOOLS-09 original). Phase 06.x added
// set_language for mid-call language switching → cap raised to 16. Any
// further additions need an architectural review (model-attention budget
// degrades with too many tools).
if (ENTRIES.length > 16) {
  throw new Error(`REQ-TOOLS-09 ceiling 16 exceeded: ${ENTRIES.length}`)
}

const REGISTRY = new Map(ENTRIES.map((e) => [e.name, e]))

export function getAllowlist(): ToolEntry[] {
  return ENTRIES
}

export function getEntry(name: string): ToolEntry | undefined {
  return REGISTRY.get(name)
}

export const INVALID_TOOL_RESPONSE = {
  type: 'tool_error' as const,
  message: 'Das kann ich gerade leider nicht nachsehen.',
  code: 'invalid_tool_call' as const,
}

export function logAllowlistCompiled(log: {
  info: (o: Record<string, unknown>, msg?: string) => void
}): void {
  const tool_count = ENTRIES.length
  const mutating_count = ENTRIES.filter((e) => e.mutating).length
  log.info(
    { event: 'allowlist_compiled', tool_count, mutating_count },
    'tool allowlist compiled',
  )
}
