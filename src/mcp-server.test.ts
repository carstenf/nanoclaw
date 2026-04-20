import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { buildMcpApp } from './mcp-server.js';
import { buildDefaultRegistry } from './mcp-tools/index.js';
import { SlowBrainSessionManager } from './mcp-tools/slow-brain-session.js';

let tmpDir: string;
let server: http.Server;
let baseUrl: string;

async function startApp(allowlist: string[]): Promise<void> {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  // Use a no-op session manager to avoid real OneCLI calls in tests
  const mockSessionManager = new SlowBrainSessionManager({
    claudeClient: async () => 'null',
  });
  const registry = buildDefaultRegistry({
    dataDir: tmpDir,
    log,
    sessionManager: mockSessionManager,
    sweepIntervalMs: 0,
  });
  const app = buildMcpApp({
    registry,
    log,
    allowlist,
    boundTo: '127.0.0.1:test',
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-test-'));
});

afterEach(async () => {
  await stopApp();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /health', () => {
  it('returns 200 with bound_to, peers, tools for allowed peer', async () => {
    await startApp(['127.0.0.1']);
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      bound_to: string;
      peers: string[];
      tools: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.bound_to).toBe('127.0.0.1:test');
    expect(body.peers).toEqual(['127.0.0.1']);
    expect(body.tools).toContain('voice_on_transcript_turn');
  });

  it('returns 403 peer_not_allowed for unlisted peer', async () => {
    await startApp(['10.0.0.99']); // 127.0.0.1 not listed
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string; peer_ip: string };
    expect(body.error).toBe('peer_not_allowed');
    expect(body.peer_ip).toBe('127.0.0.1');
  });
});

describe('POST /mcp/:tool_name', () => {
  it('voice_on_transcript_turn with valid body -> 200 {ok, result}', async () => {
    await startApp(['127.0.0.1']);
    const r = await fetch(`${baseUrl}/mcp/voice_on_transcript_turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: {
          call_id: 'rtc-x',
          turn_id: 't-0',
          transcript: 'hallo claude',
        },
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      result: { ok: boolean; instructions_update: string | null };
    };
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ ok: true, instructions_update: null });
  });

  it('unknown tool -> 404 unknown_tool', async () => {
    await startApp(['127.0.0.1']);
    const r = await fetch(`${baseUrl}/mcp/foo.bar_not_real`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: {} }),
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string; tool_name: string };
    expect(body.error).toBe('unknown_tool');
    expect(body.tool_name).toBe('foo.bar_not_real');
  });

  it('broken JSON body -> 400 bad_json', async () => {
    await startApp(['127.0.0.1']);
    const r = await fetch(`${baseUrl}/mcp/voice_on_transcript_turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('bad_json');
  });

  it('missing call_id -> 400 bad_request with field', async () => {
    await startApp(['127.0.0.1']);
    const r = await fetch(`${baseUrl}/mcp/voice_on_transcript_turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: { turn_id: 't', transcript: 'hi' },
      }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; field: string };
    expect(body.error).toBe('bad_request');
    expect(body.field).toBe('call_id');
  });

  it('blocked peer on POST -> 403 before tool dispatch', async () => {
    await startApp(['10.0.0.99']);
    const r = await fetch(`${baseUrl}/mcp/voice_on_transcript_turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arguments: { call_id: 'c', turn_id: 't', transcript: 'x' },
      }),
    });
    expect(r.status).toBe(403);
  });

  it('logs mcp_rest_request_seen on every request (D-8 deprecation observability)', async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };
    const mockSessionManager = new SlowBrainSessionManager({
      claudeClient: async () => 'null',
    });
    const registry = buildDefaultRegistry({
      dataDir: tmpDir,
      log,
      sessionManager: mockSessionManager,
      sweepIntervalMs: 0,
    });
    const app = buildMcpApp({
      registry,
      log,
      allowlist: ['127.0.0.1'],
      boundTo: '127.0.0.1:test',
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;

    await fetch(`${url}/mcp/voice_on_transcript_turn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'test-ua/1.0',
      },
      body: JSON.stringify({
        arguments: { call_id: 'rtc-x', turn_id: 't-0', transcript: 'hi' },
      }),
    });

    const seen = log.info.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>)?.event === 'mcp_rest_request_seen',
    );
    expect(seen).toBeDefined();
    const payload = seen![0] as Record<string, unknown>;
    expect(payload.tool_name).toBe('voice_on_transcript_turn');
    expect(payload.user_agent).toBe('test-ua/1.0');
    expect(typeof payload.peer_ip).toBe('string');
  });
});
