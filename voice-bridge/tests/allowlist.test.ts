import { describe, it, expect } from 'vitest'
import {
  getAllowlist,
  getEntry,
  INVALID_TOOL_RESPONSE,
  type ToolEntry,
} from '../src/tools/allowlist.js'

describe('tools/allowlist — REQ-TOOLS registry (D-07, D-08)', () => {
  it('exposes exactly 17 entries (Phase 5 set + Phase 06.x set_language + notify_user)', () => {
    const entries = getAllowlist()
    expect(entries.length).toBe(17)
  })

  it('enforces the REQ-TOOLS-09 ceiling of 17 at module load (Phase 06.x raised from 15→16→17)', () => {
    const entries = getAllowlist()
    expect(entries.length).toBeLessThanOrEqual(17)
  })

  it('marks exactly 10 tools as mutating (D-05 + request_outbound_call + delete/update_calendar_entry + end_call + notify_user)', () => {
    const entries = getAllowlist()
    const mutating = entries.filter((e: ToolEntry) => e.mutating)
    expect(mutating.length).toBe(10)
    expect(mutating.map((e) => e.name).sort()).toEqual([
      'confirm_action',
      'create_calendar_entry',
      'delete_calendar_entry',
      'end_call',
      'notify_user',
      'request_outbound_call',
      'schedule_retry',
      'send_discord_message',
      'transfer_call',
      'update_calendar_entry',
    ])
  })

  it('marks exactly 7 tools as non-mutating (read-only set + Phase 06.x set_language)', () => {
    const entries = getAllowlist()
    const readOnly = entries.filter((e: ToolEntry) => !e.mutating)
    expect(readOnly.length).toBe(7)
    expect(readOnly.map((e) => e.name).sort()).toEqual([
      'ask_core',
      'check_calendar',
      'get_contract',
      'get_practice_profile',
      'get_travel_time',
      'search_competitors',
      'set_language',
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

  it('ask_core is in registry with mutating=false (02-12)', () => {
    const entry = getEntry('ask_core')
    expect(entry).toBeDefined()
    expect(entry?.mutating).toBe(false)
    expect(typeof entry?.validate).toBe('function')
  })

  it('ask_core validate accepts valid topic+request (02-12, 02-15 enum)', () => {
    const entry = getEntry('ask_core')!
    expect(entry.validate({ topic: 'andy', request: 'Was sind eure Oeffnungszeiten?' })).toBe(true)
    expect(entry.validate({ topic: 'test', request: 'ping' })).toBe(true)
    // 02-15: topic is now enum ['andy','test'] — non-enum values rejected
    expect(entry.validate({ topic: 'general', request: 'x' })).toBe(false)
    expect(entry.validate({ topic: 'praxis-info', request: 'x' })).toBe(false)
  })

  it('ask_core validate rejects invalid topic pattern (02-12)', () => {
    const entry = getEntry('ask_core')!
    expect(entry.validate({ topic: 'UPPERCASE NOT ALLOWED', request: 'test' })).toBe(false)
  })

  it('get_travel_time is in registry with mutating=false (02-12)', () => {
    const entry = getEntry('get_travel_time')
    expect(entry).toBeDefined()
    expect(entry?.mutating).toBe(false)
    expect(typeof entry?.validate).toBe('function')
  })

  it('get_travel_time validate accepts valid origin+destination (02-12)', () => {
    const entry = getEntry('get_travel_time')!
    expect(entry.validate({ origin: 'Marienplatz, Munich', destination: 'Schwabing, Munich' })).toBe(true)
  })

  it('get_travel_time validate accepts optional mode enum (02-12)', () => {
    const entry = getEntry('get_travel_time')!
    expect(entry.validate({ origin: 'A', destination: 'B', mode: 'transit' })).toBe(true)
    expect(entry.validate({ origin: 'A', destination: 'B', mode: 'flying' })).toBe(false)
  })

  it('delete_calendar_entry is in registry with mutating=true (03-12)', () => {
    const entry = getEntry('delete_calendar_entry')
    expect(entry).toBeDefined()
    expect(entry?.mutating).toBe(true)
  })

  it('delete_calendar_entry validate accepts event_id alone (03-12)', () => {
    const entry = getEntry('delete_calendar_entry')!
    expect(entry.validate({ event_id: 'evt-123' })).toBe(true)
  })

  it('delete_calendar_entry validate accepts title+date alone (03-12)', () => {
    const entry = getEntry('delete_calendar_entry')!
    expect(entry.validate({ title: 'Joggen', date: '2026-04-20' })).toBe(true)
  })

  it('delete_calendar_entry validate rejects empty args (03-12)', () => {
    // Bridge-side schema rejects {} via minProperties: 1.
    // Core handler's zod refine enforces title+date pairing (cannot express in
    // ajv-strict-friendly draft-07 without anyOf+strictRequired conflict).
    const entry = getEntry('delete_calendar_entry')!
    expect(entry.validate({})).toBe(false)
  })

  it('delete_calendar_entry validate rejects additionalProperties (03-12)', () => {
    const entry = getEntry('delete_calendar_entry')!
    expect(
      entry.validate({ event_id: 'evt-123', evil: 'x' }),
    ).toBe(false)
  })

  it('update_calendar_entry is in registry with mutating=true (03-12)', () => {
    const entry = getEntry('update_calendar_entry')
    expect(entry).toBeDefined()
    expect(entry?.mutating).toBe(true)
  })

  it('update_calendar_entry validate accepts event_id + single field (03-12)', () => {
    const entry = getEntry('update_calendar_entry')!
    expect(
      entry.validate({
        event_id: 'evt-1',
        fields_to_update: { title: 'Neu' },
      }),
    ).toBe(true)
  })

  it('update_calendar_entry validate rejects empty fields_to_update (03-12)', () => {
    const entry = getEntry('update_calendar_entry')!
    expect(
      entry.validate({ event_id: 'evt-1', fields_to_update: {} }),
    ).toBe(false)
  })

  it('update_calendar_entry validate rejects missing event_id (03-12)', () => {
    const entry = getEntry('update_calendar_entry')!
    expect(
      entry.validate({ fields_to_update: { title: 'X' } }),
    ).toBe(false)
  })

  it('end_call is in registry with mutating=true (03-13)', () => {
    const entry = getEntry('end_call')
    expect(entry).toBeDefined()
    expect(entry?.mutating).toBe(true)
  })

  it('end_call validate accepts valid reason enum (03-13)', () => {
    const entry = getEntry('end_call')!
    for (const reason of ['farewell', 'silence', 'user_request', 'error']) {
      expect(entry.validate({ reason })).toBe(true)
    }
  })

  it('end_call validate rejects unknown reason values (03-13)', () => {
    const entry = getEntry('end_call')!
    expect(entry.validate({ reason: 'because_i_want_to' })).toBe(false)
    expect(entry.validate({ reason: '' })).toBe(false)
    expect(entry.validate({})).toBe(false)
  })
})
