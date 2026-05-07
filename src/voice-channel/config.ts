// src/voice-channel/config.ts
//
// Voice-channel configuration. All env-var parsing for voice-only settings
// lives here so the /add-voice-channel skill can carry these definitions
// with the rest of the voice-channel module on uninstall.
//
// Re-exported from src/config.ts for backwards compatibility with consumers
// outside the voice-channel directory (skill-loader, active-session-tracker).
// Skill uninstall path: delete this file + drop the re-exports from
// src/config.ts.

import path from 'path';
import { readEnvFile } from '../env.js';

// Local DATA_DIR resolution to avoid circular import with config.ts
// (which re-exports the symbols below for backwards compat). Same
// algorithm as config.ts: project_root/data, where project_root = cwd
// at process startup.
const DATA_DIR = path.resolve(process.cwd(), 'data');

// ----- Discord channel allowlist for voice MCP send-discord-message -----
const _envDiscord = readEnvFile([
  'VOICE_DISCORD_ALLOWED_CHANNELS',
  'VOICE_DISCORD_TIMEOUT_MS',
]);

export const VOICE_DISCORD_ALLOWED_CHANNELS_RAW =
  process.env.VOICE_DISCORD_ALLOWED_CHANNELS ??
  _envDiscord.VOICE_DISCORD_ALLOWED_CHANNELS ??
  '';

export const VOICE_DISCORD_ALLOWED_CHANNELS: Set<string> = new Set(
  VOICE_DISCORD_ALLOWED_CHANNELS_RAW.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

export const VOICE_DISCORD_TIMEOUT_MS = parseInt(
  process.env.VOICE_DISCORD_TIMEOUT_MS ??
    _envDiscord.VOICE_DISCORD_TIMEOUT_MS ??
    '8000',
  10,
);

// ----- Flat-DB paths for voice_get_contract + voice_get_practice_profile -----
export const CONTRACTS_PATH =
  process.env.CONTRACTS_PATH ?? path.join(DATA_DIR, 'contracts.json');
export const PRACTICE_PROFILE_PATH =
  process.env.PRACTICE_PROFILE_PATH ??
  path.join(DATA_DIR, 'practice-profile.json');

// ----- Skills directory for voice_ask_core skill resolution -----
export const SKILLS_DIR =
  process.env.SKILLS_DIR ?? path.join(DATA_DIR, 'skills');

// ----- voice_ask_core Claude inference settings -----
export const ASK_CORE_CLAUDE_TIMEOUT_MS = parseInt(
  process.env.ASK_CORE_CLAUDE_TIMEOUT_MS ?? '10000',
  10,
);
export const ASK_CORE_MAX_TOKENS_PER_CALL = parseInt(
  process.env.ASK_CORE_MAX_TOKENS_PER_CALL ?? '500',
  10,
);

// ----- voice_ask_core topic='andy' — container-agent timeout -----
// Default 90s: cold container start (Docker pull skipped if image cached) + npm compile
// + Claude inference can take 30-60s. Plan spec says 30s but real containers need more.
export const ASK_CORE_ANDY_TIMEOUT_MS = parseInt(
  process.env.ASK_CORE_ANDY_TIMEOUT_MS ?? '300000',
  10,
);

// ----- Andy's voice-long-form Discord channel -----
// Default: env ANDY_VOICE_DISCORD_CHANNEL, or first allowed channel from VOICE_DISCORD_ALLOWED_CHANNELS
const _envAndyDiscord = readEnvFile(['ANDY_VOICE_DISCORD_CHANNEL']);
export const ANDY_VOICE_DISCORD_CHANNEL: string =
  process.env.ANDY_VOICE_DISCORD_CHANNEL ??
  _envAndyDiscord.ANDY_VOICE_DISCORD_CHANNEL ??
  '';

// ----- Plan 03-11: voice_request_outbound_call -----
// Bridge base URL for outbound-call requests.
export const BRIDGE_OUTBOUND_URL =
  process.env.BRIDGE_OUTBOUND_URL ?? 'http://10.0.0.2:4402';
// Optional Bearer token for Bridge /outbound (empty = disabled).
export const BRIDGE_OUTBOUND_AUTH_TOKEN =
  process.env.BRIDGE_OUTBOUND_AUTH_TOKEN ?? '';

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
