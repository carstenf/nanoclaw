import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SlowBrainSessionManager } from './slow-brain-session.js';

// Mock Claude client that returns a fixed response
function makeClaudeClientMock(response: string) {
  return vi.fn().mockResolvedValue(response);
}

const SYSTEM_PROMPT = 'Du bist ein Test-Koordinator.';

describe('SlowBrainSessionManager.getOrCreate', () => {
  it('creates a new session for a new call_id', () => {
    const mgr = new SlowBrainSessionManager({ claudeClient: makeClaudeClientMock('null') });
    const session = mgr.getOrCreate('call-1');
    expect(session.callId).toBe('call-1');
    expect(session.messages).toEqual([]);
    expect(session.startedAt).toBeGreaterThan(0);
  });

  it('returns the same session for the same call_id (dedup)', () => {
    const mgr = new SlowBrainSessionManager({ claudeClient: makeClaudeClientMock('null') });
    const s1 = mgr.getOrCreate('call-2');
    const s2 = mgr.getOrCreate('call-2');
    expect(s1).toBe(s2);
  });

  it('creates distinct sessions for different call_ids', () => {
    const mgr = new SlowBrainSessionManager({ claudeClient: makeClaudeClientMock('null') });
    const s1 = mgr.getOrCreate('call-a');
    const s2 = mgr.getOrCreate('call-b');
    expect(s1).not.toBe(s2);
  });
});

describe('SlowBrainSessionManager.recordTurn', () => {
  it('returns null when Claude responds "null"', async () => {
    const mockClaude = makeClaudeClientMock('null');
    const mgr = new SlowBrainSessionManager({ claudeClient: mockClaude });
    const session = mgr.getOrCreate('call-3');
    const result = await mgr.recordTurn(session, 'turn-1', 'Hallo, wer bist du?');
    expect(result).toBeNull();
  });

  it('returns instructions string when Claude responds with content', async () => {
    const mockClaude = makeClaudeClientMock('Du solltest freundlicher sein.');
    const mgr = new SlowBrainSessionManager({ claudeClient: mockClaude });
    const session = mgr.getOrCreate('call-4');
    const result = await mgr.recordTurn(session, 'turn-1', 'Guten Morgen!');
    expect(result).toBe('Du solltest freundlicher sein.');
  });

  it('accumulates user + assistant messages after each turn', async () => {
    const mockClaude = makeClaudeClientMock('null');
    const mgr = new SlowBrainSessionManager({ claudeClient: mockClaude });
    const session = mgr.getOrCreate('call-5');

    await mgr.recordTurn(session, 'turn-1', 'Erster Satz.');
    expect(session.messages).toHaveLength(2); // user + assistant
    expect(session.messages[0]).toEqual({ role: 'user', content: 'Erster Satz.' });
    expect(session.messages[1].role).toBe('assistant');

    await mgr.recordTurn(session, 'turn-2', 'Zweiter Satz.');
    expect(session.messages).toHaveLength(4);
  });

  it('updates lastTurnAt after each call', async () => {
    let fakeNow = 1000;
    const mockClaude = makeClaudeClientMock('null');
    const mgr = new SlowBrainSessionManager({
      claudeClient: mockClaude,
      now: () => fakeNow,
    });
    const session = mgr.getOrCreate('call-6');
    fakeNow = 2000;
    await mgr.recordTurn(session, 'turn-1', 'hi');
    expect(session.lastTurnAt).toBe(2000);
  });
});

describe('SlowBrainSessionManager.idleSweep', () => {
  it('removes sessions idle longer than TTL', () => {
    const TTL = 100;
    const mgr = new SlowBrainSessionManager({
      claudeClient: makeClaudeClientMock('null'),
      sessionIdleMs: TTL,
    });

    const s = mgr.getOrCreate('call-7');
    // Manually set lastTurnAt to expired
    s.lastTurnAt = Date.now() - TTL - 1;

    mgr.idleSweep(Date.now());
    expect(mgr.getSessionCount()).toBe(0);
  });

  it('keeps sessions that are still within TTL', () => {
    const TTL = 30000;
    const mgr = new SlowBrainSessionManager({
      claudeClient: makeClaudeClientMock('null'),
      sessionIdleMs: TTL,
    });

    mgr.getOrCreate('call-8');
    // lastTurnAt is just set (fresh session), not expired
    mgr.idleSweep(Date.now());
    expect(mgr.getSessionCount()).toBe(1);
  });

  it('does not remove active sessions when others expire', () => {
    const TTL = 100;
    const mgr = new SlowBrainSessionManager({
      claudeClient: makeClaudeClientMock('null'),
      sessionIdleMs: TTL,
    });

    const expired = mgr.getOrCreate('call-expired');
    expired.lastTurnAt = Date.now() - TTL - 1;

    mgr.getOrCreate('call-active'); // fresh session, not expired

    mgr.idleSweep(Date.now());
    expect(mgr.getSessionCount()).toBe(1);
  });
});
