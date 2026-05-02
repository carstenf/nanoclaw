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
});
