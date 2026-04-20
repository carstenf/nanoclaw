import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ActiveSessionTracker,
  createActiveSessionTracker,
} from './active-session-tracker.js';

describe('ActiveSessionTracker', () => {
  let tracker: ActiveSessionTracker;

  beforeEach(() => {
    tracker = createActiveSessionTracker();
  });

  it('Test 1: new tracker has _size() === 0 after construction', () => {
    expect(tracker._size()).toBe(0);
  });

  it('Test 2: recordActivity whatsapp, then getActiveChannelFor returns whatsapp within window', () => {
    tracker.recordActivity('whatsapp', 'jid1', 1000);
    expect(tracker.getActiveChannelFor('jid1', 1500)).toBe('whatsapp');
  });

  it('Test 3: recordActivity outside window returns null', () => {
    tracker.recordActivity('whatsapp', 'jid1', 1000);
    expect(tracker.getActiveChannelFor('jid1', 1000 + 600001)).toBeNull();
  });

  it('Test 4: most-recent activity wins when channel changes', () => {
    tracker.recordActivity('whatsapp', 'jid1', 1000);
    tracker.recordActivity('discord', 'jid1', 2000);
    expect(tracker.getActiveChannelFor('jid1', 2500)).toBe('discord');
  });

  it('Test 5: different JID returns null', () => {
    tracker.recordActivity('whatsapp', 'jid1', 1000);
    expect(tracker.getActiveChannelFor('jid-other', 1500)).toBeNull();
  });

  it('Test 6: default VOICE_ACTIVE_SESSION_WINDOW_MS is 600000 (10 min)', async () => {
    const { VOICE_ACTIVE_SESSION_WINDOW_MS } = await import('../config.js');
    expect(VOICE_ACTIVE_SESSION_WINDOW_MS).toBe(600000);
  });

  it('Test 7: env override sets window to 5000', async () => {
    vi.stubEnv('VOICE_ACTIVE_SESSION_WINDOW_MS', '5000');
    // Re-import with overridden env
    const mod = await import('./active-session-tracker.js?t=' + Date.now());
    const t = mod.createActiveSessionTracker({ windowMs: 5000 });
    t.recordActivity('whatsapp', 'jid1', 1000);
    // Within 5000ms window
    expect(t.getActiveChannelFor('jid1', 5999)).toBe('whatsapp');
    // Outside 5000ms window
    expect(t.getActiveChannelFor('jid1', 6001)).toBeNull();
    vi.unstubAllEnvs();
  });
});
