/**
 * slow-brain-session.ts
 *
 * Per-call session manager for Slow-Brain Claude inference.
 * Sessions are kept in RAM only — no disk state.
 * Idle sessions are evicted by idleSweep() called on a setInterval.
 */
import { callClaudeViaOneCli, type ClaudeMessage, type CallClaudeOpts } from './claude-client.js';
import { SLOW_BRAIN_SESSION_IDLE_MS } from '../config.js';

/** The system prompt template for Slow-Brain inference. */
export const SLOW_BRAIN_SYSTEM_PROMPT =
  'Du bist der Hintergrund-Koordinator fuer einen laufenden Voice-Call. ' +
  'Du bekommst pro Turn den neuesten Transcript-Ausschnitt. ' +
  'Entscheide: braucht die Voice-Bot-Persona gerade einen Kontext-Update ' +
  '(z.B. weil neuer Fakt/Memory/Customer-Info relevant ist)? ' +
  'Wenn ja, gib NUR den neuen Instructions-Delta-Text als Antwort. ' +
  'Wenn nein, antworte EXAKT mit dem String "null". ' +
  'Keine Erklaerungen, keine Metadata.';

export interface SlowBrainSession {
  callId: string;
  startedAt: number;
  lastTurnAt: number;
  messages: ClaudeMessage[];
}

export type ClaudeClientFn = (
  systemPrompt: string,
  messages: ClaudeMessage[],
  opts?: CallClaudeOpts,
) => Promise<string>;

export interface SlowBrainSessionManagerOpts {
  /** Override the Claude client for tests. Default: callClaudeViaOneCli */
  claudeClient?: ClaudeClientFn;
  /** Session idle timeout in ms. Default: SLOW_BRAIN_SESSION_IDLE_MS (30min) */
  sessionIdleMs?: number;
  /** Current time provider for tests. Default: Date.now */
  now?: () => number;
  /** System prompt override (rarely needed). Default: SLOW_BRAIN_SYSTEM_PROMPT */
  systemPrompt?: string;
}

export class SlowBrainSessionManager {
  private readonly sessions = new Map<string, SlowBrainSession>();
  private readonly claudeClient: ClaudeClientFn;
  private readonly sessionIdleMs: number;
  private readonly now: () => number;
  private readonly systemPrompt: string;

  constructor(opts: SlowBrainSessionManagerOpts = {}) {
    this.claudeClient = opts.claudeClient ?? callClaudeViaOneCli;
    this.sessionIdleMs = opts.sessionIdleMs ?? SLOW_BRAIN_SESSION_IDLE_MS;
    this.now = opts.now ?? (() => Date.now());
    this.systemPrompt = opts.systemPrompt ?? SLOW_BRAIN_SYSTEM_PROMPT;
  }

  /**
   * Get or create a session for the given call_id.
   * Returns the existing session if one exists, otherwise creates a new one.
   */
  getOrCreate(callId: string): SlowBrainSession {
    const existing = this.sessions.get(callId);
    if (existing) return existing;

    const now = this.now();
    const session: SlowBrainSession = {
      callId,
      startedAt: now,
      lastTurnAt: now,
      messages: [],
    };
    this.sessions.set(callId, session);
    return session;
  }

  /**
   * Record a transcript turn: calls Claude, accumulates messages, returns instructions delta or null.
   */
  async recordTurn(
    session: SlowBrainSession,
    _turnId: string,
    transcript: string,
  ): Promise<string | null> {
    // Append user turn
    session.messages.push({ role: 'user', content: transcript });
    session.lastTurnAt = this.now();

    // Call Claude with full history
    const rawResponse = await this.claudeClient(this.systemPrompt, session.messages);

    // Append assistant response to history
    session.messages.push({ role: 'assistant', content: rawResponse });
    session.lastTurnAt = this.now();

    // Parse response: "null" (case-insensitive) → null, else return trimmed text
    const trimmed = rawResponse.trim();
    if (trimmed.toLowerCase() === 'null') {
      return null;
    }

    // Return first non-empty line block
    const firstBlock = trimmed.split(/\n\n+/)[0].trim();
    return firstBlock || null;
  }

  /**
   * Remove sessions that have been idle longer than sessionIdleMs.
   * Called periodically via setInterval.
   */
  idleSweep(now: number = this.now()): void {
    for (const [callId, session] of this.sessions) {
      if (now - session.lastTurnAt > this.sessionIdleMs) {
        this.sessions.delete(callId);
      }
    }
  }

  /**
   * Returns the number of active sessions (for testing and monitoring).
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
