import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

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
}

export function buildDefaultRegistry(deps: RegistryDeps = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    'voice.on_transcript_turn',
    makeVoiceOnTranscriptTurn({
      dataDir: deps.dataDir ?? DATA_DIR,
      log: deps.log ?? logger,
    }),
  );
  return registry;
}
