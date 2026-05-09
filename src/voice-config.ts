// src/voice-config.ts
//
// v1.4.0 — single source of truth for voice-channel deployment config that
// the bot can self-manage through conversation. Replaces the env-var-only
// model used up to v1.3.x where OPERATOR_NAME / OPERATOR_CLI_NUMBER had to
// be hand-edited in two .env files (NanoClaw + voice-bridge).
//
// Storage:
//   ~/.config/nanoclaw/voice-config.json  (host)
//   /etc/nanoclaw/voice-config.json       (bind-mounted into voice-bridge)
//
// Schema (all fields optional, only present keys override defaults):
//   operator_name        string  — display name used in personas + goal text
//   operator_cli_number  string  — E.164, used by bridge for case_6b CLI match
//
// Read path:
//   - NanoClaw `voice-agent-invoker.ts` reads on every persona render
//     (cheap fs read, fresh values without restart).
//   - Bridge `config.ts` reads at startup AND on each inbound /accept (so
//     a config change picks up on the next call without docker restart).
//
// Write path:
//   - The MCP tool `voice_set_operator_config` (see mcp-tools/) is the only
//     supported writer. Atomic write via tmp-file + rename.
//
// Migration: install.sh seeds voice-config.json once from the legacy
// OPERATOR_* env vars if the file is missing or empty. After v1.5 the env
// fallback in voice-agent-invoker.ts is removed.

import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

export interface VoiceConfig {
  operator_name?: string;
  operator_cli_number?: string;
  /**
   * Monthly OpenAI budget in EUR. When set, the post-call summary
   * (voice_finalize_call_cost on the bridge's session-end hook) shows
   * "rest = budget - month-to-date" so Carsten sees how much is left.
   * Unset / 0 → summary omits the budget line.
   *
   * Source of truth for the cost number is OpenAI's /v1/organization/costs
   * (admin API) — covers ALL projects on the org, not just NanoClaw, so a
   * 50 EUR budget here means "50 EUR across the whole OpenAI account this
   * month".
   */
  monthly_budget_eur?: number;
}

/**
 * Default config path on the NanoClaw host. Inside the bridge container
 * this is overridden via VOICE_CONFIG_PATH=/etc/nanoclaw/voice-config.json.
 */
export const DEFAULT_VOICE_CONFIG_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
  'voice-config.json',
);

function resolvePath(override?: string): string {
  return override ?? process.env.VOICE_CONFIG_PATH ?? DEFAULT_VOICE_CONFIG_PATH;
}

/**
 * Read voice-config.json. Returns {} when the file is missing / empty /
 * malformed — the read path is meant to be best-effort. Hard errors only
 * for genuine I/O issues (permission denied, etc.) which surface via log.
 */
export function readVoiceConfig(filePath?: string): VoiceConfig {
  const p = resolvePath(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn({ err, path: p }, 'voice-config read failed');
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn({ path: p }, 'voice-config: not a JSON object');
      return {};
    }
    return parsed as VoiceConfig;
  } catch (err) {
    logger.warn({ err, path: p }, 'voice-config: JSON parse failed');
    return {};
  }
}

/**
 * Atomically merge `partial` into the current config. Empty-string and
 * undefined values delete the key. Creates parent directories if needed.
 * Returns the new config object.
 */
export function writeVoiceConfig(
  partial: Partial<VoiceConfig>,
  filePath?: string,
): VoiceConfig {
  const p = resolvePath(filePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const current = readVoiceConfig(p);
  const next: VoiceConfig = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    const k = key as keyof VoiceConfig;
    if (value === undefined || value === '' || value === null) {
      delete next[k];
    } else {
      // Type-assert via record indexer so the writer accepts both string
      // (operator_*) and number (monthly_budget_eur) fields without losing
      // VoiceConfig's structural typing on read.
      (next as Record<string, unknown>)[k] = value;
    }
  }

  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  return next;
}
