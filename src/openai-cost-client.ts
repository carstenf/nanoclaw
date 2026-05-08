// src/openai-cost-client.ts
//
// Thin client for the OpenAI Admin API `GET /v1/organization/costs`
// endpoint. Used by the post-call cost summary (Phase C, 2026-05-07) to
// compute month-to-date USD spend across the entire org and derive a
// "budget rest" against the operator-configured monthly budget.
//
// Why admin API, not /v1/usage:
//   - /v1/usage is project-scoped and requires a project key; only counts
//     tokens, no money.
//   - /v1/organization/costs is org-scoped and returns billed USD per
//     project, which matches what Carsten sees on the dashboard.
//   - There is NO public endpoint that returns "remaining prepaid credit
//     balance" (legacy /dashboard/billing/credit_grants is dead). The
//     operator sets monthly_budget_eur in voice-config.json and the rest
//     is computed: rest = budget_eur - month_eur.
//
// Auth: requires an admin-API-key (sk-admin-…). The user/project keys in
// .env (OPENAI_REALTIME_VOICE etc.) cannot read /v1/organization/*.
//
// Caching: 5-minute TTL in process memory. The endpoint is rate-limited
// and post-call summaries can fire in bursts; caching keeps us under the
// limit and removes API-call latency from the hangup-to-Discord path.

import { logger } from './logger.js';
import { readEnvFile } from './env.js';

export interface CostBucket {
  results: Array<{
    amount: { value: string; currency: string };
  }>;
}

export interface OrgCostsResponse {
  data: CostBucket[];
  has_more: boolean;
  next_page?: string;
}

export interface MonthToDateCost {
  /** Sum of costs in USD for the current calendar month (UTC). */
  usd: number;
  /** Cache age in seconds (0 for a fresh fetch, >0 for a cached value). */
  cache_age_s: number;
  /** ISO timestamp of the data window start (start of month). */
  window_start: string;
  /** ISO timestamp of when the API was actually queried. */
  fetched_at: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  cost: MonthToDateCost;
  cached_at_ms: number;
}

let cache: CacheEntry | null = null;

/**
 * For tests + manual force-refresh after a cap-bust event.
 */
export function _resetCostCache(): void {
  cache = null;
}

/**
 * Pick the admin key from env. Tries process.env first (production override),
 * then ~/nanoclaw/.env (dev / our deploy). Returns undefined when unset so
 * the caller can degrade gracefully (post-call summary without budget rest).
 */
export function getAdminKey(): string | undefined {
  const fromEnv = process.env.OPENAI_ADMIN_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readEnvFile(['OPENAI_ADMIN_KEY']).OPENAI_ADMIN_KEY?.trim();
  return fromFile || undefined;
}

/**
 * Compute the start of the current calendar month (UTC) as a unix timestamp.
 * Matches the month boundary OpenAI uses on the dashboard.
 */
function startOfMonthUnix(now: Date): number {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  return Math.floor(start.getTime() / 1000);
}

export interface FetchDeps {
  /** DI seam — overridden in tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** DI clock for tests. */
  now?: () => Date;
  /** Force-bypass the cache. */
  noCache?: boolean;
  /** Override admin key (skip env lookup). */
  adminKey?: string;
}

/**
 * Sum month-to-date organization costs in USD. Walks pagination if needed
 * (one bucket per day, so pages are short — typical month: 1-2 pages).
 *
 * Errors (network / 4xx / 5xx) are logged + thrown. The caller (post-call
 * summary) catches and degrades to a Discord message without budget rest.
 */
export async function getMonthToDateUsd(
  deps: FetchDeps = {},
): Promise<MonthToDateCost> {
  const fetchFn = deps.fetchFn ?? fetch;
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();

  if (!deps.noCache && cache) {
    const age_ms = now.getTime() - cache.cached_at_ms;
    if (age_ms < CACHE_TTL_MS) {
      return { ...cache.cost, cache_age_s: Math.floor(age_ms / 1000) };
    }
  }

  const adminKey = deps.adminKey ?? getAdminKey();
  if (!adminKey) {
    throw new Error('OPENAI_ADMIN_KEY not set');
  }

  const startUnix = startOfMonthUnix(now);
  const windowStartIso = new Date(startUnix * 1000).toISOString();

  let usd = 0;
  let nextPage: string | undefined;
  let pages = 0;
  do {
    const url = new URL('https://api.openai.com/v1/organization/costs');
    url.searchParams.set('start_time', String(startUnix));
    url.searchParams.set('limit', '31');
    if (nextPage) url.searchParams.set('page', nextPage);

    const res = await fetchFn(url.toString(), {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `openai admin costs ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as OrgCostsResponse;
    for (const bucket of json.data) {
      for (const r of bucket.results) {
        const v = Number(r.amount.value);
        if (Number.isFinite(v)) usd += v;
      }
    }
    nextPage = json.has_more ? json.next_page : undefined;
    pages++;
    if (pages > 10) {
      // Sanity: a month has ≤31 days; with limit=31 we should always finish
      // in 1-2 pages. 10 pages means something is wrong (cycle, API bug).
      throw new Error('openai admin costs: pagination runaway (>10 pages)');
    }
  } while (nextPage);

  const cost: MonthToDateCost = {
    usd,
    cache_age_s: 0,
    window_start: windowStartIso,
    fetched_at: now.toISOString(),
  };
  cache = { cost, cached_at_ms: now.getTime() };

  logger.info({
    event: 'openai_costs_fetched',
    month_usd: usd,
    pages,
    window_start: windowStartIso,
  });

  return cost;
}

// 2026-05-08: variant of getMonthToDateUsd that takes a custom window start
// (e.g. user's prepaid topup timestamp). Same fetch shape, separate cache
// map keyed by startUnix so multiple windows can coexist (month-start +
// topup-start, etc.). Lives in this file because it shares the auth +
// pagination loop; promote to a helper if a third caller appears.

const sinceCache = new Map<number, CacheEntry>();

export interface CostsSinceUnix {
  usd: number;
  cache_age_s: number;
  window_start_unix: number;
  window_start_iso: string;
  fetched_at: string;
}

export async function getCostsSinceUnix(
  startUnix: number,
  deps: FetchDeps = {},
): Promise<CostsSinceUnix> {
  if (!Number.isFinite(startUnix) || startUnix <= 0) {
    throw new Error(`getCostsSinceUnix: invalid startUnix=${startUnix}`);
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const nowFn = deps.now ?? (() => new Date());
  const now = nowFn();

  if (!deps.noCache) {
    const cached = sinceCache.get(startUnix);
    if (cached) {
      const age_ms = now.getTime() - cached.cached_at_ms;
      if (age_ms < CACHE_TTL_MS) {
        return {
          usd: cached.cost.usd,
          cache_age_s: Math.floor(age_ms / 1000),
          window_start_unix: startUnix,
          window_start_iso: cached.cost.window_start,
          fetched_at: cached.cost.fetched_at,
        };
      }
    }
  }

  const adminKey = deps.adminKey ?? getAdminKey();
  if (!adminKey) {
    throw new Error('OPENAI_ADMIN_KEY not set');
  }
  const windowStartIso = new Date(startUnix * 1000).toISOString();

  let usd = 0;
  let nextPage: string | undefined;
  let pages = 0;
  do {
    const url = new URL('https://api.openai.com/v1/organization/costs');
    url.searchParams.set('start_time', String(startUnix));
    url.searchParams.set('limit', '31');
    if (nextPage) url.searchParams.set('page', nextPage);

    const res = await fetchFn(url.toString(), {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `openai admin costs ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as OrgCostsResponse;
    for (const bucket of json.data) {
      for (const r of bucket.results) {
        const v = Number(r.amount.value);
        if (Number.isFinite(v)) usd += v;
      }
    }
    nextPage = json.has_more ? json.next_page : undefined;
    pages++;
    // Sanity: at 31 days/page, even a year-long window is <12 pages. 30
    // pages = something pathological (cycle, API bug) — abort.
    if (pages > 30) {
      throw new Error('openai admin costs: pagination runaway (>30 pages)');
    }
  } while (nextPage);

  const cost: MonthToDateCost = {
    usd,
    cache_age_s: 0,
    window_start: windowStartIso,
    fetched_at: now.toISOString(),
  };
  sinceCache.set(startUnix, { cost, cached_at_ms: now.getTime() });

  logger.info({
    event: 'openai_costs_since_fetched',
    usd,
    pages,
    window_start_unix: startUnix,
    window_start_iso: windowStartIso,
  });

  return {
    usd,
    cache_age_s: 0,
    window_start_unix: startUnix,
    window_start_iso: windowStartIso,
    fetched_at: now.toISOString(),
  };
}

export function _resetSinceCache(): void {
  sinceCache.clear();
}
