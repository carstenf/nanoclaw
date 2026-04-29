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
// `invokeAgent` callback. Phase 05.5 shipped a no-op AGENT-NOT-WIRED stub
// in `mcp-tools/index.ts`. Phase 05.6 Plan 01 (this file) replaced the
// default with the real `src/voice-agent-invoker.ts` →
// `src/container-runner.ts` integration. The DI seam is unchanged — tests
// that pass an explicit `invokeAgent` override continue to work; only the
// default behavior changed.
//
// Multilingual (Phase 06.x — 2026-04-28): schema accepts optional `lang`
// arg ('de' | 'en' | 'it', default 'de'). Renderer + skill loader pick
// per-language baseline + overlays from `i18n/{lang}/`; Bridge maps lang
// to OpenAI Realtime voice + transcription.language.
//
// REQ-COST-06 (Plan 05.5-05): optional `recordCost` DI captures per-trigger
// cost in the same voice_record_turn_cost ledger as Realtime turns. The
// container-agent's `invokeAgent` returns an optional `cost_eur` (defaults
// to 0 for the Phase-05.5 no-op stub); the handler inserts a synthetic-row
// (turn_id='init', trigger_type='init_trigger') so SUM(cost_eur) per call
// continues to reflect the real total. recordCost failure is non-fatal —
// the JSONL audit is the last-resort record.
import path from 'path';
import fs from 'fs';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';
// Phase 05.6 Plan 01 Task 2: re-export the real defaultInvokeAgent so callers
// (incl. mcp-tools/index.ts and the Wave-1 live-cutover synth test) get the
// real container-runner integration without any AGENT-NOT-WIRED fallback.
import { defaultInvokeAgent as realDefaultInvokeAgent } from '../voice-agent-invoker.js';
export const defaultInvokeAgent = realDefaultInvokeAgent;
// Phase 05.6 Plan 01 Task 4: register the active call before invoking the
// agent. The matching deregister lives in voice-finalize-call-cost.ts.
// Registration happens after schema validation so we never register a call_id
// that failed Zod parsing.
import { registerActiveCall } from '../voice-mid-call-gateway.js';

// Tool-name regex compliance validated at module load.
export const TOOL_NAME = 'voice_triggers_init' as const;
if (!/^[a-zA-Z0-9_]{1,64}$/.test(TOOL_NAME)) {
  throw new Error(`TOOL_NAME '${TOOL_NAME}' does not match ^[a-zA-Z0-9_]{1,64}$`);
}

// D-8 locked schema. case_type enum starts with the three overlays in
// scope for v1 (case_2 outbound restaurant, case_6a / case_6b Carsten).
// Extend the enum when new overlays land (skill ships them).
//
// `lang` (optional, default 'de'): persona/voice language. Supported v1:
// de (default — works with all current overlays), en, it. The renderer
// reads from `i18n/{lang}/` and derives anrede/goal text per language.
// Bridge-side OpenAI Realtime voice + transcription.language map from
// this field.
export const VoiceTriggersInitSchema = z.object({
  call_id: z.string().min(1),
  case_type: z.enum(['case_2', 'case_6a', 'case_6b']),
  call_direction: z.enum(['inbound', 'outbound']),
  counterpart_label: z.string().min(1).max(120),
  lang: z.enum(['de', 'en', 'it']).optional().default('de'),
  // Step 2B+ patch: outbound goal text from voice_request_outbound_call.
  // Threaded into the {{goal}} placeholder so the bot sees the actual call
  // brief instead of the hardcoded restaurant default. Optional — inbound
  // and case_2 legacy callers (no goal in init) keep working with the
  // case-specific defaults from deriveGoalAndContext.
  goal: z.string().max(500).optional(),
  // Mid-call language switch whitelist (Phase 06.x). Allowed langs the bot
  // may switch to via voice_set_language(lang). Stored per call_id by the
  // active-call gateway and re-read by voice_set_language for validation.
  // Renderer also bakes this into the {{lang_whitelist}} persona slot so
  // the bot knows its allowed-set verbatim.
  lang_whitelist: z.array(z.enum(['de', 'en', 'it'])).max(5).optional(),
});

// Use the schema's INPUT type (pre-default-application) so callers and
// fixtures may omit `lang`. Renderer treats it as defaulted to 'de'.
export type VoiceTriggersInitInput = z.input<typeof VoiceTriggersInitSchema>;

export type VoiceTriggersInitResult =
  | { ok: true; result: { instructions: string } }
  | { ok: false; error: 'agent_unavailable' };

export interface VoiceTriggersInitDeps {
  /**
   * D-24 DI seam — Phase 05.5 ships a no-op default; Phase 05.6 replaces
   * with the real `src/container-runner.ts` integration.
   *
   * REQ-COST-06: invokeAgent MAY return `cost_eur`. The Phase-05.5 no-op
   * default returns 0; the real container-agent integration in 05.6+
   * populates it from Claude API usage.
   */
  invokeAgent: (
    input: VoiceTriggersInitInput,
  ) => Promise<{ instructions: string; cost_eur?: number }>;
  /**
   * REQ-COST-06: optional cost-ledger sink. When wired (default in
   * `mcp-tools/index.ts` registration), the handler inserts one synthetic
   * row per init-trigger invocation with trigger_type='init_trigger' and
   * turn_id='init'. Failure is non-fatal (caught + logged).
   */
  recordCost?: (entry: {
    call_id: string;
    turn_id: string;
    trigger_type: 'init_trigger' | 'transcript_trigger';
    cost_eur: number;
  }) => Promise<void>;
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

    // Phase 05.6 Plan 01 Task 4 (REQ-DIR-17): mark this call_id active for
    // the dispatch-path mid-call mutation gateway. The matching deregister
    // lives in voice_finalize_call_cost. Idempotent — safe to call again on
    // accept-retry. Registered BEFORE the agent invocation so any concurrent
    // mutating tool attempt during persona rendering is already blocked.
    //
    // Phase 06.x: also seed the call's starting lang + whitelist so
    // voice_set_language can validate switch-attempts against the per-call
    // allowed set.
    registerActiveCall(parsed.data.call_id, {
      lang: parsed.data.lang,
      lang_whitelist: parsed.data.lang_whitelist ?? [],
      render_ctx: {
        case_type: parsed.data.case_type,
        call_direction: parsed.data.call_direction,
        counterpart_label: parsed.data.counterpart_label,
        goal: parsed.data.goal,
      },
    });

    try {
      const r = await deps.invokeAgent(parsed.data);
      // REQ-COST-06: per-trigger cost-ledger entry. Synthetic turn_id='init'
      // with trigger_type='init_trigger' so SUM(cost_eur) still reflects
      // total voice cost. Failure non-fatal — JSONL audit is last resort.
      if (deps.recordCost) {
        await deps
          .recordCost({
            call_id: parsed.data.call_id,
            turn_id: 'init',
            trigger_type: 'init_trigger',
            cost_eur: r.cost_eur ?? 0,
          })
          .catch((rcErr: unknown) => {
            logger.warn({
              event: 'voice_triggers_init_record_cost_failed',
              call_id: parsed.data.call_id,
              err: (rcErr as Error)?.message ?? String(rcErr),
            });
          });
      }
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'init_trigger_done',
        call_id: parsed.data.call_id,
        case_type: parsed.data.case_type,
        call_direction: parsed.data.call_direction,
        cost_eur: r.cost_eur ?? 0,
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
