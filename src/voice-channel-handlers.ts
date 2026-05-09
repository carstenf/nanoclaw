// src/voice-channel-handlers.ts
//
// Wires the voice-channel adapter (channels/voice.ts) to the per-tool
// handler logic. One setupVoiceHandlers() call replaces the six v1
// INTEGRATION patches:
//
//   import { setupVoiceHandlers } from './voice-channel-handlers.js';
//   import { getVoiceChannel } from './channels/voice.js';
//   const vc = getVoiceChannel();
//   if (vc) setupVoiceHandlers(vc, { spawnVoiceAgent, sendDiscordMessage });
//
// Phase 4 (this file) wires the deterministic handlers — voice_triggers_init,
// voice_triggers_transcript, voice_set_language — directly via the slim
// voice-render.ts template renderer. ask_core / send_discord_message /
// schedule_retry / wake_up are routed through host-supplied dependency
// callbacks (`spawnVoiceAgent`, `sendDiscordMessage`, `scheduleVoiceTask`).
// The host wires whatever it has — Phase-4 ships it as optional + missing-dep
// returns `not_yet_wired` so the channel surface is well-defined even when
// the host hasn't supplied every dep yet.

import { z } from 'zod';

import { logger } from './logger.js';
import {
  VoiceChannel,
  VoiceDispatchHandler,
  VoiceDispatchResult,
} from './channels/voice.js';
import {
  Lang,
  SUPPORTED_LANGS,
  effectiveLangWhitelist,
  renderPersonaForCall,
  type VoicePersonaInput,
} from './voice-render.js';

// ---------------------------------------------------------------------------
// Per-call lang-whitelist + render-context tracker
// ---------------------------------------------------------------------------
// Replaces v1's voice-mid-call-gateway state. We only keep what's needed for
// voice_set_language (the bot's mid-call switch). Active-call lifecycle
// proper lives in voice-mcp/orchestrator/lifecycle.ts now.

interface CallRenderContext {
  call_id: string;
  case_type: string;
  call_direction: 'inbound' | 'outbound';
  counterpart_label: string;
  lang: Lang;
  lang_whitelist: readonly Lang[];
  goal?: string;
}

const activeCallContexts = new Map<string, CallRenderContext>();

// ---------------------------------------------------------------------------
// Schemas — local copies; the v1 mcp-tools/voice-*.ts files defined these but
// are deleted in Phase 3/4. Schema bodies are unchanged so wire-compat with
// voice-mcp's dispatcher contract is preserved.
// ---------------------------------------------------------------------------

const VoiceTriggersInitSchema = z.object({
  call_id: z.string().min(1),
  case_type: z.enum(['case_2', 'case_6a', 'case_6b']),
  call_direction: z.enum(['inbound', 'outbound']),
  counterpart_label: z.string().min(1).max(120),
  lang: z.enum(SUPPORTED_LANGS).optional().default('de'),
  goal: z.string().max(500).optional(),
  lang_whitelist: z.array(z.enum(SUPPORTED_LANGS)).max(5).optional(),
});

const VoiceTriggersTranscriptSchema = z.object({
  call_id: z.string().min(1),
  turn_id: z.union([z.string().min(1), z.number().int().min(0)]),
});

const VoiceSetLanguageSchema = z.object({
  call_id: z.string().min(1).max(128),
  lang: z.enum(SUPPORTED_LANGS),
});

const VoiceSendDiscordMessageSchema = z.object({
  channel: z.string().min(1).max(64),
  content: z.string().min(1).max(8000),
  call_id: z.string().min(1).max(128).optional(),
});

const VoiceAskCoreSchema = z.object({
  call_id: z.string().min(1).max(128),
  topic: z.string().min(1).max(64).default('andy'),
  request: z.string().min(1).max(4000),
  warmup: z.boolean().optional(),
  timeout_ms: z.number().int().min(100).max(600_000).optional(),
});

const VoiceScheduleRetrySchema = z.object({
  call_id: z.string().optional(),
  case_type: z.string().min(1).max(64),
  target_phone: z
    .string()
    .regex(/^\+\d{8,15}$/, 'target_phone must be E.164 format (+NNNN…)'),
  not_before_ts: z.string(),
});

const VoiceWakeUpSchema = z.object({
  call_id: z.string().min(1),
  reason: z.enum(['inbound', 'outbound']).optional(),
});

// ---------------------------------------------------------------------------
// Host-supplied dependencies
// ---------------------------------------------------------------------------

export interface VoiceHandlerDeps {
  /**
   * Spawn or wake the voice-context container with the given prompt and
   * return the agent's textual reply. Used by voice_ask_core.
   *
   * Implementation lives in the host (v2 trunk) because container-runner
   * details vary across forks. When omitted, ask_core returns
   * `not_yet_wired` and the bot can fall back to a graceful refusal.
   */
  spawnVoiceAgent?(args: {
    callId: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<{ ok: true; result: { voice_short: string; discord_long?: string | null } } | { ok: false; error: string }>;

  /**
   * Send a Discord message via the host's already-connected Discord
   * channel. Used by voice_send_discord_message.
   */
  sendDiscordMessage?(args: {
    channel: string;
    content: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;

  /**
   * Schedule a future outbound retry. Writes one row to the host's
   * scheduled-tasks table; `runAt` must be > now and within the host's
   * configured max-future window. Used by voice_schedule_retry.
   */
  scheduleRetry?(args: {
    call_id?: string;
    case_type: string;
    target_phone: string;
    not_before_ts: string;
  }): Promise<{ ok: true; task_id: string } | { ok: false; error: string }>;

  /**
   * Drop a wake-up sentinel into the operator's main group so the
   * container-agent spawns or refreshes idle. Fire-and-forget — voice-bridge
   * calls this at /accept so Andy is warm by the first ask_core. Returns
   * `no_main_group` if the host has no main-group registered yet.
   */
  triggerWakeUp?(args: {
    call_id: string;
    reason: 'inbound' | 'outbound';
  }): Promise<{ ok: true; status: 'scheduled' | 'no_main_group' } | { ok: false; error: string }>;
}

// ---------------------------------------------------------------------------
// Handler bodies
// ---------------------------------------------------------------------------

function makeInitHandler(): VoiceDispatchHandler {
  return async (raw): Promise<VoiceDispatchResult> => {
    const parsed = VoiceTriggersInitSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: 'bad_args' };
    }
    const input = parsed.data;
    const lang_whitelist = effectiveLangWhitelist(input.lang_whitelist);
    activeCallContexts.set(input.call_id, {
      call_id: input.call_id,
      case_type: input.case_type,
      call_direction: input.call_direction,
      counterpart_label: input.counterpart_label,
      lang: input.lang,
      lang_whitelist,
      goal: input.goal,
    });
    try {
      const r = renderPersonaForCall({
        ...input,
        lang_whitelist: [...lang_whitelist] as Lang[],
      } satisfies VoicePersonaInput);
      return { ok: true, result: { instructions: r.instructions } };
    } catch (err) {
      const code = (err as { code?: string }).code;
      logger.warn({
        event: 'voice_triggers_init_failed',
        call_id: input.call_id,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: code ?? 'agent_unavailable' };
    }
  };
}

function makeTranscriptHandler(): VoiceDispatchHandler {
  return async (raw): Promise<VoiceDispatchResult> => {
    const parsed = VoiceTriggersTranscriptSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'bad_args' };
    // No-op decision policy — same as v1 defaultInvokeAgentTurn.
    // Mid-call persona re-renders are rare; the OpenAI Realtime model
    // handles intra-call adaptation from the persona given at /accept.
    return { ok: true, result: { instructions_update: null } };
  };
}

function makeOnTranscriptTurnHandler(): VoiceDispatchHandler {
  return async (_raw): Promise<VoiceDispatchResult> => {
    // Pre-greet / per-turn variant. Same null no-op policy as transcript.
    return { ok: true, result: { instructions_update: null } };
  };
}

function makeSetLanguageHandler(): VoiceDispatchHandler {
  return async (raw): Promise<VoiceDispatchResult> => {
    const parsed = VoiceSetLanguageSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'bad_args' };
    const { call_id, lang } = parsed.data;
    const ctx = activeCallContexts.get(call_id);
    if (!ctx) return { ok: false, error: 'unknown_call' };
    if (!ctx.lang_whitelist.includes(lang)) {
      return { ok: false, error: 'lang_not_in_whitelist' };
    }
    const next: CallRenderContext = { ...ctx, lang };
    activeCallContexts.set(call_id, next);
    try {
      const r = renderPersonaForCall({
        call_id,
        case_type: ctx.case_type,
        call_direction: ctx.call_direction,
        counterpart_label: ctx.counterpart_label,
        lang,
        goal: ctx.goal,
        lang_whitelist: [...ctx.lang_whitelist] as Lang[],
      });
      return { ok: true, result: { lang, instructions: r.instructions } };
    } catch (err) {
      logger.warn({
        event: 'voice_set_language_render_failed',
        call_id,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'render_failed' };
    }
  };
}

function makeSendDiscordHandler(deps: VoiceHandlerDeps): VoiceDispatchHandler {
  return async (raw): Promise<VoiceDispatchResult> => {
    const parsed = VoiceSendDiscordMessageSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'bad_args' };
    if (!deps.sendDiscordMessage) return { ok: false, error: 'not_yet_wired' };
    try {
      const r = await deps.sendDiscordMessage({
        channel: parsed.data.channel,
        content: parsed.data.content,
      });
      if (r.ok) return { ok: true, result: { ok: true, status: 'sent' } };
      return { ok: false, error: r.error };
    } catch (err) {
      logger.warn({
        event: 'voice_send_discord_message_threw',
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'internal' };
    }
  };
}

function makeAskCoreHandler(deps: VoiceHandlerDeps): VoiceDispatchHandler {
  const DEFAULT_TIMEOUT_MS = 90_000;
  return async (raw): Promise<VoiceDispatchResult> => {
    const parsed = VoiceAskCoreSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'bad_args' };
    const { call_id, request, warmup, timeout_ms } = parsed.data;
    if (warmup) {
      // Warmup is a no-op in v2-friendly. Container is spawned on the
      // first non-warmup ask_core if not already warm. Bot still gets
      // the success shape it expects.
      return {
        ok: true,
        result: { voice_short: '', discord_long: null, source: 'warmup' },
      };
    }
    if (!deps.spawnVoiceAgent) return { ok: false, error: 'not_yet_wired' };
    try {
      const r = await deps.spawnVoiceAgent({
        callId: call_id,
        prompt: request,
        timeoutMs: timeout_ms ?? DEFAULT_TIMEOUT_MS,
      });
      if (r.ok) {
        return {
          ok: true,
          result: {
            voice_short: r.result.voice_short,
            discord_long: r.result.discord_long ?? null,
            source: 'andy',
          },
        };
      }
      return { ok: false, error: r.error };
    } catch (err) {
      logger.warn({
        event: 'voice_ask_core_threw',
        call_id,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'internal' };
    }
  };
}

function makeScheduleRetryHandler(deps: VoiceHandlerDeps): VoiceDispatchHandler {
  const MAX_FUTURE_MS = 30 * 24 * 60 * 60 * 1000;
  return async (raw): Promise<VoiceDispatchResult> => {
    const parsed = VoiceScheduleRetrySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'bad_args' };
    const args = parsed.data;
    const notBeforeMs = new Date(args.not_before_ts).getTime();
    if (!Number.isFinite(notBeforeMs)) {
      return { ok: false, error: 'invalid_not_before_ts' };
    }
    const nowMs = Date.now();
    if (notBeforeMs <= nowMs) return { ok: false, error: 'retry_at_in_past' };
    if (notBeforeMs > nowMs + MAX_FUTURE_MS) {
      return { ok: false, error: 'retry_at_too_far' };
    }
    if (!deps.scheduleRetry) return { ok: false, error: 'not_yet_wired' };
    try {
      const r = await deps.scheduleRetry(args);
      if (r.ok) return { ok: true, result: { task_id: r.task_id } };
      return { ok: false, error: r.error };
    } catch (err) {
      logger.warn({
        event: 'voice_schedule_retry_threw',
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'internal' };
    }
  };
}

function makeWakeUpHandler(deps: VoiceHandlerDeps): VoiceDispatchHandler {
  return async (raw): Promise<VoiceDispatchResult> => {
    const parsed = VoiceWakeUpSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'bad_args' };
    const { call_id, reason } = parsed.data;
    if (!deps.triggerWakeUp) return { ok: false, error: 'not_yet_wired' };
    try {
      const r = await deps.triggerWakeUp({ call_id, reason: reason ?? 'inbound' });
      if (r.ok) return { ok: true, result: { status: r.status } };
      return { ok: false, error: r.error };
    } catch (err) {
      logger.warn({
        event: 'voice_wake_up_threw',
        call_id,
        err: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'internal' };
    }
  };
}

// ---------------------------------------------------------------------------
// Public setup
// ---------------------------------------------------------------------------

export function setupVoiceHandlers(
  channel: VoiceChannel,
  deps: VoiceHandlerDeps,
): void {
  channel.setHandler('voice_triggers_init', makeInitHandler());
  channel.setHandler('voice_triggers_transcript', makeTranscriptHandler());
  channel.setHandler('voice_on_transcript_turn', makeOnTranscriptTurnHandler());
  channel.setHandler('voice_set_language', makeSetLanguageHandler());
  channel.setHandler('voice_send_discord_message', makeSendDiscordHandler(deps));
  channel.setHandler('voice_ask_core', makeAskCoreHandler(deps));

  channel.setHandler('voice_schedule_retry', makeScheduleRetryHandler(deps));
  channel.setHandler('voice_wake_up', makeWakeUpHandler(deps));

  logger.info({
    event: 'voice_handlers_registered',
    deterministic: ['voice_triggers_init', 'voice_triggers_transcript',
                    'voice_on_transcript_turn', 'voice_set_language'],
    dep_routed: ['voice_send_discord_message', 'voice_ask_core',
                 'voice_schedule_retry', 'voice_wake_up'],
  });
}

/**
 * Drop the per-call render context. Called by the host on call-end (the
 * mirror of voice-mcp/orchestrator/lifecycle.ts on the trunk side).
 */
export function endCallContext(call_id: string): void {
  activeCallContexts.delete(call_id);
}

/** Test-only export. */
export function _resetCallContexts(): void {
  activeCallContexts.clear();
}
