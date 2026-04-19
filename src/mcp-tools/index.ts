import fs from 'fs';

import { OneCLI } from '@onecli-sh/sdk';

import { DATA_DIR, ONECLI_URL } from '../config.js';
import { logger } from '../logger.js';

import {
  VOICE_DISCORD_ALLOWED_CHANNELS,
  VOICE_DISCORD_TIMEOUT_MS,
  GOOGLE_MAPS_API_KEY,
  GOOGLE_MAPS_TIMEOUT_MS,
  CONTRACTS_PATH,
  PRACTICE_PROFILE_PATH,
} from '../config.js';
import { SlowBrainSessionManager } from './slow-brain-session.js';
import { makeVoiceOnTranscriptTurn } from './voice-on-transcript-turn.js';
import { makeVoiceCheckCalendar } from './voice-check-calendar.js';
import { makeVoiceCreateCalendarEntry } from './voice-create-calendar-entry.js';
import { makeVoiceDeleteCalendarEntry } from './voice-delete-calendar-entry.js';
import { makeVoiceUpdateCalendarEntry } from './voice-update-calendar-entry.js';
import { getCalendarClient } from './calendar-client.js';
import { makeVoiceSendDiscordMessage } from './voice-send-discord-message.js';
import { makeVoiceGetTravelTime } from './voice-get-travel-time.js';
import { makeVoiceGetContract } from './voice-get-contract.js';
import { makeVoiceGetPracticeProfile } from './voice-get-practice-profile.js';
import { makeVoiceScheduleRetry } from './voice-schedule-retry.js';
import { makeVoiceAskCore } from './voice-ask-core.js';
import { makeVoiceRequestOutboundCall } from './voice-request-outbound-call.js';
import { makeVoiceRecordTurnCost } from './voice-record-turn-cost.js';
import { makeVoiceFinalizeCallCost } from './voice-finalize-call-cost.js';
import { makeVoiceGetDayMonthCostSum } from './voice-get-day-month-cost-sum.js';
import { makeVoiceResetMonthlyCap } from './voice-reset-monthly-cap.js';
import { makeVoiceSearchCompetitors } from './voice-search-competitors.js';
import { loadSkill } from './skill-loader.js';
import { callClaudeViaOneCli } from './claude-client.js';
import { runAndyForVoice } from './andy-agent-runner.js';
import { createTask, getAllTasks, getDatabase, getRouterState, setRouterState } from '../db.js';
import {
  insertTurnCost,
  upsertCallCost,
  sumCostCurrentDay,
  sumCostCurrentMonth,
} from '../cost-ledger.js';
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
  /** Discord send callback — injected from index.ts to reuse existing DiscordChannel gateway. */
  sendDiscordMessage?: (
    channelId: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Main-group lookup callback — returns {folder, jid} for is_main=1 group, or null. */
  getMainGroupAndJid?: () => { folder: string; jid: string } | null;
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

  // Ensure the OneCLI CA cert is written before the first inference call.
  // Fire-and-forget: if OneCLI is unreachable at startup, inference will
  // log a warning at call time.
  if (!deps.sessionManager) {
    void ensureOneCLICaCert();
  }

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

  registry.register(
    'voice.check_calendar',
    makeVoiceCheckCalendar({
      calendarClient: () => getCalendarClient(),
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-calendar.jsonl`
        : undefined,
    }),
  );

  registry.register(
    'voice.create_calendar_entry',
    makeVoiceCreateCalendarEntry({
      calendarClient: () => getCalendarClient(),
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-calendar.jsonl`
        : undefined,
    }),
  );

  registry.register(
    'voice.delete_calendar_entry',
    makeVoiceDeleteCalendarEntry({
      calendarClient: () => getCalendarClient(),
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-calendar.jsonl`
        : undefined,
    }),
  );

  registry.register(
    'voice.update_calendar_entry',
    makeVoiceUpdateCalendarEntry({
      calendarClient: () => getCalendarClient(),
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-calendar.jsonl`
        : undefined,
    }),
  );

  // voice.send_discord_message — only register when callback is provided AND allowlist is non-empty
  if (deps.sendDiscordMessage && VOICE_DISCORD_ALLOWED_CHANNELS.size > 0) {
    const log = deps.log ?? logger;
    log.info(
      {
        event: 'mcp_tool_registering',
        tool: 'voice.send_discord_message',
        allowlist_size: VOICE_DISCORD_ALLOWED_CHANNELS.size,
      },
      'registered tool voice.send_discord_message',
    );
    registry.register(
      'voice.send_discord_message',
      makeVoiceSendDiscordMessage({
        sendDiscordMessage: deps.sendDiscordMessage,
        allowedChannels: VOICE_DISCORD_ALLOWED_CHANNELS,
        jsonlPath: deps.dataDir
          ? `${deps.dataDir}/voice-discord.jsonl`
          : undefined,
        timeoutMs: VOICE_DISCORD_TIMEOUT_MS,
      }),
    );
  } else {
    const log = deps.log ?? logger;
    log.warn(
      {
        event: 'mcp_tool_skipped',
        tool: 'voice.send_discord_message',
        has_callback: !!deps.sendDiscordMessage,
        allowlist_size: VOICE_DISCORD_ALLOWED_CHANNELS.size,
      },
      'skipping voice.send_discord_message — no callback or empty allowlist',
    );
  }

  // voice.get_travel_time — only register when GOOGLE_MAPS_API_KEY is set
  if (GOOGLE_MAPS_API_KEY.length > 0) {
    const log = deps.log ?? logger;
    log.info(
      { event: 'mcp_tool_registering', tool: 'voice.get_travel_time' },
      'registered tool voice.get_travel_time',
    );
    registry.register(
      'voice.get_travel_time',
      makeVoiceGetTravelTime({
        apiKey: GOOGLE_MAPS_API_KEY,
        timeoutMs: GOOGLE_MAPS_TIMEOUT_MS,
        jsonlPath: deps.dataDir
          ? `${deps.dataDir}/voice-maps.jsonl`
          : undefined,
      }),
    );
  } else {
    const log = deps.log ?? logger;
    log.info(
      { event: 'mcp_tool_skipped', tool: 'voice.get_travel_time' },
      'voice.get_travel_time skipped: no GOOGLE_MAPS_API_KEY',
    );
  }

  // voice.get_contract — always registered; graceful not_configured when file absent
  registry.register(
    'voice.get_contract',
    makeVoiceGetContract({
      contractsPath: CONTRACTS_PATH,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-lookup.jsonl`
        : undefined,
    }),
  );

  // voice.get_practice_profile — always registered; graceful not_configured when file absent
  registry.register(
    'voice.get_practice_profile',
    makeVoiceGetPracticeProfile({
      profilesPath: PRACTICE_PROFILE_PATH,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-lookup.jsonl`
        : undefined,
    }),
  );

  // voice.schedule_retry — always registered; returns no_main_group if callback absent or returns null
  registry.register(
    'voice.schedule_retry',
    makeVoiceScheduleRetry({
      createTask,
      getAllTasks,
      getMainGroupAndJid: deps.getMainGroupAndJid ?? (() => null),
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-scheduler.jsonl`
        : undefined,
    }),
  );

  // Resolve Andy's Discord channel: use explicit ANDY_VOICE_DISCORD_CHANNEL if set,
  // otherwise fall back to the first allowed channel from VOICE_DISCORD_ALLOWED_CHANNELS.
  const andyDiscordChannel: string =
    ANDY_VOICE_DISCORD_CHANNEL ||
    (VOICE_DISCORD_ALLOWED_CHANNELS_RAW.split(',')
      .map((s) => s.trim())
      .filter(Boolean)[0] ??
      '');

  // voice.ask_core — always registered; graceful skill_not_configured when skill absent
  // topic='andy' → runAndyForVoice (real container-agent against groups/main)
  // other topics  → echo-skill / Claude inference path
  registry.register(
    'voice.ask_core',
    makeVoiceAskCore({
      loadSkill: (topic) => loadSkill(topic, { skillsDir: SKILLS_DIR }),
      callClaude: (sys, msgs, o) =>
        callClaudeViaOneCli(sys, msgs, {
          timeoutMs: o?.timeoutMs,
          maxTokens: o?.maxTokens,
        }),
      runAndy: (req) =>
        runAndyForVoice(req, { timeoutMs: ASK_CORE_ANDY_TIMEOUT_MS }),
      sendDiscord: deps.sendDiscordMessage,
      andyDiscordChannel: andyDiscordChannel || undefined,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-ask-core.jsonl`
        : undefined,
      timeoutMs: ASK_CORE_CLAUDE_TIMEOUT_MS,
      maxTokens: ASK_CORE_MAX_TOKENS_PER_CALL,
    }),
  );

  // voice.request_outbound_call — always registered; forwards to Bridge /outbound
  registry.register(
    'voice.request_outbound_call',
    makeVoiceRequestOutboundCall({
      bridgeUrl: BRIDGE_OUTBOUND_URL,
      bridgeAuthToken: BRIDGE_OUTBOUND_AUTH_TOKEN || undefined,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-outbound.jsonl`
        : undefined,
    }),
  );

  // Phase 4 (INFRA-06): Bridge-internal cost housekeeping tools.
  // Always registered — no external prereq. Bridge posts per-turn and per-call
  // rows as it observes response.done / session.closed events.
  registry.register(
    'voice.record_turn_cost',
    makeVoiceRecordTurnCost({
      insertTurnCost: (row) => insertTurnCost(getDatabase(), row),
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-cost.jsonl`
        : undefined,
    }),
  );

  registry.register(
    'voice.finalize_call_cost',
    makeVoiceFinalizeCallCost({
      upsertCallCost: (row) => upsertCallCost(getDatabase(), row),
      sumTurnCosts: (call_id) => {
        const r = getDatabase()
          .prepare(
            'SELECT COALESCE(SUM(cost_eur), 0) AS s, COUNT(*) AS n FROM voice_turn_costs WHERE call_id = ?',
          )
          .get(call_id) as { s: number; n: number };
        return { sum_eur: r.s, count: r.n };
      },
      // Phase 4 Plan 04-02 (COST-03 variant b): auto-suspend after monthly
      // cap reached, triggered inside finalize — atomic with the upsert.
      sumCostCurrentMonth: () => sumCostCurrentMonth(getDatabase()),
      setRouterState,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-cost.jsonl`
        : undefined,
    }),
  );

  // Phase 4 Plan 04-02: /accept-time cost gate + manual cap reset.
  // voice.get_day_month_cost_sum is read by voice-bridge/src/cost/gate.ts on
  // every incoming call. voice.reset_monthly_cap is the manual override
  // Carsten invokes (via iPhone/Chat) after a €25 monthly breach.
  registry.register(
    'voice.get_day_month_cost_sum',
    makeVoiceGetDayMonthCostSum({
      sumCostCurrentDay: () => sumCostCurrentDay(getDatabase()),
      sumCostCurrentMonth: () => sumCostCurrentMonth(getDatabase()),
      isSuspended: () => getRouterState('voice_channel_suspended') === '1',
    }),
  );

  registry.register(
    'voice.reset_monthly_cap',
    makeVoiceResetMonthlyCap({
      getRouterState,
      setRouterState,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-cost.jsonl`
        : undefined,
    }),
  );

  // Phase 4 Plan 04-03 (TOOLS-05): voice.search_competitors.
  // MVP Phase-4: returns not_configured when SEARCH_COMPETITORS_PROVIDER env
  // is unset. Phase 7 (C4 negotiation) wires the Claude-over-web-search
  // backend via askCompetitorsBackend dep.
  registry.register(
    'voice.search_competitors',
    makeVoiceSearchCompetitors({
      provider: process.env.SEARCH_COMPETITORS_PROVIDER,
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-lookup.jsonl`
        : undefined,
      // askCompetitorsBackend deferred to Phase 7
    }),
  );

  return registry;
}
