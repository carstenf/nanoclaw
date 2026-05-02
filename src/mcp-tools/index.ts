import fs from 'fs';

import { OneCLI } from '@onecli-sh/sdk';

import { DATA_DIR, ONECLI_URL } from '../config.js';
import { logger } from '../logger.js';

import {
  VOICE_DISCORD_ALLOWED_CHANNELS,
  VOICE_DISCORD_TIMEOUT_MS,
  CONTRACTS_PATH,
  PRACTICE_PROFILE_PATH,
} from '../config.js';
import { SlowBrainSessionManager } from './slow-brain-session.js';
import { makeVoiceOnTranscriptTurn } from './voice-on-transcript-turn.js';
import { makeVoiceSendDiscordMessage } from './voice-send-discord-message.js';
import { makeVoiceGetContract } from './voice-get-contract.js';
import { makeVoiceGetPracticeProfile } from './voice-get-practice-profile.js';
import { makeVoiceScheduleRetry } from './voice-schedule-retry.js';
import { makeVoiceSearchCompetitors } from './voice-search-competitors.js';
import { makeVoiceSetLanguage, TOOL_NAME as VOICE_SET_LANGUAGE_TOOL_NAME } from './voice-set-language.js';
import { makeVoiceWakeUp } from './voice-wake-up.js';
import {
  makeVoiceTriggersInit,
  TOOL_NAME as VOICE_TRIGGERS_INIT_TOOL_NAME,
  type VoiceTriggersInitInput,
  // Phase 05.6 Plan 01 Task 2: real defaultInvokeAgent re-exported from
  // voice-triggers-init.ts (which itself re-exports from voice-agent-invoker.ts).
  // Replaces the Phase-05.5 inline AGENT-NOT-WIRED no-op stub.
  defaultInvokeAgent as realDefaultInvokeAgent,
} from './voice-triggers-init.js';
import {
  makeVoiceTriggersTranscript,
  TOOL_NAME as VOICE_TRIGGERS_TRANSCRIPT_TOOL_NAME,
  type VoiceTriggersTranscriptInput,
  defaultInvokeAgentTurn as realDefaultInvokeAgentTurn,
} from './voice-triggers-transcript.js';
import { VoiceTriggerQueue } from '../voice-trigger-queue.js';
import { createActiveSessionTracker } from '../channels/active-session-tracker.js';
import { loadSkill } from './skill-loader.js';
import { callClaudeViaOneCli } from './claude-client.js';
import { makeVoiceRespond } from './voice-respond.js';
import { VoiceRespondManager } from '../voice-channel/index.js';
import {
  createTask,
  getAllTasks,
  getDatabase,
  getRouterState,
  setRouterState,
} from '../db.js';
import {
  insertTurnCost,
  upsertCallCost,
  sumCostCurrentDay,
  sumCostCurrentMonth,
  insertPriceSnapshot,
} from '../cost-ledger.js';
// Phase 05.6 Plan 01 Task 4 — REQ-DIR-17 dispatch-path gateway.
import {
  checkMidCallMutation,
  type ToolMeta,
} from '../voice-mid-call-gateway.js';
import {
  SKILLS_DIR,
  ASK_CORE_CLAUDE_TIMEOUT_MS,
  ASK_CORE_MAX_TOKENS_PER_CALL,
  ASK_CORE_ANDY_TIMEOUT_MS,
  ANDY_VOICE_DISCORD_CHANNEL,
  VOICE_DISCORD_ALLOWED_CHANNELS_RAW,
  BRIDGE_OUTBOUND_URL,
  BRIDGE_OUTBOUND_AUTH_TOKEN,
} from '../config.js';

/**
 * Fetch OneCLI CA certificate and write it to the path set in NODE_EXTRA_CA_CERTS.
 * Must be called before the first TLS connection through the OneCLI proxy.
 * Fails silently — if OneCLI is unreachable, inference will fail at call time.
 */
export async function ensureOneCLICaCert(): Promise<void> {
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  if (!caPath) return;
  // If file already exists, no need to re-fetch
  if (fs.existsSync(caPath)) return;
  try {
    const onecli = new OneCLI({ url: ONECLI_URL });
    const config = await onecli.getContainerConfig();
    fs.writeFileSync(caPath, config.caCertificate);
    logger.info({ event: 'onecli_ca_cert_written', path: caPath });
  } catch (err) {
    logger.warn({ event: 'onecli_ca_cert_write_failed', err });
  }
}

export type ToolHandler = (args: unknown) => Promise<unknown>;

export class UnknownToolError extends Error {
  readonly code = 'unknown_tool';
  constructor(public readonly toolName: string) {
    super(`unknown_tool: ${toolName}`);
    this.name = 'UnknownToolError';
  }
}

/**
 * Per-tool registration entry. The optional `meta.mutating` flag drives the
 * REQ-DIR-17 dispatch-path gateway (Phase 05.6 Plan 01 Task 4): mutating
 * tools invoked while a call is active are rejected with
 * `{ ok: false, error: 'mid_call_mutation_forbidden' }` BEFORE the handler runs.
 */
export interface ToolRegistration {
  handler: ToolHandler;
  meta: ToolMeta;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();

  /**
   * Backward-compat additive signature. Existing callers that omit `meta`
   * implicitly register the tool as non-mutating (the safe default —
   * read-only tools always pass the gateway).
   */
  register(name: string, handler: ToolHandler, meta: ToolMeta = {}): void {
    this.tools.set(name, { handler, meta });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async invoke(name: string, args: unknown): Promise<unknown> {
    const reg = this.tools.get(name);
    if (!reg) throw new UnknownToolError(name);

    // REQ-DIR-17 dispatch-path gateway (Phase 05.6 Plan 01 Task 4).
    // Read call_id off the args object if present; absent or non-string
    // call_id → null → gateway treats as no-call-correlation → ALLOWED.
    const callId =
      args && typeof args === 'object' && 'call_id' in args
        ? (args as { call_id: unknown }).call_id
        : null;
    const callIdStr = typeof callId === 'string' ? callId : null;
    const decision = checkMidCallMutation(callIdStr, name, reg.meta);
    if (!decision.allowed) {
      return { ok: false, error: decision.reason };
    }
    return reg.handler(args);
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
  /** Discord send callback — injected from index.ts to reuse existing DiscordChannel gateway. */
  sendDiscordMessage?: (
    channelId: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Main-group lookup callback — returns {folder, jid} for is_main=1 group, or null. */
  getMainGroupAndJid?: () => { folder: string; jid: string } | null;
  /**
   * Plan 05-02 Task 5: external ActiveSessionTracker instance.
   * When provided, voice_notify_user uses this tracker instead of creating its own.
   * index.ts creates one at startup and calls tracker.recordActivity() on every
   * inbound message, then passes the same instance here so the routing has real data.
   */
  activeSessionTracker?: import('../channels/active-session-tracker.js').ActiveSessionTracker;
  /**
   * Phase 05.5 Plan 01 Task 4 (D-24): DI seam for the container-agent reasoning
   * layer. Phase 05.5 keeps the defaults as no-op stubs (see registration below);
   * Phase 05.6 replaces with a real `src/container-runner.ts` integration.
   * Tests inject mocks for behavioural verification.
   */
  invokeAgent?: (
    input: VoiceTriggersInitInput,
  ) => Promise<{ instructions: string }>;
  invokeAgentTurn?: (
    input: VoiceTriggersTranscriptInput,
  ) => Promise<{ instructions_update: string | null }>;
  /**
   * Phase 05.6-04 follow-up: shared VoiceRespondManager for the
   * existing-container voice-request path. The voice_respond MCP tool
   * resolves pending Promises in this manager; voice-ask-core (topic='andy')
   * registers them. Inject the same instance for both. If omitted,
   * buildDefaultRegistry creates one internally.
   */
  voiceRespondManager?: VoiceRespondManager;
  /**
   * Phase 05.6-04 follow-up: drop a voice_request IPC envelope into the
   * active main container. Returns true if the container was active and the
   * file was written; false if no active container — voice-ask-core then
   * returns a graceful "Andy nicht erreichbar" (NO --rm fallback to avoid
   * orphan-container leaks across NanoClaw restarts). Wired in NanoClaw
   * index.ts as `(callId, prompt) => queue.sendVoiceRequest(mainJid, ...)`.
   */
  tryInjectVoiceRequest?: (callId: string, prompt: string) => boolean;
  /**
   * open_points 2026-04-27 #1: pre-warm the main container at voice /accept
   * time. Inserts a `<voice_wake_up>` sentinel message into the main group
   * DB and triggers `enqueueMessageCheck`, so the container spawns if down
   * or the wake-up turn is absorbed if up. Returns true when scheduled,
   * false if no main group is registered. Wired in NanoClaw index.ts.
   */
  triggerWakeUp?: (callId: string, reason: string) => boolean;
}

// Phase 05.5 Plan 01 Task 4 (REQ-INFRA-16, D-11): Module-level singleton so
// `voice-finalize-call-cost.ts` can import it for end-of-call gc(). Named
// export — finalize-call-cost imports via dynamic import to avoid circular
// dependency (mcp-tools/index.ts imports finalize-call-cost statically).
export const voiceTriggerQueue = new VoiceTriggerQueue();

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

  // Ensure the OneCLI CA cert is written before the first inference call.
  // Fire-and-forget: if OneCLI is unreachable at startup, inference will
  // log a warning at call time.
  if (!deps.sessionManager) {
    void ensureOneCLICaCert();
  }

  const sessionManager = deps.sessionManager ?? new SlowBrainSessionManager();
  // Phase 05.6-04 follow-up: shared VoiceRespondManager for ask_core
  // existing-container path. Singleton per registry — voice-ask-core
  // registers, voice_respond resolves.
  const voiceRespondManager =
    deps.voiceRespondManager ?? new VoiceRespondManager();

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
    'voice_on_transcript_turn',
    makeVoiceOnTranscriptTurn({
      dataDir: deps.dataDir ?? DATA_DIR,
      log: deps.log ?? logger,
      sessionManager,
    }),
  );

  // voice_send_discord_message — only register when callback is provided AND allowlist is non-empty
  if (deps.sendDiscordMessage && VOICE_DISCORD_ALLOWED_CHANNELS.size > 0) {
    const log = deps.log ?? logger;
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
      { mutating: true },
    );
  } else {
    const log = deps.log ?? logger;
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

  // (Phase 5 voice_start_case_2_call retired 2026-04-29 — Andy uses
  // voice_request_outbound_call for ALL outbound calls, see open_points
  // 2026-04-27 Step 1 + 2A-D for the merge sequence.)

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

  // V2.1: voice_set_operator_config and voice_notify_user moved to voice-mcp
  // (Hetzner :3300). Andy calls them via mcp__voice__* now.

  // voice_wake_up — pre-warm the main container at /accept time. Only
  // registered when triggerWakeUp dep is provided (production wires it in
  // src/index.ts; tests can omit).
  if (deps.triggerWakeUp) {
    const log = deps.log ?? logger;
    log.info(
      { event: 'mcp_tool_registering', tool: 'voice_wake_up' },
      'registered tool voice_wake_up',
    );
    registry.register('voice_wake_up', makeVoiceWakeUp({
      triggerWakeUp: deps.triggerWakeUp,
    }), { mutating: false });
  }

  return registry;
}
