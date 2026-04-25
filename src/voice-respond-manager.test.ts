import { describe, it, expect, vi } from 'vitest';
import {
  VoiceRespondManager,
  VoiceRespondTimeoutError,
} from './voice-respond-manager.js';

describe('VoiceRespondManager', () => {
  it('happy path: register → resolve → Promise resolves with payload', async () => {
    const mgr = new VoiceRespondManager();
    const promise = mgr.register('call-1', 5000);
    const matched = mgr.resolve('call-1', {
      voice_short: 'Hallo Carsten',
      discord_long: null,
    });
    expect(matched).toBe(true);
    await expect(promise).resolves.toEqual({
      voice_short: 'Hallo Carsten',
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
});
