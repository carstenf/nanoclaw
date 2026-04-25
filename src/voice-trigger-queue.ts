// src/voice-trigger-queue.ts
// Phase 05.5 Plan 01 (REQ-DIR-15, REQ-INFRA-16, D-11, D-12):
// Per-`call_id` FIFO Promise-chain queue for the container-agent reasoning
// triggers (`voice_triggers_transcript`).
//
// Invariants:
// - One Promise chain per `call_id`. Two enqueues for the SAME call_id run
//   strictly sequentially (turn N+1 waits for turn N's resolution).
// - Different `call_id`s run concurrently — no cross-call blocking.
// - A failing task does NOT poison the chain — `prev.then(fn, fn)` runs the
//   next task on success OR failure of the prior (D-12: no abort).
// - `gc(callId)` removes the chain on end-of-call (REQ-INFRA-16; called from
//   `voice_finalize_call_cost`). Subsequent `enqueue(callId, ...)` starts a
//   fresh chain.
// - `depth(callId)` reflects in-flight + pending tasks for /health observability.
//
// NO container-process awareness. NO retry logic. Pure in-memory class.
// Slim by design — see PATTERNS.md "voice-trigger-queue.ts" for the rationale
// against re-using the heavier `GroupQueue` machinery.

export class VoiceTriggerQueue {
  private chains = new Map<string, Promise<unknown>>();
  private depths = new Map<string, number>();

  /**
   * Enqueue a task for `callId`. Returns the result of `fn` after every
   * earlier task on this chain has resolved (or rejected — see D-12).
   *
   * Failing tasks do NOT poison the chain: the next enqueued task still runs.
   */
  enqueue<T>(callId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(callId) ?? Promise.resolve();
    this.depths.set(callId, (this.depths.get(callId) ?? 0) + 1);

    // Run on success OR failure of prior task — D-12: failing task does
    // not poison the chain.
    const next = prev.then(fn, fn);

    // Store the depth-tracked variant in the map (not `next` itself) so
    // depth-decrement bookkeeping fires whether next succeeds or fails.
    this.chains.set(
      callId,
      next.finally(() => {
        const cur = this.depths.get(callId) ?? 1;
        const decremented = Math.max(0, cur - 1);
        if (decremented === 0) {
          this.depths.delete(callId);
        } else {
          this.depths.set(callId, decremented);
        }
      }),
    );

    return next;
  }

  /**
   * Remove the chain for `callId`. Called on end-of-call from
   * `voice_finalize_call_cost` per REQ-INFRA-16 / D-11.
   *
   * Pending in-flight tasks continue to run to completion — gc() only drops
   * NanoClaw's reference to the chain so subsequent `enqueue(callId, ...)`
   * starts a fresh chain (no wait on a stale promise).
   */
  gc(callId: string): void {
    this.chains.delete(callId);
    this.depths.delete(callId);
  }

  /**
   * Current in-flight + pending count for `callId`. Exposed via /health for
   * observability per Specifics §FIFO queue invariants.
   */
  depth(callId: string): number {
    return this.depths.get(callId) ?? 0;
  }
}
