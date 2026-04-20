/**
 * voice-search-competitors.ts
 *
 * MCP tool: voice.search_competitors  (REQ-TOOLS-05, Phase 4 Plan 04-03)
 *
 * Schema (matches voice-bridge/src/tools/schemas/search_competitors.json):
 *   { category: string, criteria: object, call_id?: string }
 * Returns:
 *   { ok: true,  result: { offers: [{ provider, price, terms, source_url }, ...] } }
 *   { ok: false, error: 'not_configured' | 'backend_error' }
 *
 * Phase-4 MVP ships graceful not_configured fallback: if SEARCH_COMPETITORS_PROVIDER
 * env is absent / 'not_configured', OR no askCompetitorsBackend dep is wired, the
 * handler returns {ok:false, error:'not_configured'} so the Phase-4 gate passes
 * without forcing a Brave/Claude backend decision. Phase 7 (C4 negotiation) wires
 * the real backend.
 */

import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';

import { BadRequestError } from './voice-on-transcript-turn.js';
import type { ToolHandler } from './index.js';

// ---------------------------------------------------------------------------
// Schema — matches Bridge-side JSON schema exactly (criteria is an OBJECT).
// ---------------------------------------------------------------------------

export const SearchCompetitorsSchema = z.object({
  call_id: z.string().optional(),
  category: z.string().min(1).max(64),
  criteria: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// Backend result shape
// ---------------------------------------------------------------------------

export interface CompetitorOffer {
  provider: string;
  price: string;
  terms: string;
  source_url: string;
}

export interface CompetitorBackendResult {
  offers: CompetitorOffer[];
}

// ---------------------------------------------------------------------------
// DI
// ---------------------------------------------------------------------------

export interface VoiceSearchCompetitorsDeps {
  /**
   * Optional backend — a thin wrapper around Claude-over-web-search or Brave.
   * When omitted, the handler returns not_configured (Phase-4 MVP default).
   * Phase 7 wires this via makeClaudeWebSearchBackend() or similar.
   */
  askCompetitorsBackend?: (
    category: string,
    criteria: Record<string, unknown>,
  ) => Promise<CompetitorBackendResult>;
  /** 'claude_web' | 'brave' | 'not_configured' | undefined. Falls back to env. */
  provider?: string;
  /** JSONL audit path override. Default: DATA_DIR/voice-lookup.jsonl. */
  jsonlPath?: string;
  /** Clock injection for test determinism. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function makeVoiceSearchCompetitors(
  deps: VoiceSearchCompetitorsDeps,
): ToolHandler {
  const now = deps.now ?? (() => Date.now());
  const jsonlPath = deps.jsonlPath ?? path.join(DATA_DIR, 'voice-lookup.jsonl');
  const provider =
    deps.provider ?? process.env.SEARCH_COMPETITORS_PROVIDER ?? '';

  return async function voiceSearchCompetitors(
    args: unknown,
  ): Promise<unknown> {
    const start = now();

    const parseResult = SearchCompetitorsSchema.safeParse(args);
    if (!parseResult.success) {
      const firstError = parseResult.error.issues[0];
      const field = String(firstError?.path?.[0] ?? 'input');
      const message = firstError?.message ?? 'invalid';
      throw new BadRequestError(field, message);
    }

    const { call_id, category, criteria } = parseResult.data;

    // Graceful not_configured — Phase-4 gate passes without a backend.
    if (!provider || provider === 'not_configured') {
      logger.warn({
        event: 'voice_search_competitors_not_configured',
        reason: 'provider_unset',
      });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'search_competitors_not_configured',
        tool: 'voice.search_competitors',
        call_id: call_id ?? null,
        latency_ms: now() - start,
      });
      return { ok: false, error: 'not_configured' };
    }

    if (!deps.askCompetitorsBackend) {
      logger.warn({
        event: 'voice_search_competitors_not_configured',
        reason: 'backend_missing',
        provider,
      });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'search_competitors_not_configured',
        tool: 'voice.search_competitors',
        call_id: call_id ?? null,
        provider,
        latency_ms: now() - start,
      });
      return { ok: false, error: 'not_configured' };
    }

    try {
      const res = await deps.askCompetitorsBackend(category, criteria);
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'search_competitors_done',
        tool: 'voice.search_competitors',
        call_id: call_id ?? null,
        category,
        offer_count: res.offers.length,
        provider,
        latency_ms: now() - start,
      });
      return { ok: true, result: { offers: res.offers } };
    } catch (err) {
      logger.warn({
        event: 'voice_search_competitors_fail',
        provider,
        err: err instanceof Error ? err.message : String(err),
      });
      appendJsonl(jsonlPath, {
        ts: new Date().toISOString(),
        event: 'search_competitors_failed',
        tool: 'voice.search_competitors',
        call_id: call_id ?? null,
        provider,
        latency_ms: now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: 'backend_error' };
    }
  };
}

// ---------------------------------------------------------------------------
// JSONL appender (non-fatal)
// ---------------------------------------------------------------------------

function appendJsonl(filePath: string, entry: object): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // non-fatal
  }
}
