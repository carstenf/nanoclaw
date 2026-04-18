/**
 * voice-get-contract.ts
 *
 * MCP tool: voice.get_contract
 * Reads flat JSON contracts file, looks up by id or provider substring.
 * Graceful: not_configured when file absent, parse_error on bad JSON.
 * JSONL-logged, PII-clean (no contract content in log).
 */

import path from 'path';
import fs from 'fs';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { readFlatDb, FlatDbNotFound, FlatDbParseError } from './flat-db-reader.js';
import { BadRequestError } from './voice-on-transcript-turn.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GetContractSchema = z.object({
  call_id: z.string().optional(),
  id: z.string().regex(/^[a-z0-9_-]+$/).optional(),
  provider: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Contracts DB shape
// ---------------------------------------------------------------------------

interface Contract {
  id: string;
  provider: string;
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
  /** Override readFlatDb for tests. */
  readDb?: (filePath: string) => Promise<ContractsDb>;
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
 * Build voice.get_contract handler.
 */
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
    ((filePath: string) => readFlatDb<ContractsDb>(filePath, { contracts: [] }));

  return async function voiceGetContract(args: unknown): Promise<unknown> {
    const start = now();

    // Zod parse
    const parseResult = GetContractSchema.safeParse(args);
    if (!parseResult.success) {
      const first = parseResult.error.issues[0];
      throw new BadRequestError(
        String(first?.path?.[0] ?? 'input'),
        first?.message ?? 'invalid',
      );
    }

    const { call_id, id, provider } = parseResult.data;

    // At least one query param required
    if (!id && !provider) {
      throw new BadRequestError('missing_query', 'id or provider required');
    }

    const queryKey = id ?? provider ?? '';

    // Load DB
    let db: ContractsDb;
    try {
      db = await readDb(contractsPath);
    } catch (err) {
      if (err instanceof FlatDbNotFound) {
        logger.warn({ event: 'voice_get_contract_not_configured', contractsPath });
        return { ok: false, error: 'not_configured' };
      }
      if (err instanceof FlatDbParseError) {
        return { ok: false, error: 'parse_error' };
      }
      throw err;
    }

    // Lookup
    const contracts = db.contracts ?? [];
    let found: Contract | undefined;

    if (id) {
      found = contracts.find((c) => c.id === id);
    } else if (provider) {
      const query = provider.toLowerCase();
      found = contracts.find((c) => c.provider.toLowerCase().includes(query));
    }

    const latency = now() - start;

    // JSONL log — no contract content
    appendJsonl({
      ts: new Date().toISOString(),
      event: 'contract_lookup_done',
      tool: 'voice.get_contract',
      call_id: call_id ?? null,
      query_key: queryKey,
      found: found !== undefined,
      latency_ms: latency,
    });

    return {
      ok: true,
      result: {
        contract: found ?? null,
      },
    };
  };
}
