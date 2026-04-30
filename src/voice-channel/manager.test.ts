import { describe, it, expect, vi } from 'vitest';
import {
  VoiceRespondManager,
  VoiceRespondTimeoutError,
  VoiceRespondCancelledError,
} from './manager.js';

describe('VoiceRespondManager', () => {
  it('happy path: register → resolve → Promise resolves with payload', async () => {
    const mgr = new VoiceRespondManager();
    const promise = mgr.register('call-1', 5000);
    const matched = mgr.resolve('call-1', {
      voice_short: 'Hallo Operator',
      discord_long: null,
    });
    expect(matched).toBe(true);
    await expect(promise).resolves.toEqual({
      voice_short: 'Hallo Operator',
      discord_long: null,
    });
    expect(mgr.size()).toBe(0);
  });

  it('timeout: Promise rejects with VoiceRespondTimeoutError after timeoutMs', async () => {
    vi.useFakeTimers();
    const mgr = new VoiceRespondManager();
    const promise = mgr.register('call-timeout', 1000);
    vi.advanceTimersByTime(1001);
    await expect(promise).rejects.toBeInstanceOf(VoiceRespondTimeoutError);
    expect(mgr.size()).toBe(0);
    vi.useRealTimers();
  });

  it('resolve unknown call_id: returns false, no throw', () => {
    const mgr = new VoiceRespondManager();
    const matched = mgr.resolve('call-ghost', { voice_short: 'x' });
    expect(matched).toBe(false);
  });

  it('duplicate register: rejects prior, new register replaces it', async () => {
    const mgr = new VoiceRespondManager();
    const first = mgr.register('call-dup', 5000);
    // Suppress unhandled rejection on the displaced promise
    first.catch(() => undefined);
    const second = mgr.register('call-dup', 5000);
    await expect(first).rejects.toThrow(/duplicate register/);
    expect(mgr.size()).toBe(1);
    mgr.resolve('call-dup', { voice_short: 'second wins' });
    await expect(second).resolves.toEqual({ voice_short: 'second wins' });
  });

  it('size(): tracks pending count across register/resolve cycles', async () => {
    const mgr = new VoiceRespondManager();
    expect(mgr.size()).toBe(0);
    const p1 = mgr.register('a', 5000);
    const p2 = mgr.register('b', 5000);
    expect(mgr.size()).toBe(2);
    mgr.resolve('a', { voice_short: '1' });
    await p1;
    expect(mgr.size()).toBe(1);
    mgr.resolve('b', { voice_short: '2' });
    await p2;
    expect(mgr.size()).toBe(0);
  });

  it('clear(): rejects all pending and empties map', async () => {
    const mgr = new VoiceRespondManager();
    const p1 = mgr.register('a', 5000);
    const p2 = mgr.register('b', 5000);
    mgr.clear('test-shutdown');
    await expect(p1).rejects.toThrow(/test-shutdown/);
    await expect(p2).rejects.toThrow(/test-shutdown/);
    expect(mgr.size()).toBe(0);
  });

  it('double resolve: second call returns false, payload not delivered twice', async () => {
    const mgr = new VoiceRespondManager();
    const promise = mgr.register('call-2x', 5000);
    expect(mgr.resolve('call-2x', { voice_short: 'first' })).toBe(true);
    expect(mgr.resolve('call-2x', { voice_short: 'second' })).toBe(false);
    await expect(promise).resolves.toEqual({ voice_short: 'first' });
  });

  it('resolve after timeout: returns false (entry already gone)', async () => {
    vi.useFakeTimers();
    const mgr = new VoiceRespondManager();
    const promise = mgr.register('call-late', 100);
    vi.advanceTimersByTime(101);
    await expect(promise).rejects.toBeInstanceOf(VoiceRespondTimeoutError);
    expect(mgr.resolve('call-late', { voice_short: 'too late' })).toBe(false);
    vi.useRealTimers();
  });

  describe('cancel()', () => {
    it('cancels pending entry, frees map, rejects with VoiceRespondCancelledError', async () => {
      const mgr = new VoiceRespondManager();
      const pending = mgr.register('call-cancel', 60_000);
      expect(mgr.size()).toBe(1);
      const cancelled = mgr.cancel('call-cancel', 'no_active_container');
      expect(cancelled).toBe(true);
      expect(mgr.size()).toBe(0);
      await expect(pending).rejects.toBeInstanceOf(VoiceRespondCancelledError);
      await expect(pending).rejects.toMatchObject({
        callId: 'call-cancel',
        reason: 'no_active_container',
      });
    });

    it('cancel of unknown call_id: returns false, no throw', () => {
      const mgr = new VoiceRespondManager();
      expect(mgr.cancel('call-ghost')).toBe(false);
    });

    it('cancel after resolve: returns false (entry already gone)', async () => {
      const mgr = new VoiceRespondManager();
      const pending = mgr.register('call-rc', 5000);
      mgr.resolve('call-rc', { voice_short: 'done' });
      await pending;
      expect(mgr.cancel('call-rc')).toBe(false);
    });

    it('cancel clears the timeout (no late rejection after cancel)', async () => {
      vi.useFakeTimers();
      const mgr = new VoiceRespondManager();
      const pending = mgr.register('call-tc', 100);
      mgr.cancel('call-tc');
      await expect(pending).rejects.toBeInstanceOf(VoiceRespondCancelledError);
      // Advance past the original timeout — no second rejection should fire.
      vi.advanceTimersByTime(200);
      // size still 0, no double-reject (would be unhandled-rejection if it fired).
      expect(mgr.size()).toBe(0);
      vi.useRealTimers();
    });

    it('cancel with default reason: rejection carries "cancelled"', async () => {
      const mgr = new VoiceRespondManager();
      const pending = mgr.register('call-default', 5000);
      mgr.cancel('call-default');
      await expect(pending).rejects.toMatchObject({ reason: 'cancelled' });
    });
  });
});
