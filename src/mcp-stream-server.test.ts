/**
 * Phase 4 Plan 04-03 (AC-07): StreamableHTTP MCP transport tests.
 *
 * Covers:
 * - Bearer auth (401 without / with wrong token; pass-through on match)
 * - Health endpoint exempt from auth, reports registered tools
 * - Peer allowlist enforced even after bearer succeeds
 * - buildMcpStreamApp throws when no bearer is supplied (fail-loud defaults)
 *
 * Handshake with the underlying StreamableHTTPServerTransport is out of scope
 * for unit tests — that is asserted by the Plan 05 manual verify. Here we
 * only verify the Express-level middleware chain (auth + allowlist + route
 * mount) because the MCP transport itself is an SDK-owned black box.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

import { buildMcpStreamApp } from './mcp-stream-server.js';
import { ToolRegistry } from './mcp-tools/index.js';
import type { logger } from './logger.js';

let tmpDir: string;
let server: http.Server;
let baseUrl: string;

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register('voice.echo_test', async (args: unknown) => ({
    ok: true,
    echo: args,
  }));
  r.register('voice.health_probe', async () => ({ ok: true }));
  return r;
}

async function startApp(opts: {
  bearerToken?: string;
  allowlist?: string[];
}): Promise<void> {
  const app = buildMcpStreamApp({
    registry: makeRegistry(),
    bearerToken: opts.bearerToken ?? 'test-token',
    allowlist: opts.allowlist ?? ['127.0.0.1', '::ffff:127.0.0.1', '::1'],
    log: makeLog() as unknown as typeof logger,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopApp(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stream-test-'));
});

afterEach(async () => {
  await stopApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp-stream-server — AC-07 StreamableHTTP', () => {
  it('GET /mcp/stream/health returns 200 ok + tool list WITHOUT auth', async () => {
    await startApp({});
    const r = await fetch(`${baseUrl}/mcp/stream/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      tools: string[];
      bound_to?: string;
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools).toContain('voice.echo_test');
    expect(body.tools).toContain('voice.health_probe');
  });

  it('POST /mcp/stream without Authorization returns 401', async () => {
    await startApp({});
    const r = await fetch(`${baseUrl}/mcp/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(401);
  });

  it('POST /mcp/stream with wrong bearer returns 401', async () => {
    await startApp({ bearerToken: 'correct-token' });
    const r = await fetch(`${baseUrl}/mcp/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer WRONG',
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(401);
  });

  it('POST /mcp/stream with correct bearer passes bearer gate (routes to transport)', async () => {
    // The underlying StreamableHTTPServerTransport may respond with an MCP-level
    // error for an empty JSON-RPC body, but the 401 gate must have been passed.
    // We only assert status !== 401 (bearer gate passed).
    await startApp({ bearerToken: 'correct-token' });
    const r = await fetch(`${baseUrl}/mcp/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer correct-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    expect(r.status).not.toBe(401);
  });

  it('POST /mcp/stream with correct bearer but disallowed peer returns 403', async () => {
    // Allowlist deliberately excludes loopback — peer-allowlist middleware
    // runs AFTER bearer check, so bearer must be correct for us to reach it.
    await startApp({
      bearerToken: 'correct-token',
      allowlist: ['10.99.99.99'], // nothing else allowed
    });
    const r = await fetch(`${baseUrl}/mcp/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer correct-token',
      },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(403);
  });

  it('buildMcpStreamApp throws when MCP_STREAM_BEARER is unset (no insecure default)', () => {
    // With no bearerToken dep AND no env var, construction must throw.
    const prevEnv = process.env.MCP_STREAM_BEARER;
    delete process.env.MCP_STREAM_BEARER;
    try {
      expect(() =>
        buildMcpStreamApp({
          registry: makeRegistry(),
          // bearerToken omitted intentionally
        }),
      ).toThrow(/MCP_STREAM_BEARER/);
    } finally {
      if (prevEnv !== undefined) process.env.MCP_STREAM_BEARER = prevEnv;
    }
  });
});
