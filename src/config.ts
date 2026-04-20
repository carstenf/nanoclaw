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

// Flat-DB paths for voice_get_contract + voice_get_practice_profile
export const CONTRACTS_PATH =
  process.env.CONTRACTS_PATH ?? path.join(DATA_DIR, 'contracts.json');
export const PRACTICE_PROFILE_PATH =
  process.env.PRACTICE_PROFILE_PATH ??
  path.join(DATA_DIR, 'practice-profile.json');

// Skills directory for voice_ask_core skill resolution
export const SKILLS_DIR =
  process.env.SKILLS_DIR ?? path.join(DATA_DIR, 'skills');

// voice_ask_core Claude inference settings
export const ASK_CORE_CLAUDE_TIMEOUT_MS = parseInt(
  process.env.ASK_CORE_CLAUDE_TIMEOUT_MS ?? '10000',
  10,
);
export const ASK_CORE_MAX_TOKENS_PER_CALL = parseInt(
  process.env.ASK_CORE_MAX_TOKENS_PER_CALL ?? '500',
  10,
);

// voice_ask_core topic='andy' — container-agent timeout
// Default 90s: cold container start (Docker pull skipped if image cached) + npm compile
// + Claude inference can take 30-60s. Plan spec says 30s but real containers need more.
export const ASK_CORE_ANDY_TIMEOUT_MS = parseInt(
  process.env.ASK_CORE_ANDY_TIMEOUT_MS ?? '90000',
  10,
);

// Andy's voice-long-form Discord channel
// Default: env ANDY_VOICE_DISCORD_CHANNEL, or first allowed channel from VOICE_DISCORD_ALLOWED_CHANNELS
const _envAndyDiscord = readEnvFile(['ANDY_VOICE_DISCORD_CHANNEL']);
export const ANDY_VOICE_DISCORD_CHANNEL: string =
  process.env.ANDY_VOICE_DISCORD_CHANNEL ??
  _envAndyDiscord.ANDY_VOICE_DISCORD_CHANNEL ??
  '';

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

// ----- Plan 03-11: voice_request_outbound_call -----
// Bridge base URL for outbound-call requests.
export const BRIDGE_OUTBOUND_URL =
  process.env.BRIDGE_OUTBOUND_URL ?? 'http://10.0.0.2:4402';
// Optional Bearer token for Bridge /outbound (empty = disabled).
export const BRIDGE_OUTBOUND_AUTH_TOKEN =
  process.env.BRIDGE_OUTBOUND_AUTH_TOKEN ?? '';

// ----- Plan 04-03 (AC-07): StreamableHTTP MCP transport -----
// Second MCP surface on port 3201 exposes the SAME ToolRegistry via the
// @modelcontextprotocol/sdk StreamableHTTPServerTransport. Port 3200 stays
// for the home-grown Bridge REST fassade (Phase 3 unchanged).
// Pitfall 6: bind explicitly to 10.0.0.2 (WG interface), never 0.0.0.0.
// Pitfall 8: handler wrapper synthesizes chat-prefixed call_id/turn_id so
// debug invocations never collide with live-call idempotency keys.
export const MCP_STREAM_PORT = Number(process.env.MCP_STREAM_PORT ?? 3201);
export const MCP_STREAM_BIND = process.env.MCP_STREAM_BIND ?? '10.0.0.2';
// MCP_STREAM_BEARER is provisioned via OneCLI (onecli add-secret). When empty
// the server does NOT start (fail-loud — no insecure default).
export const MCP_STREAM_BEARER = process.env.MCP_STREAM_BEARER ?? '';
// Phase 4.5 Plan 01 (D-3): session-based StreamableHTTP transport.
// Idle TTL per session; sweep evicts sessions inactive longer than this.
// Active (in-flight) sessions are NEVER swept — lastActivity bumps on every
// request. Default: 30 minutes.
export const MCP_STREAM_SESSION_TTL_MS = Number(
  process.env.MCP_STREAM_SESSION_TTL_MS ?? 30 * 60 * 1000,
);
// Hard cap on concurrent sessions to bound DoS surface (T-4.5-A). Excess
// initialize requests are rejected with 503 `session_cap_reached` and logged
// as `mcp_session_cap_rejected`. Default 50 — expected real load ≤ 10.
export const MCP_STREAM_MAX_SESSIONS = Number(
  process.env.MCP_STREAM_MAX_SESSIONS ?? 50,
);

// ----- Plan 05-01 (SEED-001): channel-routing session tracker -----
// Window within which inbound activity is considered "active session".
// Default: 10 minutes.
export const VOICE_ACTIVE_SESSION_WINDOW_MS = parseInt(
  process.env.VOICE_ACTIVE_SESSION_WINDOW_MS ?? '600000',
  10,
);

// Long-text threshold for voice_notify_user routing: payloads with more
// than this many words are force-routed to Discord regardless of active session.
// Default: 50 words (per feedback_long_text_discord.md rule).
export const VOICE_NOTIFY_LONG_TEXT_WORD_THRESHOLD = parseInt(
  process.env.VOICE_NOTIFY_LONG_TEXT_WORD_THRESHOLD ?? '50',
  10,
);

// ----- Plan 05-02 (Case-2 Wave 2): retry ladder + daily cap -----
// Ladder: minutes to wait before attempt 1→2, 2→3, 3→4, 4→5.
// CASE_2_DAILY_CAP: max attempts per (target_phone, calendar_date).
export const CASE_2_RETRY_LADDER_MIN = [5, 15, 45, 120];
export const CASE_2_DAILY_CAP = 5;
// Default tolerances for voice_start_case_2_call D-5 args.
export const CASE_2_TIME_TOLERANCE_MIN_DEFAULT = 30;
export const CASE_2_PARTY_SIZE_TOLERANCE_DEFAULT = 0;

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
