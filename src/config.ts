import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Slow-Brain Claude inference settings
export const SLOW_BRAIN_MODEL =
  process.env.SLOW_BRAIN_MODEL || 'claude-sonnet-4-5';
// SLOW_BRAIN_PROXY_URL: authenticated OneCLI proxy URL for host-process inference.
// Format: http://x:<access-token>@localhost:10255
// Set via systemd Environment= — never put access tokens in .env or code.
export const SLOW_BRAIN_PROXY_URL = process.env.SLOW_BRAIN_PROXY_URL || '';
export const SLOW_BRAIN_MAX_TOKENS_PER_TURN = parseInt(
  process.env.SLOW_BRAIN_MAX_TOKENS_PER_TURN || '300',
  10,
);
export const SLOW_BRAIN_CLAUDE_TIMEOUT_MS = parseInt(
  process.env.SLOW_BRAIN_CLAUDE_TIMEOUT_MS || '5000',
  10,
);
export const SLOW_BRAIN_SESSION_IDLE_MS = parseInt(
  process.env.SLOW_BRAIN_SESSION_IDLE_MS || '1800000',
  10,
);

// Discord MCP tool settings
const envDiscord = readEnvFile([
  'VOICE_DISCORD_ALLOWED_CHANNELS',
  'VOICE_DISCORD_TIMEOUT_MS',
]);
export const VOICE_DISCORD_ALLOWED_CHANNELS_RAW =
  process.env.VOICE_DISCORD_ALLOWED_CHANNELS ??
  envDiscord.VOICE_DISCORD_ALLOWED_CHANNELS ??
  '';
export const VOICE_DISCORD_ALLOWED_CHANNELS: Set<string> = new Set(
  VOICE_DISCORD_ALLOWED_CHANNELS_RAW.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
export const VOICE_DISCORD_TIMEOUT_MS = parseInt(
  process.env.VOICE_DISCORD_TIMEOUT_MS ??
    envDiscord.VOICE_DISCORD_TIMEOUT_MS ??
    '8000',
  10,
);

// Google Maps MCP tool settings
const envMaps = readEnvFile(['GOOGLE_MAPS_API_KEY', 'GOOGLE_MAPS_TIMEOUT_MS']);
export const GOOGLE_MAPS_API_KEY =
  process.env.GOOGLE_MAPS_API_KEY ?? envMaps.GOOGLE_MAPS_API_KEY ?? '';
export const GOOGLE_MAPS_TIMEOUT_MS = parseInt(
  process.env.GOOGLE_MAPS_TIMEOUT_MS ??
    envMaps.GOOGLE_MAPS_TIMEOUT_MS ??
    '6000',
  10,
);

// Flat-DB paths for voice.get_contract + voice.get_practice_profile
export const CONTRACTS_PATH =
  process.env.CONTRACTS_PATH ?? path.join(DATA_DIR, 'contracts.json');
export const PRACTICE_PROFILE_PATH =
  process.env.PRACTICE_PROFILE_PATH ??
  path.join(DATA_DIR, 'practice-profile.json');

// Google Calendar MCP tool settings
export const GCALENDAR_CREDS_PATH =
  process.env.GCALENDAR_CREDS_PATH ??
  path.join(HOME_DIR, '.gcalendar-mcp', 'gcp-oauth.keys.json');
export const GCALENDAR_TOKENS_PATH =
  process.env.GCALENDAR_TOKENS_PATH ??
  path.join(HOME_DIR, '.gcalendar-mcp', 'google-calendar-mcp', 'tokens.json');
export const GCALENDAR_DEFAULT_TZ =
  process.env.GCALENDAR_DEFAULT_TZ ?? 'Europe/Berlin';
export const GCALENDAR_DEFAULT_CAL_ID =
  process.env.GCALENDAR_DEFAULT_CAL_ID ?? 'primary';
export const GCALENDAR_TIMEOUT_MS = parseInt(
  process.env.GCALENDAR_TIMEOUT_MS ?? '10000',
  10,
);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
