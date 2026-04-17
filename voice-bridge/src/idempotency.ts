// voice-bridge/src/idempotency.ts
// D-01..D-06: Bridge-side idempotency wrapper for mutating Realtime tool-calls.
// RFC 8785-style canonical JSON; sha256 key; in-process RAM Map; per-call TTL.
// Bridge restart mid-call -> graceful cache-miss (D-04). Cache-hit returns the
// cached MCP result identically (D-06). Never bypass: dispatch-path is the
// only writer, clearCall() on session.closed is the only deleter.
import { createHash } from 'node:crypto'
import type { Logger } from 'pino'

export interface IdempotencyEntry {
  result: unknown
  storedAt: number
}

const cache = new Map<string, IdempotencyEntry>()

/**
 * RFC 8785-style canonical JSON: sort object keys alphabetically, no whitespace.
 * Arrays preserve order. Primitives pass through JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]))
  return '{' + parts.join(',') + '}'
}

/**
 * D-02: sha256(callId \0 turnId \0 toolName \0 canonical_json(args))
 * All four components are required. Missing any -> throw.
 * Null-byte separators prevent concatenation collisions (T-02-02-04).
 */
export function makeKey(
  callId: string,
  turnId: string,
  toolName: string,
  args: unknown,
): string {
  if (!callId || !turnId || !toolName) {
    throw new TypeError(
      'idempotency.makeKey requires non-empty callId, turnId, toolName',
    )
  }
  if (args === undefined) {
    throw new TypeError(
      'idempotency.makeKey requires args (use null or {} if absent)',
    )
  }
  const canon = canonicalJson(args)
  return createHash('sha256')
    .update(`${callId}\0${turnId}\0${toolName}\0${canon}`)
    .digest('hex')
}

export function get(key: string): IdempotencyEntry | undefined {
  return cache.get(key)
}

export function set(key: string, result: unknown): void {
  cache.set(key, { result, storedAt: Date.now() })
}

/**
 * D-03: Per-call TTL. Clears the entire cache on session.closed.
 * TODO (Phase 4+): if multi-concurrent-call support lands, key cache entries
 * by callId prefix and delete only matching entries.
 */
export function clearCall(_callId: string): void {
  cache.clear()
}

/**
 * Convenience wrapper used by /accept wiring (Plan 02-07) and tests.
 * Cache-miss -> invoke once, cache, return. Cache-hit -> return cached, log
 * idempotency_hit event (D-06).
 */
export async function invokeIdempotent<T>(
  callId: string,
  turnId: string,
  toolName: string,
  args: unknown,
  invoker: () => Promise<T>,
  log: Logger,
): Promise<T> {
  const key = makeKey(callId, turnId, toolName, args)
  const hit = get(key)
  if (hit) {
    log.info({
      event: 'idempotency_hit',
      call_id: callId,
      turn_id: turnId,
      tool_name: toolName,
      key_hash: key.slice(0, 16),
    })
    return hit.result as T
  }
  const result = await invoker()
  set(key, result)
  return result
}

// Observability/test-only accessor — never consumed in production code paths.
export function _cacheSize(): number {
  return cache.size
}
