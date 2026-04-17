import { describe, it, expect } from 'vitest'
import {
  getAllowlist,
  getEntry,
  INVALID_TOOL_RESPONSE,
  type ToolEntry,
} from '../src/tools/allowlist.js'

describe('tools/allowlist — REQ-TOOLS registry (D-07, D-08)', () => {
  it('exposes exactly 9 entries (REQ-TOOLS-01..08 + confirm_action)', () => {
    const entries = getAllowlist()
    expect(entries.length).toBe(9)
  })

  it('enforces the REQ-TOOLS-09 ceiling of 15 at module load', () => {
    const entries = getAllowlist()
    expect(entries.length).toBeLessThanOrEqual(15)
  })

  it('marks exactly 5 tools as mutating (D-05)', () => {
    const entries = getAllowlist()
    const mutating = entries.filter((e: ToolEntry) => e.mutating)
    expect(mutating.length).toBe(5)
    expect(mutating.map((e) => e.name).sort()).toEqual([
      'confirm_action',
      'create_calendar_entry',
      'schedule_retry',
      'send_discord_message',
      'transfer_call',
    ])
  })

  it('marks exactly 4 tools as non-mutating', () => {
    const entries = getAllowlist()
    const readOnly = entries.filter((e: ToolEntry) => !e.mutating)
    expect(readOnly.length).toBe(4)
    expect(readOnly.map((e) => e.name).sort()).toEqual([
      'check_calendar',
      'get_contract',
      'get_practice_profile',
      'search_competitors',
    ])
  })

  it('getEntry returns entry for known tool name with compiled validator', () => {
    const entry = getEntry('create_calendar_entry')
    expect(entry).toBeDefined()
    expect(entry?.mutating).toBe(true)
    expect(typeof entry?.validate).toBe('function')
  })

  it('getEntry returns undefined for fabricated tool name (T-02-01-01)', () => {
    expect(getEntry('foo_bar_drop_db')).toBeUndefined()
    expect(getEntry('')).toBeUndefined()
  })

  it('check_calendar is read-only (mutating=false)', () => {
    expect(getEntry('check_calendar')?.mutating).toBe(false)
  })

  it('every entry has a compiled ajv validator function', () => {
    for (const entry of getAllowlist()) {
      expect(typeof entry.validate).toBe('function')
      expect(entry.schema).toBeTypeOf('object')
    }
  })

  it('validate accepts correct args for create_calendar_entry', () => {
    const entry = getEntry('create_calendar_entry')!
    expect(
      entry.validate({
        title: 'Zahnarzt',
        date: '2026-05-01',
        time: '14:00',
        duration: 60,
      }),
    ).toBe(true)
  })

  it('validate rejects additionalProperties (T-02-01-02)', () => {
    const entry = getEntry('create_calendar_entry')!
    expect(
      entry.validate({
        title: 'Zahnarzt',
        date: '2026-05-01',
        time: '14:00',
        duration: 60,
        evil_field: 'drop table',
      }),
    ).toBe(false)
  })

  it('INVALID_TOOL_RESPONSE carries the canonical German safety message', () => {
    expect(INVALID_TOOL_RESPONSE.type).toBe('tool_error')
    expect(INVALID_TOOL_RESPONSE.code).toBe('invalid_tool_call')
    expect(INVALID_TOOL_RESPONSE.message).toBe(
      'Das kann ich gerade leider nicht nachsehen.',
    )
  })
})
