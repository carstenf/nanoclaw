// src/drift-monitor.ts
// Phase 4 Plan 04-04 (REQ-QUAL-03): rolling 24h P50 turn-latency scan.
//
// Scans turns-*.jsonl files in BRIDGE_LOG_DIR for entries matching the
// voice-bridge/src/turn-timing.ts TurnTimingEntry schema, computes per-line
// latency = (t4_first_tts_audio_ms - t0_vad_end_ms), filters to a rolling
// 24-hour window, and fires a Discord alert when the P50 exceeds the
// threshold (default 1200 ms).
//
// Pitfall 9 defense: the JSONL is treated as additive/tolerant JSON — any
// missing / typo'd / newly-added field is ignored. We only require the
// two numeric fields that define the metric (t0_vad_end_ms + t4_first_tts_audio_ms)
// and a parseable ts_iso or ts field for the rolling window cutoff.
//
// Registered into src/task-scheduler.ts as an in-process scheduled task
// (CLAUDE.md "single Node.js process" constraint — no separate daemon).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { logger } from './logger.js';

export interface DriftMonitorDeps {
  /** Defaults to BRIDGE_LOG_DIR env var, then ~/nanoclaw/voice-container/runs. */
  baseDir?: string;
  /** Clock for rolling-window cutoff. Default Date.now. */
  now?: () => number;
  /** Fan-out for the drift alert — usually voice-bridge/src/alerts.ts sendDiscordAlert. */
  sendDiscordAlert: (msg: string) => Promise<void>;
  /** Alert threshold in ms. Default 1200 (QUAL-03). */
  p50Threshold?: number;
  /** Rolling window size in ms. Default 24h. */
  windowMs?: number;
  /** Minimum sample count before any alert fires. Default 10 — suppresses noise on idle days. */
  minSamples?: number;
}

export interface DriftMonitorResult {
  samples: number;
  p50_ms: number;
  alerted: boolean;
}

function defaultBaseDir(): string {
  return (
    process.env.BRIDGE_LOG_DIR ??
    path.join(os.homedir(), 'nanoclaw', 'voice-container', 'runs')
  );
}

/**
 * Scan all turns-*.jsonl files in `baseDir`, collect per-turn latencies
 * that fall inside the rolling window, and compute the P50.
 *
 * Exported for unit testing — runDriftMonitor wraps this with alert gating.
 */
export function computeP50RollingWindow(
  baseDir: string,
  nowMs: number,
  windowMs: number,
): { samples: number[]; p50_ms: number } {
  const cutoff = nowMs - windowMs;
  const latencies: number[] = [];

  if (!fs.existsSync(baseDir)) return { samples: [], p50_ms: 0 };

  let files: string[];
  try {
    files = fs
      .readdirSync(baseDir)
      .filter((f) => f.startsWith('turns-') && f.endsWith('.jsonl'));
  } catch {
    return { samples: [], p50_ms: 0 };
  }

  for (const file of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(baseDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // Pitfall 9: malformed line → skip, don't crash
      }
      const e = entry as Record<string, unknown>;
      if (typeof e?.t0_vad_end_ms !== 'number') continue;
      if (typeof e?.t4_first_tts_audio_ms !== 'number') continue;

      const tsField = e.ts_iso ?? e.ts;
      const tsMs =
        typeof tsField === 'string'
          ? Date.parse(tsField)
          : typeof tsField === 'number'
            ? tsField
            : NaN;
      if (!Number.isFinite(tsMs) || tsMs < cutoff) continue;

      const lat = (e.t4_first_tts_audio_ms as number) - (e.t0_vad_end_ms as number);
      if (lat > 0) latencies.push(lat);
    }
  }

  latencies.sort((a, b) => a - b);
  const p50 =
    latencies.length === 0
      ? 0
      : latencies[Math.floor(latencies.length / 2)];
  return { samples: latencies, p50_ms: p50 };
}

export async function runDriftMonitor(
  deps: DriftMonitorDeps,
): Promise<DriftMonitorResult> {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  const now = deps.now ?? Date.now;
  const threshold = deps.p50Threshold ?? 1200;
  const windowMs = deps.windowMs ?? 24 * 60 * 60 * 1000;
  const minSamples = deps.minSamples ?? 10;

  const { samples, p50_ms } = computeP50RollingWindow(baseDir, now(), windowMs);

  logger.info({
    event: 'drift_monitor_run',
    samples: samples.length,
    p50_ms,
    threshold,
    window_ms: windowMs,
  });

  const alerted = samples.length >= minSamples && p50_ms > threshold;
  if (alerted) {
    await deps.sendDiscordAlert(
      `Drift alert: P50 turn-latency rolling-24h = ${p50_ms}ms (threshold ${threshold}ms, samples=${samples.length}) (REQ-QUAL-03)`,
    );
  }

  return { samples: samples.length, p50_ms, alerted };
}
