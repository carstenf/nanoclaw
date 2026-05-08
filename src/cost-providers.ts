// src/cost-providers.ts
//
// Pluggable per-LLM cost-provider abstraction. Each provider exposes a
// snapshot of cumulative spend that the per-call cost flow can take twice
// (at /accept + at hangup-after-lag) and subtract for the actual billed
// cost of that call.
//
// Providers implement snapshotMtdUsd() — returns USD spent since some
// stable origin (typically start-of-month, but the absolute value doesn't
// matter; only the DELTA between two snapshots is what callers care about).
//
// Today only OpenAI is wired. When Anthropic / others gain admin-cost APIs
// (Anthropic added one in late-2025; not yet wired here) drop a new file
// like anthropic-cost-provider.ts and register it in the providers map
// below — no changes to the call-cost flow.

import { getMonthToDateUsd } from './openai-cost-client.js';
import { logger } from './logger.js';

export type ProviderName = 'openai';

export interface CostProvider {
  /** Stable identifier; used in summaries and as the registry key. */
  readonly name: ProviderName;
  /**
   * Cumulative cost in USD since some origin (typically month-start).
   * Two snapshots and a subtract = the cost of work done in between.
   */
  snapshotMtdUsd(): Promise<number>;
}

class OpenAiCostProvider implements CostProvider {
  readonly name = 'openai' as const;
  async snapshotMtdUsd(): Promise<number> {
    // noCache=true so back-to-back snapshots from snapshot() and
    // finalize() don't return the same cached value (the 5-min cache
    // would mask the per-call delta entirely).
    const r = await getMonthToDateUsd({ noCache: true });
    return r.usd;
  }
}

const providers: Record<ProviderName, CostProvider> = {
  openai: new OpenAiCostProvider(),
};

export function getCostProvider(name: ProviderName): CostProvider {
  const p = providers[name];
  if (!p) {
    logger.warn({ event: 'cost_provider_unknown', name });
    throw new Error(`unknown cost provider: ${name}`);
  }
  return p;
}

export function listCostProviders(): ProviderName[] {
  return Object.keys(providers) as ProviderName[];
}
