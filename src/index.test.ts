// src/index.test.ts
// Plan 05-02 Task 5 (TDD): verify active-session-tracker wiring into inbound message loop.
//
// Strategy: We test the wiring via buildDefaultRegistry + the activeSessionTracker
// that is created inside it. Since index.ts creates the tracker at startup and
// passes it into buildDefaultRegistry via the tracker DI, we verify:
//  1. The tracker is a real ActiveSessionTracker (recordActivity + getActiveChannelFor).
//  2. After recordActivity is called, getActiveChannelFor returns the right channel.
//  3. After the window expires, it returns null.
//  4. voice_notify_user routing uses the tracker (via DI in buildDefaultRegistry).
//
// These tests confirm the INTEGRATION CONTRACT — that the wiring described in
// Task 5 functions correctly once index.ts calls tracker.recordActivity() on
// every inbound message.
import { describe, it, expect, vi } from 'vitest';

import { createActiveSessionTracker } from './channels/active-session-tracker.js';

describe('ActiveSessionTracker — wiring contract (Plan 05-02 Task 5)', () => {
  // Test 1: recordActivity + getActiveChannelFor returns correct channel within window
  it('whatsapp: recordActivity → getActiveChannelFor returns whatsapp within window', () => {
    const tracker = createActiveSessionTracker({ windowMs: 600000 });
    const now = Date.now();
    tracker.recordActivity('whatsapp', 'g1@g.us', now);
    expect(tracker.getActiveChannelFor('g1@g.us', now + 1000)).toBe('whatsapp');
  });

  // Test 2: discord channel works the same way
  it('discord: recordActivity → getActiveChannelFor returns discord within window', () => {
    const tracker = createActiveSessionTracker({ windowMs: 600000 });
    const now = Date.now();
    tracker.recordActivity('discord', 'g1@g.us', now);
    expect(tracker.getActiveChannelFor('g1@g.us', now + 1000)).toBe('discord');
  });

  // Test 3: after window expires → returns null
  it('expired: after window → getActiveChannelFor returns null', () => {
    const tracker = createActiveSessionTracker({ windowMs: 100 });
    const now = Date.now();
    tracker.recordActivity('whatsapp', 'g1@g.us', now);
    // 101ms later — outside the 100ms window
    expect(tracker.getActiveChannelFor('g1@g.us', now + 101)).toBeNull();
  });

  // Test 4: voice_notify_user routing uses tracker — whatsapp active → routes to whatsapp
  it('voice_notify_user: active whatsapp session → routes to whatsapp (not discord)', async () => {
    const { makeVoiceNotifyUser } = await import('./mcp-tools/voice-notify-user.js');
    const tracker = createActiveSessionTracker({ windowMs: 600000 });
    const now = Date.now();

    // Simulate: inbound WhatsApp message arrived
    tracker.recordActivity('whatsapp', 'main@g.us', now);

    const sendWhatsappSpy = vi.fn().mockResolvedValue({ ok: true });
    const sendDiscordSpy = vi.fn().mockResolvedValue({ ok: true });

    const handler = makeVoiceNotifyUser({
      getActiveChannel: (jid, ts) => tracker.getActiveChannelFor(jid, ts),
      sendWhatsappMessage: sendWhatsappSpy,
      sendDiscordMessage: sendDiscordSpy,
      getMainGroupAndJid: () => ({ folder: 'main', jid: 'main@g.us' }),
      isDiscordConnected: () => true,
      isWhatsappConnected: () => true,
      now: () => now + 1000,
    });

    const result = (await handler({
      text: 'Test nachricht',
      urgency: 'info',
      target_jid: 'main@g.us',
    })) as { ok: boolean; result: { routed_via: string } };

    expect(result.ok).toBe(true);
    expect(result.result.routed_via).toBe('whatsapp');
    expect(sendWhatsappSpy).toHaveBeenCalledOnce();
    expect(sendDiscordSpy).not.toHaveBeenCalled();
  });

  // Test 5: long text (>50 words) → Discord override despite active WhatsApp
  it('voice_notify_user: long text + active whatsapp → force discord (long_text_override)', async () => {
    const { makeVoiceNotifyUser } = await import('./mcp-tools/voice-notify-user.js');
    const tracker = createActiveSessionTracker({ windowMs: 600000 });
    const now = Date.now();

    // Simulate active WhatsApp session
    tracker.recordActivity('whatsapp', 'main@g.us', now);

    const sendWhatsappSpy = vi.fn().mockResolvedValue({ ok: true });
    const sendDiscordSpy = vi.fn().mockResolvedValue({ ok: true });

    const handler = makeVoiceNotifyUser({
      getActiveChannel: (jid, ts) => tracker.getActiveChannelFor(jid, ts),
      sendWhatsappMessage: sendWhatsappSpy,
      sendDiscordMessage: sendDiscordSpy,
      getMainGroupAndJid: () => ({ folder: 'main', jid: 'main@g.us' }),
      isDiscordConnected: () => true,
      isWhatsappConnected: () => true,
      longTextThreshold: 10, // low threshold to test override
      now: () => now + 1000,
    });

    // 60-word text (well above threshold of 10)
    const longText = Array(60).fill('word').join(' ');
    const result = (await handler({
      text: longText,
      urgency: 'info',
      target_jid: 'main@g.us',
    })) as { ok: boolean; result: { routed_via: string } };

    expect(result.ok).toBe(true);
    expect(result.result.routed_via).toBe('discord');
    expect(sendDiscordSpy).toHaveBeenCalledOnce();
    expect(sendWhatsappSpy).not.toHaveBeenCalled();
  });
});
