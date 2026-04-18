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
import { getCalendarClient } from './calendar-client.js';
import { makeVoiceSendDiscordMessage } from './voice-send-discord-message.js';
import { makeVoiceGetTravelTime } from './voice-get-travel-time.js';
import { makeVoiceGetContract } from './voice-get-contract.js';
import { makeVoiceGetPracticeProfile } from './voice-get-practice-profile.js';
import { makeVoiceScheduleRetry } from './voice-schedule-retry.js';
import { createTask } from '../db.js';

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
      getMainGroupAndJid: deps.getMainGroupAndJid ?? (() => null),
      jsonlPath: deps.dataDir
        ? `${deps.dataDir}/voice-scheduler.jsonl`
        : undefined,
    }),
  );

  return registry;
}
