// voice-bridge/src/logger.ts
// Per Pitfall NEW-5: both transports default to INFO. If LOG_LEVEL=debug
// is needed, raise BRIDGE_LOG_LEVEL_FILE separately to avoid journald
// disk pressure.
import pino from 'pino'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export function buildLogger(): pino.Logger {
  const dir =
    process.env.BRIDGE_LOG_DIR ??
    join(homedir(), 'nanoclaw', 'voice-container', 'runs')
  mkdirSync(dir, { recursive: true })

  const transport = pino.transport({
    targets: [
      {
        target: 'pino-roll',
        options: {
          file: join(dir, 'bridge'), // pino-roll appends -YYYY-MM-DD
          frequency: 'daily',
          dateFormat: 'yyyy-MM-dd',
          extension: '.jsonl',
          mkdir: true,
        },
        level: process.env.LOG_LEVEL ?? 'info',
      },
      {
        target: 'pino/file', // also stdout for journald
        options: { destination: 1 },
        level: process.env.LOG_LEVEL ?? 'info',
      },
    ],
  })
  return pino({ base: { svc: 'voice-bridge' } }, transport)
}

// --- Phase 2 JSONL event field taxonomy (additive — no transport change) ---
// idempotency_hit:                     { event, call_id, turn_id, tool_name, key_hash }
// invalid_tool_call:                   { event, call_id, turn_id, tool_name, reason, ajv_errors? }
// readback_mismatch:                   { event, call_id, turn_id, tool_name, expected, observed, tolerance_dim }
// sideband_ready:                      { event, call_id, latency_ms }
// sideband_timeout:                    { event, call_id, elapsed_ms }
// sideband_error:                      { event, call_id, err }
// sideband_closed:                     { event, call_id }
// sideband_update_skipped:             { event, call_id, reason }
// slow_brain_degraded:                 { event, call_id, reason }
// slow_brain_backpressure:             { event, call_id, queue_depth, dropped_turn_id }
// slow_brain_tools_field_stripped_BUG: { event, call_id }
// turn_timing:                         written to turns-{call_id}.jsonl (see turn-timing.ts), NOT bridge log
// ghost_scan_hit:                      { event, call_id, path }   — warn-level
// ghost_scan_clean:                    { event, call_id }         — info-level
// mem_delta_mb:                        { event, call_id, delta_mb } — observability only (D-19)
// teardown_started:                    { event, call_id, trigger }
// teardown_kill_pending:               { event, call_id, elapsed_ms }
// teardown_closed_normally:            { event, call_id, elapsed_ms }
// teardown_force_closed:               { event, call_id, elapsed_ms }
// allowlist_compiled:                  { event, tool_count, mutating_count }
