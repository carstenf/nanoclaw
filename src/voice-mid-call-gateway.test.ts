// src/voice-mid-call-gateway.test.ts
//
// Phase 05.6 Plan 01 Task 4 — vitest unit + dispatch-integration tests for
// REQ-DIR-17 NanoClaw-side mid-call mutation gateway.

import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  checkMidCallMutation,
  registerActiveCall,
  deregisterActiveCall,
  isCallActive,
  _resetActiveSet,
} from './voice-mid-call-gateway.js';
import { ToolRegistry } from './mcp-tools/index.js';

beforeEach(() => {
  _resetActiveSet();
});

// ---------------------------------------------------------------------------
// Tests 1-6 — gateway unit tests
// ---------------------------------------------------------------------------

describe('checkMidCallMutation — REQ-DIR-17 unit tests', () => {
  it('Test 1: read-only tool during active call → ALLOWED', () => {
    registerActiveCall('rtc_test1');
    const r = checkMidCallMutation(
      'rtc_test1',
      'voice_check_calendar',
      { mutating: false },
    );
    expect(r.allowed).toBe(true);
  });

  it('Test 2: mutating tool during active call → REJECTED with mid_call_mutation_forbidden', () => {
    registerActiveCall('rtc_test1');
    const r = checkMidCallMutation(
      'rtc_test1',
      'voice_create_calendar_entry',
      { mutating: true },
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('mid_call_mutation_forbidden');
  });

  it('Test 3: mutating tool with no active call → ALLOWED (post-call execution path)', () => {
    // active set is empty
    const r = checkMidCallMutation(
      'rtc_test1',
      'voice_create_calendar_entry',
      { mutating: true },
    );
    expect(r.allowed).toBe(true);
  });

  it('Test 4: null call_id → ALLOWED (background task, Andy, scheduled retry)', () => {
    registerActiveCall('rtc_other');
    const r = checkMidCallMutation(
      null,
      'voice_create_calendar_entry',
      { mutating: true },
    );
    expect(r.allowed).toBe(true);
  });

  it('Test 5: missing tool_meta.mutating → treated as non-mutating (read-only by default)', () => {
    registerActiveCall('rtc_test1');
    const r = checkMidCallMutation(
      'rtc_test1',
      'voice_get_contract',
      {},
    );
    expect(r.allowed).toBe(true);
  });

  it('Test 6: register/deregister round-trip + idempotent deregister', () => {
    registerActiveCall('rtc_test1');
    expect(isCallActive('rtc_test1')).toBe(true);
    deregisterActiveCall('rtc_test1');
    expect(isCallActive('rtc_test1')).toBe(false);
    // Idempotent — deregister of unknown id is a no-op (does not throw).
    expect(() => deregisterActiveCall('rtc_never_registered')).not.toThrow();
    expect(() => deregisterActiveCall('rtc_test1')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests 9 + 10 — registry dispatch-path enforcement
//
// Build a tiny ToolRegistry, register a fake mutating + read-only handler,
// invoke each during an active call, assert the gateway blocks ONLY the
// mutating tool — and that the underlying handler is NEVER reached on rejection.
// ---------------------------------------------------------------------------

describe('ToolRegistry dispatch-path REQ-DIR-17 enforcement (Tests 9 + 10)', () => {
  it('Test 9: mutating tool during active call → handler NEVER reached + returns mid_call_mutation_forbidden', async () => {
    registerActiveCall('rtc_test1');
    const handlerSpy = vi.fn(async () => ({ ok: true, side_effect: 'created' }));
    const registry = new ToolRegistry();
    registry.register('voice_create_calendar_entry', handlerSpy, { mutating: true });

    const result = (await registry.invoke('voice_create_calendar_entry', {
      call_id: 'rtc_test1',
      summary: 'Should be blocked',
    })) as { ok: false; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('mid_call_mutation_forbidden');
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it('Test 10: read-only tool during active call → handler IS reached and runs normally', async () => {
    registerActiveCall('rtc_test1');
    const handlerSpy = vi.fn(async () => ({ ok: true, result: { busy_minutes: 0 } }));
    const registry = new ToolRegistry();
    registry.register('voice_check_calendar', handlerSpy);
    // Default meta is non-mutating — no flag passed.

    const result = await registry.invoke('voice_check_calendar', {
      call_id: 'rtc_test1',
    });

    expect(handlerSpy).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
  });

  it('Bonus: mutating tool AFTER deregister (post-call) → handler IS reached', async () => {
    registerActiveCall('rtc_test1');
    deregisterActiveCall('rtc_test1');
    const handlerSpy = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry();
    registry.register('voice_create_calendar_entry', handlerSpy, { mutating: true });

    await registry.invoke('voice_create_calendar_entry', {
      call_id: 'rtc_test1',
      summary: 'Now allowed',
    });
    expect(handlerSpy).toHaveBeenCalledOnce();
  });
});
