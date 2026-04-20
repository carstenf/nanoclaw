// Phase 4.5 Wave-0 scaffold for the Bridge v2 CoreMcpClient test suite.
// Case titles are the contract: Wave 2 executor tasks `-t`-filter on them,
// so names must NOT drift. Implementations land in Wave 2 (Plan 04.5-02/03).
//
// Source of truth for titles: 04.5-VALIDATION.md §"Per-Task Verification Map"
// and 04.5-PATTERNS.md §"voice-bridge/src/core-mcp-client.test.ts (NEW)".
// Fixture pattern to mirror: voice-bridge/src/cost/gate.test.ts (DI-mock + env-backup).
import { describe, it } from 'vitest';

describe('CoreMcpClient v2 (MCP StreamableHTTP via SDK)', () => {
  it.skip('connect: lazy-opens MCP session on first ensureConnected()', () => {
    // Wave 2 Task: construct CoreMcpClient, call ensureConnected(), assert
    //   internal .client is non-null and an initialize was issued exactly once.
  });

  it.skip('callTool: returns server result, preserves args shape', () => {
    // Wave 2 Task: run ephemeral buildMcpStreamApp or mock transport; verify
    //   echo-tool round-trips args without reshuffling keys or dropping fields.
  });

  it.skip('close: idempotent, second close() is no-op', () => {
    // Wave 2 Task: await client.close(); await client.close(); no throw.
    //   Pitfall-5 guard (double-close path).
  });

  it.skip('timeout: callTool rejects with CoreMcpTimeoutError when opts.timeoutMs elapses', () => {
    // Wave 2 Task: mock slow server, pass timeoutMs: 50, assert rejection
    //   instanceof CoreMcpTimeoutError; underlying socket torn down.
  });

  it.skip('server_error: callTool rejects with CoreMcpError when server returns isError: true', () => {
    // Wave 2 Task: server returns MCP error payload with isError: true, client
    //   wraps into CoreMcpError (distinct class from CoreMcpTimeoutError).
  });

  it.skip('reconnect_after_close: ensureConnected() after close() opens a fresh session', () => {
    // Wave 2 Task: close(); ensureConnected(); assert new client instance is
    //   a different object reference than the previous one (no stale handle).
  });
});
