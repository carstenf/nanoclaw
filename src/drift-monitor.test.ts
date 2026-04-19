// src/drift-monitor.test.ts
// Phase 4 Plan 04-04 (QUAL-03): rolling-24h P50 turn-latency scan + Discord alert.
// RED during Wave-4: the module does not exist yet. Task 3 turns it GREEN.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { computeP50RollingWindow, runDriftMonitor } from './drift-monitor.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-monitor-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_NOW = new Date('2026-04-19T12:00:00Z').getTime();
const ONE_HOUR_MS = 60 * 60 * 1000;

function writeTurns(
  fileName: string,
  entries: Array<Record<string, unknown>>,
): void {
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(tmpDir, fileName), body);
}

function entry(
  tsMs: number,
  t0: number,
  t4: number | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ts_iso: new Date(tsMs).toISOString(),
    call_id: 'c1',
    turn_id: `t_${tsMs}`,
    t0_vad_end_ms: t0,
    t2_first_llm_token_ms: null,
    t4_first_tts_audio_ms: t4,
    barge_in: false,
    ...extra,
  };
}

describe('computeP50RollingWindow', () => {
  it('returns p50=0 and samples=0 when directory is empty', () => {
    const out = computeP50RollingWindow(tmpDir, BASE_NOW, 24 * ONE_HOUR_MS);
    expect(out.samples.length).toBe(0);
    expect(out.p50_ms).toBe(0);
  });

  it('returns p50=0 and samples=0 when directory does not exist', () => {
    const out = computeP50RollingWindow(
      path.join(tmpDir, 'missing'),
      BASE_NOW,
      24 * ONE_HOUR_MS,
    );
    expect(out.samples.length).toBe(0);
    expect(out.p50_ms).toBe(0);
  });

  it('computes P50=1000 for 15 turns with t0=0, t4=1000', () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      entry(BASE_NOW - ONE_HOUR_MS * (i + 1), 0, 1000),
    );
    writeTurns('turns-c1.jsonl', entries);

    const out = computeP50RollingWindow(tmpDir, BASE_NOW, 24 * ONE_HOUR_MS);
    expect(out.samples.length).toBe(15);
    expect(out.p50_ms).toBe(1000);
  });

  it('drops entries older than the rolling window', () => {
    const fresh = Array.from({ length: 5 }, (_, i) =>
      entry(BASE_NOW - ONE_HOUR_MS * (i + 1), 0, 800),
    );
    const stale = Array.from({ length: 5 }, (_, i) =>
      entry(BASE_NOW - ONE_HOUR_MS * (30 + i), 0, 1500),
    );
    writeTurns('turns-c1.jsonl', [...fresh, ...stale]);

    const out = computeP50RollingWindow(tmpDir, BASE_NOW, 24 * ONE_HOUR_MS);
    expect(out.samples.length).toBe(5);
    expect(out.p50_ms).toBe(800);
  });

  it('tolerates missing t0/t4 fields without throwing (Pitfall 9)', () => {
    writeTurns('turns-c1.jsonl', [
      entry(BASE_NOW - ONE_HOUR_MS, 0, 1000),
      {
        ts_iso: new Date(BASE_NOW - ONE_HOUR_MS).toISOString(),
        call_id: 'c1',
        turn_id: 'x',
      }, // no timings
      { random: 'junk' }, // no fields at all
      entry(BASE_NOW - ONE_HOUR_MS, 100, null), // t4 null → barge-in
    ]);

    const out = computeP50RollingWindow(tmpDir, BASE_NOW, 24 * ONE_HOUR_MS);
    expect(out.samples.length).toBe(1);
    expect(out.p50_ms).toBe(1000);
  });

  it('ignores non-turns-*.jsonl files', () => {
    writeTurns('other.log', [entry(BASE_NOW - ONE_HOUR_MS, 0, 5000)]);
    writeTurns('turns-real.jsonl', [entry(BASE_NOW - ONE_HOUR_MS, 0, 500)]);

    const out = computeP50RollingWindow(tmpDir, BASE_NOW, 24 * ONE_HOUR_MS);
    expect(out.samples.length).toBe(1);
    expect(out.p50_ms).toBe(500);
  });

  it('tolerates malformed JSON lines without crashing', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'turns-c1.jsonl'),
      'not-json-at-all\n' +
        JSON.stringify(entry(BASE_NOW - ONE_HOUR_MS, 0, 900)) +
        '\n' +
        '{"partial": \n',
    );
    const out = computeP50RollingWindow(tmpDir, BASE_NOW, 24 * ONE_HOUR_MS);
    expect(out.samples.length).toBe(1);
    expect(out.p50_ms).toBe(900);
  });
});

describe('runDriftMonitor', () => {
  it('does NOT alert when P50 is below threshold', async () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      entry(BASE_NOW - ONE_HOUR_MS * (i + 1), 0, 1000),
    );
    writeTurns('turns-c1.jsonl', entries);

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const result = await runDriftMonitor({
      baseDir: tmpDir,
      now: () => BASE_NOW,
      sendDiscordAlert: alertSpy,
      p50Threshold: 1200,
    });

    expect(result.alerted).toBe(false);
    expect(result.p50_ms).toBe(1000);
    expect(result.samples).toBe(15);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('ALERTS when P50 > threshold with enough samples', async () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      entry(BASE_NOW - ONE_HOUR_MS * (i + 1), 0, 1500),
    );
    writeTurns('turns-c1.jsonl', entries);

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const result = await runDriftMonitor({
      baseDir: tmpDir,
      now: () => BASE_NOW,
      sendDiscordAlert: alertSpy,
      p50Threshold: 1200,
    });

    expect(result.alerted).toBe(true);
    expect(result.p50_ms).toBe(1500);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const msg = alertSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/P50/i);
    expect(msg).toMatch(/1500/);
  });

  it('does NOT alert with fewer than 10 samples (noise floor)', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry(BASE_NOW - ONE_HOUR_MS * (i + 1), 0, 5000),
    );
    writeTurns('turns-c1.jsonl', entries);

    const alertSpy = vi.fn().mockResolvedValue(undefined);
    const result = await runDriftMonitor({
      baseDir: tmpDir,
      now: () => BASE_NOW,
      sendDiscordAlert: alertSpy,
      p50Threshold: 1200,
    });

    expect(result.alerted).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
