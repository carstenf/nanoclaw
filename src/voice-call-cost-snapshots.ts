// src/voice-call-cost-snapshots.ts
//
// In-memory per-call cost-snapshot store. Bridge calls voice_call_cost_
// snapshot at /accept (stores a baseline cost), then voice_call_cost_
// finalize at hangup (looks up the baseline, subtracts, posts summary).
//
// Lifetime: a snapshot lives for the call duration only. Finalize clears
// it. If finalize never runs (crash, network drop), the entry leaks until
// next process restart — acceptable, the map is tiny per-call.

import { logger } from './logger.js';
import type { ProviderName } from './cost-providers.js';

interface Snapshot {
  call_id: string;
  provider: ProviderName;
  baseline_usd: number;
  taken_at_unix: number;
}

const snapshots = new Map<string, Snapshot>();

export function setSnapshot(s: Snapshot): void {
  if (snapshots.has(s.call_id)) {
    logger.warn({
      event: 'voice_call_cost_snapshot_overwrite',
      call_id: s.call_id,
      previous_baseline_usd: snapshots.get(s.call_id)!.baseline_usd,
      new_baseline_usd: s.baseline_usd,
    });
  }
  snapshots.set(s.call_id, s);
}

export function getSnapshot(call_id: string): Snapshot | undefined {
  return snapshots.get(call_id);
}

export function clearSnapshot(call_id: string): boolean {
  return snapshots.delete(call_id);
}

export function snapshotsSize(): number {
  return snapshots.size;
}

/** For tests. */
export function _resetAllSnapshots(): void {
  snapshots.clear();
}
