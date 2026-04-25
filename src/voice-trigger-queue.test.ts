// src/voice-trigger-queue.test.ts
// Phase 05.5 Plan 01 Task 1 — unit tests for the per-call_id FIFO queue.
// All five scenarios from PATTERNS.md "Test scenarios":
// 1. Same call_id → strictly sequentially.
// 2. Different call_ids → concurrently.
// 3. gc(callId) removes the chain — fresh enqueue runs immediately.
// 4. depth(callId) reflects in-flight + pending count.
// 5. A failing task does NOT poison the chain.

import { describe, expect, it } from 'vitest';

import { VoiceTriggerQueue } from './voice-trigger-queue.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('VoiceTriggerQueue', () => {
  // --- Scenario 1: same call_id runs sequentially ---
  it('runs two enqueues for the same call_id strictly sequentially (FIFO)', async () => {
    const queue = new VoiceTriggerQueue();
    const events: string[] = [];

    const t1 = queue.enqueue('call-A', async () => {
      events.push('t1-start');
      await delay(50);
      events.push('t1-end');
      return 't1';
    });
    const t2 = queue.enqueue('call-A', async () => {
      events.push('t2-start');
      await delay(10);
      events.push('t2-end');
      return 't2';
    });

    const [r1, r2] = await Promise.all([t1, t2]);
    expect(r1).toBe('t1');
    expect(r2).toBe('t2');

    // Strict ordering: t1 must finish before t2 starts.
    expect(events).toEqual(['t1-start', 't1-end', 't2-start', 't2-end']);
  });

  // --- Scenario 2: different call_ids run concurrently ---
  it('runs enqueues for different call_ids concurrently (no cross-call blocking)', async () => {
    const queue = new VoiceTriggerQueue();
    const start = Date.now();

    const t1 = queue.enqueue('call-A', async () => {
      await delay(50);
      return Date.now();
    });
    const t2 = queue.enqueue('call-B', async () => {
      await delay(0);
      return Date.now();
    });

    const [end1, end2] = await Promise.all([t1, t2]);
    const totalElapsed = Math.max(end1, end2) - start;

    // If they ran sequentially, total would be ~50ms+. Concurrent → both
    // finish within the longer task's duration. Allow generous slack for
    // CI jitter; the key assertion is "well under sum of durations".
    expect(totalElapsed).toBeLessThan(120);
  });

  // --- Scenario 3: gc(callId) removes the chain ---
  it('gc(callId) removes the chain — subsequent enqueue does not wait on stale promise', async () => {
    const queue = new VoiceTriggerQueue();
    const events: string[] = [];

    // Schedule a long-running task on call-A — DON'T await it yet.
    const stale = queue.enqueue('call-A', async () => {
      await delay(200);
      events.push('stale-end');
      return 'stale';
    });

    // gc() drops our reference to the chain. The stale task continues to
    // run, but the queue no longer waits on it for new enqueues.
    queue.gc('call-A');
    expect(queue.depth('call-A')).toBe(0);

    // A fresh enqueue should run immediately, NOT wait the 200ms.
    const t0 = Date.now();
    const fresh = await queue.enqueue('call-A', async () => {
      events.push('fresh');
      return 'fresh';
    });
    const elapsed = Date.now() - t0;

    expect(fresh).toBe('fresh');
    // 'fresh' ran independently of 'stale'.
    expect(events[0]).toBe('fresh');
    expect(elapsed).toBeLessThan(50);

    // Wait for the stale task to drain so vitest does not flag a leak.
    await stale;
  });

  // --- Scenario 4: depth(callId) reflects in-flight + pending ---
  it('depth(callId) reflects in-flight + pending count', async () => {
    const queue = new VoiceTriggerQueue();

    // Initially zero.
    expect(queue.depth('call-A')).toBe(0);

    // Two enqueues queued — one in-flight, one pending. Depth = 2.
    const t1 = queue.enqueue('call-A', async () => {
      await delay(40);
    });
    const t2 = queue.enqueue('call-A', async () => {
      await delay(10);
    });
    expect(queue.depth('call-A')).toBe(2);

    // After both resolve, depth back to 0.
    await Promise.all([t1, t2]);
    expect(queue.depth('call-A')).toBe(0);
  });

  // --- Scenario 5: failing task does NOT poison the chain ---
  it('does not poison the chain: a failing task is followed by a successful one', async () => {
    const queue = new VoiceTriggerQueue();
    const events: string[] = [];

    const t1 = queue
      .enqueue('call-A', async () => {
        events.push('t1-rejecting');
        throw new Error('t1 boom');
      })
      .catch((err: Error) => {
        events.push(`t1-caught:${err.message}`);
      });

    const t2 = queue.enqueue('call-A', async () => {
      events.push('t2-running');
      return 't2-ok';
    });

    await t1;
    const r2 = await t2;

    expect(r2).toBe('t2-ok');
    // t1 rejected but t2 still ran afterwards.
    expect(events).toContain('t1-rejecting');
    expect(events).toContain('t1-caught:t1 boom');
    expect(events).toContain('t2-running');
    // Order: t1-running before t2-running (FIFO holds even on rejection).
    expect(events.indexOf('t1-rejecting')).toBeLessThan(
      events.indexOf('t2-running'),
    );
  });
});
