/**
 * voice-get-practice-profile.ts
 *
 * MCP tool: voice.get_practice_profile
 * Reads flat JSON practice-profile file.
 * - key absent → list all profile keys
 * - key set → exact lookup → profile or null
 * Graceful: not_configured when file absent, parse_error on bad JSON.
 * JSONL-logged, PII-clean (no profile content in log).
 */

import path from 'path';
import fs from 'fs';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import {
  readFlatDb,
  FlatDbNotFound,
  FlatDbParseError,
} from './flat-db-reader.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GetPracticeProfileSchema = z.object({
  call_id: z.string().optional(),
  key: z.string().regex(/^[a-z0-9_-]*$/).optional(),
});

// ---------------------------------------------------------------------------
// Practice Profile DB shape
// ---------------------------------------------------------------------------

interface PracticeProfile {
  name: string;
  type?: string;
  address?: string;
  phone?: string;
  email?: string;
  languages?: string[];
  opening_hours?: string;
  notes?: string;
}

interface PracticeProfileDb {
  profiles?: Record<string, PracticeProfile>;
}

// ---------------------------------------------------------------------------
// Deps injection interface
// ---------------------------------------------------------------------------

export interface VoiceGetPracticeProfileDeps {
  profilesPath: string;
  jsonlPath?: string | null;
  /** Override readFlatDb for tests. */
  readDb?: (filePath: string) => Promise<PracticeProfileDb>;
  /** Override JSONL appender for tests. */
  appendJsonl?: (entry: object) => void;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Internal JSONL writer (file-based, non-fatal)
// ---------------------------------------------------------------------------

function makeFileAppender(filePath: string) {
  return function appendToFile(entry: object): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch {
      // non-fatal
    }
  };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Build voice.get_practice_profile handler.
 */
export function makeVoiceGetPracticeProfile(deps: VoiceGetPracticeProfileDeps) {
  const profilesPath = deps.profilesPath;
  const now = deps.now ?? (() => Date.now());

  const appendJsonl =
    deps.appendJsonl ??
    (deps.jsonlPath != null
      ? makeFileAppender(deps.jsonlPath)
      : (entry: object) => {
          try {
            const filePath = path.join(DATA_DIR, 'voice-lookup.jsonl');
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
          } catch {
            // non-fatal
          }
        });

  const readDb =
    deps.readDb ??
    ((filePath: string) =>
      readFlatDb<PracticeProfileDb>(filePath, { profiles: {} }));

  return async function voiceGetPracticeProfile(
    args: unknown,
  ): Promise<unknown> {
    const start = now();

    // Zod parse
    const parseResult = GetPracticeProfileSchema.safeParse(args);
    if (!parseResult.success) {
      const first = parseResult.error.issues[0];
      logger.warn({
        event: 'voice_get_practice_profile_invalid_input',
        error: first?.message,
      });
      // Return graceful error rather than throwing (key is optional anyway)
      return { ok: false, error: 'invalid_input' };
    }

    const { call_id, key } = parseResult.data;
    const queryKey = key ?? 'list';

    // Load DB
    let db: PracticeProfileDb;
    try {
      db = await readDb(profilesPath);
    } catch (err) {
      if (err instanceof FlatDbNotFound) {
        logger.warn({
          event: 'voice_get_practice_profile_not_configured',
          profilesPath,
        });
        return { ok: false, error: 'not_configured' };
      }
      if (err instanceof FlatDbParseError) {
        return { ok: false, error: 'parse_error' };
      }
      throw err;
    }

    const profiles = db.profiles ?? {};
    const latency = now() - start;

    if (!key) {
      // List mode — return all keys
      const keys = Object.keys(profiles);

      appendJsonl({
        ts: new Date().toISOString(),
        event: 'practice_profile_lookup_done',
        tool: 'voice.get_practice_profile',
        call_id: call_id ?? null,
        query_key: queryKey,
        found: keys.length > 0,
        latency_ms: latency,
      });

      return { ok: true, result: { keys } };
    }

    // Lookup mode — exact key
    const profile = profiles[key] ?? null;

    appendJsonl({
      ts: new Date().toISOString(),
      event: 'practice_profile_lookup_done',
      tool: 'voice.get_practice_profile',
      call_id: call_id ?? null,
      query_key: queryKey,
      found: profile !== null,
      latency_ms: latency,
    });

    return { ok: true, result: { profile } };
  };
}
