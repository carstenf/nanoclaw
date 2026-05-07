// src/voice-channel/register-tools.ts
//
// Voice-channel MCP tool registrations, extracted from src/mcp-tools/index.ts
// (refactor 2026-05-06) so the voice-channel can be added/removed as a
// `/add-voice-channel` skill without touching shared infrastructure.
//
// Single entry point: registerVoiceTools(registry, deps). Called once at
// registry-build time. When voice-channel is uninstalled (skill removed),
// this file disappears and the import + call in mcp-tools/index.ts go with
// it. The shared registry infrastructure (ToolRegistry, sweep timer,
// SlowBrainSessionManager wiring) stays in mcp-tools/index.ts.

import {
  VOICE_DISCORD_ALLOWED_CHANNELS,
  VOICE_DISCORD_TIMEOUT_MS,
  CONTRACTS_PATH,
  PRACTICE_PROFILE_PATH,
  ANDY_VOICE_DISCORD_CHANNEL,
  VOICE_DISCORD_ALLOWED_CHANNELS_RAW,
} from './config.js';
import { logger } from '../logger.js';
import {
  createTask,
  getAllTasks,
  getDatabase,
} from '../db.js';
import { insertTurnCost } from '../cost-ledger.js';
import type { ToolRegistry, RegistryDeps } from '../mcp-tools/index.js';
import { makeVoiceOnTranscriptTurn } from '../mcp-tools/voice-on-transcript-turn.js';
import { makeVoiceSendDiscordMessage } from '../mcp-tools/voice-send-discord-message.js';
import { makeVoiceFinalizeCallCost } from '../mcp-tools/voice-finalize-call-cost.js';
import { makeVoiceGetContract } from '../mcp-tools/voice-get-contract.js';
import { makeVoiceGetPracticeProfile } from '../mcp-tools/voice-get-practice-profile.js';
import { makeVoiceScheduleRetry } from '../mcp-tools/voice-schedule-retry.js';
import { makeVoiceSearchCompetitors } from '../mcp-tools/voice-search-competitors.js';
import { makeVoiceSetLanguage, TOOL_NAME as VOICE_SET_LANGUAGE_TOOL_NAME } from '../mcp-tools/voice-set-language.js';
import { makeVoiceWakeUp } from '../mcp-tools/voice-wake-up.js';
import {
  makeVoiceTriggersInit,
  TOOL_NAME as VOICE_TRIGGERS_INIT_TOOL_NAME,
  defaultInvokeAgent as realDefaultInvokeAgent,
} from '../mcp-tools/voice-triggers-init.js';
import {
  makeVoiceTriggersTranscript,
  TOOL_NAME as VOICE_TRIGGERS_TRANSCRIPT_TOOL_NAME,
  defaultInvokeAgentTurn as realDefaultInvokeAgentTurn,
} from '../mcp-tools/voice-triggers-transcript.js';
import { makeVoiceRespond } from '../mcp-tools/voice-respond.js';
import { VoiceTriggerQueue } from '../voice-trigger-queue.js';
import { VoiceRespondManager } from './index.js';
import { DATA_DIR } from '../config.js';

// Phase 05.5 Plan 01 Task 4 (REQ-INFRA-16, D-11): module-level singleton.
// Lives here (with the registrar) rather than mcp-tools/index.ts so the
// uninstall-voice-channel path takes this with it.
export const voiceTriggerQueue = new VoiceTriggerQueue();

/**
 * Register all voice-channel MCP tools onto the given registry.
 * Reads dependencies (deps) from the registry's caller; deps shape is
 * RegistryDeps so existing callers don't have to restructure their args.
 *
 * Conditional registrations (kept identical to pre-refactor behaviour):
 *  - voice_send_discord_message: only when sendDiscordMessage callback +
 *    non-empty allowlist are present.
 *  - voice_wake_up: only when triggerWakeUp callback is provided.
 *  - All others: always registered.
 */
export function registerVoiceTools(
  registry: ToolRegistry,
  deps: RegistryDeps,
): void {
  const log = deps.log ?? logger;
  const sessionManager = deps.sessionManager;
  const voiceRespondManager =
    deps.voiceRespondManager ?? new VoiceRespondManager();

  registry.register(
    'voice_on_transcript_turn',
    makeVoiceOnTranscriptTurn({
      dataDir: deps.dataDir ?? DATA_DIR,
      log,
      // sessionManager is created in mcp-tools/index.ts and forwarded via deps.
      // Cast: SlowBrainSessionManager is the concrete type; the on-transcript
      // factory accepts the same nominal type.
      sessionManager: sessionManager as NonNullable<RegistryDeps['sessionManager']>,
    }),
  );

  // voice_send_discord_message — only register when callback is provided AND allowlist is non-empty
  if (deps.sendDiscordMessage && VOICE_DISCORD_ALLOWED_CHANNELS.size > 0) {
    log.info(
      {
        event: 'mcp_tool_registering',
        tool: 'voice_send_discord_message',
        allowlist_size: VOICE_DISCORD_ALLOWED_CHANNELS.size,
      },
      'registered tool voice_send_discord_message',
    );
    registry.register(
      'voice_send_discord_message',
      makeVoiceSendDiscordMessage({
        sendDiscordMessage: deps.sendDiscordMessage,
        allowedChannels: VOICE_DISCORD_ALLOWED_CHANNELS,
        jsonlPath: deps.dataDir
          ? `${deps.dataDir}/voice-discord.jsonl`
          : undefined,
        timeoutMs: VOICE_DISCORD_TIMEOUT_MS,
      }),
      // Bridge-only utility (post-call transcript chunks). Bridge invokes
      // BEFORE voice_finalize_call_cost deregisters the call, so REQ-DIR-17
      // gateway with mutating=true rejects every chunk → transcripts never
      // reach Discord. Defense-in-depth still holds: persona prompt (layer 1)
      // forbids Andy from calling it, allowlist gates the channel, dedup-TTL
      // gates content. Layer 2 gateway off for this specific tool only.
      { mutating: false },
    );
  } else {
    log.warn(
      {
        event: 'mcp_tool_skipped',
        tool: 'voice_send_discord_message',
        has_callback: !!deps.sendDiscordMessage,
        allowlist_size: VOICE_DISCORD_ALLOWED_CHANNELS.size,
      },
      'skipping voice_send_discord_message — no callback or empty allowlist',
    );
  }

  // voice_finalize_call_cost — stub that deregisters the call from the
  // mid-call mutation gateway (cost-tracking deprecated 2026-05-05). Bridge
  // calls this on session.closed; without it, calls stay registered as
  // active and the post-call transcript chunks get rejected by the
  // REQ-DIR-17 gate as mid-call mutations. Mutating=false because this
  // IS the call-end signal — it must run regardless of active-call state.
  registry.register(
    'voice_finalize_call_cost',
    makeVoiceFinalizeCallCost(),
    { mutating: false },
  );
  log.info(
    { event: 'mcp_tool_registering', tool: 'voice_finalize_call_cost' },
    'registered tool voice_finalize_call_cost',
  );

  // voice_get_contract — always registered; graceful not_configured when file absent
  registry.register(
    'voice_get_contract',
    makeVoiceGetContract({
      contractsPath: CONTRACTS_PATH,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-lookup.jsonl`
        : undefined,
    }),
  );

  // voice_get_practice_profile — always registered; graceful not_configured when file absent
  registry.register(
    'voice_get_practice_profile',
    makeVoiceGetPracticeProfile({
      profilesPath: PRACTICE_PROFILE_PATH,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-lookup.jsonl`
        : undefined,
    }),
  );

  // voice_schedule_retry — always registered; returns no_main_group if callback absent or returns null
  registry.register(
    'voice_schedule_retry',
    makeVoiceScheduleRetry({
      createTask,
      getAllTasks,
      getMainGroupAndJid: deps.getMainGroupAndJid ?? (() => null),
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-scheduler.jsonl`
        : undefined,
    }),
    { mutating: true },
  );

  // Resolve Andy's Discord channel: use explicit ANDY_VOICE_DISCORD_CHANNEL if set,
  // otherwise fall back to the first allowed channel from VOICE_DISCORD_ALLOWED_CHANNELS.
  const andyDiscordChannel: string =
    ANDY_VOICE_DISCORD_CHANNEL ||
    (VOICE_DISCORD_ALLOWED_CHANNELS_RAW.split(',')
      .map((s) => s.trim())
      .filter(Boolean)[0] ??
      '');

  // voice_respond — Andy → Voice delivery channel. Resolves the pending
  // Promise registered by /voice/ask_core HTTP channel handler so the voice-
  // bridge gets Andy's reply as the ask_core tool result.
  registry.register(
    'voice_respond',
    makeVoiceRespond({
      manager: voiceRespondManager,
      sendDiscord: deps.sendDiscordMessage,
      andyDiscordChannel: andyDiscordChannel || undefined,
    }),
  );

  // Phase 4 Plan 04-03 (TOOLS-05): voice_search_competitors.
  // MVP Phase-4: returns not_configured when SEARCH_COMPETITORS_PROVIDER env
  // is unset. Phase 7 (C4 negotiation) wires the Claude-over-web-search
  // backend via askCompetitorsBackend dep.
  registry.register(
    'voice_search_competitors',
    makeVoiceSearchCompetitors({
      provider: process.env.SEARCH_COMPETITORS_PROVIDER,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-lookup.jsonl`
        : undefined,
      // askCompetitorsBackend deferred to Phase 7
    }),
  );

  // Phase 05.5 Plan 01 Task 4 (D-8, D-24): voice_triggers_init + voice_triggers_transcript.
  // Container-agent reasoning triggers. Phase 05.6 Plan 01 Task 2 replaced the
  // inline no-op AGENT-NOT-WIRED stubs (returned null) with the real
  // `src/voice-agent-invoker.ts` integration imported above as
  // `realDefaultInvokeAgent` / `realDefaultInvokeAgentTurn`. Tests that pass
  // an explicit `invokeAgent` / `invokeAgentTurn` via DI continue to work —
  // only the default behaviour changed.
  const defaultInvokeAgent: NonNullable<RegistryDeps['invokeAgent']> =
    realDefaultInvokeAgent;
  const defaultInvokeAgentTurn: NonNullable<RegistryDeps['invokeAgentTurn']> =
    realDefaultInvokeAgentTurn;

  // Phase 05.5 Plan 05 (REQ-COST-06): per-trigger cost-ledger sink. Wraps
  // the existing voice_record_turn_cost code-path so init / transcript
  // triggers share the same insertTurnCost pipeline (and the same SUM
  // aggregation) as Realtime turns. Synthetic turn_ids ('init', 'trigger-N')
  // avoid PRIMARY KEY collisions with numeric Realtime turn_ids.
  const recordTriggerCost = async (entry: {
    call_id: string;
    turn_id: string;
    trigger_type: 'init_trigger' | 'transcript_trigger';
    cost_eur: number;
  }): Promise<void> => {
    const row = {
      ts: new Date().toISOString(),
      call_id: entry.call_id,
      turn_id: entry.turn_id,
      audio_in_tokens: 0,
      audio_out_tokens: 0,
      cached_in_tokens: 0,
      text_in_tokens: 0,
      text_out_tokens: 0,
      cost_eur: entry.cost_eur,
      trigger_type: entry.trigger_type,
    };
    insertTurnCost(getDatabase(), row);
  };

  registry.register(
    VOICE_TRIGGERS_INIT_TOOL_NAME,
    makeVoiceTriggersInit({
      invokeAgent: deps.invokeAgent ?? defaultInvokeAgent,
      recordCost: recordTriggerCost,
      jsonlPath: deps.dataDir ? `${deps.dataDir}/voice-triggers.jsonl` : undefined,
    }),
  );

  registry.register(
    VOICE_TRIGGERS_TRANSCRIPT_TOOL_NAME,
    makeVoiceTriggersTranscript({
      queue: voiceTriggerQueue,
      invokeAgentTurn: deps.invokeAgentTurn ?? defaultInvokeAgentTurn,
      recordCost: recordTriggerCost,
      jsonlPath: deps.dataDir ? `${deps.dataDir}/voice-triggers.jsonl` : undefined,
    }),
  );

  // Phase 06.x: voice_set_language — mid-call language switch tool. mutating
  // is false because the only state mutated is the per-call gateway entry
  // (voice-channel internal); no external system writes happen. The tool
  // validates lang ∈ per-call lang_whitelist server-side so an off-whitelist
  // bot call is rejected even with valid args.
  registry.register(
    VOICE_SET_LANGUAGE_TOOL_NAME,
    makeVoiceSetLanguage(),
    { mutating: false },
  );

  // voice_wake_up — pre-warm the main container at /accept time. Only
  // registered when triggerWakeUp dep is provided (production wires it in
  // src/index.ts; tests can omit).
  if (deps.triggerWakeUp) {
    log.info(
      { event: 'mcp_tool_registering', tool: 'voice_wake_up' },
      'registered tool voice_wake_up',
    );
    registry.register('voice_wake_up', makeVoiceWakeUp({
      triggerWakeUp: deps.triggerWakeUp,
    }), { mutating: false });
  }
}
