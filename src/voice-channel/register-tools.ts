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
import { makeVoiceRecordTurnCost } from '../mcp-tools/voice-record-turn-cost.js';
import { makeVoiceGetContract } from '../mcp-tools/voice-get-contract.js';
import { makeVoiceGetPracticeProfile } from '../mcp-tools/voice-get-practice-profile.js';
import { makeVoiceScheduleRetry } from '../mcp-tools/voice-schedule-retry.js';
import { makeVoiceSearchCompetitors } from '../mcp-tools/voice-search-competitors.js';
import { makeVoiceSetLanguage, TOOL_NAME as VOICE_SET_LANGUAGE_TOOL_NAME } from '../mcp-tools/voice-set-language.js';
import { makeVoiceGetBudgetStatus, TOOL_NAME as VOICE_GET_BUDGET_STATUS_TOOL_NAME } from '../mcp-tools/voice-get-budget-status.js';
import { makeVoiceSetPrepaidBalance, TOOL_NAME as VOICE_SET_PREPAID_BALANCE_TOOL_NAME } from '../mcp-tools/voice-set-prepaid-balance.js';
import { makeVoiceCallCostSnapshot, TOOL_NAME as VOICE_CALL_COST_SNAPSHOT_TOOL_NAME } from '../mcp-tools/voice-call-cost-snapshot.js';
import { makeVoiceCallCostFinalize, TOOL_NAME as VOICE_CALL_COST_FINALIZE_TOOL_NAME } from '../mcp-tools/voice-call-cost-finalize.js';
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

  // Resolve Andy's Discord channel here (was inline below before 2026-05-07)
  // because voice_finalize_call_cost needs it for the post-call summary.
  // Used by voice_respond as well — same value, single resolve.
  // 2026-05-08: Falls back to VOICE_TRANSCRIPT_DISCORD_CHANNEL when
  // ANDY_VOICE_DISCORD_CHANNEL is unset, so the post-call cost summary
  // lands in the same channel as the transcript by default. Without this,
  // andyDiscordChannel resolved to the first allowlist entry (often a
  // different channel), and the summary went to a channel the user wasn't
  // watching.
  const andyDiscordChannel: string =
    ANDY_VOICE_DISCORD_CHANNEL ||
    process.env.VOICE_TRANSCRIPT_DISCORD_CHANNEL ||
    (VOICE_DISCORD_ALLOWED_CHANNELS_RAW.split(',')
      .map((s) => s.trim())
      .filter(Boolean)[0] ??
      '');

  // voice_finalize_call_cost — deregisters the call from the mid-call
  // mutation gateway. Bridge calls this on session.closed; without it,
  // calls stay registered as active and the post-call transcript chunks
  // get rejected by the REQ-DIR-17 gate as mid-call mutations.
  // Mutating=false because this IS the call-end signal — it must run
  // regardless of active-call state.
  // 2026-05-07: extended with post-call summary (per-call EUR + day/month
  // ledger SUM + OpenAI org month-to-date USD + budget rest). When
  // sendDiscordMessage + andyDiscordChannel are wired, every call ends
  // with a Discord post in the voice channel.
  registry.register(
    'voice_finalize_call_cost',
    makeVoiceFinalizeCallCost({
      sendDiscordMessage: deps.sendDiscordMessage,
      discordChannelId: andyDiscordChannel || undefined,
    }),
    { mutating: false },
  );
  log.info(
    {
      event: 'mcp_tool_registering',
      tool: 'voice_finalize_call_cost',
      summary_wired: !!(deps.sendDiscordMessage && andyDiscordChannel),
    },
    'registered tool voice_finalize_call_cost',
  );

  // voice_record_turn_cost — bridge fires per response.done with the
  // OpenAI Realtime usage + computed EUR cost. Persists into
  // voice_turn_costs ledger. Re-introduced 2026-05-07 after the 2026-05-05
  // deprecation, because Carsten wants per-call cost summaries posted to
  // Discord (Phase C) and the ledger is the source of truth for both per-
  // call and monthly aggregates.
  registry.register(
    'voice_record_turn_cost',
    makeVoiceRecordTurnCost(),
    { mutating: false },
  );
  log.info(
    { event: 'mcp_tool_registering', tool: 'voice_record_turn_cost' },
    'registered tool voice_record_turn_cost',
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

  // 2026-05-08: voice_get_budget_status — Andy-facing chat tool. Lets the
  // user ask "wieviel guthaben hab ich noch?" via WhatsApp/Discord and
  // get OpenAI org month-to-date + budget rest. Read-only; mutating=false.
  registry.register(
    VOICE_GET_BUDGET_STATUS_TOOL_NAME,
    makeVoiceGetBudgetStatus(),
    { mutating: false },
  );

  // 2026-05-08: voice_set_prepaid_balance — Andy-facing chat tool. Operator
  // declares the OpenAI prepaid topup amount ("ich hab gerade 100 EUR
  // aufgeladen"). Writes voice-balance.json; voice_get_budget_status reads
  // it to compute the actual remaining balance via the cost-API delta from
  // the topup timestamp. mutating=true because it persists state.
  registry.register(
    VOICE_SET_PREPAID_BALANCE_TOOL_NAME,
    makeVoiceSetPrepaidBalance(),
    { mutating: true },
  );

  // 2026-05-08 Phase 2: per-call delta-cost path.
  //
  // Bridge calls voice_call_cost_snapshot at /accept (records baseline
  // OpenAI mtd cost), then voice_call_cost_finalize ~8s after teardown
  // (subtracts to get the actual billed call cost; posts full summary
  // to the standard voice-channel — first VOICE_DISCORD_ALLOWED_CHANNELS
  // entry, NOT the transcript channel).
  //
  // Standard channel resolution: explicit env override
  // VOICE_STANDARD_DISCORD_CHANNEL > first allowlist entry. The transcript
  // channel (VOICE_TRANSCRIPT_DISCORD_CHANNEL) is intentionally NOT used
  // here — operator wants summaries in the main voice channel, not the
  // transcript log channel.
  const standardVoiceChannel: string =
    process.env.VOICE_STANDARD_DISCORD_CHANNEL ||
    (VOICE_DISCORD_ALLOWED_CHANNELS_RAW.split(',')
      .map((s) => s.trim())
      .filter(Boolean)[0] ??
      '');

  registry.register(
    VOICE_CALL_COST_SNAPSHOT_TOOL_NAME,
    makeVoiceCallCostSnapshot(),
    { mutating: false },
  );

  registry.register(
    VOICE_CALL_COST_FINALIZE_TOOL_NAME,
    makeVoiceCallCostFinalize({
      sendDiscordMessage: deps.sendDiscordMessage,
      discordChannelId: standardVoiceChannel || undefined,
    }),
    { mutating: false },
  );
  log.info(
    {
      event: 'mcp_tool_registering',
      tool: 'voice_call_cost_finalize',
      standard_channel: standardVoiceChannel || '(unset)',
      summary_wired: !!(deps.sendDiscordMessage && standardVoiceChannel),
    },
    'registered tool voice_call_cost_finalize',
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
