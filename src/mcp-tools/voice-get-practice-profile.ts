/**
 * voice-get-practice-profile.ts
 *
 * MCP tool: voice.get_practice_profile  (REQ-TOOLS-06)
 * Args: {name: string 1..200}
 * Returns: {phone, patient_id, insurance_type, last_visit, authorized_data_fields[]}
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
import { BadRequestError } from './voice-on-transcript-turn.js';

// ---------------------------------------------------------------------------
// Schema — REQ-TOOLS-06
// ---------------------------------------------------------------------------

export const GetPracticeProfileSchema = z.object({
  call_id: z.string().optional(),
  name: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Practice Profile DB shape
// ---------------------------------------------------------------------------

interface PracticeProfile {
  name: string;
  phone?: string;
  patient_id?: string;
  insurance_type?: string;
  last_visit?: string;
  authorized_data_fields?: string[];
  // legacy fields kept for backwards-compat reads
  type?: string;
  address?: string;
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
  readDb?: (filePath: string) => Promise<PracticeProfileDb>;
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

    // Zod parse — REQ-TOOLS-06 shape
    const parseResult = GetPracticeProfileSchema.safeParse(args);
    if (!parseResult.success) {
      const first = parseResult.error.issues[0];
      throw new BadRequestError(
        String(first?.path?.[0] ?? 'input'),
        first?.message ?? 'invalid',
      );
    }

    const { call_id, name } = parseResult.data;

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

    // Lookup — case-insensitive name match across all profiles
    const profiles = db.profiles ?? {};
    const query = name.toLowerCase();
    const found = Object.values(profiles).find((p) =>
      p.name.toLowerCase().includes(query),
    );

    const latency = now() - start;

    appendJsonl({
      ts: new Date().toISOString(),
      event: 'practice_profile_lookup_done',
      tool: 'voice.get_practice_profile',
      call_id: call_id ?? null,
      query_key: name,
      found: found !== undefined,
      latency_ms: latency,
    });

    return {
      ok: true,
      result: {
        phone: found?.phone ?? null,
        patient_id: found?.patient_id ?? null,
        insurance_type: found?.insurance_type ?? null,
        last_visit: found?.last_visit ?? null,
        authorized_data_fields: found?.authorized_data_fields ?? [],
      },
    };
  };
}
