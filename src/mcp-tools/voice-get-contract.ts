/**
 * voice-get-contract.ts
 *
 * MCP tool: voice.get_contract  (REQ-TOOLS-04)
 * Args: {provider_name: string}
 * Returns: {current_conditions, expiry_date, last_review} — all nullable
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
// Schema — REQ-TOOLS-04
// ---------------------------------------------------------------------------

const GetContractSchema = z.object({
  call_id: z.string().optional(),
  provider_name: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Contracts DB shape
// ---------------------------------------------------------------------------

interface Contract {
  provider: string;
  current_conditions?: string;
  expiry_date?: string;
  last_review?: string;
  // legacy fields kept for backwards-compat reads
  id?: string;
  product?: string;
  start_date?: string;
  end_date?: string;
  cancellation_notice_days?: number;
  monthly_cost_eur?: number;
  notes?: string;
}

interface ContractsDb {
  contracts?: Contract[];
}

// ---------------------------------------------------------------------------
// Deps injection interface
// ---------------------------------------------------------------------------

export interface VoiceGetContractDeps {
  contractsPath: string;
  jsonlPath?: string | null;
  readDb?: (filePath: string) => Promise<ContractsDb>;
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

export function makeVoiceGetContract(deps: VoiceGetContractDeps) {
  const contractsPath = deps.contractsPath;
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
      readFlatDb<ContractsDb>(filePath, { contracts: [] }));

  return async function voiceGetContract(args: unknown): Promise<unknown> {
    const start = now();

    // Zod parse — REQ-TOOLS-04 shape
    const parseResult = GetContractSchema.safeParse(args);
    if (!parseResult.success) {
      const first = parseResult.error.issues[0];
      throw new BadRequestError(
        String(first?.path?.[0] ?? 'input'),
        first?.message ?? 'invalid',
      );
    }

    const { call_id, provider_name } = parseResult.data;

    // Load DB
    let db: ContractsDb;
    try {
      db = await readDb(contractsPath);
    } catch (err) {
      if (err instanceof FlatDbNotFound) {
        logger.warn({
          event: 'voice_get_contract_not_configured',
          contractsPath,
        });
        return { ok: false, error: 'not_configured' };
      }
      if (err instanceof FlatDbParseError) {
        return { ok: false, error: 'parse_error' };
      }
      throw err;
    }

    // Lookup — case-insensitive provider substring match
    const contracts = db.contracts ?? [];
    const query = provider_name.toLowerCase();
    const found = contracts.find((c) =>
      c.provider.toLowerCase().includes(query),
    );

    const latency = now() - start;

    appendJsonl({
      ts: new Date().toISOString(),
      event: 'contract_lookup_done',
      tool: 'voice.get_contract',
      call_id: call_id ?? null,
      query_key: provider_name,
      found: found !== undefined,
      latency_ms: latency,
    });

    return {
      ok: true,
      result: {
        current_conditions: found?.current_conditions ?? null,
        expiry_date: found?.expiry_date ?? null,
        last_review: found?.last_review ?? null,
      },
    };
  };
}
