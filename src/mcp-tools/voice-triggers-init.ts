// src/mcp-tools/voice-triggers-init.ts
// Phase 05.5 Plan 01 Task 2: voice_triggers_init MCP-tool.
//
// Container-agent reasoning trigger — synchronous at /accept. Returns the
// fully-rendered persona instructions string from the per-call container
// agent. Stateless per REQ-DIR-14: no DB row created, no global mutation.
//
// D-8 schema (locked):
//   call_id: string
//   case_type: 'case_2' | 'case_6a' | 'case_6b' (expand as overlays land)
//   call_direction: 'inbound' | 'outbound'
//   counterpart_label: string
// Returns: { ok: true, result: { instructions: string } } on success
//        | { ok: false, error: 'agent_unavailable' }     on agent failure
//        | throws BadRequestError                         on schema failure
//
// D-24 (Phase 05.5 / 05.6 boundary): handler accepts a DI-injectable
// `invokeAgent` callback. Phase 05.5 ships a no-op default in
// `mcp-tools/index.ts` returning `{ instructions: 'AGENT_NOT_WIRED' }`;
// Phase 05.6 replaces the default with a real `src/container-runner.ts`
// integration. This file only owns the schema + handler contract.
import path from 'path';
import fs from 'fs';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

// Tool-name regex compliance validated at module load.
export const TOOL_NAME = 'voice_triggers_init' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

// D-8 locked schema. case_type enum starts with the three overlays in
// scope for v1 (case_2 outbound restaurant, case_6a / case_6b Carsten).
// Extend the enum when new overlays land (skill ships them).
export const VoiceTriggersInitSchema = z.object({
  call_id: z.string().min(1),
  case_type: z.enum(['case_2', 'case_6a', 'case_6b']),
  call_direction: z.enum(['inbound', 'outbound']),
  counterpart_label: z.string().min(1).max(120),
});

export type VoiceTriggersInitInput = z.infer<typeof VoiceTriggersInitSchema>;

export type VoiceTriggersInitResult =
  | { ok: true; result: { instructions: string } }
  | { ok: false; error: 'agent_unavailable' };

export interface VoiceTriggersInitDeps {
  /**
   * D-24 DI seam — Phase 05.5 ships a no-op default; Phase 05.6 replaces
   * with the real `src/container-runner.ts` integration.
   */
  invokeAgent: (input: VoiceTriggersInitInput) => Promise<{ instructions: string }>;
  /** JSONL path for per-trigger audit log. */
  jsonlPath?: string;
  /** Clock override for tests. */
  now?: () => number;
}

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}

export function makeVoiceTriggersInit(deps: VoiceTriggersInitDeps): ToolHandler {
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-triggers.jsonl');
  const nowFn = deps.now ?? (() => Date.now());

  return async function voiceTriggersInit(args: unknown) {
    const start = nowFn();

    const parsed = VoiceTriggersInitSchema.safeParse(args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(
        String(issue?.path?.[0] ?? 'input'),
        issue?.message ?? 'invalid',
      );
    }

    try {
      const r = await deps.invokeAgent(parsed.data);
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'init_trigger_done',
        call_id: parsed.data.call_id,
        case_type: parsed.data.case_type,
        call_direction: parsed.data.call_direction,
        latency_ms: nowFn() - start,
      });
      return { ok: true as const, result: { instructions: r.instructions } };
    } catch (err: unknown) {
      logger.warn({
        event: 'voice_triggers_init_failed',
        call_id: parsed.data.call_id,
        err: (err as Error)?.message ?? String(err),
      });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'init_trigger_failed',
        call_id: parsed.data.call_id,
        latency_ms: nowFn() - start,
        err: (err as Error)?.message ?? String(err),
      });
      return { ok: false as const, error: 'agent_unavailable' as const };
    }
  };
}
