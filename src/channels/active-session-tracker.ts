import { VOICE_ACTIVE_SESSION_WINDOW_MS } from '../config.js';

export interface ActiveSessionTracker {
  /** Called by Andy's message ingest with the channel name + JID + timestamp_ms of the inbound message. */
  recordActivity(channel: 'whatsapp' | 'discord', jid: string, ts_ms: number): void;
  /** Looks up which channel Carsten most-recently sent a message on for a given JID within window_ms. */
  getActiveChannelFor(jid: string, now_ms: number): 'whatsapp' | 'discord' | null;
  /** DI test hook — exposes the internal map size. */
  _size(): number;
}

interface ActivityEntry {
  channel: 'whatsapp' | 'discord';
  ts_ms: number;
}

export interface ActiveSessionTrackerOptions {
  /** Override the session window in ms. Defaults to VOICE_ACTIVE_SESSION_WINDOW_MS. */
  windowMs?: number;
}

/**
 * Factory function returning a new in-memory ActiveSessionTracker.
 * The tracker stores the most-recent activity per JID (overwrite on each recordActivity call).
 */
export function createActiveSessionTracker(
  opts: ActiveSessionTrackerOptions = {},
): ActiveSessionTracker {
  const windowMs = opts.windowMs ?? VOICE_ACTIVE_SESSION_WINDOW_MS;
  const map = new Map<string, ActivityEntry>();

  return {
    recordActivity(channel, jid, ts_ms) {
      map.set(jid, { channel, ts_ms });
    },

    getActiveChannelFor(jid, now_ms) {
      const entry = map.get(jid);
      if (!entry) return null;
      if (now_ms - entry.ts_ms >= windowMs) return null;
      return entry.channel;
    },

    _size() {
      return map.size;
    },
  };
}
