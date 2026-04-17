import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { SlowBrainSessionManager } from './slow-brain-session.js';
import { makeVoiceOnTranscriptTurn } from './voice-on-transcript-turn.js';

export type ToolHandler = (args: unknown) => Promise<unknown>;

export class UnknownToolError extends Error {
  readonly code = 'unknown_tool';
  constructor(public readonly toolName: string) {
    super(`unknown_tool: ${toolName}`);
    this.name = 'UnknownToolError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();

  register(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async invoke(name: string, args: unknown): Promise<unknown> {
    const h = this.tools.get(name);
    if (!h) throw new UnknownToolError(name);
    return h(args);
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }
}

export interface RegistryDeps {
  dataDir?: string;
  log?: Pick<typeof logger, 'info' | 'warn'>;
  /** Idle sweep interval in ms. Default: 60000. Pass 0 to disable (useful in tests). */
  sweepIntervalMs?: number;
  /** Inject a session manager (useful in tests to avoid real OneCLI calls). */
  sessionManager?: SlowBrainSessionManager;
}

export interface RegistryHandle {
  registry: ToolRegistry;
  /** Call to stop the background idle-sweep timer. */
  stop: () => void;
}

/**
 * Build the default MCP tool registry with Slow-Brain session manager wired in.
 * Returns registry + stop() to clean up the setInterval when process exits.
 */
export function buildDefaultRegistry(deps: RegistryDeps = {}): ToolRegistry {
  const registry = new ToolRegistry();

  const sessionManager = deps.sessionManager ?? new SlowBrainSessionManager();

  // Start idle-sweep on a 60s interval (clearable via handle.stop)
  const sweepMs = deps.sweepIntervalMs ?? 60000;
  if (sweepMs > 0) {
    const interval = setInterval(() => {
      sessionManager.idleSweep();
    }, sweepMs);
    // Allow Node process to exit even if timer is still active
    if (interval.unref) interval.unref();
  }

  registry.register(
    'voice.on_transcript_turn',
    makeVoiceOnTranscriptTurn({
      dataDir: deps.dataDir ?? DATA_DIR,
      log: deps.log ?? logger,
      sessionManager,
    }),
  );

  return registry;
}
